//! Minimal native execution boundary for CrewON Device connections.
//!
//! This crate owns platform execution admission only. Product state, model
//! orchestration, approvals and database authority remain outside this crate.

mod connection_epoch_fence;
mod native_connection;
mod workspace_directory;

pub use connection_epoch_fence::AcceptedGatewayConnection;
pub use connection_epoch_fence::ConnectionEpochFence;
pub use connection_epoch_fence::ConnectionEpochFenceError;
pub use native_connection::DeviceCommandAuthorizer;
pub use native_connection::NativeDeviceAdmissionError;
pub use native_connection::NativeDeviceConnection;
pub use native_connection::TrustedDeviceCommandKey;
pub use native_connection::VerifiedDeviceCommand;
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
pub use workspace_directory::WorkspaceListCancellation;
pub use workspace_directory::WorkspaceListLimits;
pub use workspace_directory::WorkspaceListPage;
pub use workspace_directory::WorkspaceListPageRequest;
