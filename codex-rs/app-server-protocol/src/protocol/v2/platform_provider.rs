use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use super::ExecutionLocation;
use super::ProviderCapabilityKind;
use super::ProviderConnectionStatus;
use super::ProviderKind;
use super::ResourceBindingMode;
use super::ResourceBindingRef;
use super::ResourceRef;
use super::ResourceType;
use super::WorkspaceScope;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceBindingCapability {
    pub resource_type: ResourceType,
    pub mode: ResourceBindingMode,
    pub execution_location: ExecutionLocation,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ProviderConnectionProjection {
    pub connection_id: String,
    pub provider_id: String,
    pub kind: ProviderKind,
    pub protocol_version: String,
    pub status: ProviderConnectionStatus,
    pub capabilities: Vec<ProviderCapabilityKind>,
    pub resource_capabilities: Vec<ResourceBindingCapability>,
    pub projection_etag: String,
    pub observed_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderConnectParams {
    pub provider_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ProviderConnectResponse {
    pub provider: ProviderConnectionProjection,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderReadParams {
    pub connection_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ProviderReadResponse {
    pub provider: ProviderConnectionProjection,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ResourceListParams {
    pub connection_id: String,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    #[ts(optional = nullable)]
    pub resource_type: Option<ResourceType>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceListResponse {
    pub data: Vec<ResourceRef>,
    pub next_cursor: Option<String>,
    pub provider_etag: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ResourceReadParams {
    pub connection_id: String,
    pub resource: ResourceRef,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceManifestProjection {
    pub resource: ResourceRef,
    pub schema_version: String,
    pub content_digest: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceReadResponse {
    pub manifest: ResourceManifestProjection,
    pub provider_etag: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ResourceBindParams {
    pub connection_id: String,
    pub workspace_binding_id: String,
    pub resource: ResourceRef,
    pub mode: ResourceBindingMode,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ResourceBindingStatus {
    Active,
    Unbound,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceBindingProjection {
    pub connection_id: String,
    pub binding: ResourceBindingRef,
    pub workspace_scope: WorkspaceScope,
    pub workspace_scope_id: String,
    pub status: ResourceBindingStatus,
    pub revision: u64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceBindResponse {
    pub binding: ResourceBindingProjection,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ResourceUnbindParams {
    pub binding_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceUnbindResponse {
    pub binding_id: String,
    pub status: ResourceBindingStatus,
    pub revision: u64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ProviderProjectionUpdatedNotification {
    pub provider: ProviderConnectionProjection,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceBindingUpdatedNotification {
    pub binding: ResourceBindingProjection,
}
