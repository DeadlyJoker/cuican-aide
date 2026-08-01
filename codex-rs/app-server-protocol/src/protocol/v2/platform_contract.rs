//! Versioned reference types shared by CrewON platform consumers.
//!
//! These types intentionally do not define RPC methods. They establish the wire
//! vocabulary used by later identity, resource, task, and collaboration APIs
//! without exposing client-controlled authority or credential secrets.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct RequestIdentityRef {
    pub actor_id: String,
    pub tenant_id: Option<String>,
    pub space_id: Option<String>,
    pub session_id: String,
    pub trace_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum WorkspaceScope {
    Conversation,
    Office,
    Workflow,
    Automation,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct WorkspaceRef {
    pub workspace_key: String,
    pub binding_id: String,
    pub scope: WorkspaceScope,
    pub scope_id: String,
    pub node_id: String,
    pub environment_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum CredentialStatus {
    Available,
    Expired,
    Revoked,
    Unavailable,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum CredentialScope {
    User,
    Space,
    Service,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct CredentialRef {
    pub credential_id: String,
    pub provider_id: String,
    pub scope: CredentialScope,
    pub status: CredentialStatus,
    pub expires_at: Option<i64>,
    pub revision: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ProviderKind {
    Local,
    AgentPlatform,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ProviderConnectionStatus {
    Connected,
    Disconnected,
    Degraded,
}

#[derive(
    Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, JsonSchema, TS,
)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ProviderCapabilityKind {
    DurableRun,
    ResumableEvents,
    PersistentConversation,
    RemoteAgent,
    RemoteTool,
    RemoteKnowledge,
    RemoteWorkflow,
    Approval,
    ToolResult,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ProviderRef {
    pub provider_id: String,
    pub kind: ProviderKind,
    pub status: ProviderConnectionStatus,
    pub capabilities: Vec<ProviderCapabilityKind>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ResourceType {
    Agent,
    Skill,
    McpServer,
    McpTool,
    KnowledgeBase,
    Workflow,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ResourceRef {
    pub provider_id: String,
    pub resource_id: String,
    pub revision: String,
    pub resource_type: ResourceType,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ResourceBindingMode {
    RemoteReference,
    LocalSnapshot,
    LocalFork,
    ProviderManaged,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ExecutionLocation {
    LocalNode,
    Provider,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ResourceBindingRef {
    pub binding_id: String,
    pub workspace_key: String,
    pub resource: ResourceRef,
    pub mode: ResourceBindingMode,
    pub execution_location: ExecutionLocation,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum TaskAuthorityKind {
    LocalAppServer,
    CloudTaskControl,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum TaskStrategyKind {
    Single,
    Office,
    Workflow,
    Experts,
    Automation,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum TaskStatus {
    Created,
    Queued,
    Running,
    Suspended,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct TaskRef {
    pub task_id: String,
    pub authority: TaskAuthorityKind,
    pub strategy: TaskStrategyKind,
    pub status: TaskStatus,
    pub revision: u64,
    pub stream_offset: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum TaskEventType {
    Accepted,
    Started,
    Progressed,
    Suspended,
    Resumed,
    Completed,
    Failed,
    Cancelled,
    ReconcileRequired,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct TaskEventRef {
    pub event_id: String,
    pub task_id: String,
    pub attempt_id: Option<String>,
    pub worker_sequence: Option<u64>,
    pub stream_offset: u64,
    pub event_type: TaskEventType,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
    Consumed,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ApprovalRef {
    pub approval_id: String,
    pub action_digest: String,
    pub status: ApprovalStatus,
    pub expires_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ArtifactKind {
    File,
    Image,
    Report,
    Evidence,
    ToolResult,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum RetentionClass {
    Session,
    Task,
    UserManaged,
    Compliance,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ArtifactRef {
    pub artifact_id: String,
    pub task_id: String,
    pub kind: ArtifactKind,
    pub revision: u64,
    pub retention: RetentionClass,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct TeamRef {
    pub team_id: String,
    pub workspace_key: String,
    pub strategy: TaskStrategyKind,
    pub leader_agent_id: Option<String>,
    pub revision: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct AutomationRef {
    pub automation_id: String,
    pub schedule_revision: u64,
    pub next_run_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum PlatformErrorCode {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    CapabilityUnsupported,
    ProviderUnavailable,
    Timeout,
    UnknownOutcome,
    Internal,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct PlatformErrorRef {
    pub code: PlatformErrorCode,
    pub retryable: bool,
    pub trace_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct PlatformContract {
    pub schema_version: String,
    pub identity: RequestIdentityRef,
    pub workspace: WorkspaceRef,
    pub credential: CredentialRef,
    pub provider: ProviderRef,
    pub resource_binding: ResourceBindingRef,
    pub task: TaskRef,
    pub event: TaskEventRef,
    pub approval: ApprovalRef,
    pub artifact: ArtifactRef,
    pub team: TeamRef,
    pub automation: AutomationRef,
    pub error: PlatformErrorRef,
}

#[cfg(test)]
#[path = "platform_contract_tests.rs"]
mod tests;
