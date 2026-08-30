use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// One bounded local role in an Experts definition.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertRole {
    pub name: String,
    pub role: String,
    pub agent_type: String,
    pub instructions: Option<String>,
}

/// Path-free Experts definition owned by one subject and Conversation workspace.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamConfig {
    pub experts_id: String,
    pub title: String,
    pub goal: String,
    pub leader: ExpertRole,
    pub experts: Vec<ExpertRole>,
    pub record_revision: String,
    pub workspace_key: String,
    pub owner_subject: String,
    pub tenant_id: Option<String>,
    pub space_id: Option<String>,
}

/// Server-owned Experts record projection. The file path is never accepted in create/read params.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamRecord {
    pub file_path: String,
    pub config: ExpertTeamConfig,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamListParams {
    pub workspace_key: String,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamCreateParams {
    pub workspace_key: String,
    pub title: String,
    pub goal: String,
    pub leader: ExpertRole,
    pub experts: Vec<ExpertRole>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamReadParams {
    pub workspace_key: String,
    pub experts_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamListResponse {
    pub data: Vec<ExpertTeamRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamCreateResponse {
    pub record: ExpertTeamRecord,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ExpertTeamReadResponse {
    pub record: Option<ExpertTeamRecord>,
}
