use crate::ExternalActionPolicy;
use crate::LocalWritePolicy;
use crate::RecommendedPermission;
use crate::SceneDeliverable;
use crate::SceneId;
use crate::SceneInteractionMode;
use crate::SceneTaskContract;
use serde::Deserialize;
use serde::Serialize;
use std::error::Error;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SceneContextSlot {
    pub id: &'static str,
    pub label_key: &'static str,
    pub accepts: &'static [SceneContextKind],
    pub max_items: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SceneModeSpec {
    pub mode: SceneInteractionMode,
    pub default_contract: SceneTaskContract,
    pub allowed_deliverables: &'static [SceneDeliverable],
    pub completion_check_ids: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScenePreset {
    pub scene: SceneId,
    pub label_key: &'static str,
    pub subtitle_key: &'static str,
    pub placeholder_key: &'static str,
    pub preset_version: u16,
    pub instruction_version: u16,
    pub default_mode: SceneInteractionMode,
    pub default_deliverable: SceneDeliverable,
    pub recommended_permission: RecommendedPermission,
    pub context_slots: &'static [SceneContextSlot],
    pub mode_specs: &'static [SceneModeSpec],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneContractError {
    ModeNotAvailable {
        scene: SceneId,
        mode: SceneInteractionMode,
    },
    DeliverableNotAvailable {
        scene: SceneId,
        mode: SceneInteractionMode,
        deliverable: SceneDeliverable,
    },
}

impl fmt::Display for SceneContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ModeNotAvailable { scene, mode } => {
                write!(
                    formatter,
                    "mode {mode:?} is not available for scene {scene:?}"
                )
            }
            Self::DeliverableNotAvailable {
                scene,
                mode,
                deliverable,
            } => write!(
                formatter,
                "deliverable {deliverable:?} is not available for scene {scene:?} and mode {mode:?}"
            ),
        }
    }
}

impl Error for SceneContractError {}

const fn contract(
    scene: SceneId,
    mode: SceneInteractionMode,
    deliverable: SceneDeliverable,
    local_write_policy: LocalWritePolicy,
    external_action_policy: ExternalActionPolicy,
) -> SceneTaskContract {
    SceneTaskContract {
        scene,
        mode,
        deliverable,
        local_write_policy,
        external_action_policy,
    }
}

const OFFICE_AUTO_DELIVERABLES: &[SceneDeliverable] = &[
    SceneDeliverable::Conversation,
    SceneDeliverable::Document,
    SceneDeliverable::Table,
    SceneDeliverable::ActionList,
    SceneDeliverable::MessageDraft,
    SceneDeliverable::KnowledgeEntry,
];
const CODE_AUTO_DELIVERABLES: &[SceneDeliverable] = &[
    SceneDeliverable::Conversation,
    SceneDeliverable::ImplementationPlan,
    SceneDeliverable::CodeChange,
    SceneDeliverable::CodeReview,
];
const DESIGN_AUTO_DELIVERABLES: &[SceneDeliverable] = &[
    SceneDeliverable::Conversation,
    SceneDeliverable::DesignDirections,
    SceneDeliverable::DesignArtifact,
    SceneDeliverable::HandoffSpec,
    SceneDeliverable::DesignReview,
];
const OFFICE_ORGANIZE_DELIVERABLES: &[SceneDeliverable] = &[
    SceneDeliverable::Document,
    SceneDeliverable::Table,
    SceneDeliverable::ActionList,
    SceneDeliverable::KnowledgeEntry,
];
const OFFICE_WRITE_DELIVERABLES: &[SceneDeliverable] =
    &[SceneDeliverable::Document, SceneDeliverable::MessageDraft];
