use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crate::attestation::app_server_attestation_provider;
use crate::automation_scheduler::AutomationScheduler;
use crate::config_manager::ConfigManager;
use crate::connection_rpc_gate::ConnectionRpcGate;
use crate::error_code::internal_error;
use crate::error_code::invalid_request;
use crate::extensions::ThreadExtensionDependencies;
use crate::extensions::app_server_extension_event_sink;
use crate::extensions::guardian_agent_spawner;
use crate::extensions::thread_extensions;
use crate::fs_watch::FsWatchManager;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::ConnectionRequestId;
use crate::outgoing_message::OutgoingMessageSender;
use crate::outgoing_message::RequestContext;
use crate::request_processors::AccountRequestProcessor;
use crate::request_processors::AgentPlatformRequestProcessor;
use crate::request_processors::AppsRequestProcessor;
use crate::request_processors::CatalogRequestProcessor;
use crate::request_processors::CommandExecRequestProcessor;
use crate::request_processors::ConfigRequestProcessor;
use crate::request_processors::CrewonDomainRequestProcessor;
use crate::request_processors::EnvironmentRequestProcessor;
use crate::request_processors::ExternalAgentConfigRequestProcessor;
use crate::request_processors::FeedbackRequestProcessor;
use crate::request_processors::FsRequestProcessor;
use crate::request_processors::GitRequestProcessor;
use crate::request_processors::InitializeRequestProcessor;
use crate::request_processors::KnowledgeRequestProcessor;
use crate::request_processors::MarketplaceRequestProcessor;
use crate::request_processors::McpConfigRequestProcessor;
use crate::request_processors::McpRequestProcessor;
use crate::request_processors::OfficeAutoDispatchContext;
use crate::request_processors::OfficeMemberRuntimeThreadStart;
use crate::request_processors::OfficeVerificationDispatchStarted;
use crate::request_processors::PluginRequestProcessor;
use crate::request_processors::ProcessExecRequestProcessor;
use crate::request_processors::RemoteControlRequestProcessor;
use crate::request_processors::SearchRequestProcessor;
use crate::request_processors::ThreadGoalRequestProcessor;
use crate::request_processors::ThreadRequestProcessor;
use crate::request_processors::TurnRequestProcessor;
use crate::request_processors::WindowsSandboxRequestProcessor;
use crate::request_processors::office_run_updated_notification;
use crate::request_processors::sync_office_run_updates_for_thread_turn;
use crate::request_serialization::QueuedInitializedRequest;
use crate::request_serialization::RequestSerializationQueueKey;
use crate::request_serialization::RequestSerializationQueues;
use crate::skills_watcher::SkillsWatcher;
use crate::thread_state::ConnectionCapabilities;
use crate::thread_state::ThreadStateManager;
use crate::transport::AppServerTransport;
use crate::transport::RemoteControlHandle;
use async_trait::async_trait;
use chrono::DateTime;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_analytics::AnalyticsEventsClient;
use crewon_analytics::AppServerRpcTransport;
use crewon_app_server_protocol::AgentReadParams;
use crewon_app_server_protocol::AgentUpdateParams;
use crewon_app_server_protocol::AuthMode as LoginAuthMode;
use crewon_app_server_protocol::AutomationRunStartParams;
use crewon_app_server_protocol::AutomationRunStartResponse;
use crewon_app_server_protocol::ChatgptAuthTokensRefreshParams;
use crewon_app_server_protocol::ChatgptAuthTokensRefreshReason;
use crewon_app_server_protocol::ChatgptAuthTokensRefreshResponse;
use crewon_app_server_protocol::ClientNotification;
use crewon_app_server_protocol::ClientRequest;
use crewon_app_server_protocol::ClientResponsePayload;
use crewon_app_server_protocol::ConfigWarningNotification;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::ExperimentalApi;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::JSONRPCNotification;
use crewon_app_server_protocol::JSONRPCRequest;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::OfficeDelegationCancelResponse;
use crewon_app_server_protocol::OfficeDelegationDispatchNextResponse;
use crewon_app_server_protocol::OfficeDelegationDispatchResponse;
use crewon_app_server_protocol::OfficeDelegationRetryResponse;
use crewon_app_server_protocol::OfficeListParams;
use crewon_app_server_protocol::OfficeReadParams;
use crewon_app_server_protocol::OfficeRunCancelResponse;
use crewon_app_server_protocol::OfficeRunResponse;
use crewon_app_server_protocol::OfficeRunRetryResponse;
use crewon_app_server_protocol::OfficeRunSyncResponse;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_app_server_protocol::OfficeVerificationCancelResponse;
use crewon_app_server_protocol::OfficeVerificationDispatchNextResponse;
use crewon_app_server_protocol::OfficeVerificationRetryResponse;
use crewon_app_server_protocol::ServerRequestPayload;
use crewon_app_server_protocol::TurnInterruptParams;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::UserInput;
use crewon_app_server_protocol::experimental_required_message;
use crewon_arg0::Arg0DispatchPaths;
use crewon_chatgpt::workspace_settings;
use crewon_core::ThreadManager;
use crewon_core::config::Config;
use crewon_exec_server::EnvironmentManager;
use crewon_feedback::CrewonFeedback;
use crewon_goal_extension::GoalService;
use crewon_login::AuthManager;
use crewon_login::auth::ExternalAuth;
use crewon_login::auth::ExternalAuthRefreshContext;
use crewon_login::auth::ExternalAuthRefreshReason;
use crewon_login::auth::ExternalAuthTokens;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::SessionSource;
use crewon_protocol::protocol::W3cTraceContext;
use crewon_rollout::StateDbHandle;
use crewon_state::log_db::LogDbLayer;
use serde::Deserialize;
use serde::Serialize;
use tokio::fs;
use tokio::sync::Mutex;
use tokio::sync::Semaphore;
use tokio::sync::broadcast;
use tokio::sync::watch;
use tokio::time::Duration;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
use uuid::Uuid;

const EXTERNAL_AUTH_REFRESH_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECTION_RPC_DRAIN_TIMEOUT: Duration = Duration::from_secs(/*secs*/ 30);
const OFFICE_STARTUP_RECOVERY_CONNECTION_ID: ConnectionId = ConnectionId(u64::MAX);
const OFFICE_SCHEDULER_WORKSPACE_INDEX_DIR: &str = "office-scheduler";
const OFFICE_SCHEDULER_WORKSPACE_INDEX_FILE: &str = "workspaces.json";
const MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS: usize = 64;
const MAX_OFFICE_SCHEDULER_TARGET_THREADS: usize = 16;
const OFFICE_SCHEDULER_RECOVERY_MAX_PASSES: usize = 200;
const OFFICE_SCHEDULER_RECOVERY_IDLE_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone)]
struct ExternalAuthRefreshBridge {
    outgoing: Arc<OutgoingMessageSender>,
}

impl ExternalAuthRefreshBridge {
    fn map_reason(reason: ExternalAuthRefreshReason) -> ChatgptAuthTokensRefreshReason {
        match reason {
            ExternalAuthRefreshReason::Unauthorized => ChatgptAuthTokensRefreshReason::Unauthorized,
        }
    }
}

#[async_trait]
impl ExternalAuth for ExternalAuthRefreshBridge {
    fn auth_mode(&self) -> LoginAuthMode {
        LoginAuthMode::Chatgpt
    }

    async fn refresh(
        &self,
        context: ExternalAuthRefreshContext,
    ) -> std::io::Result<ExternalAuthTokens> {
        let params = ChatgptAuthTokensRefreshParams {
            reason: Self::map_reason(context.reason),
            previous_account_id: context.previous_account_id,
        };

        let (request_id, rx) = self
            .outgoing
            .send_request(ServerRequestPayload::ChatgptAuthTokensRefresh(params))
            .await;

        let result = match timeout(EXTERNAL_AUTH_REFRESH_TIMEOUT, rx).await {
            Ok(result) => {
                // Two failure scenarios:
                // 1) `oneshot::Receiver` failed (sender dropped) => request canceled/channel closed.
                // 2) client answered with JSON-RPC error payload => propagate code/message.
                let result = result.map_err(|err| {
                    std::io::Error::other(format!("auth refresh request canceled: {err}"))
                })?;
                result.map_err(|err| {
                    std::io::Error::other(format!(
                        "auth refresh request failed: code={} message={}",
                        err.code, err.message
                    ))
                })?
            }
            Err(_) => {
                let _canceled = self.outgoing.cancel_request(&request_id).await;
                return Err(std::io::Error::other(format!(
                    "auth refresh request timed out after {}s",
                    EXTERNAL_AUTH_REFRESH_TIMEOUT.as_secs()
                )));
            }
        };

        let response: ChatgptAuthTokensRefreshResponse =
            serde_json::from_value(result).map_err(std::io::Error::other)?;

        Ok(ExternalAuthTokens::chatgpt(
            response.access_token,
            response.chatgpt_account_id,
            response.chatgpt_plan_type,
        ))
    }
}

pub(crate) struct MessageProcessor {
    outgoing: Arc<OutgoingMessageSender>,
    codex_home: PathBuf,
    office_scheduler_recovery_running: Arc<AtomicBool>,
    skills_watcher: Arc<SkillsWatcher>,
    account_processor: AccountRequestProcessor,
    agent_platform_processor: AgentPlatformRequestProcessor,
    automation_scheduler: AutomationScheduler,
    apps_processor: AppsRequestProcessor,
    catalog_processor: CatalogRequestProcessor,
    command_exec_processor: CommandExecRequestProcessor,
    crewon_domain_processor: CrewonDomainRequestProcessor,
    process_exec_processor: ProcessExecRequestProcessor,
    config_processor: ConfigRequestProcessor,
    environment_processor: EnvironmentRequestProcessor,
    external_agent_config_processor: ExternalAgentConfigRequestProcessor,
    feedback_processor: FeedbackRequestProcessor,
    fs_processor: FsRequestProcessor,
    git_processor: GitRequestProcessor,
    initialize_processor: InitializeRequestProcessor,
    knowledge_processor: KnowledgeRequestProcessor,
    marketplace_processor: MarketplaceRequestProcessor,
    mcp_config_processor: McpConfigRequestProcessor,
    mcp_processor: McpRequestProcessor,
    plugin_processor: PluginRequestProcessor,
    remote_control_processor: RemoteControlRequestProcessor,
    search_processor: SearchRequestProcessor,
    thread_goal_processor: ThreadGoalRequestProcessor,
    thread_processor: ThreadRequestProcessor,
    turn_processor: TurnRequestProcessor,
    windows_sandbox_processor: WindowsSandboxRequestProcessor,
    request_serialization_queues: RequestSerializationQueues,
}

#[derive(Debug)]
pub(crate) struct ConnectionSessionState {
    pub(crate) rpc_gate: Arc<ConnectionRpcGate>,
    cancellation: CancellationToken,
    initialized: OnceLock<InitializedConnectionSessionState>,
}

#[derive(Debug)]
pub(crate) struct InitializedConnectionSessionState {
    pub(crate) experimental_api_enabled: bool,
    pub(crate) opted_out_notification_methods: HashSet<String>,
    pub(crate) app_server_client_name: String,
    pub(crate) client_version: String,
    pub(crate) request_attestation: bool,
}

impl Default for ConnectionSessionState {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionSessionState {
    pub(crate) fn new() -> Self {
        Self {
            rpc_gate: Arc::new(ConnectionRpcGate::new()),
            cancellation: CancellationToken::new(),
            initialized: OnceLock::new(),
        }
    }

    pub(crate) fn initialized(&self) -> bool {
        self.initialized.get().is_some()
    }

    pub(crate) fn experimental_api_enabled(&self) -> bool {
        self.initialized
            .get()
            .is_some_and(|session| session.experimental_api_enabled)
    }

    pub(crate) fn opted_out_notification_methods(&self) -> HashSet<String> {
        self.initialized
            .get()
            .map(|session| session.opted_out_notification_methods.clone())
            .unwrap_or_default()
    }

    pub(crate) fn app_server_client_name(&self) -> Option<&str> {
        self.initialized
            .get()
            .map(|session| session.app_server_client_name.as_str())
    }

    pub(crate) fn client_version(&self) -> Option<&str> {
        self.initialized
            .get()
            .map(|session| session.client_version.as_str())
    }

    pub(crate) fn request_attestation(&self) -> bool {
        self.initialized
            .get()
            .is_some_and(|session| session.request_attestation)
    }

