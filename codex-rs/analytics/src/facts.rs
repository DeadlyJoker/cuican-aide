use crate::events::AppServerRpcTransport;
use crate::events::CrewonRuntimeMetadata;
use crate::events::GuardianReviewEventParams;
use crewon_app_server_protocol::ClientRequest;
use crewon_app_server_protocol::ClientResponsePayload;
use crewon_app_server_protocol::InitializeParams;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ServerNotification;
use crewon_app_server_protocol::ServerRequest;
use crewon_app_server_protocol::ServerResponse;
use crewon_plugin::PluginTelemetryMetadata;
use crewon_protocol::config_types::ApprovalsReviewer;
use crewon_protocol::config_types::ModeKind;
use crewon_protocol::config_types::Personality;
use crewon_protocol::config_types::ReasoningSummary;
use crewon_protocol::config_types::ServiceTier;
use crewon_protocol::error::CodexErr;
use crewon_protocol::models::PermissionProfile;
use crewon_protocol::openai_models::ReasoningEffort;
use crewon_protocol::protocol::AskForApproval;
use crewon_protocol::protocol::HookEventName;
use crewon_protocol::protocol::HookRunStatus;
use crewon_protocol::protocol::HookSource;
use crewon_protocol::protocol::SessionSource;
use crewon_protocol::protocol::SkillScope;
use crewon_protocol::protocol::SubAgentSource;
use crewon_protocol::protocol::TokenUsage;
use crewon_protocol::request_permissions::RequestPermissionsResponse;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AcceptedLineFingerprint {
    pub path_hash: String,
    pub line_hash: String,
}

#[derive(Clone)]
pub struct TrackEventsContext {
    pub model_slug: String,
    pub thread_id: String,
    pub turn_id: String,
}