const OFFICE_ANALYZE_DELIVERABLES: &[SceneDeliverable] = &[
    SceneDeliverable::Table,
    SceneDeliverable::Document,
    SceneDeliverable::ActionList,
];
const OFFICE_COORDINATE_DELIVERABLES: &[SceneDeliverable] = &[
    SceneDeliverable::ActionList,
    SceneDeliverable::MessageDraft,
    SceneDeliverable::Document,
];
const CODE_ASK_DELIVERABLES: &[SceneDeliverable] = &[SceneDeliverable::Conversation];
const CODE_PLAN_DELIVERABLES: &[SceneDeliverable] = &[SceneDeliverable::ImplementationPlan];
const CODE_IMPLEMENT_DELIVERABLES: &[SceneDeliverable] = &[SceneDeliverable::CodeChange];
const CODE_REVIEW_DELIVERABLES: &[SceneDeliverable] = &[SceneDeliverable::CodeReview];
const DESIGN_EXPLORE_DELIVERABLES: &[SceneDeliverable] = &[SceneDeliverable::DesignDirections];
const DESIGN_BUILD_DELIVERABLES: &[SceneDeliverable] = &[
    SceneDeliverable::DesignArtifact,
    SceneDeliverable::HandoffSpec,
];
const DESIGN_INSPECT_DELIVERABLES: &[SceneDeliverable] = &[SceneDeliverable::DesignReview];

const AUTO_CHECKS: &[&str] = &["common.minimal-clarification"];
const OFFICE_ORGANIZE_CHECKS: &[&str] = &[
    "office.structure",
    "office.sources",
    "office.action-ownership",
];
const OFFICE_WRITE_CHECKS: &[&str] = &[
    "office.audience",
    "office.fact-source",
    "office.ready-to-use",
];
const OFFICE_ANALYZE_CHECKS: &[&str] = &["office.method", "office.sources", "office.conclusion"];
const OFFICE_COORDINATE_CHECKS: &[&str] = &[
    "office.external-status",
    "office.owner-time",
    "office.target-state",
];
const CODE_ASK_CHECKS: &[&str] = &["code.evidence", "code.no-unrequested-write"];
const CODE_PLAN_CHECKS: &[&str] = &[
    "code.plan-scope",
    "code.plan-validation",
    "code.no-unrequested-write",
];
const CODE_IMPLEMENT_CHECKS: &[&str] = &[
    "code.rules",
    "code.diff",
    "code.validation",
    "code.user-changes",
];
const CODE_REVIEW_CHECKS: &[&str] = &["code.findings", "code.evidence", "code.no-write"];
const DESIGN_EXPLORE_CHECKS: &[&str] = &[
    "design.direction-difference",
    "design.fit",
    "design.assumptions",
];
const DESIGN_REFINE_CHECKS: &[&str] = &["design.system-reuse", "design.preview", "design.states"];
const DESIGN_PRODUCE_CHECKS: &[&str] = &["design.spec", "design.preview", "design.accessibility"];
const DESIGN_INSPECT_CHECKS: &[&str] = &["design.findings", "design.states", "design.no-write"];

const OFFICE_CONTEXT_SLOTS: &[SceneContextSlot] = &[
    SceneContextSlot {
        id: "office-sources",
        label_key: "scene.context.office-sources.label",
        accepts: &[
            SceneContextKind::Document,
            SceneContextKind::File,
            SceneContextKind::Thread,
            SceneContextKind::Knowledge,
            SceneContextKind::WebPage,
        ],
        max_items: 12,
    },
    SceneContextSlot {
        id: "office-people-time",
        label_key: "scene.context.office-people-time.label",
        accepts: &[
            SceneContextKind::Contact,
            SceneContextKind::Calendar,
            SceneContextKind::DateRange,
        ],
        max_items: 12,
    },
    SceneContextSlot {
        id: "office-coordination-target",
        label_key: "scene.context.office-coordination-target.label",
        accepts: &[
            SceneContextKind::Contact,
            SceneContextKind::Calendar,
            SceneContextKind::Document,
            SceneContextKind::Knowledge,
        ],
        max_items: 8,
    },
];
const CODE_CONTEXT_SLOTS: &[SceneContextSlot] = &[
    SceneContextSlot {
        id: "code-workspace",
        label_key: "scene.context.code-workspace.label",
        accepts: &[
            SceneContextKind::Workspace,
            SceneContextKind::Repository,
            SceneContextKind::Branch,
        ],
        max_items: 3,
    },
    SceneContextSlot {
        id: "code-targets",
        label_key: "scene.context.code-targets.label",
        accepts: &[
            SceneContextKind::File,
            SceneContextKind::Issue,
            SceneContextKind::PullRequest,
            SceneContextKind::Log,
        ],
        max_items: 16,
    },
    SceneContextSlot {
        id: "code-evidence",
        label_key: "scene.context.code-evidence.label",
        accepts: &[
            SceneContextKind::Issue,
            SceneContextKind::PullRequest,
            SceneContextKind::Log,
            SceneContextKind::WebPage,
        ],
        max_items: 12,
    },
];
const DESIGN_CONTEXT_SLOTS: &[SceneContextSlot] = &[
    SceneContextSlot {
        id: "design-brief",
        label_key: "scene.context.design-brief.label",
        accepts: &[
            SceneContextKind::Brief,
            SceneContextKind::Document,
            SceneContextKind::Thread,
        ],
        max_items: 4,
    },
    SceneContextSlot {
        id: "design-target",
        label_key: "scene.context.design-target.label",
        accepts: &[
            SceneContextKind::FigmaNode,
            SceneContextKind::Image,
            SceneContextKind::WebPage,
            SceneContextKind::File,
        ],
        max_items: 8,
    },
    SceneContextSlot {
        id: "design-brand",
        label_key: "scene.context.design-brand.label",
        accepts: &[
            SceneContextKind::Brand,
            SceneContextKind::Knowledge,
            SceneContextKind::Document,
        ],
        max_items: 4,
    },
    SceneContextSlot {
        id: "design-canvas",
        label_key: "scene.context.design-canvas.label",
        accepts: &[SceneContextKind::CanvasSpec],
        max_items: 2,
    },
];

