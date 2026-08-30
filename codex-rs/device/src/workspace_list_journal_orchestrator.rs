use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use chrono::DateTime;
use chrono::Utc;
use crewon_device_journal::AcknowledgeWorkspaceListOutcome;
use crewon_device_journal::DeviceJournalError;
use crewon_device_journal::DeviceWorkspaceJournal;
use crewon_device_journal::PrepareWorkspaceListWithAdmissionError;
use crewon_device_journal::PrepareWorkspaceListWithAdmissionOutcome;
use crewon_device_journal::RecordTerminalOutcome;
use crewon_device_journal::WorkspaceJournalExecution;
use crewon_device_journal::WorkspaceJournalListQuery;
use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::MAX_DEVICE_COMMAND_BYTES;
use crewon_device_protocol::parse_device_workspace_list_command;

use crate::DeviceWorkspaceListResult;
use crate::NativeDeviceAdmissionError;
use crate::NativeDeviceConnection;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::workspace_list_dispatcher::AdmittedWorkspaceList;
use crate::workspace_list_dispatcher::execute_admitted_workspace_list;
use crate::workspace_list_journal_events::accepted_event;
use crate::workspace_list_journal_events::completed_terminal;
use crate::workspace_list_journal_events::failed_terminal;
use crate::workspace_list_journal_events::unknown_terminal;

