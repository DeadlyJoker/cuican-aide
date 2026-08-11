//! Minimal native execution boundary for CrewON Device connections.
//!
//! This crate owns platform execution admission only. Product state, model
//! orchestration, approvals and database authority remain outside this crate.

mod connection_epoch_fence;
mod native_connection;
mod native_filesystem_read;
mod filesystem_read_journal_events;
mod filesystem_read_journal_orchestrator;
mod native_runtime_binding;
mod workspace_directory;
mod workspace_file_read;
mod workspace_list_dispatcher;
mod workspace_list_journal_events;
mod workspace_list_journal_orchestrator;

#[cfg(test)]
mod workspace_list_journal_test_support;

pub use connection_epoch_fence::AcceptedGatewayConnection;
pub use connection_epoch_fence::ConnectionEpochFence;
pub use connection_epoch_fence::ConnectionEpochFenceError;
pub use native_connection::DeviceCommandAuthorizer;
pub use native_connection::NativeDeviceAdmissionError;
pub use native_connection::NativeDeviceConnection;
pub use native_connection::TrustedDeviceCommandKey;
pub use native_connection::VerifiedDeviceCommand;
pub use native_connection::VerifiedDeviceWorkspaceListCommand;
pub use native_filesystem_read::VerifiedDeviceFilesystemReadCommand;
pub use filesystem_read_journal_orchestrator::NativeFilesystemReadDispatchOutcome;
pub use filesystem_read_journal_orchestrator::NativeFilesystemReadOrchestrator;
pub use filesystem_read_journal_orchestrator::NativeFilesystemReadReconnectItem;
pub use filesystem_read_journal_orchestrator::NativeFilesystemReadReconnectPage;
pub use native_runtime_binding::NativeDeviceRuntimeBinding;
pub use workspace_directory::MAX_WORKSPACE_LIST_ENTRIES;
pub use workspace_directory::MAX_WORKSPACE_LIST_TIMEOUT;
pub use workspace_directory::MAX_WORKSPACE_NAME_BYTES;
pub use workspace_directory::MAX_WORKSPACE_OUTPUT_BYTES;
pub use workspace_directory::MAX_WORKSPACE_SCANNED_ENTRIES;
pub use workspace_directory::MAX_WORKSPACE_SCANNED_NAME_BYTES;
pub use workspace_directory::WorkspaceDirectoryBinding;
pub use workspace_directory::WorkspaceDirectoryEntry;
pub use workspace_directory::WorkspaceDirectoryEntryKind;
pub use workspace_directory::WorkspaceDirectoryError;
pub use workspace_directory::WorkspaceDirectoryListing;
pub use workspace_directory::WorkspaceDirectoryRegistry;
pub use workspace_file_read::MAX_WORKSPACE_FILE_READ_BYTES;
pub use workspace_file_read::WorkspaceFileReadResult;
pub use workspace_directory::WorkspaceListCancellation;
pub use workspace_directory::WorkspaceListLimits;
pub use workspace_directory::WorkspaceListPage;
pub use workspace_directory::WorkspaceListPageRequest;
pub use workspace_list_dispatcher::DeviceWorkspaceListResult;
pub use workspace_list_journal_orchestrator::NativeWorkspaceListDispatchOutcome;
pub use workspace_list_journal_orchestrator::NativeWorkspaceListOrchestrator;
pub use workspace_list_journal_orchestrator::NativeWorkspaceReconnectItem;
pub use workspace_list_journal_orchestrator::NativeWorkspaceReconnectPage;
