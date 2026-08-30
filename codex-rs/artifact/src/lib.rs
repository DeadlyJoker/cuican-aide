//! Bounded Artifact, Evidence, Audit, Trace, and Retention domain contracts.
//!
//! Payload persistence, SQL transactions, transports, and UI projections live
//! in adapters outside this crate.

mod audit;
mod execution_projection;
mod model;
mod trace_restore;
mod value;

pub use audit::*;
pub use execution_projection::*;
pub use model::*;
pub use value::*;
