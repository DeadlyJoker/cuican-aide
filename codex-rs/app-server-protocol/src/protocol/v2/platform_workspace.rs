use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use super::WorkspaceRef;
use super::WorkspaceScope;

/// How the current transport may access server-registered workspace roots.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum WorkspaceAccessMode {
    LocalProcessServerRoots,
    RemoteServerRoots,
}

/// Current availability of a root already registered in this connection session.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum WorkspaceAvailability {
    Available,
    Missing,
    Unreadable,
}

/// Path-free projection of one server-registered workspace root.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkspaceSummary {
    pub workspace_key: String,
    pub display_name: String,
    pub node_id: String,
    pub environment_id: String,
    pub availability: WorkspaceAvailability,
}

/// Paginated request for roots already registered by app-server configuration.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct WorkspaceListParams {
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

/// Path-free workspace roots visible to the current connection session.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkspaceListResponse {
    pub data: Vec<WorkspaceSummary>,
    pub next_cursor: Option<String>,
    pub access_mode: WorkspaceAccessMode,
}

/// Request to bind one session workspace key to a domain scope.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct WorkspaceBindParams {
    pub workspace_key: String,
    pub scope: WorkspaceScope,
    pub scope_id: String,
}

/// Server-derived scope binding for a registered workspace root.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkspaceBindResponse {
    pub workspace: WorkspaceRef,
}
