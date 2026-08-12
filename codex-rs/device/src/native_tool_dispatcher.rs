use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use chrono::DateTime;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_journal::AcknowledgeToolOutcome;
use crewon_device_journal::DeviceWorkspaceJournal;
use crewon_device_journal::PrepareToolError;
use crewon_device_journal::PrepareToolOutcome;
use crewon_device_journal::RecordToolTerminalOutcome;
use crewon_device_journal::ToolJournalExecution;
use crewon_device_journal::ToolJournalListQuery;
use crewon_device_protocol::DEVICE_FILESYSTEM_READ_CAPABILITY;
use crewon_device_protocol::DeviceAcceptedData;
use crewon_device_protocol::DeviceCompletedData;
use crewon_device_protocol::DeviceExecutionAck;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::DeviceExecutionEventEnvelope;
use crewon_device_protocol::DeviceUnknownOutcomeData;
use crewon_device_protocol::parse_device_execution_command;
use sha2::Digest as _;
use sha2::Sha256;
use uuid::Uuid;

use crate::NativeDeviceAdmissionError;
use crate::NativeDeviceConnection;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::native_connection::parse_bounded_json;

/// Explicit native Tool primitive registry.
///
/// Implementations must perform all capability-specific structural admission
/// before returning an admitted value. `execute` is called at most once, only
/// after the accepted event is durable. Implementations must never infer a
/// primitive from a Tool name or translate it into a Workspace command.
pub(crate) trait NativeToolExecutor {
    type Admitted<'a>
    where
        Self: 'a;

    fn advertised_capabilities(&self) -> &'static [&'static str];

    fn admit<'a>(
        &'a self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        now: DateTime<Utc>,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<(DeviceExecutionCommand, Self::Admitted<'a>), NativeDeviceAdmissionError>;

    fn execute<'a>(
        &'a self,
        admitted: Self::Admitted<'a>,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<DeviceCompletedData, NativeDeviceAdmissionError>;
}

/// The only currently production-enabled raw Tool primitive.
///
/// Its dedicated wire schema binds workspace incarnation, canonical path
/// segments, limits, action digest, and Ed25519 authorization.
pub(crate) struct FilesystemReadToolExecutor<'a> {
    registry: &'a WorkspaceDirectoryRegistry,
}

impl<'a> FilesystemReadToolExecutor<'a> {
    fn new(registry: &'a WorkspaceDirectoryRegistry) -> Self {
        Self { registry }
    }
}

