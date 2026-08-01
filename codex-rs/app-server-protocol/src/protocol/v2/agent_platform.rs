use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use ts_rs::TS;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPlatformAuthParams {
    pub access_token: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPlatformAgentParams {
    pub access_token: String,
    pub agent_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct AgentPlatformWorkflowInfoParams {
    pub access_token: String,
    pub workflow_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct AgentPlatformWorkflowExecuteParams {
    pub access_token: String,
    pub workflow_id: String,
    pub input: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPlatformUser {
    pub id: i64,
    pub username: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPlatformAuthResponse {
    pub user: AgentPlatformUser,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPlatformAgentInfoResponse {
    pub id: i64,
    pub uid: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub max_concurrency: u32,
    pub active_connections: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPlatformWorkflowInfoResponse {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub is_published: i64,
    pub version: i64,
    pub input_variables: Vec<JsonValue>,
    pub max_concurrency: u32,
    pub active_connections: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentPlatformWorkflowExecuteResponse {
    pub workflow_id: i64,
    pub execution_id: i64,
    pub status: String,
    pub outputs: JsonValue,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub executed_nodes: Vec<JsonValue>,
    pub node_results: JsonValue,
    pub error: Option<String>,
    pub active_connections: u32,
}
