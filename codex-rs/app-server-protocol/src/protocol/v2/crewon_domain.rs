use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use ts_rs::TS;

use super::Turn;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentListParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentSaveParams {
    pub cwd: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentCreateParams {
    pub cwd: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentUpdateParams {
    pub cwd: String,
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentReadParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub agent_id: Option<String>,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentRecruitableListParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub existing_agent_ids: Option<Vec<String>>,
    #[ts(optional = nullable)]
    pub existing_names: Option<Vec<String>>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentListResponse {
    pub data: Vec<CrewonDomainConfigRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentSaveResponse {
    pub file_path: String,
    pub agent_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentCreateResponse {
    pub file_path: String,
    pub agent_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentUpdateResponse {
    pub file_path: String,
    pub agent_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentReadResponse {
    pub record: Option<CrewonDomainConfigRecord>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentRecruitableListResponse {
    pub data: Vec<CrewonDomainConfigRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentDeleteParams {
    pub cwd: String,
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AgentDeleteResponse {
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeListParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeSaveParams {
    pub cwd: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeCreateParams {
    pub cwd: String,
    pub title: String,
    #[ts(optional = nullable)]
    pub subtitle: Option<String>,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub goal: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeListResponse {
    pub data: Vec<CrewonDomainConfigRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeSaveResponse {
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeCreateResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum OfficeManagerEnsureStatus {
    Created,
    ReusedServerOwned,
    ReusedLegacy,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeManagerEnsureParams {
    pub cwd: String,
    pub office_record_id: String,
    pub expected_record_revision: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeManagerEnsureResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub thread_id: String,
    pub status: OfficeManagerEnsureStatus,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeReadParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub title: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeReadResponse {
    pub record: Option<CrewonDomainConfigRecord>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMessageSendParams {
    pub cwd: String,
    pub config: JsonValue,
    pub message: JsonValue,
    #[ts(optional = nullable)]
    pub text: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub workspace: Option<JsonValue>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMessageSendResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunParams {
    pub cwd: String,
    pub config: JsonValue,
    pub message: JsonValue,
    pub text: String,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub thread_id: String,
    pub run_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunSyncParams {
    pub cwd: String,
    pub config: JsonValue,
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    pub turn: Turn,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunSyncResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemoryListParams {
    pub cwd: String,
    pub config: JsonValue,
    #[ts(optional = nullable)]
    pub status: Option<String>,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemoryDecideParams {
    pub cwd: String,
    pub config: JsonValue,
    pub memory_id: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemoryRecord {
    pub id: String,
    pub office_key: String,
    pub scope: String,
    pub member: Option<String>,
    pub agent_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub confidence: String,
    pub importance: String,
    pub status: String,
    pub evidence_refs: Vec<OfficeMemoryEvidenceRef>,
    pub keywords: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_used_at: Option<String>,
    pub usage_count: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemoryEvidenceRef {
    pub run_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemoryListResponse {
    pub data: Vec<OfficeMemoryRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemoryDecideResponse {
    pub memory: OfficeMemoryRecord,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemberContextPreviewParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    #[ts(optional = nullable)]
    pub task: Option<String>,
    #[ts(optional = nullable)]
    pub member: Option<String>,
    #[ts(optional = nullable)]
    pub agent_id: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemberContextPreviewResponse {
    pub run_id: String,
    pub member: String,
    pub agent_id: String,
    pub thread_id: String,
    pub context_policy: String,
    pub memory_scope: String,
    pub agent_profile: String,
    pub shared_context: String,
    pub memory_context: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunUpdatedNotification {
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
pub struct OfficeRunCancelParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub turn_id: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunCancelResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationCancelParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    pub delegation_id: String,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub turn_id: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationCancelResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationRetryParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    pub delegation_id: String,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationRetryResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub run_id: String,
    pub delegation_id: String,
    pub retry_of_delegation_id: String,
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeVerificationCancelParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    pub verification_check_id: String,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub turn_id: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeVerificationCancelResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeVerificationRetryParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    pub verification_check_id: String,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeVerificationRetryResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub run_id: String,
    pub verification_check_id: String,
    pub automation_id: String,
    pub automation_run_file_path: String,
    pub automation_run_id: String,
    pub retry_of_automation_turn_id: Option<String>,
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunRetryParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    #[ts(optional = nullable)]
    pub message: Option<JsonValue>,
    #[ts(optional = nullable)]
    pub text: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeRunRetryResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub thread_id: String,
    pub run_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationDispatchParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    pub task: String,
    #[ts(optional = nullable)]
    pub member: Option<String>,
    #[ts(optional = nullable)]
    pub agent_id: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationDispatchResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub run_id: String,
    pub delegation_id: String,
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationDispatchNextParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    #[ts(optional = nullable)]
    pub dispatch_policy: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDelegationDispatchNextResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub run_id: String,
    pub delegation_id: String,
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeVerificationDispatchNextParams {
    pub cwd: String,
    pub config: JsonValue,
    pub run_id: String,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeVerificationDispatchNextResponse {
    pub file_path: String,
    pub config: JsonValue,
    pub run_id: String,
    pub verification_check_id: String,
    pub automation_id: String,
    pub automation_run_file_path: String,
    pub automation_run_id: String,
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemberAddParams {
    pub cwd: String,
    pub config: JsonValue,
    pub agent_id: String,
    pub member: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeMemberAddResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum OfficeApprovalDecision {
    Approved,
    Denied,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeApprovalDecideParams {
    pub cwd: String,
    pub config: JsonValue,
    pub approval_id: String,
    pub decision: OfficeApprovalDecision,
    #[ts(optional = nullable)]
    pub message: Option<JsonValue>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeApprovalDecideResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeArtifactUpsertParams {
    pub cwd: String,
    pub config: JsonValue,
    pub artifact: JsonValue,
    #[ts(optional = nullable)]
    pub message: Option<JsonValue>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeArtifactUpsertResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDeleteParams {
    pub cwd: String,
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct OfficeDeleteResponse {
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationListParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationSaveParams {
    pub cwd: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationCreateParams {
    pub cwd: String,
    pub title: String,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub target_office: Option<JsonValue>,
    #[ts(optional = nullable)]
    pub execution_agent: Option<JsonValue>,
    #[ts(optional = nullable)]
    pub prompt: Option<String>,
    #[ts(optional = nullable)]
    pub enabled: Option<bool>,
    #[ts(optional = nullable)]
    pub status: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationReadParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub file_path: Option<String>,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub title: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationUpdateParams {
    pub cwd: String,
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationListResponse {
    pub data: Vec<CrewonDomainConfigRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationSaveResponse {
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationCreateResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationReadResponse {
    pub record: Option<CrewonDomainConfigRecord>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationUpdateResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunParams {
    pub cwd: String,
    pub config: JsonValue,
    #[ts(optional = nullable)]
    pub note: Option<String>,
    #[ts(optional = nullable)]
    pub turn_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunStartParams {
    pub cwd: String,
    pub config: JsonValue,
    #[ts(optional = nullable)]
    pub note: Option<String>,
    #[ts(optional = nullable)]
    pub locale: Option<String>,
    #[ts(optional = nullable)]
    pub client_user_message_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunRecord {
    pub run_id: String,
    pub automation_title: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub note: Option<String>,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunResponse {
    pub file_path: String,
    pub run: AutomationRunRecord,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunStartResponse {
    pub file_path: String,
    pub run: AutomationRunRecord,
    pub thread_id: String,
    pub turn: Turn,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunUpdateParams {
    pub cwd: String,
    pub file_path: String,
    pub status: String,
    #[ts(optional = nullable)]
    pub completed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunUpdateResponse {
    pub file_path: String,
    pub run: AutomationRunRecord,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunsListParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub thread_id: Option<String>,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRunsListResponse {
    pub data: Vec<CrewonAutomationRunConfigRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationDeleteParams {
    pub cwd: String,
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationDeleteResponse {
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ToolConfigKind {
    Mcp,
    Skill,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolListParams {
    pub cwd: String,
    #[ts(optional = nullable)]
    pub kind: Option<ToolConfigKind>,
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolSaveParams {
    pub cwd: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolReadParams {
    pub cwd: String,
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolUpdateParams {
    pub cwd: String,
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolListResponse {
    pub data: Vec<CrewonToolConfigRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolSaveResponse {
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolReadResponse {
    pub record: Option<CrewonToolConfigRecord>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolUpdateResponse {
    pub file_path: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolDeleteParams {
    pub cwd: String,
    pub file_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ToolDeleteResponse {
    pub deleted: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct CrewonDomainConfigRecord {
    pub file_path: String,
    pub saved_at: String,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct CrewonToolConfigRecord {
    pub file_path: String,
    pub saved_at: String,
    pub kind: ToolConfigKind,
    pub config: JsonValue,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct CrewonAutomationRunConfigRecord {
    pub file_path: String,
    pub saved_at: i64,
    pub run: AutomationRunRecord,
}
