use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use super::WorkspaceRef;

/// Server-owned Provider resource selection used when creating a new thread authority.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ThreadExecutionContextCreateParams {
    pub workspace_key: String,
}

/// Exact Provider resource binding revision attached to one thread.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadExecutionContextBindingRef {
    pub binding_id: String,
    pub revision: u64,
}

/// Path-free, secret-free projection of a thread's durable execution authority.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadExecutionContext {
    pub thread_id: String,
    pub workspace: WorkspaceRef,
    pub resource_bindings: Vec<ThreadExecutionContextBindingRef>,
    pub execution_binding: Option<ThreadExecutionContextBindingRef>,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Replace the exact Provider resource bindings of an existing thread authority.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ThreadExecutionContextUpdateParams {
    pub thread_id: String,
    pub workspace_binding_id: String,
    pub resource_binding_ids: Vec<String>,
    #[ts(optional = nullable)]
    pub execution_binding_id: Option<String>,
    pub expected_revision: u64,
}

/// Updated durable execution authority for a thread.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadExecutionContextUpdateResponse {
    pub execution_context: ThreadExecutionContext,
}
