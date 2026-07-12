use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum SceneId {
    Office,
    Code,
    Design,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum SceneInteractionMode {
    Auto,
    Organize,
    Write,
    Analyze,
    Coordinate,
    Ask,
    Plan,
    Implement,
    Review,
    Explore,
    Refine,
    Produce,
    Inspect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum SceneDeliverable {
    Conversation,
    Document,
    Table,
    ActionList,
    MessageDraft,
    KnowledgeEntry,
    ImplementationPlan,
    CodeChange,
    CodeReview,
    DesignDirections,
    DesignArtifact,
    DesignReview,
    HandoffSpec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum LocalWritePolicy {
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum ExternalActionPolicy {
    DraftOnly,
    ConfirmEach,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum RecommendedPermission {
    AutoLocal,
    OnRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SceneTaskContract {
    pub scene: SceneId,
    pub mode: SceneInteractionMode,
    pub deliverable: SceneDeliverable,
    pub local_write_policy: LocalWritePolicy,
    pub external_action_policy: ExternalActionPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum SceneExecutionTargetKind {
    Crewon,
    Agent,
    Team,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum SceneExecutionStrategy {
    Single,
    Team,
}

/// Server-resolved scene identity persisted with a thread.
///
/// `execution_target_ref` is an internal resource reference and must be revalidated before use.
/// It is never rendered into model-visible Application context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SceneThreadMetadata {
    pub version: u16,
    pub preset_version: u16,
    pub instruction_version: u16,
    pub contract: SceneTaskContract,
    pub execution_target_kind: SceneExecutionTargetKind,
    pub execution_target_ref: Option<String>,
    pub execution_target_token: String,
    pub execution_strategy: SceneExecutionStrategy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneExecutionTargetProfile {
    pub kind: SceneExecutionTargetKind,
    pub display_name: String,
    pub role: Option<String>,
    pub model: Option<String>,
    pub instructions: Option<String>,
    pub capabilities: Vec<String>,
    pub team_members: Vec<SceneTeamMemberProfile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneTeamMemberProfile {
    pub name: String,
    pub role: Option<String>,
    pub agent_id: Option<String>,
}