macro_rules! mode_spec {
    ($scene:ident, $mode:ident, $deliverable:ident, $local:ident, $external:ident, $allowed:ident, $checks:ident) => {
        SceneModeSpec {
            mode: SceneInteractionMode::$mode,
            default_contract: contract(
                SceneId::$scene,
                SceneInteractionMode::$mode,
                SceneDeliverable::$deliverable,
                LocalWritePolicy::$local,
                ExternalActionPolicy::$external,
            ),
            allowed_deliverables: $allowed,
            completion_check_ids: $checks,
        }
    };
}

const OFFICE_MODES: &[SceneModeSpec] = &[
    mode_spec!(
        Office,
        Auto,
        Document,
        WorkspaceWrite,
        DraftOnly,
        OFFICE_AUTO_DELIVERABLES,
        AUTO_CHECKS
    ),
    mode_spec!(
        Office,
        Organize,
        ActionList,
        WorkspaceWrite,
        DraftOnly,
        OFFICE_ORGANIZE_DELIVERABLES,
        OFFICE_ORGANIZE_CHECKS
    ),
    mode_spec!(
        Office,
        Write,
        Document,
        WorkspaceWrite,
        DraftOnly,
        OFFICE_WRITE_DELIVERABLES,
        OFFICE_WRITE_CHECKS
    ),
    mode_spec!(
        Office,
        Analyze,
        Table,
        WorkspaceWrite,
        DraftOnly,
        OFFICE_ANALYZE_DELIVERABLES,
        OFFICE_ANALYZE_CHECKS
    ),
    mode_spec!(
        Office,
        Coordinate,
        ActionList,
        WorkspaceWrite,
        ConfirmEach,
        OFFICE_COORDINATE_DELIVERABLES,
        OFFICE_COORDINATE_CHECKS
    ),
];
const CODE_MODES: &[SceneModeSpec] = &[
    mode_spec!(
        Code,
        Auto,
        CodeChange,
        WorkspaceWrite,
        ConfirmEach,
        CODE_AUTO_DELIVERABLES,
        AUTO_CHECKS
    ),
    mode_spec!(
        Code,
        Ask,
        Conversation,
        ReadOnly,
        DraftOnly,
        CODE_ASK_DELIVERABLES,
        CODE_ASK_CHECKS
    ),
    mode_spec!(
        Code,
        Plan,
        ImplementationPlan,
        ReadOnly,
        DraftOnly,
        CODE_PLAN_DELIVERABLES,
        CODE_PLAN_CHECKS
    ),
    mode_spec!(
        Code,
        Implement,
        CodeChange,
        WorkspaceWrite,
        ConfirmEach,
        CODE_IMPLEMENT_DELIVERABLES,
        CODE_IMPLEMENT_CHECKS
    ),
    mode_spec!(
        Code,
        Review,
        CodeReview,
        ReadOnly,
        DraftOnly,
        CODE_REVIEW_DELIVERABLES,
        CODE_REVIEW_CHECKS
    ),
];
const DESIGN_MODES: &[SceneModeSpec] = &[
    mode_spec!(
        Design,
        Auto,
        DesignDirections,
        WorkspaceWrite,
        ConfirmEach,
        DESIGN_AUTO_DELIVERABLES,
        AUTO_CHECKS
    ),
    mode_spec!(
        Design,
        Explore,
        DesignDirections,
        WorkspaceWrite,
        DraftOnly,
        DESIGN_EXPLORE_DELIVERABLES,
        DESIGN_EXPLORE_CHECKS
    ),
    mode_spec!(
        Design,
        Refine,
        DesignArtifact,
        WorkspaceWrite,
        ConfirmEach,
        DESIGN_BUILD_DELIVERABLES,
        DESIGN_REFINE_CHECKS
    ),
    mode_spec!(
        Design,
        Produce,
        DesignArtifact,
        WorkspaceWrite,
        ConfirmEach,
        DESIGN_BUILD_DELIVERABLES,
        DESIGN_PRODUCE_CHECKS
    ),
    mode_spec!(
        Design,
        Inspect,
        DesignReview,
        ReadOnly,
        DraftOnly,
        DESIGN_INSPECT_DELIVERABLES,
        DESIGN_INSPECT_CHECKS
    ),
];

