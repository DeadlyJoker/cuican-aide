//! Minimal native execution boundary for CrewON Device connections.
//!
//! This crate owns platform execution admission only. Product state, model
//! orchestration, approvals and database authority remain outside this crate.

mod connection_epoch_fence;
mod native_connection;

pub use connection_epoch_fence::AcceptedGatewayConnection;
pub use connection_epoch_fence::ConnectionEpochFence;
pub use connection_epoch_fence::ConnectionEpochFenceError;
pub use native_connection::DeviceCommandAuthorizer;
pub use native_connection::NativeDeviceAdmissionError;
pub use native_connection::NativeDeviceConnection;
pub use native_connection::TrustedDeviceCommandKey;
pub use native_connection::VerifiedDeviceCommand;
