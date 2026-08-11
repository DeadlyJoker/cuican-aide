use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use chrono::DateTime;
use chrono::Utc;
use crewon_device_journal::AcknowledgeFilesystemReadOutcome;
use crewon_device_journal::DeviceJournalError;
use crewon_device_journal::DeviceWorkspaceJournal;
use crewon_device_journal::FilesystemReadJournalExecution;
use crewon_device_journal::FilesystemReadJournalListQuery;
use crewon_device_journal::PrepareFilesystemReadWithAdmissionError;
use crewon_device_journal::PrepareFilesystemReadWithAdmissionOutcome;
use crewon_device_journal::RecordFilesystemReadTerminalOutcome;
use crewon_device_protocol::DeviceFilesystemReadAck;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::MAX_DEVICE_COMMAND_BYTES;
use crewon_device_protocol::parse_device_filesystem_read_command;

use crate::NativeDeviceAdmissionError;
use crate::NativeDeviceConnection;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::filesystem_read_journal_events::accepted_event;
use crate::filesystem_read_journal_events::completed_terminal;
use crate::filesystem_read_journal_events::failed_terminal;
use crate::filesystem_read_journal_events::unknown_terminal;

#[derive(Debug, Clone, PartialEq)]
pub enum NativeFilesystemReadDispatchOutcome {
    FreshResolved { accepted: DeviceFilesystemReadEvent, terminal: DeviceFilesystemReadEvent },
    AcceptedInFlight { accepted: DeviceFilesystemReadEvent },
    RecoveredUnknownOutcome { accepted: DeviceFilesystemReadEvent, terminal: DeviceFilesystemReadEvent },
    TerminalReplay { accepted: DeviceFilesystemReadEvent, terminal: DeviceFilesystemReadEvent },
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeFilesystemReadReconnectItem {
    pub execution_id: String,
    pub events: Vec<DeviceFilesystemReadEvent>,
    pub acknowledged_through: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativeFilesystemReadReconnectPage {
    pub items: Vec<NativeFilesystemReadReconnectItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone)]
pub struct NativeFilesystemReadOrchestrator {
    journal: DeviceWorkspaceJournal,
    now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

impl NativeFilesystemReadOrchestrator {
    pub fn new(journal: DeviceWorkspaceJournal) -> Self {
        Self::with_clock(journal, Utc::now)
    }

    pub fn with_clock(
        journal: DeviceWorkspaceJournal,
        now: impl Fn() -> DateTime<Utc> + Send + Sync + 'static,
    ) -> Self {
        Self { journal, now: Arc::new(now) }
    }

    pub async fn dispatch_with_accepted_observer<Observer>(
        &self,
        connection: &NativeDeviceConnection<'_>,
        command_frame: &[u8],
        registry: &WorkspaceDirectoryRegistry,
        cancellation: &WorkspaceListCancellation,
        observer: Observer,
    ) -> Result<NativeFilesystemReadDispatchOutcome, NativeDeviceAdmissionError>
    where
        Observer: FnOnce(&DeviceFilesystemReadEvent),
    {
        if command_frame.is_empty() || command_frame.len() > MAX_DEVICE_COMMAND_BYTES {
            return Err(NativeDeviceAdmissionError::new("device_command_too_large"));
        }
        let command = parse_device_filesystem_read_command(
            serde_json::from_slice(command_frame)
                .map_err(|_| NativeDeviceAdmissionError::new("device_filesystem_read_command_invalid"))?,
        )
        .map_err(NativeDeviceAdmissionError::from_protocol)?;
        let prepared = self.journal.prepare_filesystem_read_with_admission(&command, || {
            let now = (self.now)();
            let verified = connection.verify_filesystem_read_command(command_frame, now)?;
            let admitted = connection.admit_filesystem_read_metadata(verified, now, registry)?;
            if admitted != command {
                return Err(NativeDeviceAdmissionError::new("device_workspace_command_authority_mismatch"));
            }
            let running = Running::reserve(&command.command.execution_id)?;
            let accepted = accepted_event(&command, connection.accepted_connection().connection_epoch, now)?;
            Ok((accepted, (admitted, running)))
        }).await;
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(PrepareFilesystemReadWithAdmissionError::Admission(error)) => return Err(error),
            Err(PrepareFilesystemReadWithAdmissionError::Journal(error)) => return Err(from_journal(error)),
        };
        match prepared {
            PrepareFilesystemReadWithAdmissionOutcome::AcceptedReplay(execution) => self.replay_or_recover(execution).await,
            PrepareFilesystemReadWithAdmissionOutcome::TerminalReplay(execution) => terminal_replay(execution),
            PrepareFilesystemReadWithAdmissionOutcome::New { execution, admitted: (command, running) } => {
                observer(&execution.accepted);
                let lease = connection.acquire_filesystem_read_for_durable_dispatch(
                    &command, (self.now)(), registry, cancellation,
                );
                let terminal = match lease {
                    Err(_) => unknown_terminal(&execution, (self.now)())?,
                    Ok(lease) => match lease.read(cancellation) {
                        Ok(result) if connection.validate_filesystem_read_continuation(&command, (self.now)()).is_ok() => {
                            completed_terminal(&execution, result, (self.now)())?
                        }
                        Ok(_) => unknown_terminal(&execution, (self.now)())?,
                        Err(error) => failed_terminal(&execution, &NativeDeviceAdmissionError::from_workspace(error), (self.now)())?,
                    },
                };
                let resolved = record_terminal(&self.journal, &terminal).await?;
                drop(running);
                Ok(NativeFilesystemReadDispatchOutcome::FreshResolved {
                    accepted: resolved.accepted,
                    terminal: required_terminal(resolved.terminal)?,
                })
            }
        }
    }

