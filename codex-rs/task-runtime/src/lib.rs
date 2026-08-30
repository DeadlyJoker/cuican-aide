//! Pure Task Runtime domain for durable CrewON execution.
//!
//! Persistence, transport, Provider adapters, Core threads, and UI projection
//! are intentionally outside this crate.

mod aggregate;
mod command;
mod event;
mod execution_spec;
mod model;
mod reducer;
mod snapshot;
mod store_port;
mod value;
mod worker_port;

pub use aggregate::*;
pub use command::*;
pub use event::*;
pub use execution_spec::*;
pub use model::*;
pub use reducer::*;
pub use snapshot::*;
pub use store_port::*;
pub use value::*;
pub use worker_port::*;

#[cfg(test)]
#[path = "execution_spec_tests.rs"]
mod execution_spec_tests;

#[cfg(test)]
#[path = "aggregate_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "state_machine_tests.rs"]
mod state_machine_tests;

#[cfg(test)]
#[path = "store_port_tests.rs"]
mod store_port_tests;

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod snapshot_tests;
