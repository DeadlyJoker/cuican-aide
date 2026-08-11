//! Durable local authority for native workspace command delivery events.
//!
//! The journal persists protocol records and their acknowledgements. It never
//! executes workspace operations and intentionally does not repeat temporal
//! admission checks while replaying an already accepted command.

mod codec;
mod filesystem_read;
mod filesystem_read_admission;
mod filesystem_read_codec;
mod filesystem_read_listing;
mod journal;
mod listing;
mod records;
mod schema;

use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use thiserror::Error;

pub use filesystem_read::AcknowledgeFilesystemReadOutcome;
pub use filesystem_read::FilesystemReadJournalExecution;
pub use filesystem_read::PrepareFilesystemReadOutcome;
pub use filesystem_read_admission::PrepareFilesystemReadWithAdmissionError;
pub use filesystem_read_admission::PrepareFilesystemReadWithAdmissionOutcome;
pub use filesystem_read::RecordFilesystemReadTerminalOutcome;
pub use filesystem_read_listing::FilesystemReadJournalListQuery;
pub use filesystem_read_listing::FilesystemReadJournalPage;
pub use journal::DeviceWorkspaceJournal;

pub const MAX_JOURNAL_PAGE_SIZE: u16 = 100;

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceJournalExecution {
    pub command: DeviceWorkspaceListCommand,
    pub accepted: DeviceWorkspaceListEvent,
    pub terminal: Option<DeviceWorkspaceListEvent>,
    pub acknowledged_through: u64,
}

impl WorkspaceJournalExecution {
    pub fn head_sequence(&self) -> u64 {
        if self.terminal.is_some() { 2 } else { 1 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PrepareWorkspaceListOutcome {
    New(WorkspaceJournalExecution),
    AcceptedReplay(WorkspaceJournalExecution),
    TerminalReplay(WorkspaceJournalExecution),
}

#[derive(Debug)]
pub enum PrepareWorkspaceListWithAdmissionOutcome<T> {
    New {
        execution: WorkspaceJournalExecution,
        admitted: T,
    },
    AcceptedReplay(WorkspaceJournalExecution),
    TerminalReplay(WorkspaceJournalExecution),
}

#[derive(Debug)]
pub enum PrepareWorkspaceListWithAdmissionError<E> {
    Journal(DeviceJournalError),
    Admission(E),
}

#[derive(Debug, Clone, PartialEq)]
pub enum RecordTerminalOutcome {
    Committed(WorkspaceJournalExecution),
    Replayed(WorkspaceJournalExecution),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AcknowledgeWorkspaceListOutcome {
    Advanced(WorkspaceJournalExecution),
    Replayed(WorkspaceJournalExecution),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceJournalListQuery {
    pub after_execution_id: Option<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceJournalPage {
    pub executions: Vec<WorkspaceJournalExecution>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceJournalAcknowledgement {
    pub execution_id: String,
    pub through_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceJournalAcknowledgementPage {
    pub acknowledgements: Vec<WorkspaceJournalAcknowledgement>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Error)]
pub enum DeviceJournalError {
    #[error("{0}")]
    Authority(&'static str),
    #[error("device_journal_storage_failed")]
    Storage(#[source] sqlx::Error),
    #[error("device_journal_migration_failed")]
    Migration(#[source] sqlx::migrate::MigrateError),
}

impl DeviceJournalError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Authority(code) => code,
            Self::Storage(_) => "device_journal_storage_failed",
            Self::Migration(_) => "device_journal_migration_failed",
        }
    }
}

impl From<sqlx::Error> for DeviceJournalError {
    fn from(error: sqlx::Error) -> Self {
        Self::Storage(error)
    }
}

impl From<sqlx::migrate::MigrateError> for DeviceJournalError {
    fn from(error: sqlx::migrate::MigrateError) -> Self {
        Self::Migration(error)
    }
}

pub(crate) fn authority(code: &'static str) -> DeviceJournalError {
    DeviceJournalError::Authority(code)
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;

#[cfg(test)]
mod test_support;

#[cfg(test)]
#[path = "temporal_tests.rs"]
mod temporal_tests;

#[cfg(test)]
#[path = "filesystem_read_tests.rs"]
mod filesystem_read_tests;

#[cfg(test)]
#[path = "filesystem_read_listing_tests.rs"]
mod filesystem_read_listing_tests;

#[cfg(test)]
#[path = "filesystem_read_migration_tests.rs"]
mod filesystem_read_migration_tests;
