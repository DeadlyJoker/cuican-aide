//! Fail-closed registration and admission primitives for server-owned dynamic tools.
//!
//! Provider v3 Tool/Knowledge execution, exact Artifact import, and the durable journal are
//! available as isolated adapters. The v1 router intentionally accepts Provider execution only;
//! configured local MCP tools remain on the existing static MCP path until a separate immutable
//! package/materialization contract exists. Production dispatch remains disabled until W2-08
//! performs the atomic authority cutover.

#![cfg_attr(
    test,
    allow(
        dead_code,
        reason = "W2-05 ports remain intentionally incomplete before P2b production composition"
    )
)]

pub(crate) mod credential_resolver;
pub(crate) mod dispatch;
pub(crate) mod execution;
pub(crate) mod ports;
pub(crate) mod provider_artifact_importer;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Provider adapter remains uncomposed until W2-08 cutover"
    )
)]
pub(crate) mod provider_executor;
pub(crate) mod registration;
pub(crate) mod state_binding_reader;
pub(crate) mod state_journal;
mod state_journal_audit;