    pub async fn acknowledge(&self, ack: &DeviceFilesystemReadAck) -> Result<AcknowledgeFilesystemReadOutcome, NativeDeviceAdmissionError> {
        self.journal.acknowledge_filesystem_read(ack).await.map_err(from_journal)
    }

    pub async fn reconnect_page(&self, query: &FilesystemReadJournalListQuery) -> Result<NativeFilesystemReadReconnectPage, NativeDeviceAdmissionError> {
        let page = self.journal.list_unacknowledged_filesystem_reads(query).await.map_err(from_journal)?;
        let items = page.executions.into_iter().map(project).collect();
        Ok(NativeFilesystemReadReconnectPage { items, next_cursor: page.next_cursor })
    }

    async fn replay_or_recover(&self, execution: FilesystemReadJournalExecution) -> Result<NativeFilesystemReadDispatchOutcome, NativeDeviceAdmissionError> {
        if execution.terminal.is_some() {
            return terminal_replay(execution);
        }
        if running().lock().map_err(|_| NativeDeviceAdmissionError::new("device_workspace_single_flight_poisoned"))?.contains(&execution.command.command.execution_id) {
            return Ok(NativeFilesystemReadDispatchOutcome::AcceptedInFlight { accepted: execution.accepted });
        }
        let terminal = unknown_terminal(&execution, (self.now)())?;
        let resolved = record_terminal(&self.journal, &terminal).await?;
        Ok(NativeFilesystemReadDispatchOutcome::RecoveredUnknownOutcome {
            accepted: resolved.accepted,
            terminal: required_terminal(resolved.terminal)?,
        })
    }
}

async fn record_terminal(journal: &DeviceWorkspaceJournal, terminal: &DeviceFilesystemReadEvent) -> Result<FilesystemReadJournalExecution, NativeDeviceAdmissionError> {
    match journal.record_filesystem_read_terminal(terminal).await.map_err(from_journal)? {
        RecordFilesystemReadTerminalOutcome::Committed(execution) | RecordFilesystemReadTerminalOutcome::Replayed(execution) => Ok(execution),
    }
}

fn terminal_replay(execution: FilesystemReadJournalExecution) -> Result<NativeFilesystemReadDispatchOutcome, NativeDeviceAdmissionError> {
    Ok(NativeFilesystemReadDispatchOutcome::TerminalReplay {
        accepted: execution.accepted,
        terminal: required_terminal(execution.terminal)?,
    })
}

fn project(execution: FilesystemReadJournalExecution) -> NativeFilesystemReadReconnectItem {
    let mut events = Vec::new();
    if execution.acknowledged_through < 1 { events.push(execution.accepted); }
    if execution.acknowledged_through < 2 && let Some(terminal) = execution.terminal { events.push(terminal); }
    NativeFilesystemReadReconnectItem { execution_id: execution.command.command.execution_id, events, acknowledged_through: execution.acknowledged_through }
}

fn required_terminal(terminal: Option<DeviceFilesystemReadEvent>) -> Result<DeviceFilesystemReadEvent, NativeDeviceAdmissionError> {
    terminal.ok_or_else(|| NativeDeviceAdmissionError::new("device_journal_authority_corrupt"))
}

fn running() -> &'static Mutex<HashSet<String>> { RUNNING.get_or_init(|| Mutex::new(HashSet::new())) }

struct Running { execution_id: String }
impl Running {
    fn reserve(execution_id: &str) -> Result<Self, NativeDeviceAdmissionError> {
        let mut guard = running().lock().map_err(|_| NativeDeviceAdmissionError::new("device_workspace_single_flight_poisoned"))?;
        if !guard.insert(execution_id.to_string()) { return Err(NativeDeviceAdmissionError::new("device_workspace_execution_in_flight")); }
        Ok(Self { execution_id: execution_id.to_string() })
    }
}
impl Drop for Running { fn drop(&mut self) { if let Ok(mut guard) = running().lock() { guard.remove(&self.execution_id); } } }

fn from_journal(error: DeviceJournalError) -> NativeDeviceAdmissionError {
    NativeDeviceAdmissionError::with_source(error.code(), error)
}