impl NativeToolExecutor for FilesystemReadToolExecutor<'_> {
    type Admitted<'a>
        = crate::workspace_file_read::WorkspaceFileReadLease<'a>
    where
        Self: 'a;

    fn advertised_capabilities(&self) -> &'static [&'static str] {
        &[DEVICE_FILESYSTEM_READ_CAPABILITY]
    }

    fn admit<'a>(
        &'a self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        now: DateTime<Utc>,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<(DeviceExecutionCommand, Self::Admitted<'a>), NativeDeviceAdmissionError> {
        let verified = connection.verify_filesystem_read_command(command_frame, now)?;
        let command = connection.admit_filesystem_read_metadata(verified, now, self.registry)?;
        let lease = connection.acquire_filesystem_read_for_durable_dispatch(
            &command,
            now,
            self.registry,
            cancellation,
        )?;
        Ok((command.command, lease))
    }

    fn execute<'a>(
        &'a self,
        admitted: Self::Admitted<'a>,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<DeviceCompletedData, NativeDeviceAdmissionError> {
        let result = admitted
            .read(cancellation)
            .map_err(NativeDeviceAdmissionError::from_workspace)?;
        let empty = format!("sha256:{:x}", Sha256::digest([]));
        Ok(DeviceCompletedData {
            output_digest: format!("sha256:{:x}", Sha256::digest(result.content.as_bytes())),
            output: Some(result.content),
            artifact_ref: None,
            stdout_digest: empty.clone(),
            stderr_digest: empty,
            exit_code: None,
            exit_signal: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum NativeToolDispatchOutcome {
    FreshResolved {
        accepted: DeviceExecutionEvent,
        terminal: DeviceExecutionEvent,
    },
    AcceptedInFlight {
        accepted: DeviceExecutionEvent,
    },
    RecoveredUnknownOutcome {
        accepted: DeviceExecutionEvent,
        terminal: DeviceExecutionEvent,
    },
    TerminalReplay {
        accepted: DeviceExecutionEvent,
        terminal: DeviceExecutionEvent,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeToolReconnectItem {
    pub execution_id: String,
    pub events: Vec<DeviceExecutionEvent>,
    pub acknowledged_through: u64,
}

#[derive(Clone)]
pub struct NativeToolOrchestrator {
    journal: DeviceWorkspaceJournal,
    now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

impl NativeToolOrchestrator {
    pub fn new(journal: DeviceWorkspaceJournal) -> Self {
        Self::with_clock(journal, Utc::now)
    }

    pub fn with_clock(
        journal: DeviceWorkspaceJournal,
        now: impl Fn() -> DateTime<Utc> + Send + Sync + 'static,
    ) -> Self {
        Self {
            journal,
            now: Arc::new(now),
        }
    }

    pub async fn dispatch_filesystem_read(
        &self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        registry: &WorkspaceDirectoryRegistry,
        cancellation: &WorkspaceListCancellation,
        observer: impl FnOnce(&DeviceExecutionEvent),
    ) -> Result<NativeToolDispatchOutcome, NativeDeviceAdmissionError> {
        self.dispatch(
            connection,
            command_frame,
            &FilesystemReadToolExecutor::new(registry),
            cancellation,
            observer,
        )
        .await
    }

    async fn dispatch<Executor: NativeToolExecutor>(
        &self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        executor: &Executor,
        cancellation: &WorkspaceListCancellation,
        observer: impl FnOnce(&DeviceExecutionEvent),
    ) -> Result<NativeToolDispatchOutcome, NativeDeviceAdmissionError> {
        let value = parse_bounded_json(
            command_frame,
            crewon_device_protocol::MAX_DEVICE_COMMAND_BYTES,
            "device_command_invalid",
            "device_command_too_large",
        )?;
        let raw = parse_device_execution_command(value)
            .map_err(NativeDeviceAdmissionError::from_protocol)?;
        if !executor
            .advertised_capabilities()
            .contains(&raw.capability.as_str())
        {
            return Err(NativeDeviceAdmissionError::new(
                "device_capability_unsupported",
            ));
        }
        let prepared = self
            .journal
            .prepare_tool_with_admission(&raw, || {
                let now = (self.now)();
                let (command, admitted) =
                    executor.admit(connection, command_frame, now, cancellation)?;
                if command != raw {
                    return Err(NativeDeviceAdmissionError::new(
                        "device_tool_command_authority_mismatch",
                    ));
                }
                let running = RunningGuard::reserve(&command.execution_id)?;
                Ok((accepted(&command, now), (admitted, running)))
            })
            .await;
        let prepared = match prepared {
            Ok(value) => value,
            Err(PrepareToolError::Admission(error)) => return Err(error),
            Err(PrepareToolError::Journal(error)) => return Err(from_journal(error)),
        };
        match prepared {
            PrepareToolOutcome::AcceptedReplay(execution) => {
                if is_running(&execution.command.execution_id)? {
                    return Ok(NativeToolDispatchOutcome::AcceptedInFlight {
                        accepted: execution.accepted,
                    });
                }
                self.recover_unknown(execution).await
            }
            PrepareToolOutcome::TerminalReplay(execution) => terminal_replay(execution),
            PrepareToolOutcome::New {
                execution,
                admitted: (admitted, running),
            } => {
                observer(&execution.accepted);
                let terminal = match connection.start_command(
                    connection.verify_command(command_frame, (self.now)())?,
                    (self.now)(),
                    |_| executor.execute(admitted, cancellation),
                ) {
                    Ok(Ok(result)) => completed(&execution, result, (self.now)())?,
                    Ok(Err(error)) => failed(&execution, error.code, (self.now)())?,
                    Err(_) => unknown(&execution, (self.now)())?,
                };
                let recorded = self
                    .journal
                    .record_tool_terminal(&terminal)
                    .await
                    .map_err(from_journal)?;
                drop(running);
                let execution = match recorded {
                    RecordToolTerminalOutcome::Committed(value)
                    | RecordToolTerminalOutcome::Replayed(value) => value,
                };
                let terminal = execution.terminal.ok_or_else(|| {
                    NativeDeviceAdmissionError::new("device_journal_authority_corrupt")
                })?;
                Ok(NativeToolDispatchOutcome::FreshResolved {
                    accepted: execution.accepted,
                    terminal,
                })
            }
        }
    }

    async fn recover_unknown(
        &self,
        execution: ToolJournalExecution,
    ) -> Result<NativeToolDispatchOutcome, NativeDeviceAdmissionError> {
        let terminal = unknown(&execution, (self.now)())?;
        let recorded = self
            .journal
            .record_tool_terminal(&terminal)
            .await
            .map_err(from_journal)?;
        let execution = match recorded {
            RecordToolTerminalOutcome::Committed(value)
            | RecordToolTerminalOutcome::Replayed(value) => value,
        };
        Ok(NativeToolDispatchOutcome::RecoveredUnknownOutcome {
            accepted: execution.accepted,
            terminal: execution.terminal.ok_or_else(|| {
                NativeDeviceAdmissionError::new("device_journal_authority_corrupt")
            })?,
        })
    }

    pub async fn acknowledge(
        &self,
        ack: &DeviceExecutionAck,
    ) -> Result<AcknowledgeToolOutcome, NativeDeviceAdmissionError> {
        self.journal
            .acknowledge_tool(ack)
            .await
            .map_err(from_journal)
    }

    pub async fn reconnect(
        &self,
        query: &ToolJournalListQuery,
    ) -> Result<Vec<NativeToolReconnectItem>, NativeDeviceAdmissionError> {
        let page = self
            .journal
            .list_unacknowledged_tools(query)
            .await
            .map_err(from_journal)?;
        let mut recovered = Vec::with_capacity(page.executions.len());
        for execution in page.executions {
            if execution.terminal.is_none() && !is_running(&execution.command.execution_id)? {
                let terminal = unknown(&execution, (self.now)())?;
                let recorded = self
                    .journal
                    .record_tool_terminal(&terminal)
                    .await
                    .map_err(from_journal)?;
                recovered.push(match recorded {
                    RecordToolTerminalOutcome::Committed(value)
                    | RecordToolTerminalOutcome::Replayed(value) => value,
                });
            } else {
                recovered.push(execution);
            }
        }
        recovered
            .into_iter()
            .map(|execution| {
                let mut events = Vec::new();
                if execution.acknowledged_through < 1 {
                    events.push(execution.accepted.clone());
                }
                if execution.acknowledged_through < 2
                    && let Some(terminal) = execution.terminal
                {
                    events.push(terminal);
                }
                Ok(NativeToolReconnectItem {
                    execution_id: execution.command.execution_id,
                    events,
                    acknowledged_through: execution.acknowledged_through,
                })
            })
            .collect()
    }
}

struct RunningGuard(String);
impl RunningGuard {
    fn reserve(id: &str) -> Result<Self, NativeDeviceAdmissionError> {
        let mut running = running()
            .lock()
            .map_err(|_| NativeDeviceAdmissionError::new("device_tool_single_flight_poisoned"))?;
        if !running.insert(id.to_string()) {
            return Err(NativeDeviceAdmissionError::new(
                "device_tool_execution_in_flight",
            ));
        }
        Ok(Self(id.to_string()))
    }
}
impl Drop for RunningGuard {
    fn drop(&mut self) {
        if let Ok(mut values) = running().lock() {
            values.remove(&self.0);
        }
    }
}
fn running() -> &'static Mutex<HashSet<String>> {
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}
fn is_running(id: &str) -> Result<bool, NativeDeviceAdmissionError> {
    Ok(running()
        .lock()
        .map_err(|_| NativeDeviceAdmissionError::new("device_tool_single_flight_poisoned"))?
        .contains(id))
}

fn accepted(command: &DeviceExecutionCommand, now: DateTime<Utc>) -> DeviceExecutionEvent {
    DeviceExecutionEvent::Accepted {
        envelope: event_envelope(command, format!("tool-receipt-{}", Uuid::new_v4()), 1, now),
        data: DeviceAcceptedData {
            lease_epoch: command.lease_epoch,
            action_digest: command.action_digest.clone(),
        },
    }
}
fn completed(
    execution: &ToolJournalExecution,
    data: DeviceCompletedData,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEvent, NativeDeviceAdmissionError> {
    Ok(DeviceExecutionEvent::Completed {
        envelope: terminal_envelope(execution, now)?,
        data,
    })
}
fn failed(
    execution: &ToolJournalExecution,
    code: &str,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEvent, NativeDeviceAdmissionError> {
    Ok(DeviceExecutionEvent::Failed {
        envelope: terminal_envelope(execution, now)?,
        data: crewon_device_protocol::DeviceFailedData {
            code: code.to_string(),
            retryable: false,
        },
    })
}
fn unknown(
    execution: &ToolJournalExecution,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEvent, NativeDeviceAdmissionError> {
    Ok(DeviceExecutionEvent::UnknownOutcome {
        envelope: terminal_envelope(execution, now)?,
        data: DeviceUnknownOutcomeData {
            provider_receipt_id: None,
        },
    })
}
fn terminal_envelope(
    execution: &ToolJournalExecution,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEventEnvelope, NativeDeviceAdmissionError> {
    let DeviceExecutionEvent::Accepted { envelope, .. } = &execution.accepted else {
        return Err(NativeDeviceAdmissionError::new(
            "device_journal_authority_corrupt",
        ));
    };
    Ok(event_envelope(
        &execution.command,
        envelope.receipt_id.clone(),
        2,
        now,
    ))
}
fn event_envelope(
    command: &DeviceExecutionCommand,
    receipt_id: String,
    sequence: u64,
    now: DateTime<Utc>,
) -> DeviceExecutionEventEnvelope {
    DeviceExecutionEventEnvelope {
        schema_version: "crewon.device-event.v0".to_string(),
        protocol_version: command.protocol_version,
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        receipt_id,
        sequence,
        observed_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}
fn terminal_replay(
    execution: ToolJournalExecution,
) -> Result<NativeToolDispatchOutcome, NativeDeviceAdmissionError> {
    Ok(NativeToolDispatchOutcome::TerminalReplay {
        accepted: execution.accepted,
        terminal: execution
            .terminal
            .ok_or_else(|| NativeDeviceAdmissionError::new("device_journal_authority_corrupt"))?,
    })
}
fn from_journal(error: crewon_device_journal::DeviceJournalError) -> NativeDeviceAdmissionError {
    NativeDeviceAdmissionError::with_source(error.code(), error)
}

#[cfg(test)]
#[path = "native_tool_dispatcher_tests.rs"]
mod tests;
