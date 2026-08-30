//! Pure domain contracts for versioned resource discovery and binding.
//!
//! Network transports, persistence, credentials, downloads, and execution live
//! in adapters outside this crate.

mod binding;
mod model;
mod provider_port;

pub use binding::*;
pub use model::*;
pub use provider_port::*;

#[cfg(test)]
#[path = "resolver_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod snapshot_tests;