    pub(crate) fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub(crate) fn initialize(&self, session: InitializedConnectionSessionState) -> Result<(), ()> {
        self.initialized.set(session).map_err(|_| ())
    }
}

struct OfficeRecoveryTurnRef {
    thread_id: String,
    turn_id: String,
}

struct OfficeRuntimeThreadRepairCandidate {
    agent_id: String,
    member: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeSchedulerWorkspaceIndex {
    version: u32,
    cwds: Vec<OfficeSchedulerWorkspaceEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeSchedulerWorkspaceEntry {
    cwd: String,
    updated_at: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OfficeSchedulerRecoveryOutcome {
    Idle,
    Waiting,
    Dispatched,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OfficeHistoryRecoveryOutcome {
    Idle,
    Waiting,
    Recovered,
}

const MAX_OFFICE_THREAD_CWD_RECOVERY: usize = 8;
const OFFICE_RUNTIME_REPAIR_MAX_ID_CHARS: usize = 128;
const OFFICE_RUNTIME_REPAIR_MAX_FIELD_CHARS: usize = 1_000;
const OFFICE_RUNTIME_REPAIR_MAX_INSTRUCTIONS_CHARS: usize = 4_000;
const OFFICE_RUNTIME_REPAIR_TRUNCATED_SUFFIX: &str = " [truncated]";

fn office_recovery_turn_refs(records: &[CrewonDomainConfigRecord]) -> Vec<OfficeRecoveryTurnRef> {
    let mut seen = HashSet::new();
    let mut refs = Vec::new();
    for record in records {
        collect_office_recovery_turn_refs(&record.config, &mut seen, &mut refs);
    }
    refs
}

fn office_scheduler_turn_refs(records: &[CrewonDomainConfigRecord]) -> Vec<OfficeRecoveryTurnRef> {
    let mut seen = HashSet::new();
    let mut refs = Vec::new();
    for record in records {
        collect_office_scheduler_turn_refs(&record.config, &mut seen, &mut refs);
    }
    refs
}

fn office_scheduler_dispatch_target_thread_ids(
    records: &[CrewonDomainConfigRecord],
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for record in records {
        collect_office_scheduler_dispatch_target_thread_ids(&record.config, &mut seen, &mut ids);
        if ids.len() >= MAX_OFFICE_SCHEDULER_TARGET_THREADS {
            break;
        }
    }
    ids
}

fn office_scheduler_automation_target_ids(records: &[CrewonDomainConfigRecord]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for record in records {
        collect_office_scheduler_automation_target_ids(&record.config, &mut seen, &mut ids);
        if ids.len() >= MAX_OFFICE_SCHEDULER_TARGET_THREADS {
            break;
        }
    }
    ids
}

fn office_scheduler_replan_source_thread_ids(records: &[CrewonDomainConfigRecord]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for record in records {
        collect_office_scheduler_replan_source_thread_ids(&record.config, &mut seen, &mut ids);
        if ids.len() >= MAX_OFFICE_SCHEDULER_TARGET_THREADS {
            break;
        }
    }
    ids
}

fn bounded_unique_office_recovery_cwds(cwds: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for cwd in cwds {
        if seen.insert(cwd.clone()) {
            unique.push(cwd);
        }
        if unique.len() >= MAX_OFFICE_THREAD_CWD_RECOVERY {
            break;
        }
    }
    unique
}

fn office_scheduler_recovery_should_keep_polling(
    history_outcome: OfficeHistoryRecoveryOutcome,
    scheduler_outcome: OfficeSchedulerRecoveryOutcome,
) -> bool {
    scheduler_outcome == OfficeSchedulerRecoveryOutcome::Waiting
        || history_outcome == OfficeHistoryRecoveryOutcome::Waiting
}

fn collect_office_recovery_turn_refs(
    config: &serde_json::Value,
    seen: &mut HashSet<(String, String)>,
    refs: &mut Vec<OfficeRecoveryTurnRef>,
) {
    let workspace_thread_id = config
        .get("workspace")
        .and_then(|workspace| workspace.get("threadId"))
        .and_then(serde_json::Value::as_str);
    let Some(runs) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };

    for run in runs {
        if office_recovery_item_needs_terminal_sync(run) {
            let run_thread_id = office_recovery_text(run, "threadId").or(workspace_thread_id);
            if let (Some(thread_id), Some(turn_id)) =
                (run_thread_id, office_recovery_text(run, "turnId"))
            {
                push_office_recovery_turn_ref(thread_id, turn_id, seen, refs);
            }
        }
        if let Some(delegations) = run.get("delegations").and_then(serde_json::Value::as_array) {
            for delegation in delegations {
                if !office_recovery_item_needs_terminal_sync(delegation) {
                    continue;
                }
                if let (Some(thread_id), Some(turn_id)) = (
                    office_recovery_text(delegation, "threadId"),
                    office_recovery_text(delegation, "turnId"),
                ) {
                    push_office_recovery_turn_ref(thread_id, turn_id, seen, refs);
                }
            }
        }
        if let Some(checks) = run
            .get("verificationChecks")
            .and_then(serde_json::Value::as_array)
        {
            for check in checks {
                if !office_recovery_item_needs_terminal_sync(check) {
                    continue;
                }
                if let (Some(thread_id), Some(turn_id)) = (
                    office_recovery_text(check, "automationThreadId"),
                    office_recovery_text(check, "automationTurnId"),
                ) {
                    push_office_recovery_turn_ref(thread_id, turn_id, seen, refs);
                }
            }
        }
    }
}

fn collect_office_scheduler_turn_refs(
    config: &serde_json::Value,
    seen: &mut HashSet<(String, String)>,
    refs: &mut Vec<OfficeRecoveryTurnRef>,
) {
    let workspace_thread_id = config
        .get("workspace")
        .and_then(|workspace| workspace.get("threadId"))
        .and_then(serde_json::Value::as_str);
    let Some(runs) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };

    for run in runs {
        let Some(run_id) = office_recovery_text(run, "id") else {
            continue;
        };
        let has_child_dispatch = office_run_has_potential_auto_delegation(run)
            || office_run_has_potential_auto_verification(run);
        let has_replan = office_run_has_potential_auto_replan(run)
            && !office_run_has_existing_retry(runs, run_id);
        if !has_child_dispatch && !has_replan {
            continue;
        }
        if office_recovery_item_is_terminal(run) {
            let run_thread_id = office_recovery_text(run, "threadId").or(workspace_thread_id);
            if let (Some(thread_id), Some(turn_id)) =
                (run_thread_id, office_recovery_text(run, "turnId"))
            {
                push_office_recovery_turn_ref(thread_id, turn_id, seen, refs);
            }
        }
        if let Some(delegations) = run.get("delegations").and_then(serde_json::Value::as_array) {
            for delegation in delegations {
                if !office_recovery_item_is_terminal(delegation) {
                    continue;
                }
                if let (Some(thread_id), Some(turn_id)) = (
                    office_recovery_text(delegation, "threadId"),
                    office_recovery_text(delegation, "turnId"),
                ) {
                    push_office_recovery_turn_ref(thread_id, turn_id, seen, refs);
                }
            }
        }
        if let Some(checks) = run
            .get("verificationChecks")
            .and_then(serde_json::Value::as_array)
        {
            for check in checks {
                if !office_verification_item_is_terminal_for_scheduler(check) {
                    continue;
                }
                if let (Some(thread_id), Some(turn_id)) = (
                    office_recovery_text(check, "automationThreadId"),
                    office_recovery_text(check, "automationTurnId"),
                ) {
                    push_office_recovery_turn_ref(thread_id, turn_id, seen, refs);
                }
            }
        }
    }
}

fn collect_office_scheduler_replan_source_thread_ids(
    config: &serde_json::Value,
    seen: &mut HashSet<String>,
    ids: &mut Vec<String>,
) {
    let workspace_thread_id = config
        .get("workspace")
        .and_then(|workspace| workspace.get("threadId"))
        .and_then(serde_json::Value::as_str);
    let Some(runs) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };
    for run in runs {
        let Some(run_id) = office_recovery_text(run, "id") else {
            continue;
        };
        if !office_run_has_potential_auto_replan(run) || office_run_has_existing_retry(runs, run_id)
        {
            continue;
        }
        if let Some(thread_id) = office_recovery_text(run, "threadId").or(workspace_thread_id) {
            push_office_scheduler_dispatch_target_thread_id(thread_id, seen, ids);
        }
        if ids.len() >= MAX_OFFICE_SCHEDULER_TARGET_THREADS {
            break;
        }
    }
}

fn collect_office_scheduler_dispatch_target_thread_ids(
    config: &serde_json::Value,
    seen: &mut HashSet<String>,
    ids: &mut Vec<String>,
) {
    let Some(runs) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };
    if !runs.iter().any(office_run_has_potential_auto_dispatch) {
        return;
    }

    if let Some(members) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(serde_json::Value::as_array)
    {
        for member in members {
            if let Some(thread_id) = office_recovery_text(member, "threadId").or_else(|| {
                member
                    .get("runtime")
                    .and_then(|runtime| office_recovery_text(runtime, "threadId"))
            }) {
                push_office_scheduler_dispatch_target_thread_id(thread_id, seen, ids);
            }
        }
    }

    for run in runs {
        if !office_run_has_potential_auto_dispatch(run) {
            continue;
        }
        if let Some(routes) = run
            .get("delegationRoutes")
            .and_then(serde_json::Value::as_array)
        {
            for route in routes {
                let target_kind = route
                    .get("targetKind")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim);
                if matches!(target_kind, Some("runtimeThread") | None)
                    && let Some(thread_id) = office_recovery_text(route, "threadId")
                        .or_else(|| office_recovery_text(route, "target"))
                {
                    push_office_scheduler_dispatch_target_thread_id(thread_id, seen, ids);
                }
            }
        }
    }
}

fn collect_office_scheduler_automation_target_ids(
    config: &serde_json::Value,
    seen: &mut HashSet<String>,
    ids: &mut Vec<String>,
) {
    let Some(runs) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(serde_json::Value::as_array)
    else {
        return;
    };
    for run in runs {
        if !office_run_has_potential_auto_verification(run) {
            continue;
        }
        let Some(checks) = run
            .get("verificationChecks")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for check in checks {
            if !office_verification_allows_scheduler_recovery(check) {
                continue;
            }
            if let Some(automation_id) = office_recovery_text(check, "automationId") {
                push_office_scheduler_dispatch_target_thread_id(automation_id, seen, ids);
            }
        }
    }
}

fn office_recovery_item_needs_terminal_sync(item: &serde_json::Value) -> bool {
    matches!(
        item.get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::trim),
        None | Some(
            "pending" | "queued" | "running" | "canceling" | "doing" | "inProgress" | "in_progress",
        )
    )
}

fn office_recovery_item_is_terminal(item: &serde_json::Value) -> bool {
    matches!(
        item.get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::trim),
        Some("completed" | "done")
    )
}

fn office_run_has_potential_auto_dispatch(run: &serde_json::Value) -> bool {
    office_run_has_potential_auto_delegation(run)
        || office_run_has_potential_auto_verification(run)
        || office_run_has_potential_auto_replan(run)
}

fn office_run_has_potential_auto_delegation(run: &serde_json::Value) -> bool {
    run.get("delegations")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|delegations| {
            delegations
                .iter()
                .any(office_delegation_allows_scheduler_recovery)
        })
}

fn office_run_has_potential_auto_verification(run: &serde_json::Value) -> bool {
    run.get("verificationChecks")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|checks| {
            checks
                .iter()
                .any(office_verification_allows_scheduler_recovery)
        })
}

fn office_run_has_potential_auto_replan(run: &serde_json::Value) -> bool {
    if !office_recovery_item_is_terminal(run)
        || office_recovery_auto_replan_disabled(run)
        || office_run_has_active_scheduler_child(run)
    {
        return false;
    }
    let loop_value = run.get("loop");
    if office_recovery_loop_iteration(loop_value) >= office_recovery_loop_max_iterations(loop_value)
    {
        return false;
    }
    let Some(review) = loop_value.and_then(|loop_value| loop_value.get("review")) else {
        return false;
    };
    if !matches!(
        review
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::trim),
        Some("blocked" | "needsReview")
    ) {
        return false;
    }
    if review
        .get("risks")
        .and_then(|risks| risks.get("openHigh"))
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|open_high| open_high > 0)
    {
        return false;
    }
    !matches!(
        review
            .get("nextAction")
            .and_then(serde_json::Value::as_str)
            .map(str::trim),
        Some(
            "frameAcceptanceCriteria"
                | "runVerificationChecks"
                | "mitigateHighRisks"
                | "readyToSummarize"
        )
    )
}

fn office_run_has_existing_retry(runs: &[serde_json::Value], source_run_id: &str) -> bool {
    runs.iter()
        .any(|run| office_retry_run_blocks_scheduler_replan(run, source_run_id))
}

fn office_retry_run_blocks_scheduler_replan(run: &serde_json::Value, source_run_id: &str) -> bool {
    if run.get("retryOf").and_then(serde_json::Value::as_str) != Some(source_run_id) {
        return false;
    }
    if office_recovery_text(run, "turnId").is_some() {
        return true;
    }
    match run
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
    {
        Some("queued") => office_dispatch_lease_is_active(run),
        _ => true,
    }
}

fn office_dispatch_lease_is_active(value: &serde_json::Value) -> bool {
    value
        .get("dispatchLeaseExpiresAt")
        .and_then(serde_json::Value::as_str)
        .and_then(|expires_at| DateTime::parse_from_rfc3339(expires_at).ok())
        .map(|expires_at| expires_at.with_timezone(&Utc))
        .is_some_and(|expires_at| expires_at > Utc::now())
}

fn office_recovery_auto_replan_disabled(run: &serde_json::Value) -> bool {
    if office_json_boolish(
        run,
        &[
            "approvalRequired",
            "requiresApproval",
            "manualRetry",
            "manualDispatch",
        ],
    ) {
        return true;
    }
    if run
        .get("autoRetry")
        .or_else(|| run.get("autoReplan"))
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        return true;
    }
    run.get("dispatchMode")
        .or_else(|| run.get("dispatchPolicy"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| {
            matches!(
                value.as_str(),
                "manual" | "approval" | "requiresapproval" | "requires_approval" | "human"
            )
        })
}

fn office_run_has_active_scheduler_child(run: &serde_json::Value) -> bool {
    run.get("delegations")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|delegations| {
            delegations.iter().any(|delegation| {
                match delegation
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                {
                    Some("queued") => office_delegation_started_dispatch(delegation),
                    Some("running" | "canceling") => true,
                    _ => false,
                }
            })
        })
        || run
            .get("verificationChecks")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|checks| {
                checks.iter().any(|check| {
                    let dispatch_status = check
                        .get("dispatchStatus")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim);
                    let automation_status = check
                        .get("automationStatus")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim);
                    matches!(dispatch_status, Some("running" | "canceling"))
                        || dispatch_status == Some("queued")
                            && office_dispatch_lease_is_active(check)
                        || matches!(automation_status, Some("queued" | "running" | "canceling"))
                })
            })
}

fn office_recovery_loop_iteration(loop_value: Option<&serde_json::Value>) -> u64 {
    loop_value
        .and_then(|loop_value| loop_value.get("iteration"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1)
}

fn office_recovery_loop_max_iterations(loop_value: Option<&serde_json::Value>) -> u64 {
    loop_value
        .and_then(|loop_value| loop_value.get("maxIterations"))
        .and_then(serde_json::Value::as_u64)
        .filter(|max_iterations| *max_iterations > 0)
        .unwrap_or(4)
}

fn office_delegation_allows_scheduler_recovery(delegation: &serde_json::Value) -> bool {
    if office_delegation_started_dispatch(delegation)
        || office_delegation_requires_manual_dispatch(delegation)
    {
        return false;
    }
    let status = delegation
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::trim);
    if matches!(
        status,
        Some("blocked" | "done" | "completed" | "skipped" | "running" | "canceling")
    ) {
        return false;
    }
    let has_task = office_recovery_text(delegation, "task").is_some();
    let has_route_key = office_recovery_text(delegation, "member").is_some()
        || office_recovery_text(delegation, "agentId").is_some();
    has_task && has_route_key
}

fn office_verification_allows_scheduler_recovery(check: &serde_json::Value) -> bool {
    if office_recovery_text(check, "automationTurnId").is_some()
        || office_recovery_text(check, "automationRunId").is_some()
        || office_verification_requires_manual_dispatch(check)
    {
        return false;
    }
    match check
        .get("dispatchStatus")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
    {
        Some("queued") if office_dispatch_lease_is_active(check) => return false,
        Some("running" | "canceling" | "completed") => return false,
        _ => {}
    }
    let status = check
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::trim);
    if !matches!(status, None | Some("pending")) {
        return false;
    }
    office_recovery_text(check, "automationId").is_some()
}

fn office_verification_requires_manual_dispatch(check: &serde_json::Value) -> bool {
    if office_json_boolish(
        check,
        &["approvalRequired", "requiresApproval", "manualDispatch"],
    ) || office_recovery_text(check, "approvalId").is_some()
    {
        return true;
    }
    if check
        .get("dispatchMode")
        .or_else(|| check.get("dispatchPolicy"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| {
            matches!(
                value.as_str(),
                "manual" | "approval" | "requiresapproval" | "requires_approval" | "human"
            )
        })
    {
        return true;
    }
    check
        .get("riskSeverity")
        .or_else(|| check.get("severity"))
        .or_else(|| check.get("risk"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| value == "high")
}

fn office_verification_item_is_terminal_for_scheduler(check: &serde_json::Value) -> bool {
    matches!(
        check
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::trim),
        Some("passed" | "completed" | "done")
    ) && matches!(
        check
            .get("dispatchStatus")
            .and_then(serde_json::Value::as_str)
            .map(str::trim),
        Some("completed") | None
    )
}

fn office_delegation_started_dispatch(delegation: &serde_json::Value) -> bool {
    if office_recovery_text(delegation, "turnId").is_some() {
        return true;
    }
    let status = delegation
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(str::trim);
    if status == Some("queued") {
        return office_dispatch_lease_is_active(delegation);
    }
    if delegation
        .get("dispatchMethod")
        .and_then(serde_json::Value::as_str)
        == Some("turnStart")
        && !matches!(status, Some("failed" | "interrupted"))
    {
        return true;
    }
    matches!(status, Some("running" | "completed" | "done" | "canceling"))
}

fn office_delegation_requires_manual_dispatch(delegation: &serde_json::Value) -> bool {
    if office_json_boolish(
        delegation,
        &["approvalRequired", "requiresApproval", "manualDispatch"],
    ) || office_recovery_text(delegation, "approvalId").is_some()
    {
        return true;
    }
    if delegation
        .get("dispatchMode")
        .or_else(|| delegation.get("dispatchPolicy"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| {
            matches!(
                value.as_str(),
                "manual" | "approval" | "requiresapproval" | "requires_approval" | "human"
            )
        })
    {
        return true;
    }
    delegation
        .get("riskSeverity")
        .or_else(|| delegation.get("severity"))
        .or_else(|| delegation.get("risk"))
        .and_then(serde_json::Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| value == "high")
}

fn office_json_boolish(value: &serde_json::Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| match value.get(*key) {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::String(value)) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "yes" | "required" | "manual"
        ),
        _ => false,
    })
}

