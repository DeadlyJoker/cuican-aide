use crewon_scene_runtime as runtime;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SceneListParams {
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
pub enum SceneId {
    Office,
    Code,
    Design,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
pub enum LocalWritePolicy {
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
pub enum ExternalActionPolicy {
    DraftOnly,
    ConfirmEach,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
pub enum RecommendedPermission {
    AutoLocal,
    OnRequest,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
pub enum SceneContextKind {
    Workspace,
    Repository,
    Branch,
    File,
    Document,
    Thread,
    Issue,
    PullRequest,
    Calendar,
    Contact,
    DateRange,
    FigmaNode,
    Knowledge,
    Image,
    WebPage,
    Log,
    Brief,
    Brand,
    CanvasSpec,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SceneTaskContract {
    pub scene: SceneId,
    pub mode: SceneInteractionMode,
    pub deliverable: SceneDeliverable,
    pub local_write_policy: LocalWritePolicy,
    pub external_action_policy: ExternalActionPolicy,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SceneModeDescriptor {
    pub mode: SceneInteractionMode,
    pub default_contract: SceneTaskContract,
    pub allowed_deliverables: Vec<SceneDeliverable>,
    pub completion_check_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SceneContextSlotDescriptor {
    pub id: String,
    pub label_key: String,
    pub accepts: Vec<SceneContextKind>,
    pub max_items: u8,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SceneDescriptor {
    pub scene_id: SceneId,
    pub label_key: String,
    pub subtitle_key: String,
    pub placeholder_key: String,
    pub preset_version: u16,
    pub instruction_version: u16,
    pub default_mode: SceneInteractionMode,
    pub default_deliverable: SceneDeliverable,
    pub recommended_permission: RecommendedPermission,
    pub context_slots: Vec<SceneContextSlotDescriptor>,
    pub mode_specs: Vec<SceneModeDescriptor>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct SceneListResponse {
    pub data: Vec<SceneDescriptor>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[ts(tag = "kind", rename_all = "kebab-case", export_to = "v2/")]
pub enum SceneExecutionTargetSelection {
    Crewon,
    Agent { id: String },
    Team { id: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadSceneSelectionParams {
    pub scene_id: SceneId,
    #[ts(optional = nullable)]
    pub mode: Option<SceneInteractionMode>,
    #[ts(optional = nullable)]
    pub deliverable: Option<SceneDeliverable>,
    #[ts(optional = nullable)]
    pub execution_target: Option<SceneExecutionTargetSelection>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
pub enum SceneExecutionTargetKind {
    Crewon,
    Agent,
    Team,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case", export_to = "v2/")]
pub enum SceneExecutionStrategy {
    Single,
    Team,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct ThreadSceneRuntime {
    pub version: u16,
    pub preset_version: u16,
    pub instruction_version: u16,
    pub contract: SceneTaskContract,
    pub execution_target_kind: SceneExecutionTargetKind,
    pub execution_target_token: String,
    pub execution_strategy: SceneExecutionStrategy,
}

macro_rules! enum_conversion {
    ($source:ty => $target:ty { $($variant:ident),+ $(,)? }) => {
        impl From<$source> for $target {
            fn from(value: $source) -> Self {
                match value {
                    $(<$source>::$variant => Self::$variant,)+
                }
            }
        }
    };
}

enum_conversion!(runtime::SceneId => SceneId { Office, Code, Design });
enum_conversion!(runtime::SceneInteractionMode => SceneInteractionMode {
    Auto, Organize, Write, Analyze, Coordinate, Ask, Plan, Implement, Review, Explore, Refine,
    Produce, Inspect,
});
enum_conversion!(runtime::SceneDeliverable => SceneDeliverable {
    Conversation, Document, Table, ActionList, MessageDraft, KnowledgeEntry, ImplementationPlan,
    CodeChange, CodeReview, DesignDirections, DesignArtifact, DesignReview, HandoffSpec,
});
enum_conversion!(runtime::LocalWritePolicy => LocalWritePolicy { ReadOnly, WorkspaceWrite });
enum_conversion!(runtime::ExternalActionPolicy => ExternalActionPolicy { DraftOnly, ConfirmEach });
enum_conversion!(runtime::RecommendedPermission => RecommendedPermission { AutoLocal, OnRequest });
enum_conversion!(runtime::SceneContextKind => SceneContextKind {
    Workspace, Repository, Branch, File, Document, Thread, Issue, PullRequest, Calendar, Contact,
    DateRange, FigmaNode, Knowledge, Image, WebPage, Log, Brief, Brand, CanvasSpec,
});

impl From<SceneId> for runtime::SceneId {
    fn from(value: SceneId) -> Self {
        match value {
            SceneId::Office => Self::Office,
            SceneId::Code => Self::Code,
            SceneId::Design => Self::Design,
        }
    }
}

impl From<SceneInteractionMode> for runtime::SceneInteractionMode {
    fn from(value: SceneInteractionMode) -> Self {
        match value {
            SceneInteractionMode::Auto => Self::Auto,
            SceneInteractionMode::Organize => Self::Organize,
            SceneInteractionMode::Write => Self::Write,
            SceneInteractionMode::Analyze => Self::Analyze,
            SceneInteractionMode::Coordinate => Self::Coordinate,
            SceneInteractionMode::Ask => Self::Ask,
            SceneInteractionMode::Plan => Self::Plan,
            SceneInteractionMode::Implement => Self::Implement,
            SceneInteractionMode::Review => Self::Review,
            SceneInteractionMode::Explore => Self::Explore,
            SceneInteractionMode::Refine => Self::Refine,
            SceneInteractionMode::Produce => Self::Produce,
            SceneInteractionMode::Inspect => Self::Inspect,
        }
    }
}

impl From<SceneDeliverable> for runtime::SceneDeliverable {
    fn from(value: SceneDeliverable) -> Self {
        match value {
            SceneDeliverable::Conversation => Self::Conversation,
            SceneDeliverable::Document => Self::Document,
            SceneDeliverable::Table => Self::Table,
            SceneDeliverable::ActionList => Self::ActionList,
            SceneDeliverable::MessageDraft => Self::MessageDraft,
            SceneDeliverable::KnowledgeEntry => Self::KnowledgeEntry,
            SceneDeliverable::ImplementationPlan => Self::ImplementationPlan,
            SceneDeliverable::CodeChange => Self::CodeChange,
            SceneDeliverable::CodeReview => Self::CodeReview,
            SceneDeliverable::DesignDirections => Self::DesignDirections,
            SceneDeliverable::DesignArtifact => Self::DesignArtifact,
            SceneDeliverable::DesignReview => Self::DesignReview,
            SceneDeliverable::HandoffSpec => Self::HandoffSpec,
        }
    }
}

impl From<crewon_protocol::scene::SceneThreadMetadata> for ThreadSceneRuntime {
    fn from(value: crewon_protocol::scene::SceneThreadMetadata) -> Self {
        Self {
            version: value.version,
            preset_version: value.preset_version,
            instruction_version: value.instruction_version,
            contract: value.contract.into(),
            execution_target_kind: match value.execution_target_kind {
                crewon_protocol::scene::SceneExecutionTargetKind::Crewon => {
                    SceneExecutionTargetKind::Crewon
                }
                crewon_protocol::scene::SceneExecutionTargetKind::Agent => {
                    SceneExecutionTargetKind::Agent
                }
                crewon_protocol::scene::SceneExecutionTargetKind::Team => {
                    SceneExecutionTargetKind::Team
                }
            },
            execution_target_token: value.execution_target_token,
            execution_strategy: match value.execution_strategy {
                crewon_protocol::scene::SceneExecutionStrategy::Single => {
                    SceneExecutionStrategy::Single
                }
                crewon_protocol::scene::SceneExecutionStrategy::Team => {
                    SceneExecutionStrategy::Team
                }
            },
        }
    }
}

impl From<runtime::SceneTaskContract> for SceneTaskContract {
    fn from(value: runtime::SceneTaskContract) -> Self {
        Self {
            scene: value.scene.into(),
            mode: value.mode.into(),
            deliverable: value.deliverable.into(),
            local_write_policy: value.local_write_policy.into(),
            external_action_policy: value.external_action_policy.into(),
        }
    }
}

impl From<&runtime::SceneModeSpec> for SceneModeDescriptor {
    fn from(value: &runtime::SceneModeSpec) -> Self {
        Self {
            mode: value.mode.into(),
            default_contract: value.default_contract.into(),
            allowed_deliverables: value
                .allowed_deliverables
                .iter()
                .copied()
                .map(Into::into)
                .collect(),
            completion_check_ids: value
                .completion_check_ids
                .iter()
                .map(ToString::to_string)
                .collect(),
        }
    }
}

impl From<&runtime::SceneContextSlot> for SceneContextSlotDescriptor {
    fn from(value: &runtime::SceneContextSlot) -> Self {
        Self {
            id: value.id.to_string(),
            label_key: value.label_key.to_string(),
            accepts: value.accepts.iter().copied().map(Into::into).collect(),
            max_items: value.max_items,
        }
    }
}

impl From<&runtime::ScenePreset> for SceneDescriptor {
    fn from(value: &runtime::ScenePreset) -> Self {
        Self {
            scene_id: value.scene.into(),
            label_key: value.label_key.to_string(),
            subtitle_key: value.subtitle_key.to_string(),
            placeholder_key: value.placeholder_key.to_string(),
            preset_version: value.preset_version,
            instruction_version: value.instruction_version,
            default_mode: value.default_mode.into(),
            default_deliverable: value.default_deliverable.into(),
            recommended_permission: value.recommended_permission.into(),
            context_slots: value.context_slots.iter().map(Into::into).collect(),
            mode_specs: value.mode_specs.iter().map(Into::into).collect(),
        }
    }
}

#[cfg(test)]
#[path = "scene_tests.rs"]
mod tests;