#[derive(Debug, Clone, PartialEq)]
pub enum NativeWorkspaceListDispatchOutcome {
    FreshResolved {
        accepted: DeviceWorkspaceListEvent,
        terminal: DeviceWorkspaceListEvent,
    },
    AcceptedInFlight {
        accepted: DeviceWorkspaceListEvent,
    },
    RecoveredUnknownOutcome {
        accepted: DeviceWorkspaceListEvent,
        terminal: DeviceWorkspaceListEvent,
    },
    TerminalReplay {
        accepted: DeviceWorkspaceListEvent,
        terminal: DeviceWorkspaceListEvent,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeWorkspaceReconnectItem {
    pub execution_id: String,
    pub events: Vec<DeviceWorkspaceListEvent>,
    pub acknowledged_through: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeWorkspaceReconnectPage {
    pub items: Vec<NativeWorkspaceReconnectItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone)]
pub struct NativeWorkspaceListOrchestrator {
    journal: DeviceWorkspaceJournal,
    now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

static PROCESS_RUNNING_EXECUTIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

impl NativeWorkspaceListOrchestrator {
    pub fn new(journal: DeviceWorkspaceJournal) -> Self {
        Self::with_clock(journal, Utc::now)
    }

    /// Installs the trusted Native clock used for admission and event time.
    pub fn with_clock(
        journal: DeviceWorkspaceJournal,
        now: impl Fn() -> DateTime<Utc> + Send + Sync + 'static,
    ) -> Self {
        Self {
            journal,
            now: Arc::new(now),
        }
    }

    pub async fn dispatch_workspace_list(
        &self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        registry: &WorkspaceDirectoryRegistry,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<NativeWorkspaceListDispatchOutcome, NativeDeviceAdmissionError> {
        self.dispatch_workspace_list_with_accepted_observer(
            connection,
            command_frame,
            registry,
            cancellation,
            |_| {},
        )
        .await
    }

    /// Observes a freshly committed accepted event before handle acquisition.
    ///
    /// The observer is synchronous and infallible so transport availability
    /// cannot roll back journal authority. It receives no command or path
    /// material. Replay outcomes are returned directly and do not invoke it.
    pub async fn dispatch_workspace_list_with_accepted_observer<Observer>(
        &self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        registry: &WorkspaceDirectoryRegistry,
        cancellation: &WorkspaceListCancellation,
        observer: Observer,
    ) -> Result<NativeWorkspaceListDispatchOutcome, NativeDeviceAdmissionError>
    where
        Observer: FnOnce(&DeviceWorkspaceListEvent),
    {
        self.dispatch_workspace_list_with_executor(
            connection,
            command_frame,
            registry,
            cancellation,
            observer,
            execute_admitted_workspace_list,
        )
        .await
    }

    pub async fn acknowledge(
        &self,
        ack: &DeviceWorkspaceListAck,
    ) -> Result<AcknowledgeWorkspaceListOutcome, NativeDeviceAdmissionError> {
        self.journal
            .acknowledge_workspace_list(ack)
            .await
            .map_err(from_journal)
    }

    pub async fn reconnect_page(
        &self,
        query: &WorkspaceJournalListQuery,
    ) -> Result<NativeWorkspaceReconnectPage, NativeDeviceAdmissionError> {
        let page = self
            .journal
            .list_unacknowledged_workspace_lists(query)
            .await
            .map_err(from_journal)?;
        let items = page
            .executions
            .into_iter()
            .map(project_unacknowledged)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(NativeWorkspaceReconnectPage {
            items,
            next_cursor: page.next_cursor,
        })
    }

    async fn dispatch_workspace_list_with_executor<'registry, Observer, Execute>(
        &self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        registry: &'registry WorkspaceDirectoryRegistry,
        cancellation: &WorkspaceListCancellation,
        observer: Observer,
        execute: Execute,
    ) -> Result<NativeWorkspaceListDispatchOutcome, NativeDeviceAdmissionError>
    where
        Observer: FnOnce(&DeviceWorkspaceListEvent),
        Execute: FnOnce(
            AdmittedWorkspaceList<'registry>,
            &WorkspaceListCancellation,
        ) -> Result<DeviceWorkspaceListResult, NativeDeviceAdmissionError>,
    {
        let command = parse_command_frame(command_frame)?;
        let prepared = self
            .journal
            .prepare_workspace_list_with_admission(&command, || {
                let now = (self.now)();
                let verified = connection.verify_workspace_list_command(command_frame, now)?;
                let verified_command =
                    connection.admit_workspace_list_metadata(verified, now, registry)?;
                if verified_command != command {
                    return Err(NativeDeviceAdmissionError::new(
                        "device_workspace_command_authority_mismatch",
                    ));
                }
                let accepted = accepted_event(
                    &verified_command,
                    connection.accepted_connection().connection_epoch,
                    now,
                );
                let running = reserve_running(&verified_command.execution_id)?;
                Ok((accepted, (verified_command, running)))
            })
            .await;
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(PrepareWorkspaceListWithAdmissionError::Admission(error)) => return Err(error),
            Err(PrepareWorkspaceListWithAdmissionError::Journal(error)) => {
                return Err(from_journal(error));
            }
        };
        match prepared {
            PrepareWorkspaceListWithAdmissionOutcome::AcceptedReplay(execution) => {
                let is_running = running_executions()
                    .lock()
                    .map_err(|_| {
                        NativeDeviceAdmissionError::new("device_workspace_single_flight_poisoned")
                    })?
                    .contains(&execution.command.execution_id);
                if is_running {
                    return Ok(NativeWorkspaceListDispatchOutcome::AcceptedInFlight {
                        accepted: execution.accepted,
                    });
                }
                let outcome = self.recover_unknown(execution).await?;
                Ok(outcome)
            }
            PrepareWorkspaceListWithAdmissionOutcome::TerminalReplay(execution) => {
                terminal_replay(execution)
            }
            PrepareWorkspaceListWithAdmissionOutcome::New {
                execution,
                admitted: (command, running),
            } => {
                observer(&execution.accepted);
                let admitted = connection.acquire_workspace_list_for_durable_dispatch(
                    &command,
                    (self.now)(),
                    registry,
                    cancellation,
                );
                let terminal = match admitted {
                    Err(_) => unknown_terminal(&execution, (self.now)())?,
                    Ok(admitted) => match execute(admitted, cancellation) {
                        Ok(result) => {
                            if connection
                                .validate_workspace_list_continuation(&command, (self.now)())
                                .is_err()
                            {
                                unknown_terminal(&execution, (self.now)())?
                            } else {
                                completed_terminal(&execution, result, (self.now)())?
                            }
                        }
                        Err(error) => failed_terminal(&execution, &error, (self.now)())?,
                    },
                };
                let recorded = self.record_terminal_authority(&terminal).await?;
                drop(running);
                match recorded {
                    TerminalAuthority::Proposed(resolved) => {
                        Ok(NativeWorkspaceListDispatchOutcome::FreshResolved {
                            accepted: resolved.accepted,
                            terminal: required_terminal(resolved.terminal)?,
                        })
                    }
                    TerminalAuthority::Existing(resolved) => terminal_replay(resolved),
                }
            }
        }
    }

    async fn recover_unknown(
        &self,
        execution: WorkspaceJournalExecution,
    ) -> Result<NativeWorkspaceListDispatchOutcome, NativeDeviceAdmissionError> {
        let terminal = unknown_terminal(&execution, (self.now)())?;
        match self.record_terminal_authority(&terminal).await? {
            TerminalAuthority::Proposed(resolved) => Ok(
                NativeWorkspaceListDispatchOutcome::RecoveredUnknownOutcome {
                    accepted: resolved.accepted,
                    terminal: required_terminal(resolved.terminal)?,
                },
            ),
            TerminalAuthority::Existing(resolved) => terminal_replay(resolved),
        }
    }

    async fn record_terminal_authority(
        &self,
        terminal: &DeviceWorkspaceListEvent,
    ) -> Result<TerminalAuthority, NativeDeviceAdmissionError> {
        match self.journal.record_terminal(terminal).await {
            Ok(outcome) => Ok(TerminalAuthority::Proposed(match outcome {
                RecordTerminalOutcome::Committed(execution)
                | RecordTerminalOutcome::Replayed(execution) => execution,
            })),
            Err(error) if error.code() == "device_journal_terminal_conflict" => {
                let execution_id = match terminal {
                    DeviceWorkspaceListEvent::Accepted { envelope, .. }
                    | DeviceWorkspaceListEvent::Completed { envelope, .. }
                    | DeviceWorkspaceListEvent::Failed { envelope, .. }
                    | DeviceWorkspaceListEvent::Canceled { envelope, .. }
                    | DeviceWorkspaceListEvent::UnknownOutcome { envelope, .. } => {
                        &envelope.execution_id
                    }
                };
                let execution = self
                    .journal
                    .get_workspace_list(execution_id)
                    .await
                    .map_err(from_journal)?
                    .ok_or_else(|| {
                        NativeDeviceAdmissionError::new("device_journal_authority_corrupt")
                    })?;
                if execution.terminal.is_none() {
                    return Err(NativeDeviceAdmissionError::new(
                        "device_journal_authority_corrupt",
                    ));
                }
                Ok(TerminalAuthority::Existing(execution))
            }
            Err(error) => Err(from_journal(error)),
        }
    }
}

struct RunningExecution {
    execution_id: String,
}

enum TerminalAuthority {
    Proposed(WorkspaceJournalExecution),
    Existing(WorkspaceJournalExecution),
}

impl Drop for RunningExecution {
    fn drop(&mut self) {
        if let Ok(mut running) = running_executions().lock() {
            running.remove(&self.execution_id);
        }
    }
}

fn reserve_running(execution_id: &str) -> Result<RunningExecution, NativeDeviceAdmissionError> {
    let inserted = running_executions()
        .lock()
        .map_err(|_| NativeDeviceAdmissionError::new("device_workspace_single_flight_poisoned"))?
        .insert(execution_id.to_string());
    if !inserted {
        return Err(NativeDeviceAdmissionError::new(
            "device_workspace_single_flight_conflict",
        ));
    }
    Ok(RunningExecution {
        execution_id: execution_id.to_string(),
    })
}

fn running_executions() -> &'static Mutex<HashSet<String>> {
    PROCESS_RUNNING_EXECUTIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn project_unacknowledged(
    execution: WorkspaceJournalExecution,
) -> Result<NativeWorkspaceReconnectItem, NativeDeviceAdmissionError> {
    let mut events = Vec::with_capacity(2);
    if execution.acknowledged_through < 1 {
        events.push(execution.accepted);
    }
    if execution.acknowledged_through < 2
        && let Some(terminal) = execution.terminal
    {
        events.push(terminal);
    }
    if events.is_empty() {
        return Err(NativeDeviceAdmissionError::new(
            "device_journal_authority_corrupt",
        ));
    }
    Ok(NativeWorkspaceReconnectItem {
        execution_id: execution.command.execution_id,
        events,
        acknowledged_through: execution.acknowledged_through,
    })
}

fn terminal_replay(
    execution: WorkspaceJournalExecution,
) -> Result<NativeWorkspaceListDispatchOutcome, NativeDeviceAdmissionError> {
    Ok(NativeWorkspaceListDispatchOutcome::TerminalReplay {
        accepted: execution.accepted,
        terminal: required_terminal(execution.terminal)?,
    })
}

fn required_terminal(
    terminal: Option<DeviceWorkspaceListEvent>,
) -> Result<DeviceWorkspaceListEvent, NativeDeviceAdmissionError> {
    terminal.ok_or_else(|| NativeDeviceAdmissionError::new("device_journal_authority_corrupt"))
}

fn parse_command_frame(
    frame: &[u8],
) -> Result<DeviceWorkspaceListCommand, NativeDeviceAdmissionError> {
    if frame.is_empty() || frame.len() > MAX_DEVICE_COMMAND_BYTES {
        return Err(NativeDeviceAdmissionError::new(
            "device_workspace_command_invalid",
        ));
    }
    let value = serde_json::from_slice(frame).map_err(|error| {
        NativeDeviceAdmissionError::with_source("device_workspace_command_invalid", error)
    })?;
    parse_device_workspace_list_command(value)
        .map_err(|error| NativeDeviceAdmissionError::with_source(error.code, error))
}

fn from_journal(error: DeviceJournalError) -> NativeDeviceAdmissionError {
    NativeDeviceAdmissionError::with_source(error.code(), error)
}

#[cfg(test)]
#[path = "workspace_list_journal_orchestrator_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "workspace_list_journal_recovery_tests.rs"]
mod recovery_tests;