fn office_recovery_text<'a>(item: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    item.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn push_office_recovery_turn_ref(
    thread_id: &str,
    turn_id: &str,
    seen: &mut HashSet<(String, String)>,
    refs: &mut Vec<OfficeRecoveryTurnRef>,
) {
    let key = (thread_id.to_string(), turn_id.to_string());
    if !seen.insert(key.clone()) {
        return;
    }
    refs.push(OfficeRecoveryTurnRef {
        thread_id: key.0,
        turn_id: key.1,
    });
}

fn push_office_scheduler_dispatch_target_thread_id(
    thread_id: &str,
    seen: &mut HashSet<String>,
    ids: &mut Vec<String>,
) {
    if ids.len() >= MAX_OFFICE_SCHEDULER_TARGET_THREADS {
        return;
    }
    let thread_id = thread_id.trim();
    if thread_id.is_empty() || !seen.insert(thread_id.to_string()) {
        return;
    }
    ids.push(thread_id.to_string());
}

fn office_runtime_thread_repair_candidate(
    records: &[CrewonDomainConfigRecord],
    target_thread_id: &str,
) -> Option<OfficeRuntimeThreadRepairCandidate> {
    for record in records {
        if let Some(candidate) =
            office_runtime_thread_repair_candidate_from_members(&record.config, target_thread_id)
        {
            return Some(candidate);
        }
        if let Some(candidate) =
            office_runtime_thread_repair_candidate_from_routes(&record.config, target_thread_id)
        {
            return Some(candidate);
        }
    }
    None
}

fn office_runtime_thread_repair_candidate_from_members(
    config: &serde_json::Value,
    target_thread_id: &str,
) -> Option<OfficeRuntimeThreadRepairCandidate> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(serde_json::Value::as_array)?
        .iter()
        .find_map(|member| {
            let member_thread_id = office_member_runtime_thread_id(member)?;
            if member_thread_id != target_thread_id {
                return None;
            }
            let agent_id = office_recovery_text(member, "agentId")?;
            Some(OfficeRuntimeThreadRepairCandidate {
                agent_id: agent_id.to_string(),
                member: office_recovery_text(member, "name")
                    .or_else(|| office_recovery_text(member, "member"))
                    .unwrap_or("Agent")
                    .to_string(),
            })
        })
}

fn office_runtime_thread_repair_candidate_from_routes(
    config: &serde_json::Value,
    target_thread_id: &str,
) -> Option<OfficeRuntimeThreadRepairCandidate> {
    let runs = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(serde_json::Value::as_array)?;
    for run in runs {
        let Some(routes) = run
            .get("delegationRoutes")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for route in routes {
            if !office_route_is_runtime_thread(route) {
                continue;
            }
            let route_thread_id = office_recovery_text(route, "threadId")
                .or_else(|| office_recovery_text(route, "target"));
            if route_thread_id != Some(target_thread_id) {
                continue;
            }
            let Some(agent_id) = office_recovery_text(route, "agentId") else {
                continue;
            };
            return Some(OfficeRuntimeThreadRepairCandidate {
                agent_id: agent_id.to_string(),
                member: office_recovery_text(route, "member")
                    .unwrap_or("Agent")
                    .to_string(),
            });
        }
    }
    None
}

fn office_member_runtime_thread_id(member: &serde_json::Value) -> Option<&str> {
    office_recovery_text(member, "threadId").or_else(|| {
        member
            .get("runtime")
            .and_then(|runtime| office_recovery_text(runtime, "threadId"))
    })
}

fn office_route_is_runtime_thread(route: &serde_json::Value) -> bool {
    matches!(
        route
            .get("targetKind")
            .and_then(serde_json::Value::as_str)
            .map(str::trim),
        Some("runtimeThread") | None
    )
}

fn office_agent_runtime_developer_instructions(
    agent_config: &serde_json::Value,
    member: &str,
    agent_id: &str,
) -> Option<String> {
    let member =
        bounded_office_runtime_instruction_text(member, OFFICE_RUNTIME_REPAIR_MAX_ID_CHARS);
    let agent_id =
        bounded_office_runtime_instruction_text(agent_id, OFFICE_RUNTIME_REPAIR_MAX_ID_CHARS);
    let mut parts = vec![format!(
        "You are the durable runtime thread for Office member {member} ({agent_id}). Preserve this member's private execution context across delegated tasks. Use only the task prompt, this thread history, allowed Office memory, and bounded shared Office digest as context."
    )];
    for key in [
        "instructions",
        "developerInstructions",
        "systemPrompt",
        "prompt",
        "description",
        "role",
        "persona",
        "policy",
        "guardrails",
        "constraints",
    ] {
        if let Some(value) = office_recovery_text(agent_config, key) {
            let value = bounded_office_runtime_instruction_text(
                value,
                OFFICE_RUNTIME_REPAIR_MAX_FIELD_CHARS,
            );
            parts.push(format!("{key}: {value}"));
        }
    }
    let instructions = bounded_office_runtime_instruction_text(
        &parts.join("\n"),
        OFFICE_RUNTIME_REPAIR_MAX_INSTRUCTIONS_CHARS,
    );
    (!instructions.trim().is_empty()).then_some(instructions)
}

fn bounded_office_runtime_instruction_text(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let suffix_chars = OFFICE_RUNTIME_REPAIR_TRUNCATED_SUFFIX.chars().count();
    let keep_chars = max_chars.saturating_sub(suffix_chars);
    let mut bounded = value.chars().take(keep_chars).collect::<String>();
    bounded.push_str(OFFICE_RUNTIME_REPAIR_TRUNCATED_SUFFIX);
    bounded
}

fn rebind_office_runtime_thread_records(
    records: &mut [CrewonDomainConfigRecord],
    old_thread_id: &str,
    new_thread_id: &str,
    agent_id: &str,
) -> Vec<(String, serde_json::Value)> {
    let mut updates = Vec::new();
    for record in records {
        let changed = rebind_office_runtime_thread_config(
            &mut record.config,
            old_thread_id,
            new_thread_id,
            agent_id,
        );
        if changed {
            updates.push((record.file_path.clone(), record.config.clone()));
        }
    }
    updates
}

fn rebind_office_runtime_thread_config(
    config: &mut serde_json::Value,
    old_thread_id: &str,
    new_thread_id: &str,
    agent_id: &str,
) -> bool {
    let mut changed = false;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return false;
    };

    if let Some(members) = workspace
        .get_mut("members")
        .and_then(serde_json::Value::as_array_mut)
    {
        for member in members {
            let matches_agent =
                office_recovery_text(member, "agentId").is_some_and(|value| value == agent_id);
            let matches_thread = office_member_runtime_thread_id(member)
                .is_some_and(|thread_id| thread_id == old_thread_id);
            if !(matches_agent || matches_thread) {
                continue;
            }
            if let Some(member_object) = member.as_object_mut() {
                changed |= set_json_string(member_object, "threadId", new_thread_id);
                let runtime = member_object
                    .entry("runtime".to_string())
                    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
                if !runtime.is_object() {
                    *runtime = serde_json::Value::Object(serde_json::Map::new());
                    changed = true;
                }
                if let Some(runtime_object) = runtime.as_object_mut() {
                    changed |= set_json_string(runtime_object, "threadId", new_thread_id);
                    changed |=
                        set_json_string(runtime_object, "repairSourceThreadId", old_thread_id);
                    changed |= set_json_string(runtime_object, "repairedAt", &now);
                }
            }
        }
    }

    let Some(runs) = workspace
        .get_mut("activity")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(serde_json::Value::as_array_mut)
    else {
        return changed;
    };
    for run in runs {
        let Some(run_object) = run.as_object_mut() else {
            continue;
        };
        if let Some(routes) = run_object
            .get_mut("delegationRoutes")
            .and_then(serde_json::Value::as_array_mut)
        {
            for route in routes {
                if !office_route_is_runtime_thread(route) {
                    continue;
                }
                let matches_agent =
                    office_recovery_text(route, "agentId").is_some_and(|value| value == agent_id);
                let matches_thread = office_recovery_text(route, "threadId")
                    .or_else(|| office_recovery_text(route, "target"))
                    .is_some_and(|thread_id| thread_id == old_thread_id);
                if !(matches_agent || matches_thread) {
                    continue;
                }
                if let Some(route_object) = route.as_object_mut() {
                    changed |= set_json_string(route_object, "threadId", new_thread_id);
                    changed |= set_json_string(route_object, "target", new_thread_id);
                    changed |= set_json_string(route_object, "repairSourceThreadId", old_thread_id);
                    changed |= set_json_string(route_object, "repairedAt", &now);
                }
            }
        }
        if let Some(delegations) = run_object
            .get_mut("delegations")
            .and_then(serde_json::Value::as_array_mut)
        {
            for delegation in delegations {
                let has_turn = office_recovery_text(delegation, "turnId").is_some();
                if has_turn {
                    continue;
                }
                let matches_agent = office_recovery_text(delegation, "agentId")
                    .is_some_and(|value| value == agent_id);
                let matches_thread = office_recovery_text(delegation, "threadId")
                    .is_some_and(|thread_id| thread_id == old_thread_id);
                if !(matches_agent || matches_thread) {
                    continue;
                }
                if let Some(delegation_object) = delegation.as_object_mut() {
                    changed |= set_json_string(delegation_object, "threadId", new_thread_id);
                    changed |=
                        set_json_string(delegation_object, "repairSourceThreadId", old_thread_id);
                    changed |= set_json_string(delegation_object, "repairedAt", &now);
                }
            }
        }
    }

    if changed && let Some(config_object) = config.as_object_mut() {
        config_object.insert("updatedAt".to_string(), serde_json::Value::String(now));
    }
    changed
}

fn set_json_string(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &str,
) -> bool {
    if object.get(key).and_then(serde_json::Value::as_str) == Some(value) {
        return false;
    }
    object.insert(
        key.to_string(),
        serde_json::Value::String(value.to_string()),
    );
    true
}

fn apply_office_recovery_update(
    records: &mut [CrewonDomainConfigRecord],
    file_path: &str,
    config: &serde_json::Value,
) {
    if let Some(record) = records
        .iter_mut()
        .find(|record| record.file_path == file_path)
    {
        record.config = config.clone();
    } else if let [record] = records {
        record.file_path = file_path.to_string();
        record.config = config.clone();
    }
}

fn office_scheduler_workspace_index_path(codex_home: &Path) -> PathBuf {
    codex_home
        .join(OFFICE_SCHEDULER_WORKSPACE_INDEX_DIR)
        .join(OFFICE_SCHEDULER_WORKSPACE_INDEX_FILE)
}

fn office_scheduler_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

async fn read_office_scheduler_workspace_index(
    codex_home: &Path,
) -> Result<OfficeSchedulerWorkspaceIndex, JSONRPCErrorError> {
    let path = office_scheduler_workspace_index_path(codex_home);
    let bytes = match fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OfficeSchedulerWorkspaceIndex::default());
        }
        Err(err) => {
            return Err(internal_error(format!(
                "failed to read office scheduler workspace index: {err}"
            )));
        }
    };
    serde_json::from_slice::<OfficeSchedulerWorkspaceIndex>(&bytes).map_err(|err| {
        internal_error(format!(
            "failed to parse office scheduler workspace index: {err}"
        ))
    })
}

async fn write_office_scheduler_workspace_index(
    codex_home: &Path,
    index: &OfficeSchedulerWorkspaceIndex,
) -> Result<(), JSONRPCErrorError> {
    let path = office_scheduler_workspace_index_path(codex_home);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|err| {
            internal_error(format!(
                "failed to create office scheduler workspace index directory: {err}"
            ))
        })?;
    }
    let mut bytes = serde_json::to_vec_pretty(index).map_err(|err| {
        internal_error(format!(
            "failed to serialize office scheduler workspace index: {err}"
        ))
    })?;
    bytes.push(b'\n');
    fs::write(path, bytes).await.map_err(|err| {
        internal_error(format!(
            "failed to write office scheduler workspace index: {err}"
        ))
    })
}

async fn record_office_scheduler_workspace_cwd(
    codex_home: &Path,
    cwd: &str,
) -> Result<(), JSONRPCErrorError> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Ok(());
    }
    let mut index = read_office_scheduler_workspace_index(codex_home).await?;
    index.version = 1;
    index.cwds.retain(|entry| entry.cwd != cwd);
    index.cwds.insert(
        0,
        OfficeSchedulerWorkspaceEntry {
            cwd: cwd.to_string(),
            updated_at: office_scheduler_now(),
        },
    );
    index.cwds.truncate(MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS);
    write_office_scheduler_workspace_index(codex_home, &index).await
}

async fn office_scheduler_workspace_index_cwds(codex_home: &Path) -> Vec<String> {
    match read_office_scheduler_workspace_index(codex_home).await {
        Ok(mut index) => {
            index
                .cwds
                .sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
            index.cwds.into_iter().map(|entry| entry.cwd).collect()
        }
        Err(err) => {
            tracing::warn!(
                error = %err.message,
                "failed to read office scheduler workspace index"
            );
            Vec::new()
        }
    }
}

async fn send_office_run_updated_with(
    outgoing: &OutgoingMessageSender,
    cwd: &str,
    file_path: &str,
    config: &serde_json::Value,
    reason: &str,
    source_thread_id: Option<&str>,
    source_turn_id: Option<&str>,
) {
    outgoing
        .send_server_notification(office_run_updated_notification(
            cwd,
            file_path,
            config,
            reason,
            source_thread_id,
            source_turn_id,
        ))
        .await;
}

async fn recover_office_records_from_history_with(
    outgoing: &OutgoingMessageSender,
    thread_processor: &ThreadRequestProcessor,
    connection_id: ConnectionId,
    cwd: &str,
    records: &mut [CrewonDomainConfigRecord],
) -> OfficeHistoryRecoveryOutcome {
    let mut outcome = OfficeHistoryRecoveryOutcome::Idle;
    for turn_ref in office_recovery_turn_refs(records) {
        let turn = match thread_processor
            .persisted_terminal_turn(&turn_ref.thread_id, &turn_ref.turn_id)
            .await
        {
            Ok(Some(turn)) => turn,
            Ok(None) => {
                if outcome == OfficeHistoryRecoveryOutcome::Idle {
                    outcome = OfficeHistoryRecoveryOutcome::Waiting;
                }
                thread_processor
                    .monitor_office_dispatched_turn_completion(
                        cwd,
                        &turn_ref.thread_id,
                        &turn_ref.turn_id,
                        connection_id,
                    )
                    .await;
                continue;
            }
            Err(err) => {
                tracing::warn!(
                    thread_id = %turn_ref.thread_id,
                    turn_id = %turn_ref.turn_id,
                    error = %err.message,
                    "failed to read persisted turn for office recovery"
                );
                continue;
            }
        };

        let updates =
            match sync_office_run_updates_for_thread_turn(cwd, &turn_ref.thread_id, &turn).await {
                Ok(updates) => updates,
                Err(err) => {
                    tracing::warn!(
                        thread_id = %turn_ref.thread_id,
                        turn_id = %turn_ref.turn_id,
                        error = %err.message,
                        "failed to recover office run from persisted turn"
                    );
                    continue;
                }
            };
        if updates.is_empty() {
            continue;
        }
        for update in updates {
            outcome = OfficeHistoryRecoveryOutcome::Recovered;
            apply_office_recovery_update(records, &update.file_path, &update.config);
            send_office_run_updated_with(
                outgoing,
                cwd,
                &update.file_path,
                &update.config,
                "historyRecovery",
                Some(&turn_ref.thread_id),
                Some(&turn_ref.turn_id),
            )
            .await;
        }
        if let Some(update) = thread_processor
            .dispatch_office_after_terminal_turn(
                cwd,
                &turn_ref.thread_id,
                turn.clone(),
                connection_id,
            )
            .await
        {
            outcome = OfficeHistoryRecoveryOutcome::Recovered;
            apply_office_recovery_update(records, &update.file_path, &update.config);
        }
    }
    outcome
}

