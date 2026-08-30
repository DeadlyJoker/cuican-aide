use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use ts_rs::TS;

use super::CrewonDomainConfigRecord;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type", rename_all = "camelCase", export_to = "v2/")]
pub enum WorkflowNodeDefinition {
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    Agent {
        title: String,
        agent_id: String,
        agent_name: String,
        instruction: String,
    },
    #[serde(rename_all = "camelCase")]
    #[ts(rename_all = "camelCase")]
    HumanGate { title: String, instruction: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowListParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowCreateParams {
    pub cwd: String,
    pub name: String,
    pub description: String,
    pub lead: String,
    pub nodes: Vec<WorkflowNodeDefinition>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowReadParams {
    pub cwd: String,
    pub workflow_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowRunParams {
    pub cwd: String,
    pub workflow_id: String,
    pub input: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase", export_to = "v2/")]
pub enum WorkflowGateDecision {
    Approve,
    Reject,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowGateResolveParams {
    pub cwd: String,
    pub workflow_id: String,
    pub execution_id: String,
    pub node_id: String,
    pub decision: WorkflowGateDecision,
    #[ts(optional = nullable)]
    pub comment: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowRunCancelParams {
    pub cwd: String,
    pub workflow_id: String,
    pub execution_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowDeleteParams {
    pub cwd: String,
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowListResponse {
    pub data: Vec<CrewonDomainConfigRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowCreateResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowReadResponse {
    pub record: Option<CrewonDomainConfigRecord>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowNodeExecution {
    pub node_id: String,
    pub node_type: String,
    pub title: String,
    pub agent_id: Option<String>,
    pub status: String,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowRunResponse {
    pub execution_id: String,
    pub workflow_id: String,
    pub status: String,
    pub output: String,
    pub executed_nodes: Vec<WorkflowNodeExecution>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowGateResolveResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub execution_id: String,
    pub workflow_id: String,
    pub status: String,
    pub output: String,
    pub executed_nodes: Vec<WorkflowNodeExecution>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowRunCancelResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub execution_id: String,
    pub workflow_id: String,
    pub status: String,
    pub output: String,
    pub executed_nodes: Vec<WorkflowNodeExecution>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowRunUpdatedNotification {
    pub cwd: String,
    pub file_path: String,
    pub config: JsonValue,
    pub reason: String,
    pub source_thread_id: Option<String>,
    pub source_turn_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkflowDeleteResponse {
    pub deleted: bool,
}