pub fn build_track_events_context(
    model_slug: String,
    thread_id: String,
    turn_id: String,
) -> TrackEventsContext {
    TrackEventsContext {
        model_slug,
        thread_id,
        turn_id,
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSubmissionType {
    Default,
    Queued,
}

#[derive(Clone)]
pub struct TurnResolvedConfigFact {
    pub turn_id: String,
    pub thread_id: String,
    pub num_input_images: usize,
    pub submission_type: Option<TurnSubmissionType>,
    pub ephemeral: bool,
    pub session_source: SessionSource,
    pub model: String,
    pub model_provider: String,
    pub permission_profile: PermissionProfile,
    pub permission_profile_cwd: PathBuf,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub reasoning_summary: Option<ReasoningSummary>,
    pub service_tier: Option<ServiceTier>,
    pub approval_policy: AskForApproval,
    pub approvals_reviewer: ApprovalsReviewer,
    pub sandbox_network_access: bool,
    pub collaboration_mode: ModeKind,
    pub personality: Option<Personality>,
    pub workspace_kind: Option<String>,
    pub is_first_turn: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadInitializationMode {
    New,
    Forked,
    Resumed,
}

#[derive(Clone)]
pub struct TurnTokenUsageFact {
    pub turn_id: String,
    pub thread_id: String,
    pub token_usage: TokenUsage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TurnProfile {
    pub before_first_sampling_ms: u64,
    pub sampling_ms: u64,
    pub between_sampling_overhead_ms: u64,
    pub tool_blocking_ms: u64,
    pub after_last_sampling_ms: u64,
    pub sampling_request_count: u32,
    pub sampling_retry_count: u32,
}

#[derive(Clone)]
pub struct TurnProfileFact {
    pub turn_id: String,
    pub profile: TurnProfile,
}

#[derive(Clone)]
pub struct TurnCrewonErrorFact {
    pub(crate) turn_id: String,
    pub(crate) thread_id: String,
    pub(crate) error: TurnCrewonError,
}

impl TurnCrewonErrorFact {
    pub fn from_codex_err(thread_id: String, turn_id: String, error: &CodexErr) -> Self {
        Self {
            turn_id,
            thread_id,
            error: TurnCrewonError::from_codex_err(error),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CrewonErrKind {
    TurnAborted,
    Stream,
    ContextWindowExceeded,
    ThreadNotFound,
    AgentLimitReached,
    SessionConfiguredNotFirstEvent,
    Timeout,
    RequestTimeout,
    Spawn,
    Interrupted,
    UnexpectedStatus,
    InvalidRequest,
    InvalidImageRequest,
    UsageLimitReached,
    ServerOverloaded,
    CyberPolicy,
    ResponseStreamFailed,
    ConnectionFailed,
    QuotaExceeded,
    UsageNotIncluded,
    InternalServerError,
    RetryLimit,
    InternalAgentDied,
    Sandbox,
    LandlockSandboxExecutableNotProvided,
    UnsupportedOperation,
    RefreshTokenFailed,
    Fatal,
    Io,
    Json,
    #[cfg(target_os = "linux")]
    LandlockRuleset,
    #[cfg(target_os = "linux")]
    LandlockPathFd,
    TokioJoin,
    EnvVar,
}

#[derive(Clone)]
pub(crate) struct TurnCrewonError {
    pub(crate) kind: CrewonErrKind,
    pub(crate) http_status_code: Option<u16>,
}

impl TurnCrewonError {
    fn from_codex_err(error: &CodexErr) -> Self {
        Self {
            kind: error.into(),
            http_status_code: error.http_status_code_value(),
        }
    }
}

impl From<&CodexErr> for CrewonErrKind {
    fn from(error: &CodexErr) -> Self {
        match error {
            CodexErr::TurnAborted => CrewonErrKind::TurnAborted,
            CodexErr::Stream(..) => CrewonErrKind::Stream,
            CodexErr::ContextWindowExceeded => CrewonErrKind::ContextWindowExceeded,
            CodexErr::ThreadNotFound(_) => CrewonErrKind::ThreadNotFound,
            CodexErr::AgentLimitReached { .. } => CrewonErrKind::AgentLimitReached,
            CodexErr::SessionConfiguredNotFirstEvent => {
                CrewonErrKind::SessionConfiguredNotFirstEvent
            }
            CodexErr::Timeout => CrewonErrKind::Timeout,
            CodexErr::RequestTimeout => CrewonErrKind::RequestTimeout,
            CodexErr::Spawn => CrewonErrKind::Spawn,
            CodexErr::Interrupted => CrewonErrKind::Interrupted,
            CodexErr::UnexpectedStatus(_) => CrewonErrKind::UnexpectedStatus,
            CodexErr::InvalidRequest(_) => CrewonErrKind::InvalidRequest,
            CodexErr::InvalidImageRequest() => CrewonErrKind::InvalidImageRequest,
            CodexErr::UsageLimitReached(_) => CrewonErrKind::UsageLimitReached,
            CodexErr::ServerOverloaded => CrewonErrKind::ServerOverloaded,
            CodexErr::CyberPolicy { .. } => CrewonErrKind::CyberPolicy,
            CodexErr::ResponseStreamFailed(_) => CrewonErrKind::ResponseStreamFailed,
            CodexErr::ConnectionFailed(_) => CrewonErrKind::ConnectionFailed,
            CodexErr::QuotaExceeded => CrewonErrKind::QuotaExceeded,
            CodexErr::UsageNotIncluded => CrewonErrKind::UsageNotIncluded,
            CodexErr::InternalServerError => CrewonErrKind::InternalServerError,
            CodexErr::RetryLimit(_) => CrewonErrKind::RetryLimit,
            CodexErr::InternalAgentDied => CrewonErrKind::InternalAgentDied,
            CodexErr::Sandbox(_) => CrewonErrKind::Sandbox,
            CodexErr::LandlockSandboxExecutableNotProvided => {
                CrewonErrKind::LandlockSandboxExecutableNotProvided
            }
            CodexErr::UnsupportedOperation(_) => CrewonErrKind::UnsupportedOperation,
            CodexErr::RefreshTokenFailed(_) => CrewonErrKind::RefreshTokenFailed,
            CodexErr::Fatal(_) => CrewonErrKind::Fatal,
            CodexErr::Io(_) => CrewonErrKind::Io,
            CodexErr::Json(_) => CrewonErrKind::Json,
            #[cfg(target_os = "linux")]
            CodexErr::LandlockRuleset(_) => CrewonErrKind::LandlockRuleset,
            #[cfg(target_os = "linux")]
            CodexErr::LandlockPathFd(_) => CrewonErrKind::LandlockPathFd,
            CodexErr::TokioJoin(_) => CrewonErrKind::TokioJoin,
            CodexErr::EnvVar(_) => CrewonErrKind::EnvVar,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSteerResult {
    Accepted,
    Rejected,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSteerRejectionReason {
    NoActiveTurn,
    ExpectedTurnMismatch,
    NonSteerableReview,
    NonSteerableCompact,
    EmptyInput,
    InputTooLarge,
}

#[derive(Clone)]
pub struct CrewonTurnSteerEvent {
    pub expected_turn_id: Option<String>,
    pub accepted_turn_id: Option<String>,
    pub num_input_images: usize,
    pub result: TurnSteerResult,
    pub rejection_reason: Option<TurnSteerRejectionReason>,
    pub created_at: u64,
}

#[derive(Clone, Copy, Debug)]
pub enum AnalyticsJsonRpcError {
    TurnSteer(TurnSteerRequestError),
    Input(InputError),
}

#[derive(Clone, Copy, Debug)]
pub enum TurnSteerRequestError {
    NoActiveTurn,
    ExpectedTurnMismatch,
    NonSteerableReview,
    NonSteerableCompact,
}

#[derive(Clone, Copy, Debug)]
pub enum InputError {
    Empty,
    TooLarge,
}

impl From<TurnSteerRequestError> for TurnSteerRejectionReason {
    fn from(error: TurnSteerRequestError) -> Self {
        match error {
            TurnSteerRequestError::NoActiveTurn => Self::NoActiveTurn,
            TurnSteerRequestError::ExpectedTurnMismatch => Self::ExpectedTurnMismatch,
            TurnSteerRequestError::NonSteerableReview => Self::NonSteerableReview,
            TurnSteerRequestError::NonSteerableCompact => Self::NonSteerableCompact,
        }
    }
}

impl From<InputError> for TurnSteerRejectionReason {
    fn from(error: InputError) -> Self {
        match error {
            InputError::Empty => Self::EmptyInput,
            InputError::TooLarge => Self::InputTooLarge,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SkillInvocation {
    pub skill_name: String,
    pub skill_scope: SkillScope,
    pub skill_path: PathBuf,
    pub plugin_id: Option<String>,
    pub invocation_type: InvocationType,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InvocationType {
    Explicit,
    Implicit,
}

pub struct AppInvocation {
    pub connector_id: Option<String>,
    pub app_name: Option<String>,
    pub invocation_type: Option<InvocationType>,
}

#[derive(Clone)]
pub struct SubAgentThreadStartedInput {
    pub session_id: String,
    pub thread_id: String,
    pub parent_thread_id: Option<String>,
    pub forked_from_thread_id: Option<String>,
    pub product_client_id: String,
    pub client_name: String,
    pub client_version: String,
    pub model: String,
    pub ephemeral: bool,
    pub subagent_source: SubAgentSource,
    pub created_at: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionTrigger {
    Manual,
    Auto,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionReason {
    UserRequested,
    ContextLimit,
    ModelDownshift,
    CompHashChanged,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionImplementation {
    Responses,
    ResponsesCompactionV2,
    ResponsesCompact,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionPhase {
    StandaloneTurn,
    PreTurn,
    MidTurn,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionStrategy {
    Memento,
    PrefixCompaction,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone)]
pub struct CrewonCompactionEvent {
    pub thread_id: String,
    pub turn_id: String,
    pub trigger: CompactionTrigger,
    pub reason: CompactionReason,
    pub implementation: CompactionImplementation,
    pub phase: CompactionPhase,
    pub strategy: CompactionStrategy,
    pub status: CompactionStatus,
    pub crewon_error_kind: Option<CrewonErrKind>,
    pub crewon_error_http_status_code: Option<u16>,
    pub active_context_tokens_before: i64,
    pub active_context_tokens_after: i64,
    pub retained_image_count: Option<usize>,
    pub compaction_summary_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub started_at: u64,
    pub completed_at: u64,
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalEventKind {
    Created,
    UsageAccounted,
    StatusChanged,
    Cleared,
}

#[derive(Clone)]
pub struct CrewonGoalEvent {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub goal_id: String,
    pub event_kind: GoalEventKind,
    pub goal_status: crewon_state::ThreadGoalStatus,
    pub has_token_budget: bool,
    pub cumulative_tokens_accounted: Option<i64>,
    pub cumulative_time_accounted_seconds: Option<i64>,
}

#[allow(dead_code)]
pub(crate) enum AnalyticsFact {
    Initialize {
        connection_id: u64,
        params: InitializeParams,
        product_client_id: String,
        runtime: CrewonRuntimeMetadata,
        rpc_transport: AppServerRpcTransport,
    },
    ClientRequest {
        connection_id: u64,
        request_id: RequestId,
        request: Box<ClientRequest>,
    },
    ClientResponse {
        connection_id: u64,
        request_id: RequestId,
        response: Box<ClientResponsePayload>,
    },
    ErrorResponse {
        connection_id: u64,
        request_id: RequestId,
        error: JSONRPCErrorError,
        error_type: Option<AnalyticsJsonRpcError>,
    },
    ServerRequest {
        connection_id: u64,
        request: Box<ServerRequest>,
    },
    ServerResponse {
        completed_at_ms: u64,
        response: Box<ServerResponse>,
    },
    EffectivePermissionsApprovalResponse {
        completed_at_ms: u64,
        request_id: RequestId,
        response: Box<RequestPermissionsResponse>,
    },
    ServerRequestAborted {
        completed_at_ms: u64,
        request_id: RequestId,
    },
    Notification(Box<ServerNotification>),
    // Facts that do not naturally exist on the app-server protocol surface, or
    // would require non-trivial protocol reshaping on this branch.
    Custom(CustomAnalyticsFact),
}

pub(crate) enum CustomAnalyticsFact {
    SubAgentThreadStarted(SubAgentThreadStartedInput),
    Compaction(Box<CrewonCompactionEvent>),
    Goal(Box<CrewonGoalEvent>),
    GuardianReview(Box<GuardianReviewEventParams>),
    TurnResolvedConfig(Box<TurnResolvedConfigFact>),
    TurnTokenUsage(Box<TurnTokenUsageFact>),
    TurnProfile(Box<TurnProfileFact>),
    TurnCrewonError(Box<TurnCrewonErrorFact>),
    SkillInvoked(SkillInvokedInput),
    AppMentioned(AppMentionedInput),
    AppUsed(AppUsedInput),
    HookRun(HookRunInput),
    PluginUsed(PluginUsedInput),
    PluginStateChanged(PluginStateChangedInput),
}

pub(crate) struct SkillInvokedInput {
    pub tracking: TrackEventsContext,
    pub invocations: Vec<SkillInvocation>,
}

pub(crate) struct AppMentionedInput {
    pub tracking: TrackEventsContext,
    pub mentions: Vec<AppInvocation>,
}

pub(crate) struct AppUsedInput {
    pub tracking: TrackEventsContext,
    pub app: AppInvocation,
}

pub(crate) struct HookRunInput {
    pub tracking: TrackEventsContext,
    pub hook: HookRunFact,
}

pub struct HookRunFact {
    pub event_name: HookEventName,
    pub hook_source: HookSource,
    pub status: HookRunStatus,
}

pub(crate) struct PluginUsedInput {
    pub tracking: TrackEventsContext,
    pub plugin: PluginTelemetryMetadata,
}

pub(crate) struct PluginStateChangedInput {
    pub plugin: PluginTelemetryMetadata,
    pub state: PluginState,
}

#[derive(Clone, Copy)]
pub(crate) enum PluginState {
    Installed,
    Uninstalled,
    Enabled,
    Disabled,
}