async fn recover_office_scheduler_from_records_with(
    domain_processor: &CrewonDomainRequestProcessor,
    outgoing: &OutgoingMessageSender,
    thread_processor: &ThreadRequestProcessor,
    connection_id: ConnectionId,
    cwd: &str,
    records: &mut [CrewonDomainConfigRecord],
) -> OfficeSchedulerRecoveryOutcome {
    let mut dispatched = false;
    let mut waiting = false;
    let pending_intents = match domain_processor
        .office_auto_dispatch_pending_intents(cwd)
        .await
    {
        Ok(intents) => intents,
        Err(err) => {
            tracing::warn!(
                error = %err.message,
                "failed to read office scheduler intents"
            );
            Vec::new()
        }
    };
    ensure_office_scheduler_automation_targets_loaded(
        domain_processor,
        thread_processor,
        connection_id,
        cwd,
        records,
    )
    .await;
    ensure_office_scheduler_dispatch_targets_loaded(
        domain_processor,
        outgoing,
        thread_processor,
        connection_id,
        cwd,
        records,
    )
    .await;
    ensure_office_scheduler_replan_sources_loaded(thread_processor, connection_id, records).await;
    for (source_thread_id, source_turn_id) in pending_intents {
        let turn = match thread_processor
            .persisted_terminal_turn(&source_thread_id, &source_turn_id)
            .await
        {
            Ok(Some(turn)) => turn,
            Ok(None) => {
                waiting = true;
                continue;
            }
            Err(err) => {
                tracing::warn!(
                    thread_id = %source_thread_id,
                    turn_id = %source_turn_id,
                    error = %err.message,
                    "failed to read persisted turn for office scheduler intent"
                );
                continue;
            }
        };

        let lease_uuid = Uuid::new_v4();
        let lease_id = format!("office-scheduler-recovery-{lease_uuid}");
        match domain_processor
            .office_auto_dispatch_intent_claim(cwd, &source_thread_id, &source_turn_id, &lease_id)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                waiting = true;
                continue;
            }
            Err(err) => {
                tracing::warn!(
                    thread_id = %source_thread_id,
                    turn_id = %source_turn_id,
                    error = %err.message,
                    "failed to claim office scheduler intent"
                );
                continue;
            }
        }

        if let Some(update) = thread_processor
            .dispatch_office_after_terminal_turn(cwd, &source_thread_id, turn, connection_id)
            .await
        {
            dispatched = true;
            apply_office_recovery_update(records, &update.file_path, &update.config);
        }
    }

    for turn_ref in office_scheduler_turn_refs(records) {
        let turn = match thread_processor
            .persisted_terminal_turn(&turn_ref.thread_id, &turn_ref.turn_id)
            .await
        {
            Ok(Some(turn)) => turn,
            Ok(None) => {
                waiting = true;
                continue;
            }
            Err(err) => {
                tracing::warn!(
                    thread_id = %turn_ref.thread_id,
                    turn_id = %turn_ref.turn_id,
                    error = %err.message,
                    "failed to read persisted turn for office scheduler recovery"
                );
                continue;
            }
        };

        if let Some(update) = thread_processor
            .dispatch_office_after_terminal_turn(cwd, &turn_ref.thread_id, turn, connection_id)
            .await
        {
            dispatched = true;
            apply_office_recovery_update(records, &update.file_path, &update.config);
        }
    }
    if dispatched {
        OfficeSchedulerRecoveryOutcome::Dispatched
    } else if waiting {
        OfficeSchedulerRecoveryOutcome::Waiting
    } else {
        OfficeSchedulerRecoveryOutcome::Idle
    }
}

async fn ensure_office_scheduler_replan_sources_loaded(
    thread_processor: &ThreadRequestProcessor,
    connection_id: ConnectionId,
    records: &[CrewonDomainConfigRecord],
) {
    for thread_id in office_scheduler_replan_source_thread_ids(records) {
        if let Err(err) = thread_processor
            .ensure_thread_loaded_for_office_dispatch(&thread_id, connection_id)
            .await
        {
            tracing::warn!(
                thread_id,
                error = %err.message,
                "failed to load office scheduler replan source thread"
            );
        }
    }
}

async fn ensure_office_scheduler_automation_targets_loaded(
    domain_processor: &CrewonDomainRequestProcessor,
    thread_processor: &ThreadRequestProcessor,
    connection_id: ConnectionId,
    cwd: &str,
    records: &[CrewonDomainConfigRecord],
) {
    for automation_id in office_scheduler_automation_target_ids(records) {
        let record = match domain_processor
            .automation_read_by_identifier(cwd, &automation_id)
            .await
        {
            Ok(Some(record)) => record,
            Ok(None) => continue,
            Err(err) => {
                tracing::warn!(
                    automation_id,
                    error = %err.message,
                    "failed to read office scheduler automation target"
                );
                continue;
            }
        };
        let mut config = record.config;
        if let Err(err) = thread_processor
            .ensure_office_automation_runtime_thread(
                domain_processor,
                cwd,
                &record.file_path,
                &automation_id,
                &mut config,
                connection_id,
            )
            .await
        {
            tracing::warn!(
                automation_id,
                file_path = %record.file_path,
                error = %err.message,
                "failed to repair office scheduler automation runtime"
            );
        }
    }
}

async fn ensure_office_scheduler_dispatch_targets_loaded(
    domain_processor: &CrewonDomainRequestProcessor,
    outgoing: &OutgoingMessageSender,
    thread_processor: &ThreadRequestProcessor,
    connection_id: ConnectionId,
    cwd: &str,
    records: &mut [CrewonDomainConfigRecord],
) {
    for thread_id in office_scheduler_dispatch_target_thread_ids(records) {
        let was_loaded = match thread_processor
            .office_dispatch_thread_is_loaded(&thread_id)
            .await
        {
            Ok(was_loaded) => was_loaded,
            Err(err) => {
                tracing::warn!(
                    thread_id,
                    error = %err.message,
                    "failed to check loaded office scheduler dispatch target thread"
                );
                continue;
            }
        };
        let repair_reason = match thread_processor
            .ensure_thread_loaded_for_office_dispatch(&thread_id, connection_id)
            .await
        {
            Ok(()) if was_loaded => continue,
            Ok(()) => match thread_processor
                .thread_has_persisted_rollout(&thread_id)
                .await
            {
                Ok(true) => continue,
                Ok(false) => "missing persisted rollout".to_string(),
                Err(err) => {
                    tracing::warn!(
                        thread_id,
                        error = %err.message,
                        "failed to check persisted rollout for office scheduler dispatch target"
                    );
                    continue;
                }
            },
            Err(err) => {
                if office_dispatch_thread_can_be_repaired(&err, &thread_id) {
                    err.message.clone()
                } else {
                    tracing::warn!(
                        thread_id,
                        error = %err.message,
                        "failed to load office scheduler dispatch target thread"
                    );
                    continue;
                }
            }
        };
        if repair_office_scheduler_dispatch_target_thread(
            domain_processor,
            outgoing,
            thread_processor,
            connection_id,
            cwd,
            records,
            &thread_id,
        )
        .await
        {
            continue;
        }
        tracing::warn!(
            thread_id,
            reason = repair_reason,
            "failed to repair office scheduler dispatch target thread"
        );
    }
}

fn office_dispatch_thread_can_be_repaired(err: &JSONRPCErrorError, thread_id: &str) -> bool {
    err.message == format!("no rollout found for thread id {thread_id}")
}

async fn repair_office_scheduler_dispatch_target_thread(
    domain_processor: &CrewonDomainRequestProcessor,
    outgoing: &OutgoingMessageSender,
    thread_processor: &ThreadRequestProcessor,
    connection_id: ConnectionId,
    cwd: &str,
    records: &mut [CrewonDomainConfigRecord],
    old_thread_id: &str,
) -> bool {
    let Some(candidate) = office_runtime_thread_repair_candidate(records, old_thread_id) else {
        return false;
    };
    let agent_response = match domain_processor
        .agent_read(AgentReadParams {
            cwd: cwd.to_string(),
            agent_id: Some(candidate.agent_id.clone()),
            thread_id: None,
            name: None,
        })
        .await
    {
        Ok(response) => response,
        Err(err) => {
            tracing::warn!(
                agent_id = %candidate.agent_id,
                thread_id = old_thread_id,
                error = %err.message,
                "failed to read agent config for office runtime repair"
            );
            return false;
        }
    };
    let Some(agent_record) = agent_response.record else {
        tracing::warn!(
            agent_id = %candidate.agent_id,
            thread_id = old_thread_id,
            "agent config missing for office runtime repair"
        );
        return false;
    };
    let developer_instructions = office_agent_runtime_developer_instructions(
        &agent_record.config,
        &candidate.member,
        &candidate.agent_id,
    );
    let thread = match thread_processor
        .start_office_member_runtime_thread(
            OfficeMemberRuntimeThreadStart {
                cwd: cwd.to_string(),
                base_instructions: None,
                developer_instructions,
            },
            connection_id,
        )
        .await
    {
        Ok(thread) => thread,
        Err(err) => {
            tracing::warn!(
                agent_id = %candidate.agent_id,
                thread_id = old_thread_id,
                error = %err.message,
                "failed to create replacement office member runtime thread"
            );
            return false;
        }
    };
    let new_thread_id = thread.id;
    let mut agent_config = agent_record.config.clone();
    if let Some(object) = agent_config.as_object_mut() {
        set_json_string(object, "threadId", &new_thread_id);
        set_json_string(object, "runtimeRepairSourceThreadId", old_thread_id);
        set_json_string(
            object,
            "runtimeRepairedAt",
            &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        );
        if let Err(err) = domain_processor
            .agent_update(AgentUpdateParams {
                cwd: cwd.to_string(),
                file_path: agent_record.file_path,
                config: agent_config,
            })
            .await
        {
            tracing::warn!(
                agent_id = %candidate.agent_id,
                thread_id = old_thread_id,
                replacement_thread_id = %new_thread_id,
                error = %err.message,
                "failed to persist replacement office member runtime thread on agent config"
            );
        }
    }

    let updates = rebind_office_runtime_thread_records(
        records,
        old_thread_id,
        &new_thread_id,
        &candidate.agent_id,
    );
    if updates.is_empty() {
        return false;
    }
    for (_, config) in updates {
        let updated_config = config.clone();
        match domain_processor
            .office_save(OfficeSaveParams {
                cwd: cwd.to_string(),
                config,
            })
            .await
        {
            Ok(response) => {
                send_office_run_updated_with(
                    outgoing,
                    cwd,
                    &response.file_path,
                    &updated_config,
                    "runtimeRepair",
                    Some(&new_thread_id),
                    None,
                )
                .await;
            }
            Err(err) => {
                tracing::warn!(
                    agent_id = %candidate.agent_id,
                    thread_id = old_thread_id,
                    replacement_thread_id = %new_thread_id,
                    error = %err.message,
                    "failed to save office runtime repair"
                );
            }
        }
    }
    true
}

async fn recover_office_scheduler_for_cwd_with(
    domain_processor: &CrewonDomainRequestProcessor,
    outgoing: &OutgoingMessageSender,
    thread_processor: &ThreadRequestProcessor,
    connection_id: ConnectionId,
    cwd: &str,
) {
    let mut response = match domain_processor
        .office_list(OfficeListParams {
            cwd: cwd.to_string(),
            cursor: None,
            limit: None,
        })
        .await
    {
        Ok(response) => response,
        Err(err) => {
            tracing::warn!(
                cwd,
                error = %err.message,
                "failed to list offices for scheduler recovery"
            );
            return;
        }
    };
    if response.data.is_empty() {
        return;
    }
    let mut idle_passes = 0usize;
    for _ in 0..OFFICE_SCHEDULER_RECOVERY_MAX_PASSES {
        let history_outcome = recover_office_records_from_history_with(
            outgoing,
            thread_processor,
            connection_id,
            cwd,
            &mut response.data,
        )
        .await;
        let scheduler_outcome = recover_office_scheduler_from_records_with(
            domain_processor,
            outgoing,
            thread_processor,
            connection_id,
            cwd,
            &mut response.data,
        )
        .await;
        if history_outcome == OfficeHistoryRecoveryOutcome::Recovered
            || scheduler_outcome == OfficeSchedulerRecoveryOutcome::Dispatched
        {
            idle_passes = 0;
            tokio::time::sleep(OFFICE_SCHEDULER_RECOVERY_IDLE_POLL_INTERVAL).await;
            continue;
        }
        if !office_scheduler_recovery_should_keep_polling(history_outcome, scheduler_outcome) {
            break;
        }
        idle_passes += 1;
        if idle_passes >= OFFICE_SCHEDULER_RECOVERY_MAX_PASSES {
            break;
        }
        tokio::time::sleep(OFFICE_SCHEDULER_RECOVERY_IDLE_POLL_INTERVAL).await;
    }
}

async fn recover_office_scheduler_on_startup(
    outgoing: Arc<OutgoingMessageSender>,
    thread_processor: ThreadRequestProcessor,
    codex_home: PathBuf,
    connection_id: ConnectionId,
) {
    let domain_processor = CrewonDomainRequestProcessor::new();
    let mut cwds = office_scheduler_workspace_index_cwds(&codex_home).await;
    match thread_processor.office_scheduler_startup_threads().await {
        Ok(response) => {
            cwds.extend(
                response
                    .data
                    .iter()
                    .map(|thread| thread.cwd.as_path().to_string_lossy().into_owned()),
            );
        }
        Err(err) => {
            tracing::warn!(
                error = %err.message,
                "failed to list threads for office scheduler startup recovery"
            );
        }
    };
    let cwds = bounded_unique_office_recovery_cwds(cwds);
    if cwds.is_empty() {
        return;
    }
    for cwd in cwds {
        recover_office_scheduler_for_cwd_with(
            &domain_processor,
            outgoing.as_ref(),
            &thread_processor,
            connection_id,
            &cwd,
        )
        .await;
    }
}

pub(crate) struct MessageProcessorArgs {
    pub(crate) outgoing: Arc<OutgoingMessageSender>,
    pub(crate) analytics_events_client: AnalyticsEventsClient,
    pub(crate) arg0_paths: Arg0DispatchPaths,
    pub(crate) config: Arc<Config>,
    pub(crate) config_manager: ConfigManager,
    pub(crate) environment_manager: Arc<EnvironmentManager>,
    pub(crate) feedback: CrewonFeedback,
    pub(crate) log_db: Option<LogDbLayer>,
    pub(crate) state_db: Option<StateDbHandle>,
    pub(crate) config_warnings: Vec<ConfigWarningNotification>,
    pub(crate) session_source: SessionSource,
    pub(crate) auth_manager: Arc<AuthManager>,
    pub(crate) installation_id: String,
    pub(crate) rpc_transport: AppServerRpcTransport,
    pub(crate) remote_control_handle: Option<RemoteControlHandle>,
    pub(crate) plugin_startup_tasks: crate::PluginStartupTasks,
}