const PRESETS: &[ScenePreset] = &[
    ScenePreset {
        scene: SceneId::Office,
        label_key: "scene.office.label",
        subtitle_key: "scene.office.subtitle",
        placeholder_key: "scene.office.placeholder",
        preset_version: 1,
        instruction_version: 1,
        default_mode: SceneInteractionMode::Auto,
        default_deliverable: SceneDeliverable::Document,
        recommended_permission: RecommendedPermission::OnRequest,
        context_slots: OFFICE_CONTEXT_SLOTS,
        mode_specs: OFFICE_MODES,
    },
    ScenePreset {
        scene: SceneId::Code,
        label_key: "scene.code.label",
        subtitle_key: "scene.code.subtitle",
        placeholder_key: "scene.code.placeholder",
        preset_version: 1,
        instruction_version: 1,
        default_mode: SceneInteractionMode::Auto,
        default_deliverable: SceneDeliverable::CodeChange,
        recommended_permission: RecommendedPermission::AutoLocal,
        context_slots: CODE_CONTEXT_SLOTS,
        mode_specs: CODE_MODES,
    },
    ScenePreset {
        scene: SceneId::Design,
        label_key: "scene.design.label",
        subtitle_key: "scene.design.subtitle",
        placeholder_key: "scene.design.placeholder",
        preset_version: 1,
        instruction_version: 1,
        default_mode: SceneInteractionMode::Auto,
        default_deliverable: SceneDeliverable::DesignDirections,
        recommended_permission: RecommendedPermission::OnRequest,
        context_slots: DESIGN_CONTEXT_SLOTS,
        mode_specs: DESIGN_MODES,
    },
];

pub fn all_scene_presets() -> &'static [ScenePreset] {
    PRESETS
}

pub fn scene_preset(scene: SceneId) -> &'static ScenePreset {
    match scene {
        SceneId::Office => &PRESETS[0],
        SceneId::Code => &PRESETS[1],
        SceneId::Design => &PRESETS[2],
    }
}

pub fn resolve_scene_contract(
    scene: SceneId,
    mode: SceneInteractionMode,
    requested_deliverable: Option<SceneDeliverable>,
) -> Result<SceneTaskContract, SceneContractError> {
    let mode_spec = scene_preset(scene)
        .mode_specs
        .iter()
        .find(|spec| spec.mode == mode)
        .ok_or(SceneContractError::ModeNotAvailable { scene, mode })?;
    let deliverable = requested_deliverable.unwrap_or(mode_spec.default_contract.deliverable);
    if !mode_spec.allowed_deliverables.contains(&deliverable) {
        return Err(SceneContractError::DeliverableNotAvailable {
            scene,
            mode,
            deliverable,
        });
    }

    Ok(SceneTaskContract {
        deliverable,
        ..mode_spec.default_contract
    })
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;