impl MessageProcessor {
    /// Create a new `MessageProcessor`, retaining a handle to the outgoing
    /// `Sender` so handlers can enqueue messages to be written to stdout.
    pub(crate) fn new(args: MessageProcessorArgs) -> Self {
        let MessageProcessorArgs {
            outgoing,
            analytics_events_client,
            arg0_paths,
            config,
            config_manager,
            environment_manager,
            feedback,
            log_db,
            state_db,
            config_warnings,
            session_source,
            auth_manager,
            installation_id,
            rpc_transport,
            remote_control_handle,
            plugin_startup_tasks,
        } = args;
        auth_manager.set_external_auth(Arc::new(ExternalAuthRefreshBridge {
            outgoing: outgoing.clone(),
        }));
        let thread_state_manager = ThreadStateManager::new();
        // The thread store is intentionally process-scoped. Config reloads can
        // affect per-thread behavior, but they must not move newly started,
        // resumed, or forked threads to a different persistence backend/root.
        let thread_store = crewon_core::thread_store_from_config(config.as_ref(), state_db.clone());
        let environment_manager_for_requests = Arc::clone(&environment_manager);
        let environment_manager_for_extensions = Arc::clone(&environment_manager);
        let restriction_product = session_source.restriction_product();
        let executor_skill_provider: Arc<dyn crewon_skills_extension::SkillProvider> = Arc::new(
            crewon_skills_extension::ExecutorSkillProvider::new_with_restriction_product(
                environment_manager_for_extensions,
                restriction_product,
            ),
        );
        let goal_service = Arc::new(GoalService::new());
        let thread_manager = Arc::new_cyclic(|thread_manager| {
            ThreadManager::new(
                config.as_ref(),
                auth_manager.clone(),
                session_source,
                environment_manager,
                thread_extensions(
                    guardian_agent_spawner(thread_manager.clone()),
                    ThreadExtensionDependencies {
                        event_sink: app_server_extension_event_sink(
                            outgoing.clone(),
                            thread_state_manager.clone(),
                        ),
                        auth_manager: auth_manager.clone(),
                        state_db: state_db.clone(),
                        analytics_events_client: analytics_events_client.clone(),
                        thread_manager: thread_manager.clone(),
                        goal_service: Arc::clone(&goal_service),
                        executor_skill_provider: Arc::clone(&executor_skill_provider),
                        thread_store: Arc::clone(&thread_store),
                    },
                ),
                Some(analytics_events_client.clone()),
                Arc::clone(&thread_store),
                state_db.clone(),
                installation_id,
                Some(app_server_attestation_provider(
                    outgoing.clone(),
                    thread_state_manager.clone(),
                )),
            )
        });
        thread_manager
            .plugins_manager()
            .set_analytics_events_client(analytics_events_client.clone());
        let skills_watcher = SkillsWatcher::new(thread_manager.skills_manager(), outgoing.clone());

        let pending_thread_unloads = Arc::new(Mutex::new(HashSet::new()));
        let thread_watch_manager =
            crate::thread_status::ThreadWatchManager::new_with_outgoing(outgoing.clone());
        let thread_list_state_permit = Arc::new(Semaphore::new(/*permits*/ 1));
        let workspace_settings_cache =
            Arc::new(workspace_settings::WorkspaceSettingsCache::default());
        let app_list_shutdown_token = CancellationToken::new();
        let account_processor = AccountRequestProcessor::new(
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            outgoing.clone(),
            Arc::clone(&config),
            config_manager.clone(),
        );
        let agent_platform_processor =
            AgentPlatformRequestProcessor::new(config.codex_home.to_path_buf(), outgoing.clone());
        let apps_processor = AppsRequestProcessor::new(
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            outgoing.clone(),
            config_manager.clone(),
            Arc::clone(&workspace_settings_cache),
            app_list_shutdown_token,
        );
        let catalog_processor = CatalogRequestProcessor::new(
            outgoing.clone(),
            Arc::clone(&skills_watcher),
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            Arc::clone(&config),
            config_manager.clone(),
            Arc::clone(&workspace_settings_cache),
        );
        let command_exec_processor = CommandExecRequestProcessor::new(
            arg0_paths.clone(),
            Arc::clone(&config),
            outgoing.clone(),
            config_manager.clone(),
            Arc::clone(&environment_manager_for_requests),
        );
        let crewon_domain_processor = CrewonDomainRequestProcessor::new();
        let process_exec_processor = ProcessExecRequestProcessor::new(
            outgoing.clone(),
            Arc::clone(&environment_manager_for_requests),
        );
        let feedback_processor = FeedbackRequestProcessor::new(
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            Arc::clone(&config),
            feedback,
            log_db.clone(),
            state_db.clone(),
        );
        let git_processor = GitRequestProcessor::new();
        let initialize_processor = InitializeRequestProcessor::new(
            outgoing.clone(),
            analytics_events_client.clone(),
            Arc::clone(&config),
            config_warnings,
            rpc_transport,
        );
        let knowledge_processor = KnowledgeRequestProcessor::new();
        let marketplace_processor = MarketplaceRequestProcessor::new(
            Arc::clone(&config),
            config_manager.clone(),
            Arc::clone(&thread_manager),
        );
        let mcp_processor = McpRequestProcessor::new(
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            outgoing.clone(),
            config_manager.clone(),
        );
        let mcp_config_processor =
            McpConfigRequestProcessor::new(config_manager.clone(), Arc::clone(&thread_manager));
        let plugin_processor = PluginRequestProcessor::new(
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            outgoing.clone(),
            analytics_events_client.clone(),
            config_manager.clone(),
            workspace_settings_cache,
        );
        let remote_control_processor = RemoteControlRequestProcessor::new(remote_control_handle);
        let search_processor = SearchRequestProcessor::new(outgoing.clone());
        let thread_goal_processor = ThreadGoalRequestProcessor::new(
            Arc::clone(&thread_manager),
            outgoing.clone(),
            Arc::clone(&config),
            thread_state_manager.clone(),
            state_db.clone(),
            Arc::clone(&goal_service),
        );
        let turn_processor = TurnRequestProcessor::new(
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            outgoing.clone(),
            analytics_events_client.clone(),
            arg0_paths.clone(),
            Arc::clone(&config),
            config_manager.clone(),
            Arc::clone(&pending_thread_unloads),
            thread_state_manager.clone(),
            thread_watch_manager.clone(),
            Arc::clone(&thread_list_state_permit),
            Arc::clone(&skills_watcher),
        );
        let office_auto_dispatch = Some(OfficeAutoDispatchContext {
            domain_processor: Arc::new(CrewonDomainRequestProcessor::new()),
            outgoing: outgoing.clone(),
            thread_manager: Arc::clone(&thread_manager),
            turn_processor: turn_processor.clone(),
            completion_monitors: Arc::new(Mutex::new(HashSet::new())),
        });
        let thread_processor = ThreadRequestProcessor::new(
            auth_manager.clone(),
            Arc::clone(&thread_manager),
            outgoing.clone(),
            arg0_paths.clone(),
            Arc::clone(&config),
            config_manager.clone(),
            Arc::clone(&thread_store),
            pending_thread_unloads,
            thread_state_manager,
            thread_watch_manager,
            thread_list_state_permit,
            thread_goal_processor.clone(),
            state_db,
            log_db,
            Arc::clone(&skills_watcher),
            office_auto_dispatch,
        );
        let automation_scheduler = AutomationScheduler::new(
            config.codex_home.to_path_buf(),
            thread_processor.clone(),
            turn_processor.clone(),
        );
        if matches!(plugin_startup_tasks, crate::PluginStartupTasks::Start) {
            // Keep plugin startup warmups aligned at app-server startup.
            let on_effective_plugins_changed =
                plugin_processor.effective_plugins_changed_callback();
            thread_manager
                .plugins_manager()
                .maybe_start_plugin_startup_tasks_for_config(
                    &config.plugins_config_input(),
                    auth_manager,
                    Some(on_effective_plugins_changed),
                );
        }
        let config_processor = ConfigRequestProcessor::new(
            outgoing.clone(),
            config_manager.clone(),
            thread_manager.clone(),
            analytics_events_client,
        );
        let external_agent_config_processor = ExternalAgentConfigRequestProcessor::new(
            outgoing.clone(),
            Arc::clone(&thread_manager),
            Arc::clone(&thread_store),
            config_manager.clone(),
            config_processor.clone(),
            arg0_paths,
            config.codex_home.to_path_buf(),
        );
        let environment_processor =
            EnvironmentRequestProcessor::new(thread_manager.environment_manager());
        let fs_processor = FsRequestProcessor::new(
            Arc::clone(&environment_manager_for_requests),
            FsWatchManager::new(outgoing.clone()),
        );
        let windows_sandbox_processor = WindowsSandboxRequestProcessor::new(
            outgoing.clone(),
            Arc::clone(&config),
            config_manager,
        );

        let processor = Self {
            outgoing,
            codex_home: config.codex_home.to_path_buf(),
            office_scheduler_recovery_running: Arc::new(AtomicBool::new(false)),
            skills_watcher,
            account_processor,
            agent_platform_processor,
            automation_scheduler: automation_scheduler.clone(),
            apps_processor,
            catalog_processor,
            command_exec_processor,
            crewon_domain_processor,
            process_exec_processor,
            config_processor,
            environment_processor,
            external_agent_config_processor,
            feedback_processor,
            fs_processor,
            git_processor,
            initialize_processor,
            knowledge_processor,
            marketplace_processor,
            mcp_config_processor,
            mcp_processor,
            plugin_processor,
            remote_control_processor,
            search_processor,
            thread_goal_processor,
            thread_processor,
            turn_processor,
            windows_sandbox_processor,
            request_serialization_queues: RequestSerializationQueues::default(),
        };
        automation_scheduler.start();
        if matches!(plugin_startup_tasks, crate::PluginStartupTasks::Start) {
            processor.spawn_office_scheduler_recovery(OFFICE_STARTUP_RECOVERY_CONNECTION_ID);
        }
        processor
    }

    pub(crate) fn clear_runtime_references(&self) {
        self.account_processor.clear_external_auth();
        self.apps_processor.shutdown();
        self.skills_watcher.shutdown();
    }

    fn spawn_office_scheduler_recovery(&self, connection_id: ConnectionId) {
        if self
            .office_scheduler_recovery_running
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        let outgoing = Arc::clone(&self.outgoing);
        let thread_processor = self.thread_processor.clone();
        let codex_home = self.codex_home.clone();
        let recovery_running = Arc::clone(&self.office_scheduler_recovery_running);
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            recovery_running.store(false, Ordering::SeqCst);
            tracing::warn!("skipping office scheduler startup recovery without a Tokio runtime");
            return;
        };
        handle.spawn(async move {
            recover_office_scheduler_on_startup(
                outgoing,
                thread_processor,
                codex_home,
                connection_id,
            )
            .await;
            recovery_running.store(false, Ordering::SeqCst);
        });
    }

    async fn remember_office_scheduler_cwd(&self, cwd: &str) {
        if let Err(err) = record_office_scheduler_workspace_cwd(&self.codex_home, cwd).await {
            tracing::warn!(
                cwd,
                error = %err.message,
                "failed to record office scheduler workspace cwd"
            );
        }
    }

    async fn send_office_run_updated(
        &self,
        cwd: &str,
        file_path: &str,
        config: &serde_json::Value,
        reason: &str,
        source_thread_id: Option<&str>,
        source_turn_id: Option<&str>,
    ) {
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                cwd,
                file_path,
                config,
                reason,
                source_thread_id,
                source_turn_id,
            ))
            .await;
    }

    async fn recover_office_records_from_history(
        &self,
        connection_id: ConnectionId,
        cwd: &str,
        records: &mut [CrewonDomainConfigRecord],
    ) {
        recover_office_records_from_history_with(
            self.outgoing.as_ref(),
            &self.thread_processor,
            connection_id,
            cwd,
            records,
        )
        .await;
    }

    async fn recover_office_scheduler_from_records(
        &self,
        connection_id: ConnectionId,
        cwd: &str,
        records: &mut [CrewonDomainConfigRecord],
    ) {
        recover_office_scheduler_from_records_with(
            &self.crewon_domain_processor,
            self.outgoing.as_ref(),
            &self.thread_processor,
            connection_id,
            cwd,
            records,
        )
        .await;
    }

    pub(crate) async fn process_request(
        self: &Arc<Self>,
        connection_id: ConnectionId,
        request: JSONRPCRequest,
        transport: &AppServerTransport,
        session: Arc<ConnectionSessionState>,
    ) {
        let request_method = request.method.as_str();
        tracing::trace!(
            ?connection_id,
            request_id = ?request.id,
            "app-server request: {request_method}"
        );
        let request_id = ConnectionRequestId {
            connection_id,
            request_id: request.id.clone(),
        };
        let request_span =
            crate::app_server_tracing::request_span(&request, transport, connection_id, &session);
        let request_trace = request.trace.as_ref().map(|trace| W3cTraceContext {
            traceparent: trace.traceparent.clone(),
            tracestate: trace.tracestate.clone(),
        });
        let request_context = RequestContext::new(request_id.clone(), request_span, request_trace);
        Self::run_request_with_context(
            Arc::clone(&self.outgoing),
            request_context.clone(),
            async {
                let crewon_request = serde_json::to_value(&request)
                    .map_err(|err| invalid_request(format!("Invalid request: {err}")))
                    .and_then(|request_json| {
                        serde_json::from_value::<ClientRequest>(request_json)
                            .map_err(|err| invalid_request(format!("Invalid request: {err}")))
                    });
                let result = match crewon_request {
                    Ok(crewon_request) => {
                        // Websocket callers finalize outbound readiness in lib.rs after mirroring
                        // session state into outbound state and sending initialize notifications to
                        // this specific connection. Passing `None` avoids marking the connection
                        // ready too early from inside the shared request handler.
                        self.handle_client_request(
                            request_id.clone(),
                            crewon_request,
                            Arc::clone(&session),
                            /*outbound_initialized*/ None,
                            request_context.clone(),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    self.outgoing.send_error(request_id.clone(), error).await;
                }
            },
        )
        .await;
    }

    /// Handles a typed request path used by in-process embedders.
    ///
    /// This bypasses JSON request deserialization but keeps identical request
    /// semantics by delegating to `handle_client_request`.
    pub(crate) async fn process_client_request(
        self: &Arc<Self>,
        connection_id: ConnectionId,
        request: ClientRequest,
        session: Arc<ConnectionSessionState>,
        outbound_initialized: &AtomicBool,
    ) {
        let request_id = ConnectionRequestId {
            connection_id,
            request_id: request.id().clone(),
        };
        let request_span =
            crate::app_server_tracing::typed_request_span(&request, connection_id, &session);
        let request_context =
            RequestContext::new(request_id.clone(), request_span, /*parent_trace*/ None);
        tracing::trace!(
            ?connection_id,
            request_id = ?request_id.request_id,
            "app-server typed request"
        );
        Self::run_request_with_context(
            Arc::clone(&self.outgoing),
            request_context.clone(),
            async {
                // In-process clients do not have the websocket transport loop that performs
                // post-initialize bookkeeping, so they still finalize outbound readiness in
                // the shared request handler.
                let result = self
                    .handle_client_request(
                        request_id.clone(),
                        request,
                        Arc::clone(&session),
                        Some(outbound_initialized),
                        request_context.clone(),
                    )
                    .await;
                if let Err(error) = result {
                    self.outgoing.send_error(request_id.clone(), error).await;
                }
            },
        )
        .await;
    }

    pub(crate) async fn process_notification(&self, notification: JSONRPCNotification) {
        // Currently, we do not expect to receive any notifications from the
        // client, so we just log them.
        tracing::info!("<- notification: {:?}", notification);
    }

    /// Handles typed notifications from in-process clients.
    pub(crate) async fn process_client_notification(&self, notification: ClientNotification) {
        // Currently, we do not expect to receive any typed notifications from
        // in-process clients, so we just log them.
        tracing::info!("<- typed notification: {:?}", notification);
    }

    async fn run_request_with_context<F>(
        outgoing: Arc<OutgoingMessageSender>,
        request_context: RequestContext,
        request_fut: F,
    ) where
        F: Future<Output = ()>,
    {
        outgoing
            .register_request_context(request_context.clone())
            .await;
        request_fut.instrument(request_context.span()).await;
    }

    pub(crate) fn thread_created_receiver(&self) -> broadcast::Receiver<ThreadId> {
        self.thread_processor.thread_created_receiver()
    }

    pub(crate) async fn send_initialize_notifications_to_connection(
        &self,
        connection_id: ConnectionId,
    ) {
        self.initialize_processor
            .send_initialize_notifications_to_connection(connection_id)
            .await;
    }

    pub(crate) async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        request_attestation: bool,
    ) {
        self.thread_processor
            .connection_initialized(
                connection_id,
                ConnectionCapabilities {
                    request_attestation,
                },
            )
            .await;
        self.spawn_office_scheduler_recovery(connection_id);
    }

    pub(crate) async fn send_initialize_notifications(&self) {
        self.initialize_processor
            .send_initialize_notifications()
            .await;
    }

    pub(crate) async fn try_attach_thread_listener(
        &self,
        thread_id: ThreadId,
        connection_ids: Vec<ConnectionId>,
    ) {
        self.thread_processor
            .try_attach_thread_listener(thread_id, connection_ids)
            .await;
    }

    pub(crate) async fn drain_background_tasks(&self) {
        self.thread_processor.drain_background_tasks().await;
    }

    pub(crate) async fn cancel_active_login(&self) {
        self.account_processor.cancel_active_login().await;
    }

    pub(crate) async fn clear_all_thread_listeners(&self) {
        self.thread_processor.clear_all_thread_listeners().await;
    }

    pub(crate) async fn shutdown_threads(&self) {
        self.thread_processor.shutdown_threads().await;
    }

    pub(crate) async fn connection_closed(
        &self,
        connection_id: ConnectionId,
        session_state: &ConnectionSessionState,
    ) {
        session_state.cancellation.cancel();
        if timeout(
            CONNECTION_RPC_DRAIN_TIMEOUT,
            session_state.rpc_gate.shutdown(),
        )
        .await
        .is_err()
        {
            tracing::warn!(
                ?connection_id,
                timeout_seconds = CONNECTION_RPC_DRAIN_TIMEOUT.as_secs(),
                "timed out waiting for connection RPCs to drain"
            );
        }
        self.outgoing.connection_closed(connection_id).await;
        self.agent_platform_processor
            .connection_closed(connection_id)
            .await;
        self.fs_processor.connection_closed(connection_id).await;
        self.command_exec_processor
            .connection_closed(connection_id)
            .await;
        self.process_exec_processor
            .connection_closed(connection_id)
            .await;
        self.thread_processor.connection_closed(connection_id).await;
    }

    pub(crate) fn subscribe_running_assistant_turn_count(&self) -> watch::Receiver<usize> {
        self.thread_processor
            .subscribe_running_assistant_turn_count()
    }

    /// Handle a standalone JSON-RPC response originating from the peer.
    pub(crate) async fn process_response(&self, response: JSONRPCResponse) {
        tracing::info!("<- response: {:?}", response);
        let JSONRPCResponse { id, result, .. } = response;
        self.outgoing.notify_client_response(id, result).await
    }

    /// Handle an error object received from the peer.
    pub(crate) async fn process_error(&self, err: JSONRPCError) {
        tracing::error!("<- error: {:?}", err);
        self.outgoing.notify_client_error(err.id, err.error).await;
    }

    async fn handle_client_request(
        self: &Arc<Self>,
        connection_request_id: ConnectionRequestId,
        crewon_request: ClientRequest,
        session: Arc<ConnectionSessionState>,
        // `Some(...)` means the caller wants initialize to immediately mark the
        // connection outbound-ready. Websocket JSON-RPC calls pass `None` so
        // lib.rs can deliver connection-scoped initialize notifications first.
        outbound_initialized: Option<&AtomicBool>,
        request_context: RequestContext,
    ) -> Result<(), JSONRPCErrorError> {
        let connection_id = connection_request_id.connection_id;
        if let ClientRequest::Initialize { request_id, params } = crewon_request {
            let connection_initialized = self
                .initialize_processor
                .initialize(
                    connection_id,
                    request_id,
                    params,
                    &session,
                    outbound_initialized,
                )
                .await?;
            if connection_initialized {
                self.thread_processor
                    .connection_initialized(
                        connection_id,
                        ConnectionCapabilities {
                            request_attestation: session.request_attestation(),
                        },
                    )
                    .await;
                self.spawn_office_scheduler_recovery(connection_id);
            }
            return Ok(());
        }

        self.dispatch_initialized_client_request(
            connection_request_id,
            crewon_request,
            session,
            request_context,
        )
        .await
    }

    async fn dispatch_initialized_client_request(
        self: &Arc<Self>,
        connection_request_id: ConnectionRequestId,
        crewon_request: ClientRequest,
        session: Arc<ConnectionSessionState>,
        request_context: RequestContext,
    ) -> Result<(), JSONRPCErrorError> {
        if !session.initialized() {
            return Err(invalid_request("Not initialized"));
        }

        if let Some(reason) = crewon_request.experimental_reason()
            && !session.experimental_api_enabled()
        {
            return Err(invalid_request(experimental_required_message(reason)));
        }
        let connection_id = connection_request_id.connection_id;
        self.initialize_processor.track_initialized_request(
            connection_id,
            connection_request_id.request_id.clone(),
            &crewon_request,
        );

        let serialization_scope = crewon_request.serialization_scope();
        let app_server_client_name = session.app_server_client_name().map(str::to_string);
        let client_version = session.client_version().map(str::to_string);
        let connection_cancellation = session.cancellation_token();
        let error_request_id = connection_request_id.clone();
        let rpc_gate = Arc::clone(&session.rpc_gate);
        let processor = Arc::clone(self);
        let span = request_context.span();
        let request = QueuedInitializedRequest::new(
            rpc_gate,
            async move {
                let processor_for_request = Arc::clone(&processor);
                let result = processor_for_request
                    .handle_initialized_client_request(
                        connection_request_id,
                        crewon_request,
                        request_context,
                        app_server_client_name,
                        client_version,
                        connection_cancellation,
                    )
                    .await;
                if let Err(error) = result {
                    processor.outgoing.send_error(error_request_id, error).await;
                }
            }
            .instrument(span),
        );

        if let Some(scope) = serialization_scope {
            let (key, access) = RequestSerializationQueueKey::from_scope(connection_id, scope);
            self.request_serialization_queues
                .enqueue(key, access, request)
                .await;
        } else {
            tokio::spawn(async move {
                request.run().await;
            });
        }
        Ok(())
    }

    async fn handle_initialized_client_request(
        self: Arc<Self>,
        connection_request_id: ConnectionRequestId,
        crewon_request: ClientRequest,
        request_context: RequestContext,
        app_server_client_name: Option<String>,
        client_version: Option<String>,
        connection_cancellation: CancellationToken,
    ) -> Result<(), JSONRPCErrorError> {
        let connection_id = connection_request_id.connection_id;
        let request_id = ConnectionRequestId {
            connection_id,
            request_id: crewon_request.id().clone(),
        };

        let result: Result<Option<ClientResponsePayload>, JSONRPCErrorError> = match crewon_request
        {
            ClientRequest::Initialize { .. } => {
                panic!("Initialize should be handled before initialized request dispatch");
            }
            ClientRequest::ConfigRead { params, .. } => self
                .config_processor
                .read(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::WindowsSandboxReadiness { .. } => self
                .windows_sandbox_processor
                .windows_sandbox_readiness()
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ExternalAgentConfigDetect { params, .. } => self
                .external_agent_config_processor
                .detect(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ExternalAgentConfigImport { params, .. } => self
                .external_agent_config_processor
                .import(request_id.clone(), params)
                .await
                .map(|()| None),
            ClientRequest::ConfigValueWrite { params, .. } => {
                self.config_processor.value_write(params).await.map(Some)
            }
            ClientRequest::ConfigBatchWrite { params, .. } => {
                self.config_processor.batch_write(params).await.map(Some)
            }
            ClientRequest::ExperimentalFeatureEnablementSet { params, .. } => {
                self.config_processor
                    .experimental_feature_enablement_set(request_id.clone(), params)
                    .await
            }
            ClientRequest::RemoteControlEnable { .. } => self
                .remote_control_processor
                .enable()
                .map(|response| Some(response.into())),
            ClientRequest::RemoteControlDisable { .. } => self
                .remote_control_processor
                .disable()
                .map(|response| Some(response.into())),
            ClientRequest::RemoteControlStatusRead { .. } => self
                .remote_control_processor
                .status_read()
                .map(|response| Some(response.into())),
            ClientRequest::RemoteControlPairingStart { params, .. } => self
                .remote_control_processor
                .pairing_start(params, app_server_client_name.as_deref())
                .await
                .map(|response| Some(response.into())),
            ClientRequest::RemoteControlPairingStatus { params, .. } => self
                .remote_control_processor
                .pairing_status(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::RemoteControlClientsList { params, .. } => self
                .remote_control_processor
                .clients_list(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::RemoteControlClientsRevoke { params, .. } => self
                .remote_control_processor
                .clients_revoke(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ConfigRequirementsRead { params: _, .. } => self
                .config_processor
                .config_requirements_read()
                .await
                .map(|response| Some(response.into())),
            ClientRequest::EnvironmentAdd { params, .. } => {
                self.environment_processor.environment_add(params).await
            }
            ClientRequest::FsReadFile { params, .. } => self
                .fs_processor
                .read_file(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsWriteFile { params, .. } => self
                .fs_processor
                .write_file(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsCreateDirectory { params, .. } => self
                .fs_processor
                .create_directory(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsGetMetadata { params, .. } => self
                .fs_processor
                .get_metadata(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsReadDirectory { params, .. } => self
                .fs_processor
                .read_directory(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsRemove { params, .. } => self
                .fs_processor
                .remove(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsCopy { params, .. } => self
                .fs_processor
                .copy(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsWatch { params, .. } => self
                .fs_processor
                .watch(connection_id, params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FsUnwatch { params, .. } => self
                .fs_processor
                .unwatch(connection_id, params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ModelProviderCapabilitiesRead { params: _, .. } => self
                .config_processor
                .model_provider_capabilities_read()
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ThreadStart { params, .. } => {
                self.thread_processor
                    .thread_start(
                        request_id.clone(),
                        params,
                        app_server_client_name.clone(),
                        client_version.clone(),
                        request_context,
                    )
                    .await
            }
            ClientRequest::ThreadUnsubscribe { params, .. } => {
                self.thread_processor
                    .thread_unsubscribe(&request_id, params)
                    .await
            }
            ClientRequest::ThreadResume { params, .. } => {
                self.thread_processor
                    .thread_resume(
                        request_id.clone(),
                        params,
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
            }
            ClientRequest::ThreadFork { params, .. } => {
                self.thread_processor
                    .thread_fork(
                        request_id.clone(),
                        params,
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
            }
            ClientRequest::ThreadArchive { params, .. } => {
                self.thread_processor
                    .thread_archive(request_id.clone(), params)
                    .await
            }
            ClientRequest::ThreadDelete { params, .. } => {
                self.thread_processor
                    .thread_delete(request_id.clone(), params)
                    .await
            }
            ClientRequest::ThreadIncrementElicitation { params, .. } => {
                self.thread_processor
                    .thread_increment_elicitation(params)
                    .await
            }
            ClientRequest::ThreadDecrementElicitation { params, .. } => {
                self.thread_processor
                    .thread_decrement_elicitation(params)
                    .await
            }
            ClientRequest::ThreadSetName { params, .. } => {
                self.thread_processor
                    .thread_set_name(request_id.clone(), params)
                    .await
            }
            ClientRequest::ThreadGoalSet { params, .. } => {
                self.thread_goal_processor
                    .thread_goal_set(request_id.clone(), params)
                    .await
            }
            ClientRequest::ThreadGoalGet { params, .. } => {
                self.thread_goal_processor.thread_goal_get(params).await
            }
            ClientRequest::ThreadGoalClear { params, .. } => {
                self.thread_goal_processor
                    .thread_goal_clear(request_id.clone(), params)
                    .await
            }
            ClientRequest::ThreadMetadataUpdate { params, .. } => {
                self.thread_processor.thread_metadata_update(params).await
            }
            ClientRequest::ThreadSettingsUpdate { params, .. } => {
                self.turn_processor
                    .thread_settings_update(&request_id, params)
                    .await
            }
            ClientRequest::ThreadMemoryModeSet { params, .. } => {
                self.thread_processor.thread_memory_mode_set(params).await
            }
            ClientRequest::MemoryReset { .. } => self.thread_processor.memory_reset().await,
            ClientRequest::ThreadUnarchive { params, .. } => {
                self.thread_processor
                    .thread_unarchive(request_id.clone(), params)
                    .await
            }
            ClientRequest::ThreadCompactStart { params, .. } => {
                self.thread_processor
                    .thread_compact_start(&request_id, params)
                    .await
            }
            ClientRequest::ThreadBackgroundTerminalsClean { params, .. } => {
                self.thread_processor
                    .thread_background_terminals_clean(&request_id, params)
                    .await
            }
            ClientRequest::ThreadBackgroundTerminalsList { params, .. } => {
                self.thread_processor
                    .thread_background_terminals_list(params)
                    .await
            }
            ClientRequest::ThreadBackgroundTerminalsTerminate { params, .. } => {
                self.thread_processor
                    .thread_background_terminals_terminate(params)
                    .await
            }
            ClientRequest::ThreadRollback { params, .. } => {
                self.thread_processor
                    .thread_rollback(&request_id, params)
                    .await
            }
            ClientRequest::ThreadList { params, .. } => {
                let response = self.thread_processor.thread_list_response(params).await?;
                Ok(Some(response.into()))
            }
            ClientRequest::ThreadSearch { params, .. } => {
                self.thread_processor.thread_search(params).await
            }
            ClientRequest::ThreadLoadedList { params, .. } => {
                self.thread_processor.thread_loaded_list(params).await
            }
            ClientRequest::ThreadRead { params, .. } => {
                let response = self.thread_processor.thread_read_response(params).await?;
                Ok(Some(response.into()))
            }
            ClientRequest::ThreadTurnsList { params, .. } => {
                self.thread_processor.thread_turns_list(params).await
            }
            ClientRequest::ThreadTurnsItemsList { params, .. } => {
                self.thread_processor.thread_turns_items_list(params).await
            }
            ClientRequest::ThreadShellCommand { params, .. } => {
                self.thread_processor
                    .thread_shell_command(&request_id, params)
                    .await
            }
            ClientRequest::ThreadApproveGuardianDeniedAction { params, .. } => {
                self.thread_processor
                    .thread_approve_guardian_denied_action(&request_id, params)
                    .await
            }
            ClientRequest::GetConversationSummary { params, .. } => {
                self.thread_processor.conversation_summary(params).await
            }
            ClientRequest::SkillsList { params, .. } => {
                self.catalog_processor.skills_list(params).await
            }
            ClientRequest::SkillsCreate { params, .. } => {
                self.catalog_processor.skills_create(params).await
            }
            ClientRequest::SkillsExtraRootsSet { params, .. } => {
                self.catalog_processor.skills_extra_roots_set(params).await
            }
            ClientRequest::HooksList { params, .. } => {
                self.catalog_processor.hooks_list(params).await
            }
            ClientRequest::MarketplaceAdd { params, .. } => {
                self.marketplace_processor.marketplace_add(params).await
            }
            ClientRequest::MarketplaceRemove { params, .. } => {
                self.marketplace_processor.marketplace_remove(params).await
            }
            ClientRequest::MarketplaceUpgrade { params, .. } => {
                self.marketplace_processor.marketplace_upgrade(params).await
            }
            ClientRequest::PluginList { params, .. } => {
                self.plugin_processor.plugin_list(params).await
            }
            ClientRequest::PluginInstalled { params, .. } => {
                self.plugin_processor.plugin_installed(params).await
            }
            ClientRequest::PluginRead { params, .. } => {
                self.plugin_processor.plugin_read(params).await
            }
            ClientRequest::PluginSkillRead { params, .. } => {
                self.plugin_processor.plugin_skill_read(params).await
            }
            ClientRequest::PluginShareSave { params, .. } => {
                self.plugin_processor.plugin_share_save(params).await
            }
            ClientRequest::PluginShareUpdateTargets { params, .. } => {
                self.plugin_processor
                    .plugin_share_update_targets(params)
                    .await
            }
            ClientRequest::PluginShareList { params, .. } => {
                self.plugin_processor.plugin_share_list(params).await
            }
            ClientRequest::PluginShareCheckout { params, .. } => {
                self.plugin_processor.plugin_share_checkout(params).await
            }
            ClientRequest::PluginShareDelete { params, .. } => {
                self.plugin_processor.plugin_share_delete(params).await
            }
            ClientRequest::AppsList { params, .. } => {
                self.apps_processor.apps_list(&request_id, params).await
            }
            ClientRequest::AgentList { params, .. } => self
                .crewon_domain_processor
                .agent_list(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentSave { params, .. } => self
                .crewon_domain_processor
                .agent_save(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentCreate { params, .. } => self
                .crewon_domain_processor
                .agent_create(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentUpdate { params, .. } => self
                .crewon_domain_processor
                .agent_update(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentRead { params, .. } => self
                .crewon_domain_processor
                .agent_read(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentRecruitableList { params, .. } => self
                .crewon_domain_processor
                .agent_recruitable_list(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentDelete { params, .. } => self
                .crewon_domain_processor
                .agent_delete(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentPlatformAuth { params, .. } => self
                .agent_platform_processor
                .authenticate(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentPlatformAgentInfo { params, .. } => self
                .agent_platform_processor
                .agent_info(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentPlatformChat { params, .. } => self
                .agent_platform_processor
                .chat(connection_id, params, connection_cancellation)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentPlatformChatStart { params, .. } => self
                .agent_platform_processor
                .chat_start(connection_id, params, connection_cancellation)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentPlatformRunCancel { params, .. } => Ok(Some(
                self.agent_platform_processor
                    .run_cancel(connection_id, params)
                    .await
                    .into(),
            )),
            ClientRequest::AgentPlatformSessionRead { params, .. } => self
                .agent_platform_processor
                .session_read(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AgentPlatformSessionClear { params, .. } => self
                .agent_platform_processor
                .session_clear(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OfficeList { params, .. } => {
                let cwd = params.cwd.clone();
                let mut response = self.crewon_domain_processor.office_list(params).await?;
                self.recover_office_records_from_history(connection_id, &cwd, &mut response.data)
                    .await;
                self.recover_office_scheduler_from_records(connection_id, &cwd, &mut response.data)
                    .await;
                if !response.data.is_empty() {
                    self.remember_office_scheduler_cwd(&cwd).await;
                }
                Ok(Some(response.into()))
            }
            ClientRequest::OfficeSave { params, .. } => {
                let cwd = params.cwd.clone();
                let response = self.crewon_domain_processor.office_save(params).await?;
                self.remember_office_scheduler_cwd(&cwd).await;
                Ok(Some(response.into()))
            }
            ClientRequest::OfficeCreate { params, .. } => {
                let cwd = params.cwd.clone();
                let response = self.crewon_domain_processor.office_create(params).await?;
                self.remember_office_scheduler_cwd(&cwd).await;
                Ok(Some(response.into()))
            }
            ClientRequest::OfficeRead { params, .. } => {
                let cwd = params.cwd.clone();
                let mut response = self.crewon_domain_processor.office_read(params).await?;
                if let Some(record) = response.record.as_mut() {
                    self.recover_office_records_from_history(
                        connection_id,
                        &cwd,
                        std::slice::from_mut(record),
                    )
                    .await;
                    self.recover_office_scheduler_from_records(
                        connection_id,
                        &cwd,
                        std::slice::from_mut(record),
                    )
                    .await;
                }
                if response.record.is_some() {
                    self.remember_office_scheduler_cwd(&cwd).await;
                }
                Ok(Some(response.into()))
            }
            ClientRequest::OfficeMessageSend { params, .. } => self
                .crewon_domain_processor
                .office_message_send(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OfficeRun { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_run_prepare(params)
                    .await?;
                let turn_response = match self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: prepared.thread_id.clone(),
                            client_user_message_id: prepared.client_user_message_id.clone(),
                            input: vec![UserInput::Text {
                                text: prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_run_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                error = %mark_error.message,
                                "failed to mark office run as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_run_mark_started(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &turn_response.turn.id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "started",
                    Some(&prepared.thread_id),
                    Some(&turn_response.turn.id),
                )
                .await;
                self.remember_office_scheduler_cwd(&prepared.cwd).await;
                Ok(Some(
                    OfficeRunResponse {
                        file_path,
                        config,
                        thread_id: prepared.thread_id,
                        run_id: prepared.run_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::OfficeRunSync { params, .. } => {
                let cwd = params.cwd.clone();
                let turn = params.turn.clone();
                let synced = self.crewon_domain_processor.office_run_sync(params).await?;
                self.send_office_run_updated(
                    &cwd,
                    &synced.file_path,
                    &synced.config,
                    "synced",
                    Some(&synced.source_thread_id),
                    Some(&synced.source_turn_id),
                )
                .await;
                self.remember_office_scheduler_cwd(&cwd).await;
                let response = OfficeRunSyncResponse {
                    file_path: synced.file_path,
                    config: synced.config,
                };
                if matches!(turn.status, TurnStatus::Completed) {
                    let _ = self
                        .thread_processor
                        .dispatch_office_after_terminal_turn(
                            &cwd,
                            &synced.source_thread_id,
                            turn,
                            connection_id,
                        )
                        .await;
                }
                Ok(Some(response.into()))
            }
            ClientRequest::OfficeRunRetry { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_run_retry_prepare(params)
                    .await?;
                let turn_response = match self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: prepared.thread_id.clone(),
                            client_user_message_id: prepared.client_user_message_id.clone(),
                            input: vec![UserInput::Text {
                                text: prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_run_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                error = %mark_error.message,
                                "failed to mark retried office run as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_run_mark_started(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &turn_response.turn.id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "retryStarted",
                    Some(&prepared.thread_id),
                    Some(&turn_response.turn.id),
                )
                .await;
                Ok(Some(
                    OfficeRunRetryResponse {
                        file_path,
                        config,
                        thread_id: prepared.thread_id,
                        run_id: prepared.run_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::OfficeDelegationDispatch { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_delegation_dispatch_prepare(params)
                    .await?;
                let turn_response = match self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: prepared.thread_id.clone(),
                            client_user_message_id: prepared.client_user_message_id.clone(),
                            input: vec![UserInput::Text {
                                text: prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_delegation_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.delegation_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                delegation_id = %prepared.delegation_id,
                                error = %mark_error.message,
                                "failed to mark office delegation dispatch as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_delegation_dispatch_mark_started(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &prepared.delegation_id,
                        &turn_response.turn.id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "delegationStarted",
                    Some(&prepared.thread_id),
                    Some(&turn_response.turn.id),
                )
                .await;
                Ok(Some(
                    OfficeDelegationDispatchResponse {
                        file_path,
                        config,
                        run_id: prepared.run_id,
                        delegation_id: prepared.delegation_id,
                        thread_id: prepared.thread_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::OfficeDelegationDispatchNext { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_delegation_dispatch_next_prepare(params)
                    .await?;
                let turn_response = match self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: prepared.thread_id.clone(),
                            client_user_message_id: prepared.client_user_message_id.clone(),
                            input: vec![UserInput::Text {
                                text: prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_delegation_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.delegation_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                delegation_id = %prepared.delegation_id,
                                error = %mark_error.message,
                                "failed to mark next office delegation dispatch as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_delegation_dispatch_mark_started(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &prepared.delegation_id,
                        &turn_response.turn.id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "delegationStarted",
                    Some(&prepared.thread_id),
                    Some(&turn_response.turn.id),
                )
                .await;
                Ok(Some(
                    OfficeDelegationDispatchNextResponse {
                        file_path,
                        config,
                        run_id: prepared.run_id,
                        delegation_id: prepared.delegation_id,
                        thread_id: prepared.thread_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::OfficeDelegationRetry { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_delegation_retry_prepare(params)
                    .await?;
                let Some(retry_of_delegation_id) = prepared.retry_of_delegation_id.clone() else {
                    return Err(internal_error(
                        "office delegation retry prepare did not return a source delegation id",
                    ));
                };
                let turn_response = match self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: prepared.thread_id.clone(),
                            client_user_message_id: prepared.client_user_message_id.clone(),
                            input: vec![UserInput::Text {
                                text: prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_delegation_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.delegation_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                delegation_id = %prepared.delegation_id,
                                error = %mark_error.message,
                                "failed to mark office delegation retry as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_delegation_dispatch_mark_started(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &prepared.delegation_id,
                        &turn_response.turn.id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "delegationRetryStarted",
                    Some(&prepared.thread_id),
                    Some(&turn_response.turn.id),
                )
                .await;
                Ok(Some(
                    OfficeDelegationRetryResponse {
                        file_path,
                        config,
                        run_id: prepared.run_id,
                        delegation_id: prepared.delegation_id,
                        retry_of_delegation_id,
                        thread_id: prepared.thread_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::OfficeVerificationDispatchNext { params, .. } => {
                let mut prepared = self
                    .crewon_domain_processor
                    .office_verification_dispatch_next_prepare(params)
                    .await?;
                let runtime_repair = match self
                    .thread_processor
                    .ensure_office_automation_runtime_thread(
                        &self.crewon_domain_processor,
                        &prepared.cwd,
                        &prepared.automation_file_path,
                        &prepared.automation_id,
                        &mut prepared.automation_config,
                        connection_id,
                    )
                    .await
                {
                    Ok(runtime_repair) => runtime_repair,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config.clone(),
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark office verification runtime repair failure"
                            );
                        }
                        return Err(error);
                    }
                };
                let automation_prepared = match self
                    .crewon_domain_processor
                    .automation_run_start_prepare(AutomationRunStartParams {
                        cwd: prepared.cwd.clone(),
                        config: prepared.automation_config.clone(),
                        note: Some(prepared.note.clone()),
                        locale: prepared.locale.clone(),
                        client_user_message_id: prepared.client_user_message_id.clone(),
                    })
                    .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark office verification dispatch as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let turn_response = match self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: automation_prepared.thread_id.clone(),
                            client_user_message_id: automation_prepared
                                .client_user_message_id
                                .clone(),
                            input: vec![UserInput::Text {
                                text: automation_prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark next office verification dispatch as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let automation_run_response = match self
                    .crewon_domain_processor
                    .automation_run_start_record(&automation_prepared, &turn_response.turn.id)
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark office verification dispatch record failure"
                            );
                        }
                        return Err(error);
                    }
                };
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_verification_dispatch_mark_started(
                        &prepared.cwd,
                        prepared.config,
                        OfficeVerificationDispatchStarted {
                            run_id: &prepared.run_id,
                            verification_check_id: &prepared.verification_check_id,
                            automation_run_file_path: &automation_run_response.file_path,
                            automation_run_id: &automation_run_response.run.run_id,
                            automation_thread_id: &automation_prepared.thread_id,
                            automation_turn_id: &turn_response.turn.id,
                            runtime_repair_source_thread_id: runtime_repair
                                .as_ref()
                                .map(|repair| repair.source_thread_id.as_str()),
                            runtime_repaired_at: runtime_repair
                                .as_ref()
                                .map(|repair| repair.repaired_at.as_str()),
                        },
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "verificationStarted",
                    Some(&automation_prepared.thread_id),
                    Some(&turn_response.turn.id),
                )
                .await;
                Ok(Some(
                    OfficeVerificationDispatchNextResponse {
                        file_path,
                        config,
                        run_id: prepared.run_id,
                        verification_check_id: prepared.verification_check_id,
                        automation_id: prepared.automation_id,
                        automation_run_file_path: automation_run_response.file_path,
                        automation_run_id: automation_run_response.run.run_id,
                        thread_id: automation_prepared.thread_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::OfficeVerificationRetry { params, .. } => {
                let mut prepared = self
                    .crewon_domain_processor
                    .office_verification_retry_prepare(params)
                    .await?;
                let runtime_repair = match self
                    .thread_processor
                    .ensure_office_automation_runtime_thread(
                        &self.crewon_domain_processor,
                        &prepared.cwd,
                        &prepared.automation_file_path,
                        &prepared.automation_id,
                        &mut prepared.automation_config,
                        connection_id,
                    )
                    .await
                {
                    Ok(runtime_repair) => runtime_repair,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config.clone(),
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark office verification retry runtime repair failure"
                            );
                        }
                        return Err(error);
                    }
                };
                let automation_prepared = match self
                    .crewon_domain_processor
                    .automation_run_start_prepare(AutomationRunStartParams {
                        cwd: prepared.cwd.clone(),
                        config: prepared.automation_config.clone(),
                        note: Some(prepared.note.clone()),
                        locale: prepared.locale.clone(),
                        client_user_message_id: prepared.client_user_message_id.clone(),
                    })
                    .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark office verification retry as failed"
                            );
                        }
                        return Err(error);
                    }
                };
                let turn_response = match self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: automation_prepared.thread_id.clone(),
                            client_user_message_id: automation_prepared
                                .client_user_message_id
                                .clone(),
                            input: vec![UserInput::Text {
                                text: automation_prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark office verification retry turn start failure"
                            );
                        }
                        return Err(error);
                    }
                };
                let automation_run_response = match self
                    .crewon_domain_processor
                    .automation_run_start_record(&automation_prepared, &turn_response.turn.id)
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        if let Err(mark_error) = self
                            .crewon_domain_processor
                            .office_verification_dispatch_mark_failed(
                                &prepared.cwd,
                                prepared.config,
                                &prepared.run_id,
                                &prepared.verification_check_id,
                                &error.message,
                            )
                            .await
                        {
                            tracing::warn!(
                                run_id = %prepared.run_id,
                                verification_check_id = %prepared.verification_check_id,
                                error = %mark_error.message,
                                "failed to mark office verification retry record failure"
                            );
                        }
                        return Err(error);
                    }
                };
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_verification_dispatch_mark_started(
                        &prepared.cwd,
                        prepared.config,
                        OfficeVerificationDispatchStarted {
                            run_id: &prepared.run_id,
                            verification_check_id: &prepared.verification_check_id,
                            automation_run_file_path: &automation_run_response.file_path,
                            automation_run_id: &automation_run_response.run.run_id,
                            automation_thread_id: &automation_prepared.thread_id,
                            automation_turn_id: &turn_response.turn.id,
                            runtime_repair_source_thread_id: runtime_repair
                                .as_ref()
                                .map(|repair| repair.source_thread_id.as_str()),
                            runtime_repaired_at: runtime_repair
                                .as_ref()
                                .map(|repair| repair.repaired_at.as_str()),
                        },
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "verificationRetryStarted",
                    Some(&automation_prepared.thread_id),
                    Some(&turn_response.turn.id),
                )
                .await;
                Ok(Some(
                    OfficeVerificationRetryResponse {
                        file_path,
                        config,
                        run_id: prepared.run_id,
                        verification_check_id: prepared.verification_check_id,
                        automation_id: prepared.automation_id,
                        automation_run_file_path: automation_run_response.file_path,
                        automation_run_id: automation_run_response.run.run_id,
                        retry_of_automation_turn_id: prepared.retry_of_automation_turn_id,
                        thread_id: automation_prepared.thread_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::OfficeRunCancel { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_run_cancel_prepare(params)
                    .await?;
                for target in &prepared.cancel_targets {
                    self.turn_processor
                        .turn_interrupt_without_response(
                            &request_id,
                            TurnInterruptParams {
                                thread_id: target.thread_id.clone(),
                                turn_id: target.turn_id.clone(),
                            },
                        )
                        .await?;
                }
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_run_mark_cancel_requested(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &prepared.turn_id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "canceling",
                    Some(&prepared.thread_id),
                    Some(&prepared.turn_id),
                )
                .await;
                Ok(Some(OfficeRunCancelResponse { file_path, config }.into()))
            }
            ClientRequest::OfficeDelegationCancel { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_delegation_cancel_prepare(params)
                    .await?;
                for target in &prepared.cancel_targets {
                    self.turn_processor
                        .turn_interrupt_without_response(
                            &request_id,
                            TurnInterruptParams {
                                thread_id: target.thread_id.clone(),
                                turn_id: target.turn_id.clone(),
                            },
                        )
                        .await?;
                }
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_delegation_mark_cancel_requested(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &prepared.child_id,
                        &prepared.turn_id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "delegationCanceling",
                    Some(&prepared.thread_id),
                    Some(&prepared.turn_id),
                )
                .await;
                Ok(Some(
                    OfficeDelegationCancelResponse { file_path, config }.into(),
                ))
            }
            ClientRequest::OfficeVerificationCancel { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .office_verification_cancel_prepare(params)
                    .await?;
                for target in &prepared.cancel_targets {
                    self.turn_processor
                        .turn_interrupt_without_response(
                            &request_id,
                            TurnInterruptParams {
                                thread_id: target.thread_id.clone(),
                                turn_id: target.turn_id.clone(),
                            },
                        )
                        .await?;
                }
                let (file_path, config) = self
                    .crewon_domain_processor
                    .office_verification_mark_cancel_requested(
                        &prepared.cwd,
                        prepared.config,
                        &prepared.run_id,
                        &prepared.child_id,
                        &prepared.turn_id,
                    )
                    .await?;
                self.send_office_run_updated(
                    &prepared.cwd,
                    &file_path,
                    &config,
                    "verificationCanceling",
                    Some(&prepared.thread_id),
                    Some(&prepared.turn_id),
                )
                .await;
                Ok(Some(
                    OfficeVerificationCancelResponse { file_path, config }.into(),
                ))
            }
            ClientRequest::OfficeMemberContextPreview { params, .. } => self
                .crewon_domain_processor
                .office_member_context_preview(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OfficeMemberAdd { params, .. } => self
                .crewon_domain_processor
                .office_member_add(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OfficeApprovalDecide { params, .. } => self
                .crewon_domain_processor
                .office_approval_decide(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OfficeArtifactUpsert { params, .. } => self
                .crewon_domain_processor
                .office_artifact_upsert(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OfficeMemoryList { params, .. } => self
                .crewon_domain_processor
                .office_memory_list(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OfficeMemoryDecide { params, .. } => {
                let cwd = params.cwd.clone();
                let thread_id = params
                    .config
                    .get("workspace")
                    .and_then(|workspace| workspace.get("threadId"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let title = params
                    .config
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let response = self
                    .crewon_domain_processor
                    .office_memory_decide(params)
                    .await?;
                if thread_id.is_some() || title.is_some() {
                    match self
                        .crewon_domain_processor
                        .office_read(OfficeReadParams {
                            cwd: cwd.clone(),
                            thread_id,
                            title,
                        })
                        .await
                    {
                        Ok(read) => {
                            if let Some(record) = read.record {
                                self.send_office_run_updated(
                                    &cwd,
                                    &record.file_path,
                                    &record.config,
                                    "memoryDecision",
                                    None,
                                    None,
                                )
                                .await;
                            }
                        }
                        Err(err) => {
                            tracing::warn!(
                                error = %err.message,
                                "failed to read office record after memory decision"
                            );
                        }
                    }
                }
                Ok(Some(response.into()))
            }
            ClientRequest::OfficeDelete { params, .. } => self
                .crewon_domain_processor
                .office_delete(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AutomationList { params, .. } => {
                let cwd = params.cwd.clone();
                let response = self.crewon_domain_processor.automation_list(params).await?;
                self.automation_scheduler.remember_workspace(&cwd).await;
                Ok(Some(response.into()))
            }
            ClientRequest::AutomationSave { params, .. } => {
                let cwd = params.cwd.clone();
                let response = self.crewon_domain_processor.automation_save(params).await?;
                self.automation_scheduler.remember_workspace(&cwd).await;
                Ok(Some(response.into()))
            }
            ClientRequest::AutomationCreate { params, .. } => {
                let cwd = params.cwd.clone();
                let response = self
                    .crewon_domain_processor
                    .automation_create(params)
                    .await?;
                self.automation_scheduler.remember_workspace(&cwd).await;
                Ok(Some(response.into()))
            }
            ClientRequest::AutomationRead { params, .. } => self
                .crewon_domain_processor
                .automation_read(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AutomationUpdate { params, .. } => {
                let cwd = params.cwd.clone();
                let response = self
                    .crewon_domain_processor
                    .automation_update(params)
                    .await?;
                self.automation_scheduler.remember_workspace(&cwd).await;
                Ok(Some(response.into()))
            }
            ClientRequest::AutomationRun { params, .. } => self
                .crewon_domain_processor
                .automation_run(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AutomationRunStart { params, .. } => {
                let prepared = self
                    .crewon_domain_processor
                    .automation_run_start_prepare(params)
                    .await?;
                let turn_response = self
                    .turn_processor
                    .turn_start_response(
                        request_id.clone(),
                        TurnStartParams {
                            thread_id: prepared.thread_id.clone(),
                            client_user_message_id: prepared.client_user_message_id.clone(),
                            input: vec![UserInput::Text {
                                text: prepared.prompt.clone(),
                                text_elements: Vec::new(),
                            }],
                            cwd: Some(std::path::PathBuf::from(prepared.cwd.clone())),
                            ..TurnStartParams::default()
                        },
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await?;
                let run_response = self
                    .crewon_domain_processor
                    .automation_run_start_record(&prepared, &turn_response.turn.id)
                    .await?;
                Ok(Some(
                    AutomationRunStartResponse {
                        file_path: run_response.file_path,
                        run: run_response.run,
                        thread_id: prepared.thread_id,
                        turn: turn_response.turn,
                    }
                    .into(),
                ))
            }
            ClientRequest::AutomationRunUpdate { params, .. } => self
                .crewon_domain_processor
                .automation_run_update(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AutomationRunsList { params, .. } => self
                .crewon_domain_processor
                .automation_runs_list(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::AutomationDelete { params, .. } => self
                .crewon_domain_processor
                .automation_delete(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::KnowledgeList { params, .. } => self
                .knowledge_processor
                .knowledge_list(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::KnowledgeMemoryWrite { params, .. } => self
                .knowledge_processor
                .knowledge_memory_write(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ToolList { params, .. } => self
                .crewon_domain_processor
                .tool_list(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ToolRead { params, .. } => self
                .crewon_domain_processor
                .tool_read(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ToolSave { params, .. } => self
                .crewon_domain_processor
                .tool_save(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ToolUpdate { params, .. } => self
                .crewon_domain_processor
                .tool_update(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::ToolDelete { params, .. } => self
                .crewon_domain_processor
                .tool_delete(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::SkillsConfigWrite { params, .. } => {
                self.catalog_processor.skills_config_write(params).await
            }
            ClientRequest::PluginInstall { params, .. } => {
                self.plugin_processor.plugin_install(params).await
            }
            ClientRequest::PluginUninstall { params, .. } => {
                self.plugin_processor.plugin_uninstall(params).await
            }
            ClientRequest::ModelList { params, .. } => {
                self.catalog_processor.model_list(params).await
            }
            ClientRequest::ExperimentalFeatureList { params, .. } => {
                self.catalog_processor
                    .experimental_feature_list(params)
                    .await
            }
            ClientRequest::PermissionProfileList { params, .. } => {
                self.catalog_processor.permission_profile_list(params).await
            }
            ClientRequest::CollaborationModeList { params, .. } => {
                self.catalog_processor.collaboration_mode_list(params).await
            }
            ClientRequest::SceneList { params, .. } => {
                self.catalog_processor.scene_list(params).await
            }
            ClientRequest::MockExperimentalMethod { params, .. } => {
                self.catalog_processor
                    .mock_experimental_method(params)
                    .await
            }
            ClientRequest::TurnStart { params, .. } => {
                self.turn_processor
                    .turn_start(
                        request_id.clone(),
                        params,
                        app_server_client_name.clone(),
                        client_version.clone(),
                    )
                    .await
            }
            ClientRequest::ThreadInjectItems { params, .. } => {
                self.turn_processor.thread_inject_items(params).await
            }
            ClientRequest::TurnSteer { params, .. } => {
                self.turn_processor.turn_steer(&request_id, params).await
            }
            ClientRequest::TurnInterrupt { params, .. } => {
                self.turn_processor
                    .turn_interrupt(&request_id, params)
                    .await
            }
            ClientRequest::ThreadRealtimeStart { params, .. } => {
                self.turn_processor
                    .thread_realtime_start(&request_id, params)
                    .await
            }
            ClientRequest::ThreadRealtimeAppendAudio { params, .. } => {
                self.turn_processor
                    .thread_realtime_append_audio(&request_id, params)
                    .await
            }
            ClientRequest::ThreadRealtimeAppendText { params, .. } => {
                self.turn_processor
                    .thread_realtime_append_text(&request_id, params)
                    .await
            }
            ClientRequest::ThreadRealtimeStop { params, .. } => {
                self.turn_processor
                    .thread_realtime_stop(&request_id, params)
                    .await
            }
            ClientRequest::ThreadRealtimeListVoices { params: _, .. } => {
                self.turn_processor.thread_realtime_list_voices().await
            }
            ClientRequest::ReviewStart { params, .. } => {
                self.turn_processor.review_start(&request_id, params).await
            }
            ClientRequest::McpServerOauthLogin { params, .. } => {
                self.mcp_processor.mcp_server_oauth_login(params).await
            }
            ClientRequest::McpServerRefresh { params, .. } => {
                self.mcp_processor.mcp_server_refresh(params).await
            }
            ClientRequest::McpServerStatusList { params, .. } => {
                self.mcp_processor
                    .mcp_server_status_list(&request_id, params)
                    .await
            }
            ClientRequest::McpServerConfigList { params, .. } => {
                self.mcp_config_processor.list(params).await
            }
            ClientRequest::McpServerConfigRead { params, .. } => {
                self.mcp_config_processor.read(params).await
            }
            ClientRequest::McpServerConfigSave { params, .. } => {
                self.mcp_config_processor.save(params).await
            }
            ClientRequest::McpServerConfigDelete { params, .. } => {
                self.mcp_config_processor.delete(params).await
            }
            ClientRequest::McpResourceRead { params, .. } => {
                self.mcp_processor
                    .mcp_resource_read(&request_id, params)
                    .await
            }
            ClientRequest::McpServerToolCall { params, .. } => {
                self.mcp_processor
                    .mcp_server_tool_call(&request_id, params)
                    .await
            }
            ClientRequest::WindowsSandboxSetupStart { params, .. } => {
                self.windows_sandbox_processor
                    .windows_sandbox_setup_start(&request_id, params)
                    .await
            }
            ClientRequest::LoginAccount { params, .. } => {
                self.account_processor
                    .login_account(request_id.clone(), params)
                    .await
            }
            ClientRequest::LogoutAccount { .. } => {
                self.account_processor
                    .logout_account(request_id.clone())
                    .await
            }
            ClientRequest::CancelLoginAccount { params, .. } => {
                self.account_processor.cancel_login_account(params).await
            }
            ClientRequest::GetAccount { params, .. } => {
                self.account_processor.get_account(params).await
            }
            ClientRequest::GetAuthStatus { params, .. } => {
                self.account_processor.get_auth_status(params).await
            }
            ClientRequest::GetAccountRateLimits { .. } => {
                self.account_processor.get_account_rate_limits().await
            }
            ClientRequest::GetAccountTokenUsage { .. } => {
                self.account_processor.get_account_token_usage().await
            }
            ClientRequest::SendAddCreditsNudgeEmail { params, .. } => {
                self.account_processor
                    .send_add_credits_nudge_email(params)
                    .await
            }
            ClientRequest::GitDiffToRemote { params, .. } => {
                self.git_processor.git_diff_to_remote(params).await
            }
            ClientRequest::FuzzyFileSearch { params, .. } => self
                .search_processor
                .fuzzy_file_search(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FuzzyFileSearchSessionStart { params, .. } => self
                .search_processor
                .fuzzy_file_search_session_start_response(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FuzzyFileSearchSessionUpdate { params, .. } => self
                .search_processor
                .fuzzy_file_search_session_update_response(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::FuzzyFileSearchSessionStop { params, .. } => self
                .search_processor
                .fuzzy_file_search_session_stop(params)
                .await
                .map(|response| Some(response.into())),
            ClientRequest::OneOffCommandExec { params, .. } => {
                self.command_exec_processor
                    .one_off_command_exec(&request_id, params)
                    .await
            }
            ClientRequest::CommandExecWrite { params, .. } => {
                self.command_exec_processor
                    .command_exec_write(request_id.clone(), params)
                    .await
            }
            ClientRequest::CommandExecResize { params, .. } => {
                self.command_exec_processor
                    .command_exec_resize(request_id.clone(), params)
                    .await
            }
            ClientRequest::CommandExecTerminate { params, .. } => {
                self.command_exec_processor
                    .command_exec_terminate(request_id.clone(), params)
                    .await
            }
            ClientRequest::ProcessSpawn { params, .. } => self
                .process_exec_processor
                .process_spawn(request_id.clone(), params)
                .await
                .map(|()| None),
            ClientRequest::ProcessWriteStdin { params, .. } => {
                self.process_exec_processor
                    .process_write_stdin(request_id.clone(), params)
                    .await
            }
            ClientRequest::ProcessKill { params, .. } => {
                self.process_exec_processor
                    .process_kill(request_id.clone(), params)
                    .await
            }
            ClientRequest::ProcessResizePty { params, .. } => {
                self.process_exec_processor
                    .process_resize_pty(request_id.clone(), params)
                    .await
            }
            ClientRequest::FeedbackUpload { params, .. } => {
                self.feedback_processor.feedback_upload(params).await
            }
        };

        match result {
            Ok(Some(response)) => {
                self.outgoing
                    .send_response_as(request_id.clone(), response)
                    .await;
            }
            Ok(None) => {}
            Err(error) => {
                self.outgoing.send_error(request_id.clone(), error).await;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "message_processor_office_runtime_tests.rs"]
mod message_processor_office_runtime_tests;

#[cfg(test)]
#[path = "message_processor_tracing_tests.rs"]
mod message_processor_tracing_tests;
