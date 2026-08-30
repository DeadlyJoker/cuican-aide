use super::*;
use crate::error_code::method_not_found;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::AutomationUpdateParams;
use crewon_app_server_protocol::SelectedCapabilityRoot;
use crewon_extension_api::ExtensionDataInit;
use crewon_protocol::models::BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS;
use crewon_protocol::models::BUILT_IN_PERMISSION_PROFILE_WORKSPACE;

const THREAD_LIST_DEFAULT_LIMIT: usize = 25;
const THREAD_LIST_MAX_LIMIT: usize = 100;
const OFFICE_SCHEDULER_STARTUP_THREAD_LIMIT: u32 = 25;
const OFFICE_AUTOMATION_RUNTIME_REPAIR_MAX_ID_CHARS: usize = 128;
const OFFICE_AUTOMATION_RUNTIME_REPAIR_MAX_FIELD_CHARS: usize = 1_000;
const OFFICE_AUTOMATION_RUNTIME_REPAIR_MAX_INSTRUCTIONS_CHARS: usize = 4_000;
const OFFICE_AUTOMATION_RUNTIME_REPAIR_TRUNCATED_SUFFIX: &str = " [truncated]";

struct ThreadListFilters {
    model_providers: Option<Vec<String>>,
    source_kinds: Option<Vec<ThreadSourceKind>>,
    archived: bool,
    cwd_filters: Option<Vec<PathBuf>>,
    search_term: Option<String>,
    use_state_db_only: bool,
}

pub(crate) struct OfficeMemberRuntimeThreadStart {
    pub(crate) cwd: String,
    pub(crate) model: Option<String>,
    pub(crate) permissions: Option<String>,
    pub(crate) base_instructions: Option<String>,
    pub(crate) developer_instructions: Option<String>,
}

pub(crate) struct WorkflowAgentRuntimeThreadStart {
    pub(crate) cwd: String,
    pub(crate) model: Option<String>,
    pub(crate) permissions: Option<String>,
    pub(crate) developer_instructions: Option<String>,
}

pub(crate) struct OfficeManagerRuntimeThreadStart {
    pub(crate) cwd: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeManagerRuntimeProvenance {
    ServerOwned,
    Legacy,
}

pub(crate) struct OfficeAutomationRuntimeThreadStart {
    pub(crate) cwd: String,
    pub(crate) base_instructions: Option<String>,
    pub(crate) developer_instructions: Option<String>,
}

pub(crate) struct OfficeAutomationRuntimeRepair {
    pub(crate) source_thread_id: String,
    pub(crate) repaired_at: String,
}

struct OfficeRuntimeThreadStart {
    cwd: String,
    model: Option<String>,
    permissions: Option<String>,
    base_instructions: Option<String>,
    developer_instructions: Option<String>,
    thread_source: &'static str,
    metrics_service_name: &'static str,
    listener_label: &'static str,
    error_context: &'static str,
}

fn office_automation_runtime_thread_id(config: &serde_json::Value) -> Option<&str> {
    config
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
}

fn office_automation_dispatch_thread_can_be_repaired(
    err: &JSONRPCErrorError,
    thread_id: &str,
) -> bool {
    err.message == format!("no rollout found for thread id {thread_id}")
}

fn office_automation_runtime_developer_instructions(
    automation_config: &serde_json::Value,
    automation_id: &str,
) -> Option<String> {
    let automation_id = bounded_office_automation_runtime_instruction_text(
        automation_id,
        OFFICE_AUTOMATION_RUNTIME_REPAIR_MAX_ID_CHARS,
    );
    let title = automation_config
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(|title| {
            bounded_office_automation_runtime_instruction_text(
                title,
                OFFICE_AUTOMATION_RUNTIME_REPAIR_MAX_ID_CHARS,
            )
        })
        .unwrap_or_else(|| "Automation".to_string());
    let mut parts = vec![format!(
        "You are the durable runtime thread for Office verification automation {title} ({automation_id}). Preserve this automation's private execution context across verification runs. Use only the run prompt, this thread history, allowed Office memory, and bounded shared Office evidence as context."
    )];
    for key in [
        "instructions",
        "developerInstructions",
        "systemPrompt",
        "prompt",
        "description",
        "policy",
        "guardrails",
        "constraints",
    ] {
        if let Some(value) = automation_config
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let value = bounded_office_automation_runtime_instruction_text(
                value,
                OFFICE_AUTOMATION_RUNTIME_REPAIR_MAX_FIELD_CHARS,
            );
            parts.push(format!("{key}: {value}"));
        }
    }
    let instructions = bounded_office_automation_runtime_instruction_text(
        &parts.join("\n"),
        OFFICE_AUTOMATION_RUNTIME_REPAIR_MAX_INSTRUCTIONS_CHARS,
    );
    (!instructions.trim().is_empty()).then_some(instructions)
}

fn bounded_office_automation_runtime_instruction_text(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let suffix_chars = OFFICE_AUTOMATION_RUNTIME_REPAIR_TRUNCATED_SUFFIX
        .chars()
        .count();
    let keep_chars = max_chars.saturating_sub(suffix_chars);
    let mut bounded = value.chars().take(keep_chars).collect::<String>();
    bounded.push_str(OFFICE_AUTOMATION_RUNTIME_REPAIR_TRUNCATED_SUFFIX);
    bounded
}

fn set_office_automation_runtime_json_string(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &str,
) {
    object.insert(
        key.to_string(),
        serde_json::Value::String(value.to_string()),
    );
}

fn collect_resume_override_mismatches(
    request: &ThreadResumeParams,
    config_snapshot: &ThreadConfigSnapshot,
) -> Vec<String> {
    let mut mismatch_details = Vec::new();

    if let Some(requested_model) = request.model.as_deref()
        && requested_model != config_snapshot.model
    {
        mismatch_details.push(format!(
            "model requested={requested_model} active={}",
            config_snapshot.model
        ));
    }
    if let Some(requested_provider) = request.model_provider.as_deref()
        && requested_provider != config_snapshot.model_provider_id
    {
        mismatch_details.push(format!(
            "model_provider requested={requested_provider} active={}",
            config_snapshot.model_provider_id
        ));
    }
    if let Some(requested_service_tier) = request.service_tier.as_ref()
        && requested_service_tier != &config_snapshot.service_tier
    {
        mismatch_details.push(format!(
            "service_tier requested={requested_service_tier:?} active={:?}",
            config_snapshot.service_tier
        ));
    }
    if let Some(requested_cwd) = request.cwd.as_deref() {
        let requested_cwd_path = std::path::PathBuf::from(requested_cwd);
        if requested_cwd_path != config_snapshot.cwd().as_path() {
            mismatch_details.push(format!(
                "cwd requested={} active={}",
                requested_cwd_path.display(),
                config_snapshot.cwd().display()
            ));
        }
    }
    if let Some(requested_runtime_workspace_roots) = request.runtime_workspace_roots.as_ref() {
        let requested_runtime_workspace_roots = requested_runtime_workspace_roots.to_vec();
        if requested_runtime_workspace_roots != config_snapshot.workspace_roots {
            mismatch_details.push(format!(
                "runtime_workspace_roots requested={requested_runtime_workspace_roots:?} active={:?}",
                config_snapshot.workspace_roots
            ));
        }
    }
    if let Some(requested_approval) = request.approval_policy.as_ref() {
        let active_approval: AskForApproval = config_snapshot.approval_policy.into();
        if requested_approval != &active_approval {
            mismatch_details.push(format!(
                "approval_policy requested={requested_approval:?} active={active_approval:?}"
            ));
        }
    }
    if let Some(requested_review_policy) = request.approvals_reviewer.as_ref() {
        let active_review_policy: crewon_app_server_protocol::ApprovalsReviewer =
            config_snapshot.approvals_reviewer.into();
        if requested_review_policy != &active_review_policy {
            mismatch_details.push(format!(
                "approvals_reviewer requested={requested_review_policy:?} active={active_review_policy:?}"
            ));
        }
    }
    if let Some(requested_sandbox) = request.sandbox.as_ref() {
        let active_sandbox = config_snapshot.sandbox_policy();
        let sandbox_matches = matches!(
            (requested_sandbox, &active_sandbox),
            (
                SandboxMode::ReadOnly,
                crewon_protocol::protocol::SandboxPolicy::ReadOnly { .. }
            ) | (
                SandboxMode::WorkspaceWrite,
                crewon_protocol::protocol::SandboxPolicy::WorkspaceWrite { .. }
            ) | (
                SandboxMode::DangerFullAccess,
                crewon_protocol::protocol::SandboxPolicy::DangerFullAccess
            ) | (
                SandboxMode::DangerFullAccess,
                crewon_protocol::protocol::SandboxPolicy::ExternalSandbox { .. }
            )
        );
        if !sandbox_matches {
            mismatch_details.push(format!(
                "sandbox requested={requested_sandbox:?} active={active_sandbox:?}"
            ));
        }
    }
    if request.permissions.is_some() {
        mismatch_details.push(format!(
            "permissions override was provided and ignored while running; active={:?}",
            config_snapshot.active_permission_profile
        ));
    }
    if let Some(requested_personality) = request.personality.as_ref()
        && config_snapshot.personality.as_ref() != Some(requested_personality)
    {
        mismatch_details.push(format!(
            "personality requested={requested_personality:?} active={:?}",
            config_snapshot.personality
        ));
    }

    if request.config.is_some() {
        mismatch_details
            .push("config overrides were provided and ignored while running".to_string());
    }
    if request.base_instructions.is_some() {
        mismatch_details
            .push("baseInstructions override was provided and ignored while running".to_string());
    }
    if request.developer_instructions.is_some() {
        mismatch_details.push(
            "developerInstructions override was provided and ignored while running".to_string(),
        );
    }
    mismatch_details
}

fn merge_persisted_resume_metadata(
    request_overrides: &mut Option<HashMap<String, serde_json::Value>>,
    typesafe_overrides: &mut ConfigOverrides,
    persisted_metadata: &ThreadMetadata,
) {
    if has_model_resume_override(request_overrides.as_ref(), typesafe_overrides) {
        return;
    }

    typesafe_overrides.model = persisted_metadata.model.clone();
    typesafe_overrides.model_provider = Some(persisted_metadata.model_provider.clone());

    if let Some(reasoning_effort) = persisted_metadata.reasoning_effort.as_ref() {
        request_overrides.get_or_insert_with(HashMap::new).insert(
            "model_reasoning_effort".to_string(),
            serde_json::Value::String(reasoning_effort.to_string()),
        );
    }
}

fn normalize_thread_list_cwd_filters(
    cwd: Option<ThreadListCwdFilter>,
) -> Result<Option<Vec<PathBuf>>, JSONRPCErrorError> {
    let Some(cwd) = cwd else {
        return Ok(None);
    };

    let cwds = match cwd {
        ThreadListCwdFilter::One(cwd) => vec![cwd],
        ThreadListCwdFilter::Many(cwds) => cwds,
    };
    let mut normalized_cwds = Vec::with_capacity(cwds.len());
    for cwd in cwds {
        let cwd = AbsolutePathBuf::relative_to_current_dir(cwd.as_str())
            .map(AbsolutePathBuf::into_path_buf)
            .map_err(|err| {
                invalid_params(format!("invalid thread/list cwd filter `{cwd}`: {err}"))
            })?;
        normalized_cwds.push(cwd);
    }

    Ok(Some(normalized_cwds))
}

fn has_model_resume_override(
    request_overrides: Option<&HashMap<String, serde_json::Value>>,
    typesafe_overrides: &ConfigOverrides,
) -> bool {
    typesafe_overrides.model.is_some()
        || typesafe_overrides.model_provider.is_some()
        || request_overrides.is_some_and(|overrides| overrides.contains_key("model"))
        || request_overrides
            .is_some_and(|overrides| overrides.contains_key("model_reasoning_effort"))
}

fn validate_dynamic_tools(tools: &[ApiDynamicToolSpec]) -> Result<(), String> {
    const DYNAMIC_TOOL_NAME_MAX_LEN: usize = 128;
    const DYNAMIC_TOOL_NAMESPACE_MAX_LEN: usize = 64;
    const DYNAMIC_TOOL_IDENTIFIER_PATTERN: &str = "^[a-zA-Z0-9_-]+$";
    const SERVER_PROVIDER_NAMESPACE_PREFIX: &str = "crewon_binding_";
    const RESERVED_RESPONSES_NAMESPACES: &[&str] = &[
        "api_tool",
        "browser",
        "computer",
        "container",
        "file_search",
        "functions",
        "image_gen",
        "multi_tool_use",
        "python",
        "python_user_visible",
        "submodel_delegator",
        "terminal",
        "tool_search",
        "web",
    ];

    fn escape_identifier_for_error(value: &str) -> String {
        value.escape_default().to_string()
    }

    fn validate_dynamic_tool_identifier(
        value: &str,
        label: &str,
        max_len: usize,
    ) -> Result<(), String> {
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(format!(
                "{label} must match {DYNAMIC_TOOL_IDENTIFIER_PATTERN} to match Responses API: {}",
                escape_identifier_for_error(value),
            ));
        }
        if value.chars().count() > max_len {
            return Err(format!(
                "{label} must be at most {max_len} characters to match Responses API: {}",
                escape_identifier_for_error(value),
            ));
        }
        Ok(())
    }

    let mut seen = HashSet::new();
    for tool in tools {
        let name = tool.name.trim();
        if name.is_empty() {
            return Err("dynamic tool name must not be empty".to_string());
        }
        if name != tool.name {
            return Err(format!(
                "dynamic tool name has leading/trailing whitespace: {}",
                escape_identifier_for_error(&tool.name),
            ));
        }
        validate_dynamic_tool_identifier(name, "dynamic tool name", DYNAMIC_TOOL_NAME_MAX_LEN)?;
        if name == "mcp" || name.starts_with("mcp__") {
            return Err(format!("dynamic tool name is reserved: {name}"));
        }
        let namespace = tool.namespace.as_deref().map(str::trim);
        if let Some(namespace) = namespace {
            if namespace.is_empty() {
                return Err(format!(
                    "dynamic tool namespace must not be empty for {name}"
                ));
            }
            if Some(namespace) != tool.namespace.as_deref() {
                return Err(format!(
                    "dynamic tool namespace has leading/trailing whitespace for {name}: {namespace}",
                    name = escape_identifier_for_error(name),
                    namespace = escape_identifier_for_error(namespace),
                ));
            }
            validate_dynamic_tool_identifier(
                namespace,
                "dynamic tool namespace",
                DYNAMIC_TOOL_NAMESPACE_MAX_LEN,
            )?;
            if namespace == "mcp" || namespace.starts_with("mcp__") {
                return Err(format!(
                    "dynamic tool namespace is reserved for {name}: {namespace}"
                ));
            }
            if namespace.starts_with(SERVER_PROVIDER_NAMESPACE_PREFIX) {
                return Err(format!(
                    "dynamic tool namespace is reserved for server-owned Provider bindings for {name}: {namespace}"
                ));
            }
            if RESERVED_RESPONSES_NAMESPACES.contains(&namespace) {
                return Err(format!(
                    "dynamic tool namespace collides with a reserved Responses API namespace for {name}: {namespace}",
                ));
            }
        }
        if !seen.insert((namespace, name)) {
            if let Some(namespace) = namespace {
                return Err(format!(
                    "duplicate dynamic tool name in namespace {namespace}: {name}"
                ));
            }
            return Err(format!("duplicate dynamic tool name: {name}"));
        }
        if tool.defer_loading && namespace.is_none() {
            return Err(format!(
                "deferred dynamic tool must include a namespace: {name}"
            ));
        }

        if let Err(err) = crewon_tools::parse_tool_input_schema(&tool.input_schema) {
            return Err(format!(
                "dynamic tool input schema is not supported for {name}: {err}"
            ));
        }
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct ThreadRequestProcessor {
    pub(super) auth_manager: Arc<AuthManager>,
    pub(super) thread_manager: Arc<ThreadManager>,
    pub(super) outgoing: Arc<OutgoingMessageSender>,
    pub(super) arg0_paths: Arg0DispatchPaths,
    pub(super) config: Arc<Config>,
    pub(super) config_manager: ConfigManager,
    pub(super) thread_store: Arc<dyn ThreadStore>,
    pub(super) pending_thread_unloads: Arc<Mutex<HashSet<ThreadId>>>,
    pub(super) thread_state_manager: ThreadStateManager,
    pub(super) thread_watch_manager: ThreadWatchManager,
    pub(super) thread_list_state_permit: Arc<Semaphore>,
    pub(super) thread_goal_processor: ThreadGoalRequestProcessor,
    pub(super) state_db: Option<StateDbHandle>,
    pub(super) log_db: Option<LogDbLayer>,
    pub(super) background_tasks: TaskTracker,
    pub(super) skills_watcher: Arc<SkillsWatcher>,
    pub(super) office_auto_dispatch: Option<OfficeAutoDispatchContext>,
    pub(super) dynamic_tool_server:
        Arc<crate::platform_control::thread_dynamic_tool_server::ThreadDynamicToolServer>,
}

/// Outcome of trying to satisfy a resume request from an already loaded thread.
enum RunningThreadResumeResult {
    /// The request was delegated to the loaded thread.
    Handled,
    /// No loaded thread handled the request.
    ///
    /// The optional stored thread contains the history-bearing probe that cold
    /// resume can reuse instead of reading the rollout again.
    NotRunning(Option<Box<StoredThread>>),
}

impl ThreadRequestProcessor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        auth_manager: Arc<AuthManager>,
        thread_manager: Arc<ThreadManager>,
        outgoing: Arc<OutgoingMessageSender>,
        arg0_paths: Arg0DispatchPaths,
        config: Arc<Config>,
        config_manager: ConfigManager,
        thread_store: Arc<dyn ThreadStore>,
        pending_thread_unloads: Arc<Mutex<HashSet<ThreadId>>>,
        thread_state_manager: ThreadStateManager,
        thread_watch_manager: ThreadWatchManager,
        thread_list_state_permit: Arc<Semaphore>,
        thread_goal_processor: ThreadGoalRequestProcessor,
        state_db: Option<StateDbHandle>,
        log_db: Option<LogDbLayer>,
        skills_watcher: Arc<SkillsWatcher>,
        office_auto_dispatch: Option<OfficeAutoDispatchContext>,
        dynamic_tool_server: Arc<
            crate::platform_control::thread_dynamic_tool_server::ThreadDynamicToolServer,
        >,
    ) -> Self {
        Self {
            auth_manager,
            thread_manager,
            outgoing,
            arg0_paths,
            config,
            config_manager,
            thread_store,
            pending_thread_unloads,
            thread_state_manager,
            thread_watch_manager,
            thread_list_state_permit,
            thread_goal_processor,
            state_db,
            log_db,
            background_tasks: TaskTracker::new(),
            skills_watcher,
            office_auto_dispatch,
            dynamic_tool_server,
        }
    }

    pub(crate) async fn thread_start(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadStartParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
        request_context: RequestContext,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_start_inner(
            request_id,
            params,
            execution_context_runtime,
            app_server_client_name,
            app_server_client_version,
            request_context,
        )
        .await
        .map(|()| None)
    }

    pub(crate) async fn thread_unsubscribe(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadUnsubscribeParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_unsubscribe_response_inner(params, request_id.connection_id)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_resume(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadResumeParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
        cloud_agent_projection: Option<CloudAgentThreadResumeProjection>,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_resume_inner(
            request_id,
            params,
            execution_context_runtime,
            cloud_agent_projection,
            app_server_client_name,
            app_server_client_version,
        )
        .await
        .map(|()| None)
    }

    pub(crate) async fn thread_fork(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadForkParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_fork_inner(
            request_id,
            params,
            execution_context_runtime,
            app_server_client_name,
            app_server_client_version,
        )
        .await
        .map(|()| None)
    }

    pub(crate) async fn ensure_thread_loaded(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CrewonThread>), JSONRPCErrorError> {
        self.load_thread(thread_id).await
    }

    pub(crate) async fn thread_archive(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadArchiveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        match self.thread_archive_inner(params).await {
            Ok((response, archived_thread_ids)) => {
                self.outgoing
                    .send_response(request_id.clone(), response)
                    .await;
                for thread_id in archived_thread_ids {
                    self.outgoing
                        .send_server_notification(ServerNotification::ThreadArchived(
                            ThreadArchivedNotification { thread_id },
                        ))
                        .await;
                }
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn thread_increment_elicitation(
        &self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_increment_elicitation_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_decrement_elicitation(
        &self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_decrement_elicitation_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_set_name(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadSetNameParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        match self.thread_set_name_response_inner(params).await {
            Ok((response, notification)) => {
                self.outgoing
                    .send_response(request_id.clone(), response)
                    .await;
                if let Some(notification) = notification {
                    self.outgoing
                        .send_server_notification(ServerNotification::ThreadNameUpdated(
                            notification,
                        ))
                        .await;
                }
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn thread_metadata_update(
        &self,
        params: ThreadMetadataUpdateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_metadata_update_response_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_memory_mode_set(
        &self,
        params: ThreadMemoryModeSetParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_memory_mode_set_response_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn memory_reset(
        &self,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.memory_reset_response_inner()
            .await
            .map(|response: MemoryResetResponse| Some(response.into()))
    }

    pub(crate) async fn thread_unarchive(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadUnarchiveParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        match self.thread_unarchive_inner(params).await {
            Ok((response, notification)) => {
                self.outgoing
                    .send_response(request_id.clone(), response)
                    .await;
                self.outgoing
                    .send_server_notification(ServerNotification::ThreadUnarchived(notification))
                    .await;
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn thread_compact_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadCompactStartParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_compact_start_inner(request_id, params, execution_context_runtime)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_background_terminals_clean(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadBackgroundTerminalsCleanParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_background_terminals_clean_inner(request_id, params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_background_terminals_list(
        &self,
        params: ThreadBackgroundTerminalsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_background_terminals_list_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_background_terminals_terminate(
        &self,
        params: ThreadBackgroundTerminalsTerminateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_background_terminals_terminate_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_rollback(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_rollback_inner(request_id, params)
            .await
            .map(|()| None)
    }

    pub(crate) async fn thread_list_response(
        &self,
        params: ThreadListParams,
    ) -> Result<ThreadListResponse, JSONRPCErrorError> {
        self.thread_list_response_inner(params).await
    }

    pub(crate) async fn office_scheduler_startup_threads(
        &self,
    ) -> Result<ThreadListResponse, JSONRPCErrorError> {
        self.thread_list_response_inner(ThreadListParams {
            cursor: None,
            limit: Some(OFFICE_SCHEDULER_STARTUP_THREAD_LIMIT),
            sort_key: Some(ThreadSortKey::UpdatedAt),
            sort_direction: Some(SortDirection::Desc),
            model_providers: Some(Vec::new()),
            source_kinds: Some(vec![
                ThreadSourceKind::LegacyCli,
                ThreadSourceKind::VsCode,
                ThreadSourceKind::Exec,
                ThreadSourceKind::AppServer,
                ThreadSourceKind::SubAgent,
                ThreadSourceKind::SubAgentReview,
                ThreadSourceKind::SubAgentCompact,
                ThreadSourceKind::SubAgentThreadSpawn,
                ThreadSourceKind::SubAgentOther,
                ThreadSourceKind::Unknown,
            ]),
            archived: Some(false),
            cwd: None,
            use_state_db_only: false,
            search_term: None,
        })
        .await
    }

    pub(crate) async fn thread_search(
        &self,
        params: ThreadSearchParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_search_response_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_loaded_list(
        &self,
        params: ThreadLoadedListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_loaded_list_response_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_read_response(
        &self,
        params: ThreadReadParams,
    ) -> Result<ThreadReadResponse, JSONRPCErrorError> {
        self.thread_read_response_inner(params).await
    }

    pub(crate) async fn thread_turns_list(
        &self,
        params: ThreadTurnsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_turns_list_response_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_turns_items_list(
        &self,
        _params: ThreadTurnsItemsListParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        Err(method_not_found(
            "thread/turns/items/list is not supported yet",
        ))
    }

    pub(crate) async fn thread_shell_command(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadShellCommandParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_shell_command_inner(request_id, params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn thread_approve_guardian_denied_action(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadApproveGuardianDeniedActionParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.thread_approve_guardian_denied_action_inner(request_id, params)
            .await
            .map(|response| Some(response.into()))
    }

    pub(crate) async fn conversation_summary(
        &self,
        params: GetConversationSummaryParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        self.get_thread_summary_response_inner(params)
            .await
            .map(|response| Some(response.into()))
    }

    async fn load_thread(
        &self,
        thread_id: &str,
    ) -> Result<(ThreadId, Arc<CrewonThread>), JSONRPCErrorError> {
        // Resolve the core conversation handle from a v2 thread id string.
        let thread_id = ThreadId::from_string(thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;

        let thread = self
            .thread_manager
            .get_thread(thread_id)
            .await
            .map_err(|_| invalid_request(format!("thread not found: {thread_id}")))?;

        Ok((thread_id, thread))
    }
    pub(super) async fn acquire_thread_list_state_permit(
        &self,
    ) -> Result<SemaphorePermit<'_>, JSONRPCErrorError> {
        self.thread_list_state_permit
            .acquire()
            .await
            .map_err(|err| {
                internal_error(format!("failed to acquire thread list state permit: {err}"))
            })
    }

    async fn set_app_server_client_info(
        thread: &CrewonThread,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<(), JSONRPCErrorError> {
        let mcp_elicitations_auto_deny = xcode_26_4_mcp_elicitations_auto_deny(
            app_server_client_name.as_deref(),
            app_server_client_version.as_deref(),
        );
        thread
            .set_app_server_client_info(
                app_server_client_name,
                app_server_client_version,
                mcp_elicitations_auto_deny,
            )
            .await
            .map_err(|err| internal_error(format!("failed to set app server client info: {err}")))
    }

    async fn finalize_thread_teardown(&self, thread_id: ThreadId) {
        self.dynamic_tool_server
            .clear_thread(&thread_id.to_string())
            .await;
        self.pending_thread_unloads.lock().await.remove(&thread_id);
        self.outgoing
            .cancel_requests_for_thread(thread_id, /*error*/ None)
            .await;
        self.thread_state_manager
            .remove_thread_state(thread_id)
            .await;
        self.thread_watch_manager
            .remove_thread(&thread_id.to_string())
            .await;
    }

    async fn thread_unsubscribe_response_inner(
        &self,
        params: ThreadUnsubscribeParams,
        connection_id: ConnectionId,
    ) -> Result<ThreadUnsubscribeResponse, JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(&params.thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;

        if self.thread_manager.get_thread(thread_id).await.is_err() {
            self.finalize_thread_teardown(thread_id).await;
            return Ok(ThreadUnsubscribeResponse {
                status: ThreadUnsubscribeStatus::NotLoaded,
            });
        };

        let was_subscribed = self
            .thread_state_manager
            .unsubscribe_connection_from_thread(thread_id, connection_id)
            .await;

        let status = if was_subscribed {
            ThreadUnsubscribeStatus::Unsubscribed
        } else {
            ThreadUnsubscribeStatus::NotSubscribed
        };
        Ok(ThreadUnsubscribeResponse { status })
    }

    async fn prepare_thread_for_archive(&self, thread_id: ThreadId) {
        self.prepare_thread_for_removal(thread_id, "archive").await;
    }

    pub(super) async fn prepare_thread_for_removal(&self, thread_id: ThreadId, operation: &str) {
        let removed_conversation = self.thread_manager.remove_thread(&thread_id).await;
        if let Some(conversation) = removed_conversation {
            info!("thread {thread_id} was active; shutting down");
            match wait_for_thread_shutdown(&conversation).await {
                ThreadShutdownResult::Complete => {}
                ThreadShutdownResult::SubmitFailed => {
                    error!(
                        "failed to submit Shutdown to thread {thread_id}; proceeding with {operation}"
                    );
                }
                ThreadShutdownResult::TimedOut => {
                    warn!("thread {thread_id} shutdown timed out; proceeding with {operation}");
                }
            }
        }
        self.finalize_thread_teardown(thread_id).await;
    }

    fn listener_task_context(&self) -> ListenerTaskContext {
        ListenerTaskContext {
            thread_manager: Arc::clone(&self.thread_manager),
            thread_state_manager: self.thread_state_manager.clone(),
            outgoing: Arc::clone(&self.outgoing),
            pending_thread_unloads: Arc::clone(&self.pending_thread_unloads),
            thread_watch_manager: self.thread_watch_manager.clone(),
            thread_list_state_permit: self.thread_list_state_permit.clone(),
            fallback_model_provider: self.config.model_provider_id.clone(),
            codex_home: self.config.codex_home.to_path_buf(),
            skills_watcher: Arc::clone(&self.skills_watcher),
            office_auto_dispatch: self.office_auto_dispatch.clone(),
            dynamic_tool_server: Arc::clone(&self.dynamic_tool_server),
        }
    }

    async fn ensure_conversation_listener(
        &self,
        conversation_id: ThreadId,
        connection_id: ConnectionId,
        raw_events_enabled: bool,
    ) -> Result<EnsureConversationListenerResult, JSONRPCErrorError> {
        super::thread_lifecycle::ensure_conversation_listener(
            self.listener_task_context(),
            conversation_id,
            connection_id,
            raw_events_enabled,
        )
        .await
    }

    async fn ensure_listener_task_running(
        &self,
        conversation_id: ThreadId,
        conversation: Arc<CrewonThread>,
        thread_state: Arc<Mutex<ThreadState>>,
    ) -> Result<(), JSONRPCErrorError> {
        super::thread_lifecycle::ensure_listener_task_running(
            self.listener_task_context(),
            conversation_id,
            conversation,
            thread_state,
        )
        .await
    }

    async fn thread_start_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadStartParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
        request_context: RequestContext,
    ) -> Result<(), JSONRPCErrorError> {
        let ThreadStartParams {
            execution_context,
            model,
            model_provider,
            service_tier,
            cwd,
            runtime_workspace_roots,
            approval_policy,
            approvals_reviewer,
            sandbox,
            permissions,
            config,
            service_name,
            base_instructions,
            developer_instructions,
            dynamic_tools,
            selected_capability_roots,
            scene,
            mock_experimental_field: _mock_experimental_field,
            experimental_raw_events,
            personality,
            ephemeral,
            session_start_source,
            thread_source,
            environments,
        } = params;
        super::cloud_agent_thread_source_fence::ensure_source_creation_allowed(
            thread_source.as_ref(),
        )?;
        if sandbox.is_some() && permissions.is_some() {
            return Err(invalid_request(
                "`permissions` cannot be combined with `sandbox`",
            ));
        }
        if execution_context.is_some() && ephemeral == Some(true) {
            return Err(invalid_request(
                "Thread execution context requires a persistent thread",
            ));
        }
        let environment_selections = self.parse_environment_selections(environments)?;
        let prepared_execution_context = match execution_context {
            Some(params) => {
                let runtime = execution_context_runtime.as_ref().ok_or_else(|| {
                    internal_error("Thread execution context state is unavailable")
                })?;
                Some(runtime.prepare_create(params).await?)
            }
            None => None,
        };
        let execution_context = execution_context_runtime.zip(prepared_execution_context);
        let runtime_workspace_roots = runtime_workspace_roots.map(resolve_runtime_workspace_roots);
        let mut typesafe_overrides = self.build_thread_config_overrides(
            model,
            model_provider,
            service_tier,
            cwd,
            runtime_workspace_roots,
            approval_policy,
            approvals_reviewer,
            sandbox,
            permissions,
            base_instructions,
            developer_instructions,
            personality,
        );
        typesafe_overrides.ephemeral = ephemeral;
        let listener_task_context = ListenerTaskContext {
            thread_manager: Arc::clone(&self.thread_manager),
            thread_state_manager: self.thread_state_manager.clone(),
            outgoing: Arc::clone(&self.outgoing),
            pending_thread_unloads: Arc::clone(&self.pending_thread_unloads),
            thread_watch_manager: self.thread_watch_manager.clone(),
            thread_list_state_permit: self.thread_list_state_permit.clone(),
            fallback_model_provider: self.config.model_provider_id.clone(),
            codex_home: self.config.codex_home.to_path_buf(),
            skills_watcher: Arc::clone(&self.skills_watcher),
            office_auto_dispatch: self.office_auto_dispatch.clone(),
            dynamic_tool_server: Arc::clone(&self.dynamic_tool_server),
        };
        let request_trace = request_context.request_trace();
        let config_manager = self.config_manager.clone();
        let outgoing = Arc::clone(&listener_task_context.outgoing);
        let error_request_id = request_id.clone();
        let execution_context_rollback =
            super::thread_execution_context_lifecycle::ThreadExecutionContextRollback::new(
                Arc::clone(&self.thread_manager),
                Arc::clone(&self.thread_store),
                self.state_db.clone(),
            );
        let thread_start_task = async move {
            if let Err(error) = Self::thread_start_task(
                listener_task_context,
                config_manager,
                request_id,
                execution_context,
                execution_context_rollback,
                app_server_client_name,
                app_server_client_version,
                config,
                typesafe_overrides,
                dynamic_tools,
                selected_capability_roots.unwrap_or_default(),
                scene,
                session_start_source,
                thread_source.map(Into::into),
                environment_selections,
                service_name,
                experimental_raw_events,
                request_trace,
            )
            .await
            {
                outgoing.send_error(error_request_id, error).await;
            }
        };
        self.background_tasks
            .spawn(thread_start_task.instrument(request_context.span()));
        Ok(())
    }

    pub(crate) async fn drain_background_tasks(&self) {
        self.background_tasks.close();
        if tokio::time::timeout(Duration::from_secs(10), self.background_tasks.wait())
            .await
            .is_err()
        {
            warn!("timed out waiting for background tasks to shut down; proceeding");
        }
    }

    pub(crate) async fn clear_all_thread_listeners(&self) {
        self.thread_state_manager.clear_all_listeners().await;
    }

    pub(crate) async fn shutdown_threads(&self) {
        let report = self
            .thread_manager
            .shutdown_all_threads_bounded(Duration::from_secs(10))
            .await;
        for thread_id in report.submit_failed {
            warn!("failed to submit Shutdown to thread {thread_id}");
        }
        for thread_id in report.timed_out {
            warn!("timed out waiting for thread {thread_id} to shut down");
        }
    }

    async fn request_trace_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<crewon_protocol::protocol::W3cTraceContext> {
        self.outgoing.request_trace_context(request_id).await
    }

    async fn submit_core_op(
        &self,
        request_id: &ConnectionRequestId,
        thread: &CrewonThread,
        op: Op,
    ) -> CrewonResult<String> {
        thread
            .submit_with_trace(op, self.request_trace_context(request_id).await)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn thread_start_task(
        listener_task_context: ListenerTaskContext,
        config_manager: ConfigManager,
        request_id: ConnectionRequestId,
        execution_context: Option<(
            ThreadExecutionContextRequestRuntime,
            PreparedThreadExecutionContextCreate,
        )>,
        execution_context_rollback: super::thread_execution_context_lifecycle::ThreadExecutionContextRollback,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
        config_overrides: Option<HashMap<String, serde_json::Value>>,
        typesafe_overrides: ConfigOverrides,
        dynamic_tools: Option<Vec<ApiDynamicToolSpec>>,
        selected_capability_roots: Vec<SelectedCapabilityRoot>,
        scene: Option<crewon_app_server_protocol::ThreadSceneSelectionParams>,
        session_start_source: Option<crewon_app_server_protocol::ThreadStartSource>,
        thread_source: Option<crewon_protocol::protocol::ThreadSource>,
        environments: Option<Vec<TurnEnvironmentSelection>>,
        service_name: Option<String>,
        experimental_raw_events: bool,
        request_trace: Option<W3cTraceContext>,
    ) -> Result<(), JSONRPCErrorError> {
        let thread_start_started_at = std::time::Instant::now();
        let requested_cwd = typesafe_overrides.cwd.clone();
        let mut config = config_manager
            .load_with_overrides(config_overrides.clone(), typesafe_overrides.clone())
            .await
            .map_err(|err| config_load_error(&err))?;
        let scene_runtime = match scene {
            Some(scene) => Some(
                super::scene_runtime::resolve_thread_scene(
                    config.cwd.to_string_lossy().as_ref(),
                    scene,
                )
                .await?,
            ),
            None => None,
        };
        // The user may have requested WorkspaceWrite or DangerFullAccess via
        // the command line, though in the process of deriving the Config, it
        // could be downgraded to ReadOnly (perhaps there is no sandbox
        // available on Windows or the enterprise config disallows it). The cwd
        // should still be considered "trusted" in this case.
        let requested_permissions_trust_project =
            requested_permissions_trust_project(&typesafe_overrides, config.cwd.as_path());
        let effective_permissions_trust_project = permission_profile_trusts_project(
            &config.permissions.effective_permission_profile(),
            config.cwd.as_path(),
        );

        if requested_cwd.is_some()
            && config.active_project.trust_level.is_none()
            && (requested_permissions_trust_project || effective_permissions_trust_project)
        {
            let trust_target = resolve_root_git_project_for_trust(LOCAL_FS.as_ref(), &config.cwd)
                .await
                .unwrap_or_else(|| config.cwd.clone());
            let current_config_overrides = config_manager.current_config_overrides();
            let config_overrides_with_trust;
            let config_overrides_for_reload = if let Err(err) =
                crewon_core::config::set_project_trust_level(
                    &listener_task_context.codex_home,
                    trust_target.as_path(),
                    TrustLevel::Trusted,
                ) {
                warn!(
                    "failed to persist trusted project state for {}; continuing with in-memory trust for this thread: {err}",
                    trust_target.display()
                );
                let mut project = toml::map::Map::new();
                project.insert(
                    "trust_level".to_string(),
                    TomlValue::String("trusted".to_string()),
                );
                let mut projects = toml::map::Map::new();
                projects.insert(
                    project_trust_key(trust_target.as_path()),
                    TomlValue::Table(project),
                );
                config_overrides_with_trust = current_config_overrides
                    .iter()
                    .cloned()
                    .chain(std::iter::once((
                        "projects".to_string(),
                        TomlValue::Table(projects),
                    )))
                    .collect::<Vec<_>>();
                config_overrides_with_trust.as_slice()
            } else {
                current_config_overrides.as_slice()
            };

            config = config_manager
                .load_with_config_overrides(
                    config_overrides_for_reload,
                    config_overrides,
                    typesafe_overrides,
                    /*fallback_cwd*/ None,
                )
                .await
                .map_err(|err| config_load_error(&err))?;
        }
        if let Some(scene_runtime) = scene_runtime.as_ref() {
            let cwd = config.cwd.to_string_lossy().into_owned();
            super::scene_runtime::hydrate_thread_scene_config(
                &cwd,
                scene_runtime.clone(),
                &mut config,
            )
            .await?;
        }

        let environments = environments.unwrap_or_else(|| {
            listener_task_context
                .thread_manager
                .default_environment_selections(&config.cwd)
        });
        let dynamic_tools = dynamic_tools.unwrap_or_default();
        let core_dynamic_tools = if dynamic_tools.is_empty() {
            Vec::new()
        } else {
            validate_dynamic_tools(&dynamic_tools).map_err(invalid_request)?;
            dynamic_tools
                .into_iter()
                .map(|tool| CoreDynamicToolSpec {
                    namespace: tool.namespace,
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.input_schema,
                    defer_loading: tool.defer_loading,
                })
                .collect()
        };
        let core_dynamic_tool_count = core_dynamic_tools.len();
        let mut thread_extension_init = ExtensionDataInit::new();
        if !selected_capability_roots.is_empty() {
            thread_extension_init.insert(selected_capability_roots);
        }
        let create_thread_started_at = std::time::Instant::now();
        let NewThread {
            thread_id,
            thread,
            session_configured,
            ..
        } = listener_task_context
            .thread_manager
            .start_thread_with_options(StartThreadOptions {
                config,
                initial_history: match session_start_source
                    .unwrap_or(crewon_app_server_protocol::ThreadStartSource::Startup)
                {
                    crewon_app_server_protocol::ThreadStartSource::Startup => InitialHistory::New,
                    crewon_app_server_protocol::ThreadStartSource::Clear => InitialHistory::Cleared,
                },
                session_source: None,
                thread_source,
                dynamic_tools: core_dynamic_tools,
                metrics_service_name: service_name,
                parent_trace: request_trace,
                environments,
                thread_extension_init,
            })
            .instrument(tracing::info_span!(
                "app_server.thread_start.create_thread",
                otel.name = "app_server.thread_start.create_thread",
                thread_start.dynamic_tool_count = core_dynamic_tool_count,
            ))
            .await
            .map_err(|err| match err {
                CodexErr::InvalidRequest(message) => invalid_request(message),
                err => internal_error(format!("error creating thread: {err}")),
            })?;
        let execution_context = if let Some((runtime, prepared)) = execution_context {
            match runtime
                .create(
                    prepared,
                    &thread_id.to_string(),
                    ThreadExecutionContextWorkspaceScope::Conversation,
                    Utc::now().timestamp(),
                )
                .await
            {
                Ok(execution_context) => Some(execution_context),
                Err(error) => {
                    if let Err(rollback_error) =
                        execution_context_rollback.rollback(thread_id).await
                    {
                        tracing::error!(
                            thread_id = %thread_id,
                            error = %rollback_error,
                            "failed to roll back thread after execution context creation failed"
                        );
                    }
                    return Err(error);
                }
            }
        } else {
            None
        };
        let session_telemetry = thread.session_telemetry();
        session_telemetry.record_startup_phase(
            "thread_start_create_thread",
            create_thread_started_at.elapsed(),
            Some("ready"),
        );

        Self::set_app_server_client_info(
            thread.as_ref(),
            app_server_client_name,
            app_server_client_version,
        )
        .await?;

        let instruction_sources = thread.instruction_sources().await;
        let config_snapshot = thread
            .config_snapshot()
            .instrument(tracing::info_span!(
                "app_server.thread_start.config_snapshot",
                otel.name = "app_server.thread_start.config_snapshot",
            ))
            .await;
        let mut thread = build_thread_from_snapshot(
            thread_id,
            session_configured.session_id.to_string(),
            &config_snapshot,
            session_configured.rollout_path.clone(),
        );

        // Auto-attach a thread listener when starting a thread.
        log_listener_attach_result(
            super::thread_lifecycle::ensure_conversation_listener(
                listener_task_context.clone(),
                thread_id,
                request_id.connection_id,
                experimental_raw_events,
            )
            .instrument(tracing::info_span!(
                "app_server.thread_start.attach_listener",
                otel.name = "app_server.thread_start.attach_listener",
                thread_start.experimental_raw_events = experimental_raw_events,
            ))
            .await,
            thread_id,
            request_id.connection_id,
            "thread",
        );

        listener_task_context
            .thread_watch_manager
            .upsert_thread_silently(thread.clone())
            .instrument(tracing::info_span!(
                "app_server.thread_start.upsert_thread",
                otel.name = "app_server.thread_start.upsert_thread",
            ))
            .await;

        thread.status = resolve_thread_status(
            listener_task_context
                .thread_watch_manager
                .loaded_status_for_thread(&thread.id)
                .instrument(tracing::info_span!(
                    "app_server.thread_start.resolve_status",
                    otel.name = "app_server.thread_start.resolve_status",
                ))
                .await,
            /*has_in_progress_turn*/ false,
        );

        let sandbox = thread_response_sandbox_policy(
            &config_snapshot.permission_profile,
            config_snapshot.cwd().as_path(),
        );
        let cwd = config_snapshot.cwd().clone();
        let active_permission_profile =
            thread_response_active_permission_profile(config_snapshot.active_permission_profile);

        let response = ThreadStartResponse {
            thread: thread.clone(),
            execution_context,
            model: config_snapshot.model,
            model_provider: config_snapshot.model_provider_id,
            service_tier: config_snapshot.service_tier,
            cwd,
            runtime_workspace_roots: config_snapshot.workspace_roots,
            instruction_sources,
            approval_policy: config_snapshot.approval_policy.into(),
            approvals_reviewer: config_snapshot.approvals_reviewer.into(),
            sandbox,
            active_permission_profile,
            reasoning_effort: config_snapshot.reasoning_effort,
            scene_runtime: scene_runtime.map(Into::into),
        };
        let notif = thread_started_notification(thread);
        listener_task_context
            .outgoing
            .send_response(request_id, response)
            .instrument(tracing::info_span!(
                "app_server.thread_start.send_response",
                otel.name = "app_server.thread_start.send_response",
            ))
            .await;

        listener_task_context
            .outgoing
            .send_server_notification(ServerNotification::ThreadStarted(notif))
            .instrument(tracing::info_span!(
                "app_server.thread_start.notify_started",
                otel.name = "app_server.thread_start.notify_started",
            ))
            .await;
        session_telemetry.record_startup_phase(
            "thread_start_total",
            thread_start_started_at.elapsed(),
            Some("ready"),
        );
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn build_thread_config_overrides(
        &self,
        model: Option<String>,
        model_provider: Option<String>,
        service_tier: Option<Option<String>>,
        cwd: Option<String>,
        runtime_workspace_roots: Option<Vec<AbsolutePathBuf>>,
        approval_policy: Option<crewon_app_server_protocol::AskForApproval>,
        approvals_reviewer: Option<crewon_app_server_protocol::ApprovalsReviewer>,
        sandbox: Option<SandboxMode>,
        permissions: Option<String>,
        base_instructions: Option<String>,
        developer_instructions: Option<String>,
        personality: Option<Personality>,
    ) -> ConfigOverrides {
        ConfigOverrides {
            model,
            model_provider,
            service_tier,
            cwd: cwd.map(PathBuf::from),
            workspace_roots: runtime_workspace_roots,
            default_permissions: permissions,
            approval_policy: approval_policy
                .map(crewon_app_server_protocol::AskForApproval::to_core),
            approvals_reviewer: approvals_reviewer
                .map(crewon_app_server_protocol::ApprovalsReviewer::to_core),
            sandbox_mode: sandbox.map(SandboxMode::to_core),
            crewon_linux_sandbox_exe: self.arg0_paths.crewon_linux_sandbox_exe.clone(),
            main_execve_wrapper_exe: self.arg0_paths.main_execve_wrapper_exe.clone(),
            base_instructions,
            developer_instructions,
            personality,
            ..Default::default()
        }
    }

    fn parse_environment_selections(
        &self,
        environments: Option<Vec<TurnEnvironmentParams>>,
    ) -> Result<Option<Vec<TurnEnvironmentSelection>>, JSONRPCErrorError> {
        let environment_selections = environments.map(|environments| {
            environments
                .into_iter()
                .map(|environment| TurnEnvironmentSelection {
                    environment_id: environment.environment_id,
                    cwd: environment.cwd,
                })
                .collect::<Vec<_>>()
        });
        if let Some(environment_selections) = environment_selections.as_ref() {
            self.thread_manager
                .validate_environment_selections(environment_selections)
                .map_err(|err| invalid_request(environment_selection_error_message(err)))?;
        }
        Ok(environment_selections)
    }

    async fn thread_archive_inner(
        &self,
        params: ThreadArchiveParams,
    ) -> Result<(ThreadArchiveResponse, Vec<String>), JSONRPCErrorError> {
        let _thread_list_state_permit = self.acquire_thread_list_state_permit().await?;
        self.thread_archive_response(params).await
    }

    async fn thread_archive_response(
        &self,
        params: ThreadArchiveParams,
    ) -> Result<(ThreadArchiveResponse, Vec<String>), JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(&params.thread_id)
            .map_err(|err| invalid_request(format!("invalid session id: {err}")))?;

        let thread_ids = self.state_db_spawn_subtree_thread_ids(thread_id).await?;

        let mut archive_thread_ids = Vec::new();
        match self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: false,
                include_history: false,
            })
            .await
        {
            Ok(thread) => {
                super::cloud_agent_thread_source_fence::ensure_thread_source_mutation_allowed(
                    thread.thread_source.as_ref(),
                    "thread/archive",
                )?;
                if thread.archived_at.is_none() {
                    archive_thread_ids.push(thread_id);
                }
            }
            Err(err) => return Err(thread_store_archive_error("archive", err)),
        }
        for descendant_thread_id in thread_ids.into_iter().skip(1) {
            match self
                .thread_store
                .read_thread(StoreReadThreadParams {
                    thread_id: descendant_thread_id,
                    include_archived: true,
                    include_history: false,
                })
                .await
            {
                Ok(thread) => {
                    super::cloud_agent_thread_source_fence::ensure_thread_source_mutation_allowed(
                        thread.thread_source.as_ref(),
                        "thread/archive",
                    )?;
                    if thread.archived_at.is_none() {
                        archive_thread_ids.push(descendant_thread_id);
                    }
                }
                Err(err) => {
                    warn!(
                        "failed to read spawned descendant thread {descendant_thread_id} while archiving {thread_id}: {err}"
                    );
                }
            }
        }

        let mut archived_thread_ids = Vec::new();
        let Some((parent_thread_id, descendant_thread_ids)) = archive_thread_ids.split_first()
        else {
            return Ok((ThreadArchiveResponse {}, archived_thread_ids));
        };

        self.prepare_thread_for_archive(*parent_thread_id).await;
        match self
            .thread_store
            .archive_thread(StoreArchiveThreadParams {
                thread_id: *parent_thread_id,
            })
            .await
        {
            Ok(()) => {
                archived_thread_ids.push(parent_thread_id.to_string());
            }
            Err(err) => return Err(thread_store_archive_error("archive", err)),
        }

        for descendant_thread_id in descendant_thread_ids.iter().rev().copied() {
            self.prepare_thread_for_archive(descendant_thread_id).await;
            match self
                .thread_store
                .archive_thread(StoreArchiveThreadParams {
                    thread_id: descendant_thread_id,
                })
                .await
            {
                Ok(()) => {
                    archived_thread_ids.push(descendant_thread_id.to_string());
                }
                Err(err) => {
                    warn!(
                        "failed to archive spawned descendant thread {descendant_thread_id} while archiving {thread_id}: {err}"
                    );
                }
            }
        }

        Ok((ThreadArchiveResponse {}, archived_thread_ids))
    }

    pub(super) async fn state_db_spawn_subtree_thread_ids(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<ThreadId>, JSONRPCErrorError> {
        let mut thread_ids = vec![thread_id];
        let Some(state_db_ctx) = self.state_db.as_ref() else {
            return Ok(thread_ids);
        };
        let mut seen = HashSet::from([thread_id]);
        let descendants = state_db_ctx
            .list_thread_spawn_descendants(thread_id)
            .await
            .map_err(|err| {
                internal_error(format!(
                    "failed to list spawned descendants for thread id {thread_id}: {err}"
                ))
            })?;
        for descendant_id in descendants {
            if seen.insert(descendant_id) {
                thread_ids.push(descendant_id);
            }
        }
        Ok(thread_ids)
    }

    async fn thread_increment_elicitation_inner(
        &self,
        params: ThreadIncrementElicitationParams,
    ) -> Result<ThreadIncrementElicitationResponse, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        let count = thread
            .increment_out_of_band_elicitation_count()
            .await
            .map_err(|err| {
                internal_error(format!(
                    "failed to increment out-of-band elicitation counter: {err}"
                ))
            })?;
        Ok(ThreadIncrementElicitationResponse {
            count,
            paused: count > 0,
        })
    }

    async fn thread_decrement_elicitation_inner(
        &self,
        params: ThreadDecrementElicitationParams,
    ) -> Result<ThreadDecrementElicitationResponse, JSONRPCErrorError> {
        let (_, thread) = self.load_thread(&params.thread_id).await?;
        let count = thread
            .decrement_out_of_band_elicitation_count()
            .await
            .map_err(|err| match err {
                CodexErr::InvalidRequest(message) => invalid_request(message),
                err => internal_error(format!(
                    "failed to decrement out-of-band elicitation counter: {err}"
                )),
            })?;
        Ok(ThreadDecrementElicitationResponse {
            count,
            paused: count > 0,
        })
    }

    async fn thread_set_name_response_inner(
        &self,
        params: ThreadSetNameParams,
    ) -> Result<(ThreadSetNameResponse, Option<ThreadNameUpdatedNotification>), JSONRPCErrorError>
    {
        let ThreadSetNameParams { thread_id, name } = params;
        let thread_id = ThreadId::from_string(&thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;
        let Some(name) = crewon_core::util::normalize_thread_name(&name) else {
            return Err(invalid_request("thread name must not be empty"));
        };

        let _thread_list_state_permit = self.acquire_thread_list_state_permit().await?;
        self.thread_manager
            .update_thread_metadata(
                thread_id,
                StoreThreadMetadataPatch {
                    name: Some(Some(name.clone())),
                    ..Default::default()
                },
                /*include_archived*/ false,
            )
            .await
            .map_err(|err| core_thread_write_error("set thread name", err))?;

        Ok((
            ThreadSetNameResponse {},
            Some(ThreadNameUpdatedNotification {
                thread_id: thread_id.to_string(),
                thread_name: Some(name),
            }),
        ))
    }

    async fn thread_memory_mode_set_response_inner(
        &self,
        params: ThreadMemoryModeSetParams,
    ) -> Result<ThreadMemoryModeSetResponse, JSONRPCErrorError> {
        let ThreadMemoryModeSetParams { thread_id, mode } = params;
        let thread_id = ThreadId::from_string(&thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;

        self.thread_manager
            .update_thread_metadata(
                thread_id,
                StoreThreadMetadataPatch {
                    memory_mode: Some(mode.to_core()),
                    ..Default::default()
                },
                /*include_archived*/ false,
            )
            .await
            .map_err(|err| core_thread_write_error("set thread memory mode", err))?;

        Ok(ThreadMemoryModeSetResponse {})
    }

    async fn memory_reset_response_inner(&self) -> Result<MemoryResetResponse, JSONRPCErrorError> {
        let state_db = self
            .state_db
            .clone()
            .ok_or_else(|| internal_error("sqlite state db unavailable for memory reset"))?;

        state_db
            .memories()
            .clear_memory_data()
            .await
            .map_err(|err| {
                internal_error(format!("failed to clear memory rows in memories db: {err}"))
            })?;

        clear_memory_roots_contents(&self.config.codex_home)
            .await
            .map_err(|err| {
                internal_error(format!(
                    "failed to clear memory directories under {}: {err}",
                    self.config.codex_home.display()
                ))
            })?;

        Ok(MemoryResetResponse {})
    }

    async fn thread_metadata_update_response_inner(
        &self,
        params: ThreadMetadataUpdateParams,
    ) -> Result<ThreadMetadataUpdateResponse, JSONRPCErrorError> {
        let ThreadMetadataUpdateParams {
            thread_id,
            git_info,
        } = params;

        let thread_uuid = ThreadId::from_string(&thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;

        let Some(ThreadMetadataGitInfoUpdateParams {
            sha,
            branch,
            origin_url,
        }) = git_info
        else {
            return Err(invalid_request("gitInfo must include at least one field"));
        };

        if sha.is_none() && branch.is_none() && origin_url.is_none() {
            return Err(invalid_request("gitInfo must include at least one field"));
        }

        let git_sha = Self::normalize_thread_metadata_git_field(sha, "gitInfo.sha")?;
        let git_branch = Self::normalize_thread_metadata_git_field(branch, "gitInfo.branch")?;
        let git_origin_url =
            Self::normalize_thread_metadata_git_field(origin_url, "gitInfo.originUrl")?;

        let patch = StoreThreadMetadataPatch {
            git_info: Some(StoreGitInfoPatch {
                sha: git_sha,
                branch: git_branch,
                origin_url: git_origin_url,
            }),
            ..Default::default()
        };

        let updated_thread = {
            let _thread_list_state_permit = self.acquire_thread_list_state_permit().await?;
            self.thread_manager
                .update_thread_metadata(thread_uuid, patch, /*include_archived*/ true)
                .await
                .map_err(|err| core_thread_write_error("update thread metadata", err))?
        };
        let (mut thread, _) = thread_from_stored_thread(
            updated_thread,
            self.config.model_provider_id.as_str(),
            &self.config.cwd,
        );
        if let Ok(loaded_thread) = self.thread_manager.get_thread(thread_uuid).await {
            thread.session_id = loaded_thread.session_configured().session_id.to_string();
        }
        self.attach_thread_name(thread_uuid, &mut thread).await;
        thread.status = resolve_thread_status(
            self.thread_watch_manager
                .loaded_status_for_thread(&thread.id)
                .await,
            /*has_in_progress_turn*/ false,
        );

        Ok(ThreadMetadataUpdateResponse { thread })
    }

    fn normalize_thread_metadata_git_field(
        value: Option<Option<String>>,
        name: &str,
    ) -> Result<Option<Option<String>>, JSONRPCErrorError> {
        match value {
            Some(Some(value)) => {
                let value = value.trim().to_string();
                if value.is_empty() {
                    return Err(invalid_request(format!("{name} must not be empty")));
                }
                Ok(Some(Some(value)))
            }
            Some(None) => Ok(Some(None)),
            None => Ok(None),
        }
    }

    async fn thread_unarchive_inner(
        &self,
        params: ThreadUnarchiveParams,
    ) -> Result<(ThreadUnarchiveResponse, ThreadUnarchivedNotification), JSONRPCErrorError> {
        let _thread_list_state_permit = self.acquire_thread_list_state_permit().await?;
        let (response, thread_id) = self.thread_unarchive_response(params).await?;
        Ok((response, ThreadUnarchivedNotification { thread_id }))
    }

    async fn thread_unarchive_response(
        &self,
        params: ThreadUnarchiveParams,
    ) -> Result<(ThreadUnarchiveResponse, String), JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(&params.thread_id)
            .map_err(|err| invalid_request(format!("invalid session id: {err}")))?;

        let stored_thread = self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: false,
            })
            .await
            .map_err(|err| thread_store_archive_error("unarchive", err))?;
        super::cloud_agent_thread_source_fence::ensure_thread_source_mutation_allowed(
            stored_thread.thread_source.as_ref(),
            "thread/unarchive",
        )?;

        let fallback_provider = self.config.model_provider_id.clone();
        let stored_thread = self
            .thread_store
            .unarchive_thread(StoreArchiveThreadParams { thread_id })
            .await
            .map_err(|err| thread_store_archive_error("unarchive", err))?;
        let (mut thread, _) =
            thread_from_stored_thread(stored_thread, fallback_provider.as_str(), &self.config.cwd);

        thread.status = resolve_thread_status(
            self.thread_watch_manager
                .loaded_status_for_thread(&thread.id)
                .await,
            /*has_in_progress_turn*/ false,
        );
        self.attach_thread_name(thread_id, &mut thread).await;
        let thread_id = thread.id.clone();
        Ok((ThreadUnarchiveResponse { thread }, thread_id))
    }

    async fn thread_rollback_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<(), JSONRPCErrorError> {
        self.thread_rollback_start(request_id, params).await
    }

    async fn thread_rollback_start(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadRollbackParams,
    ) -> Result<(), JSONRPCErrorError> {
        let ThreadRollbackParams {
            thread_id,
            num_turns,
        } = params;

        if num_turns == 0 {
            return Err(invalid_request("numTurns must be >= 1"));
        }

        let (thread_id, thread) = self.load_thread(&thread_id).await?;
        super::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "thread/rollback",
        )
        .await?;

        let request = request_id.clone();

        let rollback_already_in_progress = {
            let thread_state = self.thread_state_manager.thread_state(thread_id).await;
            let mut thread_state = thread_state.lock().await;
            if thread_state.pending_rollbacks.is_some() {
                true
            } else {
                thread_state.pending_rollbacks = Some(request.clone());
                false
            }
        };
        if rollback_already_in_progress {
            return Err(invalid_request(
                "rollback already in progress for this thread",
            ));
        }

        if let Err(err) = self
            .submit_core_op(
                request_id,
                thread.as_ref(),
                Op::ThreadRollback { num_turns },
            )
            .await
        {
            // No ThreadRollback event will arrive if an error occurs.
            // Clean up and reply immediately.
            let thread_state = self.thread_state_manager.thread_state(thread_id).await;
            thread_state.lock().await.pending_rollbacks = None;

            return Err(internal_error(format!("failed to start rollback: {err}")));
        }
        Ok(())
    }

    async fn thread_compact_start_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadCompactStartParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
    ) -> Result<ThreadCompactStartResponse, JSONRPCErrorError> {
        let ThreadCompactStartParams { thread_id } = params;

        let (_, thread) = self.load_thread(&thread_id).await?;
        super::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "thread/compact/start",
        )
        .await?;
        if let Some(runtime) = execution_context_runtime.as_ref() {
            runtime
                .ensure_operation_supported(
                    &thread_id,
                    crate::platform_control::thread_execution_context_runtime::CloudAgentThreadOperation::Compact,
                )
                .await?;
        }
        self.submit_core_op(request_id, thread.as_ref(), Op::Compact)
            .await
            .map_err(|err| internal_error(format!("failed to start compaction: {err}")))?;
        Ok(ThreadCompactStartResponse {})
    }

    async fn thread_background_terminals_clean_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadBackgroundTerminalsCleanParams,
    ) -> Result<ThreadBackgroundTerminalsCleanResponse, JSONRPCErrorError> {
        let ThreadBackgroundTerminalsCleanParams { thread_id } = params;

        let (_, thread) = self.load_thread(&thread_id).await?;
        super::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "thread/backgroundTerminals/clean",
        )
        .await?;
        self.submit_core_op(request_id, thread.as_ref(), Op::CleanBackgroundTerminals)
            .await
            .map_err(|err| {
                internal_error(format!("failed to clean background terminals: {err}"))
            })?;
        Ok(ThreadBackgroundTerminalsCleanResponse {})
    }

    async fn thread_background_terminals_list_inner(
        &self,
        params: ThreadBackgroundTerminalsListParams,
    ) -> Result<ThreadBackgroundTerminalsListResponse, JSONRPCErrorError> {
        let ThreadBackgroundTerminalsListParams {
            thread_id,
            cursor,
            limit,
        } = params;

        let (_, thread) = self.load_thread(&thread_id).await?;
        let terminals = thread
            .list_background_terminals()
            .await
            .into_iter()
            .map(|terminal| ThreadBackgroundTerminal {
                item_id: terminal.item_id,
                process_id: terminal.process_id,
                command: terminal.command,
                cwd: terminal.cwd,
                os_pid: None,
                cpu_percent: None,
                rss_kb: None,
            })
            .collect::<Vec<_>>();

        let (data, next_cursor) = paginate_background_terminals(&terminals, cursor, limit)?;

        Ok(ThreadBackgroundTerminalsListResponse { data, next_cursor })
    }

    async fn thread_background_terminals_terminate_inner(
        &self,
        params: ThreadBackgroundTerminalsTerminateParams,
    ) -> Result<ThreadBackgroundTerminalsTerminateResponse, JSONRPCErrorError> {
        let ThreadBackgroundTerminalsTerminateParams {
            thread_id,
            process_id,
        } = params;
        let process_id = process_id.parse::<i32>().map_err(|err| {
            invalid_request(format!("invalid background terminal process id: {err}"))
        })?;

        let (_, thread) = self.load_thread(&thread_id).await?;
        super::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "thread/backgroundTerminals/terminate",
        )
        .await?;
        let terminated = thread.terminate_background_terminal(process_id).await;
        Ok(ThreadBackgroundTerminalsTerminateResponse { terminated })
    }

    async fn thread_shell_command_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadShellCommandParams,
    ) -> Result<ThreadShellCommandResponse, JSONRPCErrorError> {
        let ThreadShellCommandParams { thread_id, command } = params;
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err(invalid_request("command must not be empty"));
        }
        // `thread/shellCommand` is app-server's local-host shell escape hatch,
        // not the normal turn-selected shell tool path.
        if self
            .thread_manager
            .environment_manager()
            .try_local_environment()
            .is_none()
        {
            return Err(internal_error("local environment is not configured"));
        }

        let (_, thread) = self.load_thread(&thread_id).await?;
        super::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "thread/shellCommand",
        )
        .await?;
        self.submit_core_op(
            request_id,
            thread.as_ref(),
            Op::RunUserShellCommand { command },
        )
        .await
        .map_err(|err| internal_error(format!("failed to start shell command: {err}")))?;
        Ok(ThreadShellCommandResponse {})
    }

    async fn thread_approve_guardian_denied_action_inner(
        &self,
        request_id: &ConnectionRequestId,
        params: ThreadApproveGuardianDeniedActionParams,
    ) -> Result<ThreadApproveGuardianDeniedActionResponse, JSONRPCErrorError> {
        let ThreadApproveGuardianDeniedActionParams { thread_id, event } = params;
        let event = serde_json::from_value(event)
            .map_err(|err| invalid_request(format!("invalid Guardian denial event: {err}")))?;
        let (_, thread) = self.load_thread(&thread_id).await?;
        super::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "thread/approveGuardianDeniedAction",
        )
        .await?;

        self.submit_core_op(
            request_id,
            thread.as_ref(),
            Op::ApproveGuardianDeniedAction { event },
        )
        .await
        .map_err(|err| internal_error(format!("failed to approve Guardian denial: {err}")))?;
        Ok(ThreadApproveGuardianDeniedActionResponse {})
    }

    async fn thread_list_response_inner(
        &self,
        params: ThreadListParams,
    ) -> Result<ThreadListResponse, JSONRPCErrorError> {
        let ThreadListParams {
            cursor,
            limit,
            sort_key,
            sort_direction,
            model_providers,
            source_kinds,
            archived,
            cwd,
            use_state_db_only,
            search_term,
        } = params;
        let cwd_filters = normalize_thread_list_cwd_filters(cwd)?;

        let requested_page_size = limit
            .map(|value| value as usize)
            .unwrap_or(THREAD_LIST_DEFAULT_LIMIT)
            .clamp(1, THREAD_LIST_MAX_LIMIT);
        let store_sort_key = match sort_key.unwrap_or(ThreadSortKey::CreatedAt) {
            ThreadSortKey::CreatedAt => StoreThreadSortKey::CreatedAt,
            ThreadSortKey::UpdatedAt => StoreThreadSortKey::UpdatedAt,
        };
        let sort_direction = sort_direction.unwrap_or(SortDirection::Desc);
        let (stored_threads, next_cursor) = self
            .list_threads_common(
                requested_page_size,
                cursor,
                store_sort_key,
                sort_direction,
                ThreadListFilters {
                    model_providers,
                    source_kinds,
                    archived: archived.unwrap_or(false),
                    cwd_filters,
                    search_term,
                    use_state_db_only,
                },
            )
            .await?;
        let backwards_cursor = stored_threads.first().and_then(|thread| {
            thread_backwards_cursor_for_sort_key(thread, store_sort_key, sort_direction)
        });
        let mut threads = Vec::with_capacity(stored_threads.len());
        let mut status_ids = Vec::with_capacity(stored_threads.len());
        let fallback_provider = self.config.model_provider_id.clone();

        for stored_thread in stored_threads {
            let (thread, _) = thread_from_stored_thread(
                stored_thread,
                fallback_provider.as_str(),
                &self.config.cwd,
            );
            status_ids.push(thread.id.clone());
            threads.push(thread);
        }

        let statuses = self
            .thread_watch_manager
            .loaded_statuses_for_threads(status_ids)
            .await;

        let data: Vec<_> = threads
            .into_iter()
            .map(|mut thread| {
                if let Some(status) = statuses.get(&thread.id) {
                    thread.status = status.clone();
                }
                thread
            })
            .collect();
        Ok(ThreadListResponse {
            data,
            next_cursor,
            backwards_cursor,
        })
    }

    async fn thread_search_response_inner(
        &self,
        params: ThreadSearchParams,
    ) -> Result<ThreadSearchResponse, JSONRPCErrorError> {
        let ThreadSearchParams {
            cursor,
            limit,
            sort_key,
            sort_direction,
            source_kinds,
            archived,
            search_term,
        } = params;
        let search_term = search_term.trim().to_string();
        let search_term = (!search_term.is_empty())
            .then_some(search_term)
            .ok_or_else(|| invalid_request("thread/search requires a non-empty searchTerm"))?;
        let requested_page_size = limit
            .map(|value| value as usize)
            .unwrap_or(THREAD_LIST_DEFAULT_LIMIT)
            .clamp(1, THREAD_LIST_MAX_LIMIT);
        let store_sort_key = match sort_key.unwrap_or(ThreadSortKey::CreatedAt) {
            ThreadSortKey::CreatedAt => StoreThreadSortKey::CreatedAt,
            ThreadSortKey::UpdatedAt => StoreThreadSortKey::UpdatedAt,
        };
        let store_sort_direction = sort_direction.unwrap_or(SortDirection::Desc);
        let (allowed_sources, source_kind_filter) = compute_source_filters(source_kinds);
        let mut cursor_obj = cursor;
        let mut last_cursor = cursor_obj.clone();
        let mut remaining = requested_page_size;
        let mut search_results = Vec::with_capacity(requested_page_size);
        let mut next_cursor = None;

        while remaining > 0 {
            let page = self
                .thread_store
                .search_threads(StoreSearchThreadsParams {
                    page_size: remaining.min(THREAD_LIST_MAX_LIMIT),
                    cursor: cursor_obj.clone(),
                    sort_key: store_sort_key,
                    sort_direction: match store_sort_direction {
                        SortDirection::Asc => StoreSortDirection::Asc,
                        SortDirection::Desc => StoreSortDirection::Desc,
                    },
                    allowed_sources: allowed_sources.clone(),
                    archived: archived.unwrap_or(false),
                    search_term: search_term.clone(),
                })
                .await
                .map_err(thread_store_list_error)?;

            for result in page.items {
                let source = with_thread_spawn_agent_metadata(
                    result.thread.source.clone(),
                    result.thread.agent_nickname.clone(),
                    result.thread.agent_role.clone(),
                );
                if source_kind_filter
                    .as_ref()
                    .is_none_or(|filter| source_kind_matches(&source, filter))
                {
                    search_results.push(result);
                    if search_results.len() >= requested_page_size {
                        break;
                    }
                }
            }

            remaining = requested_page_size.saturating_sub(search_results.len());
            next_cursor = page.next_cursor;
            if remaining == 0 {
                break;
            }

            let Some(cursor_val) = next_cursor.clone() else {
                break;
            };
            if last_cursor.as_ref() == Some(&cursor_val) {
                next_cursor = None;
                break;
            }
            last_cursor = Some(cursor_val.clone());
            cursor_obj = Some(cursor_val);
        }

        let backwards_cursor = search_results.first().and_then(|result| {
            thread_backwards_cursor_for_sort_key(
                &result.thread,
                store_sort_key,
                store_sort_direction,
            )
        });
        let fallback_provider = self.config.model_provider_id.clone();
        let mut results = Vec::with_capacity(search_results.len());
        let mut status_ids = Vec::with_capacity(search_results.len());
        for result in search_results {
            let (thread, _) = thread_from_stored_thread(
                result.thread,
                fallback_provider.as_str(),
                &self.config.cwd,
            );
            status_ids.push(thread.id.clone());
            results.push((thread, result.snippet));
        }
        let statuses = self
            .thread_watch_manager
            .loaded_statuses_for_threads(status_ids)
            .await;
        let data = results
            .into_iter()
            .map(|(mut thread, snippet)| {
                if let Some(status) = statuses.get(&thread.id) {
                    thread.status = status.clone();
                }
                ThreadSearchResult { thread, snippet }
            })
            .collect();

        Ok(ThreadSearchResponse {
            data,
            next_cursor,
            backwards_cursor,
        })
    }

    async fn thread_loaded_list_response_inner(
        &self,
        params: ThreadLoadedListParams,
    ) -> Result<ThreadLoadedListResponse, JSONRPCErrorError> {
        let ThreadLoadedListParams { cursor, limit } = params;
        let mut data: Vec<String> = self
            .thread_manager
            .list_thread_ids()
            .await
            .into_iter()
            .map(|thread_id| thread_id.to_string())
            .collect();

        if data.is_empty() {
            return Ok(ThreadLoadedListResponse {
                data,
                next_cursor: None,
            });
        }

        data.sort();
        let total = data.len();
        let start = match cursor {
            Some(cursor) => {
                let cursor = match ThreadId::from_string(&cursor) {
                    Ok(id) => id.to_string(),
                    Err(_) => return Err(invalid_request(format!("invalid cursor: {cursor}"))),
                };
                match data.binary_search(&cursor) {
                    Ok(idx) => idx + 1,
                    Err(idx) => idx,
                }
            }
            None => 0,
        };

        let effective_limit = limit.unwrap_or(total as u32).max(1) as usize;
        let end = start.saturating_add(effective_limit).min(total);
        let page = data[start..end].to_vec();
        let next_cursor = page.last().filter(|_| end < total).cloned();

        Ok(ThreadLoadedListResponse {
            data: page,
            next_cursor,
        })
    }

    async fn thread_read_response_inner(
        &self,
        params: ThreadReadParams,
    ) -> Result<ThreadReadResponse, JSONRPCErrorError> {
        let ThreadReadParams {
            thread_id,
            include_turns,
        } = params;

        let thread_uuid = ThreadId::from_string(&thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;

        let thread = self
            .read_thread_view(thread_uuid, include_turns)
            .await
            .map_err(thread_read_view_error)?;
        Ok(ThreadReadResponse { thread })
    }

    /// Builds the API view for `thread/read` from persisted metadata plus optional live state.
    async fn read_thread_view(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Thread, ThreadReadViewError> {
        let loaded_thread = self.thread_manager.get_thread(thread_id).await.ok();
        let mut thread = if include_turns {
            if let Some(loaded_thread) = loaded_thread.as_ref() {
                // Loaded thread with turns: use persisted metadata when it exists,
                // but reconstruct turns from the live ThreadStore history.
                let persisted_thread = self
                    .load_persisted_thread_for_read(thread_id, /*include_turns*/ false)
                    .await?;
                self.load_live_thread_view(
                    thread_id,
                    include_turns,
                    loaded_thread,
                    persisted_thread,
                )
                .await?
            } else if let Some(thread) = self
                .load_persisted_thread_for_read(thread_id, include_turns)
                .await?
            {
                // Unloaded thread with turns: load metadata and history together
                // from the ThreadStore.
                thread
            } else {
                return Err(ThreadReadViewError::InvalidRequest(format!(
                    "thread not loaded: {thread_id}"
                )));
            }
        } else if let Some(thread) = self
            .load_persisted_thread_for_read(thread_id, include_turns)
            .await?
        {
            // Persisted metadata-only read: no live thread state is needed.
            thread
        } else if let Some(loaded_thread) = loaded_thread.as_ref() {
            // Loaded metadata-only read before persistence is materialized: build
            // the response from the live thread snapshot.
            self.load_live_thread_view(
                thread_id,
                include_turns,
                loaded_thread,
                /*persisted_thread*/ None,
            )
            .await?
        } else {
            return Err(ThreadReadViewError::InvalidRequest(format!(
                "thread not loaded: {thread_id}"
            )));
        };

        let has_live_in_progress_turn = if let Some(loaded_thread) = loaded_thread.as_ref() {
            matches!(loaded_thread.agent_status().await, AgentStatus::Running)
        } else {
            false
        };

        let thread_status = self
            .thread_watch_manager
            .loaded_status_for_thread(&thread.id)
            .await;

        set_thread_status_and_interrupt_stale_turns(
            &mut thread,
            thread_status,
            has_live_in_progress_turn,
        );
        Ok(thread)
    }

    async fn load_persisted_thread_for_read(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Option<Thread>, ThreadReadViewError> {
        let fallback_provider = self.config.model_provider_id.as_str();
        match self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: include_turns,
            })
            .await
        {
            Ok(stored_thread) => {
                let (mut thread, history) =
                    thread_from_stored_thread(stored_thread, fallback_provider, &self.config.cwd);
                if include_turns && let Some(history) = history {
                    thread.turns = build_api_turns_from_rollout_items(&history.items);
                }
                Ok(Some(thread))
            }
            Err(ThreadStoreError::InvalidRequest { message })
                if message == format!("no rollout found for thread id {thread_id}") =>
            {
                Ok(None)
            }
            Err(ThreadStoreError::ThreadNotFound {
                thread_id: missing_thread_id,
            }) if missing_thread_id == thread_id => Ok(None),
            Err(ThreadStoreError::InvalidRequest { message }) => {
                Err(ThreadReadViewError::InvalidRequest(message))
            }
            Err(err) => Err(ThreadReadViewError::Internal(format!(
                "failed to read thread: {err}"
            ))),
        }
    }

    /// Builds a `thread/read` view from a loaded thread plus optional persisted metadata.
    async fn load_live_thread_view(
        &self,
        thread_id: ThreadId,
        include_turns: bool,
        loaded_thread: &CrewonThread,
        persisted_thread: Option<Thread>,
    ) -> Result<Thread, ThreadReadViewError> {
        let config_snapshot = loaded_thread.config_snapshot().await;
        if include_turns && config_snapshot.ephemeral {
            return Err(ThreadReadViewError::InvalidRequest(
                "ephemeral threads do not support includeTurns".to_string(),
            ));
        }
        let fallback_thread =
            build_thread_from_loaded_snapshot(thread_id, &config_snapshot, loaded_thread);
        let mut thread = if let Some(mut thread) = persisted_thread {
            if thread.path.is_none() {
                thread.path = fallback_thread.path.clone();
            }
            thread.session_id.clone_from(&fallback_thread.session_id);
            thread.ephemeral = fallback_thread.ephemeral;
            thread
        } else {
            fallback_thread
        };
        self.apply_thread_read_store_fields(thread_id, &mut thread, include_turns, loaded_thread)
            .await?;
        Ok(thread)
    }

    async fn apply_thread_read_store_fields(
        &self,
        thread_id: ThreadId,
        thread: &mut Thread,
        include_turns: bool,
        loaded_thread: &CrewonThread,
    ) -> Result<(), ThreadReadViewError> {
        self.attach_thread_name(thread_id, thread).await;

        if include_turns {
            let history = loaded_thread
                .load_history(/*include_archived*/ true)
                .await
                .map_err(|err| thread_read_history_load_error(thread_id, err))?;
            thread.turns = build_api_turns_from_rollout_items(&history.items);
        }

        Ok(())
    }

    async fn thread_turns_list_response_inner(
        &self,
        params: ThreadTurnsListParams,
    ) -> Result<ThreadTurnsListResponse, JSONRPCErrorError> {
        let ThreadTurnsListParams {
            thread_id,
            cursor,
            limit,
            sort_direction,
            items_view,
        } = params;
        let thread_uuid = ThreadId::from_string(&thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;

        let items = self
            .load_thread_turns_list_history(thread_uuid)
            .await
            .map_err(thread_read_view_error)?;
        // This API optimizes network transfer by letting clients page through a
        // thread's turns incrementally, but it still replays the entire rollout on
        // every request. Rollback and compaction events can change earlier turns, so
        // the server has to rebuild the full turn list until turn metadata is indexed
        // separately.
        let loaded_thread = self.thread_manager.get_thread(thread_uuid).await.ok();
        let has_live_running_thread = match loaded_thread.as_ref() {
            Some(thread) => matches!(thread.agent_status().await, AgentStatus::Running),
            None => false,
        };
        let active_turn = if loaded_thread.is_some() {
            // Persisted history may not yet include the currently running turn. The
            // app-server listener has already projected live turn events into ThreadState,
            // so merge that in-memory snapshot before paginating.
            let thread_state = self.thread_state_manager.thread_state(thread_uuid).await;
            let state = thread_state.lock().await;
            state.active_turn_snapshot()
        } else {
            None
        };
        build_thread_turns_page_response(
            &items,
            self.thread_watch_manager
                .loaded_status_for_thread(&thread_uuid.to_string())
                .await,
            has_live_running_thread,
            active_turn,
            ThreadTurnsPageOptions {
                cursor: cursor.as_deref(),
                limit,
                sort_direction: sort_direction.unwrap_or(SortDirection::Desc),
                items_view: items_view.unwrap_or(TurnItemsView::Summary),
            },
        )
    }

    async fn load_thread_turns_list_history(
        &self,
        thread_id: ThreadId,
    ) -> Result<Vec<RolloutItem>, ThreadReadViewError> {
        match self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: true,
            })
            .await
        {
            Ok(stored_thread) => {
                let history = stored_thread.history.ok_or_else(|| {
                    ThreadReadViewError::Internal(format!(
                        "thread store did not return history for thread {thread_id}"
                    ))
                })?;
                return Ok(history.items);
            }
            Err(ThreadStoreError::InvalidRequest { message })
                if message == format!("no rollout found for thread id {thread_id}") => {}
            Err(ThreadStoreError::ThreadNotFound {
                thread_id: missing_thread_id,
            }) if missing_thread_id == thread_id => {}
            Err(ThreadStoreError::InvalidRequest { message }) => {
                return Err(ThreadReadViewError::InvalidRequest(message));
            }
            Err(err) => {
                return Err(ThreadReadViewError::Internal(format!(
                    "failed to read thread: {err}"
                )));
            }
        }

        let thread = self
            .thread_manager
            .get_thread(thread_id)
            .await
            .map_err(|_| {
                ThreadReadViewError::InvalidRequest(format!("thread not loaded: {thread_id}"))
            })?;
        let config_snapshot = thread.config_snapshot().await;
        if config_snapshot.ephemeral {
            return Err(ThreadReadViewError::InvalidRequest(
                "ephemeral threads do not support thread/turns/list".to_string(),
            ));
        }

        thread
            .load_history(/*include_archived*/ true)
            .await
            .map(|history| history.items)
            .map_err(|err| thread_turns_list_history_load_error(thread_id, err))
    }

    pub(crate) fn thread_created_receiver(&self) -> broadcast::Receiver<ThreadId> {
        self.thread_manager.subscribe_thread_created()
    }

    pub(crate) async fn start_office_member_runtime_thread(
        &self,
        params: OfficeMemberRuntimeThreadStart,
        connection_id: ConnectionId,
    ) -> Result<Thread, JSONRPCErrorError> {
        self.start_office_runtime_thread(
            OfficeRuntimeThreadStart {
                cwd: params.cwd,
                model: params.model,
                permissions: params.permissions,
                base_instructions: params.base_instructions,
                developer_instructions: params.developer_instructions,
                thread_source: "office_member_runtime",
                metrics_service_name: "app-server-office-runtime-repair",
                listener_label: "office member runtime thread",
                error_context: "office member runtime thread",
            },
            connection_id,
        )
        .await
    }

    pub(crate) async fn start_office_manager_runtime_thread(
        &self,
        params: OfficeManagerRuntimeThreadStart,
        connection_id: ConnectionId,
    ) -> Result<Thread, JSONRPCErrorError> {
        self.start_office_runtime_thread(
            OfficeRuntimeThreadStart {
                cwd: params.cwd,
                model: None,
                permissions: None,
                base_instructions: None,
                developer_instructions: None,
                thread_source: crate::office_runtime_contract::OFFICE_MANAGER_RUNTIME_THREAD_SOURCE,
                metrics_service_name: "app-server-office-manager-runtime",
                listener_label: "office manager runtime thread",
                error_context: "office manager runtime thread",
            },
            connection_id,
        )
        .await
    }

    pub(crate) async fn start_workflow_agent_runtime_thread(
        &self,
        params: WorkflowAgentRuntimeThreadStart,
        connection_id: ConnectionId,
    ) -> Result<Thread, JSONRPCErrorError> {
        self.start_office_runtime_thread(
            OfficeRuntimeThreadStart {
                cwd: params.cwd,
                model: params.model,
                permissions: params.permissions,
                base_instructions: None,
                developer_instructions: params.developer_instructions,
                thread_source: "workflow_agent_runtime",
                metrics_service_name: "app-server-workflow-agent-runtime",
                listener_label: "workflow agent runtime thread",
                error_context: "workflow agent runtime thread",
            },
            connection_id,
        )
        .await
    }

    pub(crate) async fn start_office_automation_runtime_thread(
        &self,
        params: OfficeAutomationRuntimeThreadStart,
        connection_id: ConnectionId,
    ) -> Result<Thread, JSONRPCErrorError> {
        self.start_office_runtime_thread(
            OfficeRuntimeThreadStart {
                cwd: params.cwd,
                model: None,
                permissions: None,
                base_instructions: params.base_instructions,
                developer_instructions: params.developer_instructions,
                thread_source: "office_automation_runtime",
                metrics_service_name: "app-server-office-automation-runtime-repair",
                listener_label: "office automation runtime thread",
                error_context: "office automation runtime thread",
            },
            connection_id,
        )
        .await
    }

    async fn start_office_runtime_thread(
        &self,
        params: OfficeRuntimeThreadStart,
        connection_id: ConnectionId,
    ) -> Result<Thread, JSONRPCErrorError> {
        let mut typesafe_overrides = self.build_thread_config_overrides(
            params.model,
            /*model_provider*/ None,
            /*service_tier*/ None,
            Some(params.cwd),
            /*runtime_workspace_roots*/ None,
            /*approval_policy*/ None,
            /*approvals_reviewer*/ None,
            /*sandbox*/ None,
            params.permissions,
            params.base_instructions,
            params.developer_instructions,
            /*personality*/ None,
        );
        typesafe_overrides.ephemeral = Some(false);
        let config = self
            .config_manager
            .load_with_overrides(/*request_overrides*/ None, typesafe_overrides)
            .await
            .map_err(|err| config_load_error(&err))?;
        let environments = self
            .thread_manager
            .default_environment_selections(&config.cwd);
        let NewThread {
            thread_id,
            thread: crewon_thread,
            session_configured,
            ..
        } = self
            .thread_manager
            .start_thread_with_options(StartThreadOptions {
                config,
                initial_history: InitialHistory::New,
                session_source: None,
                thread_source: Some(crewon_protocol::protocol::ThreadSource::Feature(
                    params.thread_source.to_string(),
                )),
                dynamic_tools: Vec::new(),
                metrics_service_name: Some(params.metrics_service_name.to_string()),
                parent_trace: None,
                environments,
                thread_extension_init: ExtensionDataInit::new(),
            })
            .await
            .map_err(|err| match err {
                CodexErr::InvalidRequest(message) => invalid_request(message),
                err => internal_error(format!("error creating {}: {err}", params.error_context)),
            })?;
        log_listener_attach_result(
            self.ensure_conversation_listener(
                thread_id,
                connection_id,
                /*raw_events_enabled*/ false,
            )
            .await,
            thread_id,
            connection_id,
            params.listener_label,
        );

        let config_snapshot = crewon_thread.config_snapshot().await;
        let mut thread = build_thread_from_snapshot(
            thread_id,
            session_configured.session_id.to_string(),
            &config_snapshot,
            session_configured.rollout_path,
        );
        self.thread_watch_manager
            .upsert_thread_silently(thread.clone())
            .await;
        thread.status = resolve_thread_status(
            self.thread_watch_manager
                .loaded_status_for_thread(&thread.id)
                .await,
            /*has_in_progress_turn*/ false,
        );
        Ok(thread)
    }

    pub(crate) async fn office_manager_runtime_provenance(
        &self,
        thread_id: &str,
    ) -> Result<OfficeManagerRuntimeProvenance, JSONRPCErrorError> {
        let stored = self
            .read_stored_thread_for_resume(
                thread_id, /*path*/ None, /*include_history*/ false,
            )
            .await?;
        if stored.thread_source.as_ref().is_some_and(|source| {
            source.as_str() == crate::office_runtime_contract::OFFICE_MANAGER_RUNTIME_THREAD_SOURCE
        }) {
            Ok(OfficeManagerRuntimeProvenance::ServerOwned)
        } else {
            Ok(OfficeManagerRuntimeProvenance::Legacy)
        }
    }

    pub(crate) async fn discard_office_runtime_thread(
        &self,
        thread_id: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(thread_id)
            .map_err(|error| invalid_request(format!("invalid thread id: {error}")))?;
        let rollback =
            super::thread_execution_context_lifecycle::ThreadExecutionContextRollback::new(
                Arc::clone(&self.thread_manager),
                Arc::clone(&self.thread_store),
                self.state_db.clone(),
            );
        rollback.rollback(thread_id).await.map_err(|error| {
            internal_error(format!("failed to discard Office runtime: {error}"))
        })?;
        self.finalize_thread_teardown(thread_id).await;
        Ok(())
    }

    pub(crate) async fn connection_initialized(
        &self,
        connection_id: ConnectionId,
        capabilities: ConnectionCapabilities,
    ) {
        self.thread_state_manager
            .connection_initialized(connection_id, capabilities)
            .await;
    }

    pub(crate) async fn connection_closed(&self, connection_id: ConnectionId) {
        let thread_ids = self
            .thread_state_manager
            .remove_connection(connection_id)
            .await;

        for thread_id in thread_ids {
            if self.thread_manager.get_thread(thread_id).await.is_err() {
                // Reconcile stale app-server bookkeeping when the thread has already been
                // removed from the core manager.
                self.finalize_thread_teardown(thread_id).await;
            }
        }
    }

    pub(crate) fn subscribe_running_assistant_turn_count(&self) -> watch::Receiver<usize> {
        self.thread_watch_manager.subscribe_running_turn_count()
    }

    /// Best-effort: ensure initialized connections are subscribed to this thread.
    pub(crate) async fn try_attach_thread_listener(
        &self,
        thread_id: ThreadId,
        connection_ids: Vec<ConnectionId>,
    ) {
        let mut raw_events_enabled = false;
        if let Ok(thread) = self.thread_manager.get_thread(thread_id).await {
            let config_snapshot = thread.config_snapshot().await;
            let loaded_thread = build_thread_from_snapshot(
                thread_id,
                thread.session_configured().session_id.to_string(),
                &config_snapshot,
                thread.rollout_path(),
            );
            self.thread_watch_manager.upsert_thread(loaded_thread).await;
            if let Some(parent_thread_id) = config_snapshot.parent_thread_id {
                raw_events_enabled = self
                    .thread_state_manager
                    .thread_state(parent_thread_id)
                    .await
                    .lock()
                    .await
                    .experimental_raw_events;
            }
        }

        for connection_id in connection_ids {
            log_listener_attach_result(
                self.ensure_conversation_listener(thread_id, connection_id, raw_events_enabled)
                    .await,
                thread_id,
                connection_id,
                "thread",
            );
        }
    }

    pub(crate) async fn persisted_terminal_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Option<Turn>, JSONRPCErrorError> {
        let thread_id = match ThreadId::from_string(thread_id) {
            Ok(thread_id) => thread_id,
            Err(err) => {
                return Err(invalid_request(format!("invalid session id: {err}")));
            }
        };
        let stored_thread = match self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: true,
            })
            .await
        {
            Ok(stored_thread) => stored_thread,
            Err(ThreadStoreError::ThreadNotFound { .. }) => return Ok(None),
            Err(err) => return Err(thread_store_resume_read_error(err)),
        };
        let Some(history) = stored_thread.history else {
            return Ok(None);
        };
        Ok(build_api_turns_from_rollout_items(&history.items)
            .into_iter()
            .find(|turn| {
                turn.id == turn_id
                    && matches!(
                        turn.status,
                        TurnStatus::Completed | TurnStatus::Interrupted | TurnStatus::Failed
                    )
            }))
    }

    pub(crate) async fn thread_has_persisted_rollout(
        &self,
        thread_id: &str,
    ) -> Result<bool, JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;
        match self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: true,
            })
            .await
        {
            Ok(stored_thread) => Ok(stored_thread
                .history
                .as_ref()
                .is_some_and(|history| !history.items.is_empty())),
            Err(ThreadStoreError::ThreadNotFound { .. }) => Ok(false),
            Err(ThreadStoreError::InvalidRequest { message })
                if message == format!("no rollout found for thread id {thread_id}") =>
            {
                Ok(false)
            }
            Err(err) => Err(thread_store_resume_read_error(err)),
        }
    }

    pub(crate) async fn office_dispatch_thread_is_loaded(
        &self,
        thread_id: &str,
    ) -> Result<bool, JSONRPCErrorError> {
        let parsed_thread_id = ThreadId::from_string(thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;
        Ok(self
            .thread_manager
            .get_thread(parsed_thread_id)
            .await
            .is_ok())
    }

    pub(crate) async fn ensure_office_automation_runtime_thread(
        &self,
        domain_processor: &CrewonDomainRequestProcessor,
        cwd: &str,
        automation_file_path: &str,
        automation_id: &str,
        automation_config: &mut serde_json::Value,
        connection_id: ConnectionId,
    ) -> Result<Option<OfficeAutomationRuntimeRepair>, JSONRPCErrorError> {
        let Some(old_thread_id) = office_automation_runtime_thread_id(automation_config) else {
            return Ok(None);
        };
        let old_thread_id = old_thread_id.to_string();
        let repair_reason = if self
            .office_dispatch_thread_is_loaded(&old_thread_id)
            .await?
        {
            if automation_config
                .get("runtimeRepairSourceThreadId")
                .and_then(serde_json::Value::as_str)
                .is_some()
            {
                return Ok(None);
            }
            if self.thread_has_persisted_rollout(&old_thread_id).await? {
                return Ok(None);
            }
            "loaded thread has no persisted rollout".to_string()
        } else {
            match self
                .ensure_thread_loaded_for_office_dispatch(&old_thread_id, connection_id)
                .await
            {
                Ok(()) => {
                    if self.thread_has_persisted_rollout(&old_thread_id).await? {
                        return Ok(None);
                    }
                    "missing persisted rollout".to_string()
                }
                Err(err) => {
                    if office_automation_dispatch_thread_can_be_repaired(&err, &old_thread_id) {
                        err.message.clone()
                    } else {
                        return Err(err);
                    }
                }
            }
        };
        tracing::warn!(
            automation_id,
            thread_id = %old_thread_id,
            reason = %repair_reason,
            "repairing office automation runtime thread"
        );
        let developer_instructions =
            office_automation_runtime_developer_instructions(automation_config, automation_id);
        let thread = self
            .start_office_automation_runtime_thread(
                OfficeAutomationRuntimeThreadStart {
                    cwd: cwd.to_string(),
                    base_instructions: None,
                    developer_instructions,
                },
                connection_id,
            )
            .await?;
        let new_thread_id = thread.id;
        let repaired_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let Some(object) = automation_config.as_object_mut() else {
            return Err(invalid_request(
                "automation config must be an object for runtime repair",
            ));
        };
        set_office_automation_runtime_json_string(object, "threadId", &new_thread_id);
        set_office_automation_runtime_json_string(
            object,
            "runtimeRepairSourceThreadId",
            &old_thread_id,
        );
        set_office_automation_runtime_json_string(object, "runtimeRepairedAt", &repaired_at);
        set_office_automation_runtime_json_string(object, "updatedAt", &repaired_at);
        domain_processor
            .automation_update(AutomationUpdateParams {
                cwd: cwd.to_string(),
                file_path: automation_file_path.to_string(),
                config: automation_config.clone(),
            })
            .await?;
        Ok(Some(OfficeAutomationRuntimeRepair {
            source_thread_id: old_thread_id,
            repaired_at,
        }))
    }

    pub(crate) async fn ensure_thread_loaded_for_office_dispatch(
        &self,
        thread_id: &str,
        connection_id: ConnectionId,
    ) -> Result<(), JSONRPCErrorError> {
        let parsed_thread_id = ThreadId::from_string(thread_id)
            .map_err(|err| invalid_request(format!("invalid thread id: {err}")))?;
        if self
            .thread_manager
            .get_thread(parsed_thread_id)
            .await
            .is_ok()
        {
            return Ok(());
        }
        if self
            .pending_thread_unloads
            .lock()
            .await
            .contains(&parsed_thread_id)
        {
            return Err(invalid_request(format!(
                "thread {parsed_thread_id} is closing; retry office dispatch after the thread is closed"
            )));
        }

        let _thread_list_state_permit = self.acquire_thread_list_state_permit().await?;
        if self
            .thread_manager
            .get_thread(parsed_thread_id)
            .await
            .is_ok()
        {
            return Ok(());
        }

        let (thread_history, resume_source_thread) = self
            .resume_thread_from_rollout(thread_id, /*path*/ None)
            .await?;
        let history_cwd = thread_history.session_cwd();
        let mut request_overrides = None;
        let mut typesafe_overrides = self.build_thread_config_overrides(
            /*model*/ None, /*model_provider*/ None, /*service_tier*/ None,
            /*cwd*/ None, /*runtime_workspace_roots*/ None,
            /*approval_policy*/ None, /*approvals_reviewer*/ None, /*sandbox*/ None,
            /*permissions*/ None, /*base_instructions*/ None,
            /*developer_instructions*/ None, /*personality*/ None,
        );
        self.load_and_apply_persisted_resume_metadata(
            &thread_history,
            &mut request_overrides,
            &mut typesafe_overrides,
        )
        .await;

        let config = self
            .config_manager
            .load_for_cwd(request_overrides, typesafe_overrides, history_cwd)
            .await
            .map_err(|err| config_load_error(&err))?;
        let response_history = thread_history.clone();
        let NewThread {
            thread_id,
            thread: crewon_thread,
            session_configured,
            ..
        } = self
            .thread_manager
            .resume_thread_with_history(
                config,
                thread_history,
                self.auth_manager.clone(),
                /*parent_trace*/ None,
            )
            .await
            .map_err(|err| core_thread_write_error("load office dispatch thread", err))?;
        let Some(rollout_path) = session_configured.rollout_path else {
            return Err(internal_error(format!(
                "rollout path missing for office dispatch thread {thread_id}"
            )));
        };

        log_listener_attach_result(
            self.ensure_conversation_listener(
                thread_id,
                connection_id,
                /*raw_events_enabled*/ false,
            )
            .await,
            thread_id,
            connection_id,
            "office dispatch thread",
        );

        let mut thread = self
            .load_thread_from_resume_source_or_send_internal(
                thread_id,
                crewon_thread.as_ref(),
                &response_history,
                rollout_path.as_path(),
                Some(resume_source_thread),
                /*include_turns*/ false,
            )
            .await
            .map_err(internal_error)?;
        thread.thread_source = crewon_thread
            .config_snapshot()
            .await
            .thread_source
            .map(Into::into);
        self.thread_watch_manager
            .upsert_thread_silently(thread)
            .await;
        Ok(())
    }

    pub(crate) async fn dispatch_office_after_terminal_turn(
        &self,
        cwd: &str,
        source_thread_id: &str,
        turn: Turn,
        connection_id: ConnectionId,
    ) -> Option<OfficeAutoDispatchStarted> {
        self.ensure_office_auto_verification_runtime_threads(
            cwd,
            source_thread_id,
            &turn,
            connection_id,
        )
        .await;
        if let Some(office_auto_dispatch) = self.office_auto_dispatch.as_ref() {
            return office_auto_dispatch
                .dispatch_after_terminal_turn(cwd, source_thread_id, turn, connection_id)
                .await;
        }
        None
    }

    pub(crate) async fn dispatch_claimed_office_after_terminal_turn(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        turn: Turn,
        connection_id: ConnectionId,
        lease_id: &str,
    ) -> Option<OfficeAutoDispatchStarted> {
        self.ensure_office_auto_verification_runtime_threads(
            cwd,
            source_thread_id,
            &turn,
            connection_id,
        )
        .await;
        if let Some(office_auto_dispatch) = self.office_auto_dispatch.as_ref() {
            return office_auto_dispatch
                .dispatch_claimed_after_terminal_turn(
                    cwd,
                    intent_id,
                    source_thread_id,
                    turn,
                    connection_id,
                    lease_id,
                )
                .await;
        }
        None
    }

    pub(crate) async fn monitor_office_dispatched_turn_completion(
        &self,
        cwd: &str,
        thread_id: &str,
        turn_id: &str,
        connection_id: ConnectionId,
    ) {
        if let Err(err) = self
            .ensure_thread_loaded_for_office_dispatch(thread_id, connection_id)
            .await
        {
            tracing::warn!(
                thread_id,
                turn_id,
                error = %err.message,
                "failed to load office dispatched thread for completion monitor recovery"
            );
            return;
        }
        if let Some(office_auto_dispatch) = self.office_auto_dispatch.as_ref() {
            office_auto_dispatch.spawn_completion_monitor(
                cwd.to_string(),
                thread_id.to_string(),
                turn_id.to_string(),
                connection_id,
            );
        }
    }

    pub(crate) async fn dispatch_workflow_node(
        &self,
        prepared: &PreparedWorkflowNodeDispatch,
        request_id: ConnectionRequestId,
        app_server_client_name: Option<String>,
        client_version: Option<String>,
        notification_reason: &str,
        connection_id: ConnectionId,
    ) -> Result<WorkflowRunUpdate, JSONRPCErrorError> {
        let context = self
            .office_auto_dispatch
            .as_ref()
            .ok_or_else(|| internal_error("Workflow dispatch runtime is unavailable"))?;
        context
            .dispatch_prepared_workflow_node(
                prepared,
                request_id,
                app_server_client_name,
                client_version,
                notification_reason,
                connection_id,
            )
            .await
    }

    async fn ensure_office_auto_verification_runtime_threads(
        &self,
        cwd: &str,
        source_thread_id: &str,
        turn: &Turn,
        connection_id: ConnectionId,
    ) {
        let Some(domain_processor) = self
            .office_auto_dispatch
            .as_ref()
            .map(|context| Arc::clone(&context.domain_processor))
        else {
            return;
        };
        let records = match domain_processor
            .office_auto_verification_automation_records_after_thread_turn(
                cwd,
                source_thread_id,
                turn,
            )
            .await
        {
            Ok(records) => records,
            Err(err) => {
                tracing::warn!(
                    thread_id = %source_thread_id,
                    turn_id = %turn.id,
                    error = %err.message,
                    "failed to read office auto verification automation targets"
                );
                return;
            }
        };
        for record in records {
            let automation_id = record
                .config
                .get("automationId")
                .or_else(|| record.config.get("id"))
                .or_else(|| record.config.get("title"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("automation")
                .to_string();
            let mut config = record.config;
            if let Err(err) = self
                .ensure_office_automation_runtime_thread(
                    &domain_processor,
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
                    "failed to repair office auto verification automation runtime"
                );
            }
        }
    }

    async fn thread_resume_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadResumeParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
        cloud_agent_projection: Option<CloudAgentThreadResumeProjection>,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<(), JSONRPCErrorError> {
        if let Ok(thread_id) = ThreadId::from_string(&params.thread_id)
            && self
                .pending_thread_unloads
                .lock()
                .await
                .contains(&thread_id)
        {
            self.outgoing
                .send_error(
                    request_id,
                    invalid_request(format!(
                        "thread {thread_id} is closing; retry thread/resume after the thread is closed"
                    )),
                )
                .await;
            return Ok(());
        }

        if params.sandbox.is_some() && params.permissions.is_some() {
            self.outgoing
                .send_error(
                    request_id,
                    invalid_request("`permissions` cannot be combined with `sandbox`"),
                )
                .await;
            return Ok(());
        }
        let redact_resume_payloads =
            should_redact_thread_resume_payloads(app_server_client_name.as_deref());

        let _thread_list_state_permit = match self.acquire_thread_list_state_permit().await {
            Ok(permit) => permit,
            Err(error) => {
                self.outgoing.send_error(request_id, error).await;
                return Ok(());
            }
        };
        let stored_thread_from_running_probe = match self
            .resume_running_thread(
                &request_id,
                &params,
                execution_context_runtime.as_ref(),
                cloud_agent_projection.as_ref(),
                app_server_client_name.clone(),
                app_server_client_version.clone(),
            )
            .await
        {
            Ok(RunningThreadResumeResult::Handled) => return Ok(()),
            Ok(RunningThreadResumeResult::NotRunning(stored_thread)) => stored_thread,
            Err(error) => {
                self.outgoing.send_error(request_id, error).await;
                return Ok(());
            }
        };

        let ThreadResumeParams {
            thread_id,
            history,
            path,
            model,
            model_provider,
            service_tier,
            cwd,
            runtime_workspace_roots,
            approval_policy,
            approvals_reviewer,
            sandbox,
            permissions,
            config: mut request_overrides,
            base_instructions,
            developer_instructions,
            personality,
            exclude_turns,
            initial_turns_page,
        } = params;
        let include_turns = !exclude_turns;

        let resume_result = if let Some(history) = history {
            self.resume_thread_from_history(history.as_slice())
                .await
                .map(|thread_history| (thread_history, None))
        } else if let Some(stored_thread) = stored_thread_from_running_probe {
            self.stored_thread_to_initial_history(&stored_thread)
                .await
                .map(|thread_history| (thread_history, Some(*stored_thread)))
        } else {
            self.resume_thread_from_rollout(&thread_id, path.as_ref())
                .await
                .map(|(thread_history, stored_thread)| (thread_history, Some(stored_thread)))
        };
        let (thread_history, resume_source_thread) = match resume_result {
            Ok(value) => value,
            Err(error) => {
                self.outgoing.send_error(request_id, error).await;
                return Ok(());
            }
        };
        let execution_context = if let (Some(runtime), Some(source_thread)) = (
            execution_context_runtime.as_ref(),
            resume_source_thread.as_ref(),
        ) {
            runtime
                .read_owned(&source_thread.thread_id.to_string())
                .await?
        } else {
            None
        };
        let persisted_scene_runtime = thread_history.get_scene_runtime();

        let history_cwd = thread_history.session_cwd();
        let runtime_workspace_roots = runtime_workspace_roots.map(resolve_runtime_workspace_roots);
        let mut typesafe_overrides = self.build_thread_config_overrides(
            model,
            model_provider,
            service_tier,
            cwd,
            runtime_workspace_roots,
            approval_policy,
            approvals_reviewer,
            sandbox,
            permissions,
            base_instructions,
            developer_instructions,
            personality,
        );
        self.load_and_apply_persisted_resume_metadata(
            &thread_history,
            &mut request_overrides,
            &mut typesafe_overrides,
        )
        .await;

        // Derive a Config using the same logic as new conversation, honoring overrides if provided.
        let mut config = match self
            .config_manager
            .load_for_cwd(request_overrides, typesafe_overrides, history_cwd)
            .await
        {
            Ok(config) => config,
            Err(err) => {
                let error = config_load_error(&err);
                self.outgoing.send_error(request_id, error).await;
                return Ok(());
            }
        };
        if let Some(scene_runtime) = persisted_scene_runtime {
            let cwd = config.cwd.to_string_lossy();
            let scene_runtime =
                match super::scene_runtime::revalidate_thread_scene(cwd.as_ref(), scene_runtime)
                    .await
                {
                    Ok(scene_runtime) => scene_runtime,
                    Err(error) => {
                        self.outgoing.send_error(request_id, error).await;
                        return Ok(());
                    }
                };
            let cwd = config.cwd.to_string_lossy().into_owned();
            if let Err(error) =
                super::scene_runtime::hydrate_thread_scene_config(&cwd, scene_runtime, &mut config)
                    .await
            {
                self.outgoing.send_error(request_id, error).await;
                return Ok(());
            }
        }

        let response_history = thread_history.clone();

        match self
            .thread_manager
            .resume_thread_with_history(
                config,
                thread_history,
                self.auth_manager.clone(),
                self.request_trace_context(&request_id).await,
            )
            .await
        {
            Ok(NewThread {
                thread_id,
                thread: crewon_thread,
                session_configured,
                ..
            }) => {
                if let Err(err) = Self::set_app_server_client_info(
                    crewon_thread.as_ref(),
                    app_server_client_name,
                    app_server_client_version,
                )
                .await
                {
                    self.outgoing.send_error(request_id, err).await;
                    return Ok(());
                }
                let instruction_sources = crewon_thread.instruction_sources().await;
                let SessionConfiguredEvent { rollout_path, .. } = session_configured;
                let Some(rollout_path) = rollout_path else {
                    let error =
                        internal_error(format!("rollout path missing for thread {thread_id}"));
                    self.outgoing.send_error(request_id, error).await;
                    return Ok(());
                };
                // Auto-attach a thread listener when resuming a thread.
                log_listener_attach_result(
                    self.ensure_conversation_listener(
                        thread_id,
                        request_id.connection_id,
                        /*raw_events_enabled*/ false,
                    )
                    .await,
                    thread_id,
                    request_id.connection_id,
                    "thread",
                );

                let mut thread = match self
                    .load_thread_from_resume_source_or_send_internal(
                        thread_id,
                        crewon_thread.as_ref(),
                        &response_history,
                        rollout_path.as_path(),
                        resume_source_thread,
                        include_turns,
                    )
                    .await
                {
                    Ok(thread) => thread,
                    Err(message) => {
                        self.outgoing
                            .send_error(request_id, internal_error(message))
                            .await;
                        return Ok(());
                    }
                };
                thread.thread_source = crewon_thread
                    .config_snapshot()
                    .await
                    .thread_source
                    .map(Into::into);

                self.thread_watch_manager
                    .upsert_thread(thread.clone())
                    .await;

                let thread_status = self
                    .thread_watch_manager
                    .loaded_status_for_thread(&thread.id)
                    .await;

                set_thread_status_and_interrupt_stale_turns(
                    &mut thread,
                    thread_status,
                    /*has_live_in_progress_turn*/ false,
                );
                if let Some(projection) = cloud_agent_projection.as_ref() {
                    if let Some(turns) = projection.turns.as_ref() {
                        thread.turns.clone_from(turns);
                    }
                    thread.status.clone_from(&projection.status);
                }
                let config_snapshot = crewon_thread.config_snapshot().await;
                let sandbox = thread_response_sandbox_policy(
                    &config_snapshot.permission_profile,
                    config_snapshot.cwd().as_path(),
                );
                let active_permission_profile = thread_response_active_permission_profile(
                    config_snapshot.active_permission_profile,
                );
                let token_usage_thread =
                    (include_turns && cloud_agent_projection.is_none()).then(|| thread.clone());
                let mut initial_turns_page =
                    if let Some(projection) = cloud_agent_projection.as_ref() {
                        projection.initial_turns_page.clone()
                    } else if let Some(params) = initial_turns_page.as_ref() {
                        match build_thread_resume_initial_turns_page(
                            &response_history.get_rollout_items(),
                            thread.status.clone(),
                            /*has_live_running_thread*/ false,
                            /*active_turn*/ None,
                            params,
                        ) {
                            Ok(page) => Some(page),
                            Err(error) => {
                                self.outgoing.send_error(request_id, error).await;
                                return Ok(());
                            }
                        }
                    } else {
                        None
                    };
                if redact_resume_payloads {
                    redact_thread_resume_payloads(&mut thread.turns);
                    if let Some(initial_turns_page) = initial_turns_page.as_mut() {
                        redact_thread_resume_payloads(&mut initial_turns_page.data);
                    }
                }

                let response = ThreadResumeResponse {
                    thread,
                    execution_context,
                    model: session_configured.model,
                    model_provider: session_configured.model_provider_id,
                    service_tier: session_configured.service_tier,
                    cwd: session_configured.cwd,
                    runtime_workspace_roots: config_snapshot.workspace_roots,
                    instruction_sources,
                    approval_policy: session_configured.approval_policy.into(),
                    approvals_reviewer: session_configured.approvals_reviewer.into(),
                    sandbox,
                    active_permission_profile,
                    reasoning_effort: session_configured.reasoning_effort,
                    scene_runtime: config_snapshot.scene_runtime.map(Into::into),
                    initial_turns_page,
                };

                let connection_id = request_id.connection_id;
                self.outgoing.send_response(request_id, response).await;
                // `excludeTurns` is explicitly the cheap resume path, so avoid
                // rebuilding history only to attribute a replayed usage update.
                if let Some(token_usage_thread) = token_usage_thread {
                    let token_usage_turn_id = latest_token_usage_turn_id_from_rollout_items(
                        &response_history.get_rollout_items(),
                        token_usage_thread.turns.as_slice(),
                    );
                    // The client needs restored usage before it starts another turn.
                    // Sending after the response preserves JSON-RPC request ordering while
                    // still filling the status line before the next turn lifecycle begins.
                    send_thread_token_usage_update_to_connection(
                        &self.outgoing,
                        connection_id,
                        thread_id,
                        &token_usage_thread,
                        crewon_thread.as_ref(),
                        token_usage_turn_id,
                    )
                    .await;
                }
                self.thread_goal_processor
                    .emit_resume_goal_snapshot_and_continue(thread_id, crewon_thread.as_ref())
                    .await;
            }
            Err(err) => {
                let error = core_thread_write_error("resume thread", err);
                self.outgoing.send_error(request_id, error).await;
            }
        }
        Ok(())
    }

    async fn load_and_apply_persisted_resume_metadata(
        &self,
        thread_history: &InitialHistory,
        request_overrides: &mut Option<HashMap<String, serde_json::Value>>,
        typesafe_overrides: &mut ConfigOverrides,
    ) -> Option<ThreadMetadata> {
        let InitialHistory::Resumed(resumed_history) = thread_history else {
            return None;
        };
        let state_db_ctx = self.state_db.clone()?;
        let persisted_metadata = state_db_ctx
            .get_thread(resumed_history.conversation_id)
            .await
            .ok()
            .flatten()?;
        merge_persisted_resume_metadata(request_overrides, typesafe_overrides, &persisted_metadata);
        Some(persisted_metadata)
    }

    async fn resume_running_thread(
        &self,
        request_id: &ConnectionRequestId,
        params: &ThreadResumeParams,
        execution_context_runtime: Option<&ThreadExecutionContextRequestRuntime>,
        cloud_agent_projection: Option<&CloudAgentThreadResumeProjection>,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<RunningThreadResumeResult, JSONRPCErrorError> {
        if params.history.is_none()
            && params.path.is_none()
            && let Some(runtime) = execution_context_runtime
        {
            runtime.authorize_existing(&params.thread_id).await?;
        }
        let running_thread = if params.history.is_some() {
            if let Ok(existing_thread_id) = ThreadId::from_string(&params.thread_id)
                && self
                    .thread_manager
                    .get_thread(existing_thread_id)
                    .await
                    .is_ok()
            {
                return Err(invalid_request(format!(
                    "cannot resume thread {existing_thread_id} with history while it is already running"
                )));
            }
            None
        } else if let Ok(existing_thread_id) = ThreadId::from_string(&params.thread_id)
            && let Ok(existing_thread) = self.thread_manager.get_thread(existing_thread_id).await
        {
            let execution_context = if let Some(runtime) = execution_context_runtime {
                runtime.read_owned(&existing_thread_id.to_string()).await?
            } else {
                None
            };
            let source_thread = self
                .read_stored_thread_for_resume(
                    &params.thread_id,
                    /*path*/ None,
                    /*include_history*/ true,
                )
                .await?;
            Some((
                existing_thread_id,
                existing_thread,
                source_thread,
                execution_context,
            ))
        } else {
            let source_thread = self
                .read_stored_thread_for_resume(
                    &params.thread_id,
                    params.path.as_ref(),
                    /*include_history*/ true,
                )
                .await?;
            let existing_thread_id = source_thread.thread_id;
            let execution_context = if let Some(runtime) = execution_context_runtime {
                runtime.read_owned(&existing_thread_id.to_string()).await?
            } else {
                None
            };
            match self.thread_manager.get_thread(existing_thread_id).await {
                Ok(existing_thread) => Some((
                    existing_thread_id,
                    existing_thread,
                    source_thread,
                    execution_context,
                )),
                Err(_) => {
                    return Ok(RunningThreadResumeResult::NotRunning(Some(Box::new(
                        source_thread,
                    ))));
                }
            }
        };

        if let Some((existing_thread_id, existing_thread, source_thread, execution_context)) =
            running_thread
        {
            let existing_thread_rollout_path = existing_thread.rollout_path();
            let active_path = existing_thread_rollout_path
                .as_ref()
                .or(source_thread.rollout_path.as_ref());
            if let (Some(requested_path), Some(active_path)) = (params.path.as_ref(), active_path)
                && !path_utils::paths_match_after_normalization(requested_path, active_path)
            {
                return Err(invalid_request(format!(
                    "cannot resume running thread {existing_thread_id} with stale path: requested `{}`, active `{}`",
                    requested_path.display(),
                    active_path.display()
                )));
            }
            let config_snapshot = existing_thread.config_snapshot().await;
            let mismatch_details = collect_resume_override_mismatches(params, &config_snapshot);
            if !mismatch_details.is_empty() {
                let has_subscribers = !self
                    .thread_state_manager
                    .subscribed_connection_ids(existing_thread_id)
                    .await
                    .is_empty();
                let loaded_status = self
                    .thread_watch_manager
                    .loaded_status_for_thread(&existing_thread_id.to_string())
                    .await;
                let is_running =
                    matches!(existing_thread.agent_status().await, AgentStatus::Running);

                if !has_subscribers && matches!(loaded_status, ThreadStatus::Idle) && !is_running {
                    // A loaded idle thread is only a cache entry. Shut it down
                    // before removing it so cold resume cannot duplicate a
                    // thread that timed out during shutdown.
                    match wait_for_thread_shutdown(&existing_thread).await {
                        ThreadShutdownResult::Complete => {
                            self.thread_manager.remove_thread(&existing_thread_id).await;
                            self.finalize_thread_teardown(existing_thread_id).await;
                            // Shutdown can flush newer rollout items, so reload the
                            // stored thread before starting the replacement session.
                            return Ok(RunningThreadResumeResult::NotRunning(None));
                        }
                        ThreadShutdownResult::SubmitFailed => {
                            warn!("failed to submit Shutdown to thread {existing_thread_id}");
                        }
                        ThreadShutdownResult::TimedOut => {
                            warn!("thread {existing_thread_id} shutdown timed out");
                        }
                    }
                }

                // Preserve rejoin semantics when another client can still observe
                // the loaded thread or shutdown did not complete.
                tracing::warn!(
                    "thread/resume overrides ignored for loaded thread {}: {}",
                    existing_thread_id,
                    mismatch_details.join("; ")
                );
            }
            let redact_resume_payloads =
                should_redact_thread_resume_payloads(app_server_client_name.as_deref());
            let history_items = source_thread
                .history
                .as_ref()
                .map(|history| history.items.clone())
                .ok_or_else(|| {
                    internal_error(format!(
                        "thread {existing_thread_id} did not include persisted history"
                    ))
                })?;

            let thread_state = self
                .thread_state_manager
                .thread_state(existing_thread_id)
                .await;
            self.ensure_listener_task_running(
                existing_thread_id,
                existing_thread.clone(),
                thread_state.clone(),
            )
            .await?;
            Self::set_app_server_client_info(
                existing_thread.as_ref(),
                app_server_client_name,
                app_server_client_version,
            )
            .await?;

            let mut summary_source_thread = source_thread;
            summary_source_thread.history = None;
            let mut thread_summary = self.stored_thread_to_api_thread(
                summary_source_thread,
                config_snapshot.model_provider_id.as_str(),
                /*include_turns*/ false,
            );
            thread_summary.session_id = existing_thread.session_configured().session_id.to_string();
            let instruction_sources = existing_thread.instruction_sources().await;

            let listener_command_tx = {
                let thread_state = thread_state.lock().await;
                thread_state.listener_command_tx()
            };
            let Some(listener_command_tx) = listener_command_tx else {
                return Err(internal_error(format!(
                    "failed to enqueue running thread resume for thread {existing_thread_id}: thread listener is not running"
                )));
            };

            let (emit_thread_goal_update, thread_goal_state_db) = self
                .thread_goal_processor
                .pending_resume_goal_state(existing_thread.as_ref())
                .await;

            let command = crate::thread_state::ThreadListenerCommand::SendThreadResumeResponse(
                Box::new(crate::thread_state::PendingThreadResumeRequest {
                    request_id: request_id.clone(),
                    history_items,
                    config_snapshot,
                    instruction_sources,
                    thread_summary,
                    execution_context,
                    emit_thread_goal_update,
                    thread_goal_state_db,
                    include_turns: !params.exclude_turns,
                    initial_turns_page: params.initial_turns_page.clone(),
                    projected_turns: cloud_agent_projection
                        .and_then(|projection| projection.turns.clone()),
                    projected_initial_turns_page: cloud_agent_projection
                        .and_then(|projection| projection.initial_turns_page.clone()),
                    projected_thread_status: cloud_agent_projection
                        .map(|projection| projection.status.clone()),
                    redact_resume_payloads,
                }),
            );
            if listener_command_tx.send(command).is_err() {
                return Err(internal_error(format!(
                    "failed to enqueue running thread resume for thread {existing_thread_id}: thread listener command channel is closed"
                )));
            }
            return Ok(RunningThreadResumeResult::Handled);
        }
        Ok(RunningThreadResumeResult::NotRunning(None))
    }

    async fn resume_thread_from_history(
        &self,
        history: &[ResponseItem],
    ) -> Result<InitialHistory, JSONRPCErrorError> {
        if history.is_empty() {
            return Err(invalid_request("history must not be empty"));
        }
        Ok(InitialHistory::Forked(
            history
                .iter()
                .cloned()
                .map(RolloutItem::ResponseItem)
                .collect(),
        ))
    }

    async fn resume_thread_from_rollout(
        &self,
        thread_id: &str,
        path: Option<&PathBuf>,
    ) -> Result<(InitialHistory, StoredThread), JSONRPCErrorError> {
        let stored_thread = self
            .read_stored_thread_for_resume(thread_id, path, /*include_history*/ true)
            .await?;
        let history = self
            .stored_thread_to_initial_history(&stored_thread)
            .await?;
        Ok((history, stored_thread))
    }

    async fn read_stored_thread_for_resume(
        &self,
        thread_id: &str,
        path: Option<&PathBuf>,
        include_history: bool,
    ) -> Result<StoredThread, JSONRPCErrorError> {
        let result = if let Some(path) = path {
            self.thread_store
                .read_thread_by_rollout_path(StoreReadThreadByRolloutPathParams {
                    rollout_path: path.clone(),
                    include_archived: true,
                    include_history,
                })
                .await
        } else {
            let existing_thread_id = match ThreadId::from_string(thread_id) {
                Ok(id) => id,
                Err(err) => {
                    return Err(invalid_request(format!("invalid session id: {err}")));
                }
            };
            let params = StoreReadThreadParams {
                thread_id: existing_thread_id,
                include_archived: true,
                include_history,
            };
            self.thread_store.read_thread(params).await
        };

        let stored_thread = result.map_err(thread_store_resume_read_error)?;
        if stored_thread.archived_at.is_some() {
            let thread_id = stored_thread.thread_id;
            return Err(invalid_request(format!(
                "session {thread_id} is archived. Unarchive the session before resuming it."
            )));
        }

        Ok(stored_thread)
    }

    async fn stored_thread_to_initial_history(
        &self,
        stored_thread: &StoredThread,
    ) -> Result<InitialHistory, JSONRPCErrorError> {
        let thread_id = stored_thread.thread_id;
        let history = stored_thread
            .history
            .as_ref()
            .map(|history| history.items.clone())
            .ok_or_else(|| {
                internal_error(format!(
                    "thread {thread_id} did not include persisted history"
                ))
            })?;
        Ok(InitialHistory::Resumed(ResumedHistory {
            conversation_id: thread_id,
            history,
            rollout_path: stored_thread.rollout_path.clone(),
        }))
    }

    fn stored_thread_to_api_thread(
        &self,
        stored_thread: StoredThread,
        fallback_provider: &str,
        include_turns: bool,
    ) -> Thread {
        let (mut thread, history) =
            thread_from_stored_thread(stored_thread, fallback_provider, &self.config.cwd);
        if include_turns && let Some(history) = history {
            populate_thread_turns_from_history(
                &mut thread,
                &history.items,
                /*active_turn*/ None,
            );
        }
        thread
    }

    async fn read_stored_thread_for_new_fork(
        &self,
        thread_id: ThreadId,
        include_history: bool,
    ) -> Result<StoredThread, JSONRPCErrorError> {
        self.thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history,
            })
            .await
            .map_err(thread_store_resume_read_error)
    }

    async fn load_thread_from_resume_source_or_send_internal(
        &self,
        thread_id: ThreadId,
        thread: &CrewonThread,
        thread_history: &InitialHistory,
        rollout_path: &Path,
        resume_source_thread: Option<StoredThread>,
        include_turns: bool,
    ) -> std::result::Result<Thread, String> {
        let config_snapshot = thread.config_snapshot().await;
        let session_id = thread.session_configured().session_id.to_string();
        let thread = match thread_history {
            InitialHistory::Resumed(resumed) => {
                let fallback_provider = config_snapshot.model_provider_id.as_str();
                if let Some(stored_thread) = resume_source_thread {
                    let stored_thread =
                        if let Some(rollout_path) = stored_thread.rollout_path.clone() {
                            self.thread_store
                                .read_thread_by_rollout_path(StoreReadThreadByRolloutPathParams {
                                    rollout_path,
                                    include_archived: true,
                                    include_history: false,
                                })
                                .await
                                .unwrap_or(StoredThread {
                                    history: None,
                                    ..stored_thread
                                })
                        } else {
                            self.thread_store
                                .read_thread(StoreReadThreadParams {
                                    thread_id: stored_thread.thread_id,
                                    include_archived: true,
                                    include_history: false,
                                })
                                .await
                                .unwrap_or(StoredThread {
                                    history: None,
                                    ..stored_thread
                                })
                        };
                    Ok(thread_from_stored_thread(
                        stored_thread,
                        fallback_provider,
                        &self.config.cwd,
                    )
                    .0)
                } else {
                    match self
                        .thread_store
                        .read_thread(StoreReadThreadParams {
                            thread_id: resumed.conversation_id,
                            include_archived: true,
                            include_history: false,
                        })
                        .await
                    {
                        Ok(stored_thread) => Ok(thread_from_stored_thread(
                            stored_thread,
                            fallback_provider,
                            &self.config.cwd,
                        )
                        .0),
                        Err(read_err) => {
                            Err(format!("failed to read thread from store: {read_err}"))
                        }
                    }
                }
            }
            InitialHistory::Forked(items) => {
                let mut thread = build_thread_from_snapshot(
                    thread_id,
                    session_id.clone(),
                    &config_snapshot,
                    Some(rollout_path.into()),
                );
                thread.preview = preview_from_rollout_items(items);
                Ok(thread)
            }
            InitialHistory::New | InitialHistory::Cleared => Err(format!(
                "failed to build resume response for thread {thread_id}: initial history missing"
            )),
        };
        let mut thread = thread?;
        thread.id = thread_id.to_string();
        thread.session_id = session_id;
        thread.path = Some(rollout_path.to_path_buf());
        if include_turns {
            let history_items = thread_history.get_rollout_items();
            populate_thread_turns_from_history(
                &mut thread,
                &history_items,
                /*active_turn*/ None,
            );
        }
        self.attach_thread_name(thread_id, &mut thread).await;
        Ok(thread)
    }

    async fn attach_thread_name(&self, thread_id: ThreadId, thread: &mut Thread) {
        if let Ok(stored_thread) = self
            .thread_store
            .read_thread(StoreReadThreadParams {
                thread_id,
                include_archived: true,
                include_history: false,
            })
            .await
            && let Some(title) = stored_thread.name.as_deref().map(str::trim)
            && !title.is_empty()
            && stored_thread.preview.trim() != title
        {
            set_thread_name_from_title(thread, title.to_string());
        }
    }

    async fn thread_fork_inner(
        &self,
        request_id: ConnectionRequestId,
        params: ThreadForkParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
        app_server_client_name: Option<String>,
        app_server_client_version: Option<String>,
    ) -> Result<(), JSONRPCErrorError> {
        let ThreadForkParams {
            thread_id,
            execution_context,
            path,
            model,
            model_provider,
            service_tier,
            cwd,
            runtime_workspace_roots,
            approval_policy,
            approvals_reviewer,
            sandbox,
            permissions,
            config: config_overrides,
            base_instructions,
            developer_instructions,
            ephemeral,
            thread_source,
            exclude_turns,
        } = params;
        super::cloud_agent_thread_source_fence::ensure_source_creation_allowed(
            thread_source.as_ref(),
        )?;
        let include_turns = !exclude_turns;
        if sandbox.is_some() && permissions.is_some() {
            return Err(invalid_request(
                "`permissions` cannot be combined with `sandbox`",
            ));
        }
        if execution_context.is_some() && ephemeral {
            return Err(invalid_request(
                "Thread execution context requires a persistent thread",
            ));
        }
        if path.is_none()
            && let Some(runtime) = execution_context_runtime.as_ref()
        {
            runtime.authorize_existing(&thread_id).await?;
        }
        let source_thread = self
            .read_stored_thread_for_resume(&thread_id, path.as_ref(), /*include_history*/ true)
            .await?;
        super::cloud_agent_thread_source_fence::ensure_thread_source_mutation_allowed(
            source_thread.thread_source.as_ref(),
            "thread/fork",
        )?;
        let source_thread_id = source_thread.thread_id;
        if let Some(runtime) = execution_context_runtime.as_ref() {
            runtime
                .ensure_operation_supported(
                    &source_thread_id.to_string(),
                    crate::platform_control::thread_execution_context_runtime::CloudAgentThreadOperation::Fork,
                )
                .await?;
        }
        let prepared_execution_context = match execution_context {
            Some(params) => {
                let runtime = execution_context_runtime.as_ref().ok_or_else(|| {
                    internal_error("Thread execution context state is unavailable")
                })?;
                Some(runtime.prepare_create(params).await?)
            }
            None => None,
        };
        let execution_context = execution_context_runtime.zip(prepared_execution_context);
        let source_thread_name = source_thread
            .name
            .as_deref()
            .and_then(crewon_core::util::normalize_thread_name);
        let history_items = source_thread
            .history
            .as_ref()
            .map(|history| history.items.clone())
            .ok_or_else(|| {
                internal_error(format!(
                    "thread {source_thread_id} did not include persisted history"
                ))
            })?;
        let history_cwd = Some(source_thread.cwd.clone());

        // Persist Windows sandbox mode.
        let mut config_overrides = config_overrides.unwrap_or_default();
        if cfg!(windows) {
            match WindowsSandboxLevel::from_config(&self.config) {
                WindowsSandboxLevel::Elevated => {
                    config_overrides
                        .insert("windows.sandbox".to_string(), serde_json::json!("elevated"));
                }
                WindowsSandboxLevel::RestrictedToken => {
                    config_overrides.insert(
                        "windows.sandbox".to_string(),
                        serde_json::json!("unelevated"),
                    );
                }
                WindowsSandboxLevel::Disabled => {}
            }
        }
        let request_overrides = if config_overrides.is_empty() {
            None
        } else {
            Some(config_overrides)
        };
        let runtime_workspace_roots = runtime_workspace_roots.map(resolve_runtime_workspace_roots);
        let mut typesafe_overrides = self.build_thread_config_overrides(
            model,
            model_provider,
            service_tier,
            cwd,
            runtime_workspace_roots,
            approval_policy,
            approvals_reviewer,
            sandbox,
            permissions,
            base_instructions,
            developer_instructions,
            /*personality*/ None,
        );
        typesafe_overrides.ephemeral = ephemeral.then_some(true);
        // Derive a Config using the same logic as new conversation, honoring overrides if provided.
        let source_history = InitialHistory::Resumed(ResumedHistory {
            conversation_id: source_thread_id,
            history: history_items.clone(),
            rollout_path: source_thread.rollout_path.clone(),
        });
        let persisted_scene_runtime = source_history.get_scene_runtime();
        let mut config = self
            .config_manager
            .load_for_cwd(request_overrides, typesafe_overrides, history_cwd)
            .await
            .map_err(|err| config_load_error(&err))?;
        if let Some(scene_runtime) = persisted_scene_runtime {
            let cwd = config.cwd.to_string_lossy();
            let scene_runtime =
                super::scene_runtime::revalidate_thread_scene(cwd.as_ref(), scene_runtime).await?;
            let cwd = config.cwd.to_string_lossy().into_owned();
            super::scene_runtime::hydrate_thread_scene_config(&cwd, scene_runtime, &mut config)
                .await?;
        }

        let fallback_model_provider = config.model_provider_id.clone();

        let NewThread {
            thread_id,
            thread: forked_thread,
            session_configured,
            ..
        } = self
            .thread_manager
            .fork_thread_from_history(
                ForkSnapshot::Interrupted,
                config,
                source_history,
                thread_source.map(Into::into),
                self.request_trace_context(&request_id).await,
            )
            .await
            .map_err(|err| match err {
                CodexErr::Io(_) | CodexErr::Json(_) => {
                    invalid_request(format!("failed to load thread {source_thread_id}: {err}"))
                }
                CodexErr::InvalidRequest(message) => invalid_request(message),
                err => internal_error(format!("error forking thread: {err}")),
            })?;
        let execution_context = if let Some((runtime, prepared)) = execution_context {
            match runtime
                .create(
                    prepared,
                    &thread_id.to_string(),
                    ThreadExecutionContextWorkspaceScope::Conversation,
                    Utc::now().timestamp(),
                )
                .await
            {
                Ok(execution_context) => Some(execution_context),
                Err(error) => {
                    let rollback = super::thread_execution_context_lifecycle::ThreadExecutionContextRollback::new(
                        Arc::clone(&self.thread_manager),
                        Arc::clone(&self.thread_store),
                        self.state_db.clone(),
                    );
                    if let Err(rollback_error) = rollback.rollback(thread_id).await {
                        tracing::error!(
                            thread_id = %thread_id,
                            error = %rollback_error,
                            "failed to roll back fork after execution context creation failed"
                        );
                    }
                    return Err(error);
                }
            }
        } else {
            None
        };

        Self::set_app_server_client_info(
            forked_thread.as_ref(),
            app_server_client_name,
            app_server_client_version,
        )
        .await?;
        if session_configured.rollout_path.is_some()
            && let Some(name) = source_thread_name.clone()
        {
            self.thread_manager
                .update_thread_metadata(
                    thread_id,
                    StoreThreadMetadataPatch {
                        name: Some(Some(name)),
                        ..Default::default()
                    },
                    /*include_archived*/ true,
                )
                .await
                .map_err(|err| core_thread_write_error("inherit source thread name", err))?;
        }

        let instruction_sources = forked_thread.instruction_sources().await;

        // Auto-attach a conversation listener when forking a thread.
        log_listener_attach_result(
            self.ensure_conversation_listener(
                thread_id,
                request_id.connection_id,
                /*raw_events_enabled*/ false,
            )
            .await,
            thread_id,
            request_id.connection_id,
            "thread",
        );

        // Persistent forks materialize their own rollout immediately. Ephemeral forks stay
        // pathless, so they rebuild their visible history from the copied source history instead.
        let mut thread = if session_configured.rollout_path.is_some() {
            let stored_thread = self
                .read_stored_thread_for_new_fork(thread_id, include_turns)
                .await?;
            self.stored_thread_to_api_thread(
                stored_thread,
                fallback_model_provider.as_str(),
                include_turns,
            )
        } else {
            let config_snapshot = forked_thread.config_snapshot().await;
            let mut thread = build_thread_from_snapshot(
                thread_id,
                session_configured.session_id.to_string(),
                &config_snapshot,
                /*path*/ None,
            );
            thread.preview = preview_from_rollout_items(&history_items);
            thread.forked_from_id = Some(source_thread_id.to_string());
            if include_turns {
                populate_thread_turns_from_history(
                    &mut thread,
                    &history_items,
                    /*active_turn*/ None,
                );
            }
            thread
        };
        if let Some(name) = source_thread_name {
            set_thread_name_from_title(&mut thread, name);
        }
        thread.session_id = session_configured.session_id.to_string();
        thread.thread_source = forked_thread
            .config_snapshot()
            .await
            .thread_source
            .map(Into::into);

        self.thread_watch_manager
            .upsert_thread_silently(thread.clone())
            .await;

        thread.status = resolve_thread_status(
            self.thread_watch_manager
                .loaded_status_for_thread(&thread.id)
                .await,
            /*has_in_progress_turn*/ false,
        );
        let config_snapshot = forked_thread.config_snapshot().await;
        let sandbox = thread_response_sandbox_policy(
            &config_snapshot.permission_profile,
            config_snapshot.cwd().as_path(),
        );
        let active_permission_profile =
            thread_response_active_permission_profile(config_snapshot.active_permission_profile);

        let response = ThreadForkResponse {
            thread: thread.clone(),
            execution_context,
            model: session_configured.model,
            model_provider: session_configured.model_provider_id,
            service_tier: session_configured.service_tier,
            cwd: session_configured.cwd,
            runtime_workspace_roots: config_snapshot.workspace_roots,
            instruction_sources,
            approval_policy: session_configured.approval_policy.into(),
            approvals_reviewer: session_configured.approvals_reviewer.into(),
            sandbox,
            active_permission_profile,
            reasoning_effort: session_configured.reasoning_effort,
            scene_runtime: config_snapshot.scene_runtime.map(Into::into),
        };

        let notif = thread_started_notification(thread);
        let connection_id = request_id.connection_id;
        let token_usage_thread = include_turns.then(|| response.thread.clone());
        self.outgoing.send_response(request_id, response).await;
        // `excludeTurns` is the cheap fork path, so skip restored usage replay
        // instead of rebuilding history only to attribute a historical update.
        if let Some(token_usage_thread) = token_usage_thread {
            let token_usage_turn_id = latest_token_usage_turn_id_from_rollout_items(
                &history_items,
                token_usage_thread.turns.as_slice(),
            );
            // Mirror the resume contract for forks: the new thread is usable as soon
            // as the response arrives, so restored usage must follow immediately.
            send_thread_token_usage_update_to_connection(
                &self.outgoing,
                connection_id,
                thread_id,
                &token_usage_thread,
                forked_thread.as_ref(),
                token_usage_turn_id,
            )
            .await;
        }

        self.outgoing
            .send_server_notification(ServerNotification::ThreadStarted(notif))
            .await;
        Ok(())
    }

    async fn get_thread_summary_response_inner(
        &self,
        params: GetConversationSummaryParams,
    ) -> Result<GetConversationSummaryResponse, JSONRPCErrorError> {
        let fallback_provider = self.config.model_provider_id.as_str();
        let read_result = match params {
            GetConversationSummaryParams::ThreadId { conversation_id } => self
                .thread_store
                .read_thread(StoreReadThreadParams {
                    thread_id: conversation_id,
                    include_archived: true,
                    include_history: false,
                })
                .await
                .map_err(|err| conversation_summary_thread_id_read_error(conversation_id, err)),
            GetConversationSummaryParams::RolloutPath { rollout_path } => {
                let Some(local_thread_store) = self
                    .thread_store
                    .as_any()
                    .downcast_ref::<LocalThreadStore>()
                else {
                    return Err(invalid_request(
                        "rollout path queries are only supported with the local thread store",
                    ));
                };

                local_thread_store
                    .read_thread_by_rollout_path(
                        rollout_path.clone(),
                        /*include_archived*/ true,
                        /*include_history*/ false,
                    )
                    .await
                    .map_err(|err| conversation_summary_rollout_path_read_error(&rollout_path, err))
            }
        };

        let stored_thread = read_result?;
        let summary = summary_from_stored_thread(stored_thread, fallback_provider);
        Ok(GetConversationSummaryResponse { summary })
    }

    async fn list_threads_common(
        &self,
        requested_page_size: usize,
        cursor: Option<String>,
        sort_key: StoreThreadSortKey,
        sort_direction: SortDirection,
        filters: ThreadListFilters,
    ) -> Result<(Vec<StoredThread>, Option<String>), JSONRPCErrorError> {
        let ThreadListFilters {
            model_providers,
            source_kinds,
            archived,
            cwd_filters,
            search_term,
            use_state_db_only,
        } = filters;
        let mut cursor_obj = cursor;
        let mut last_cursor = cursor_obj.clone();
        let mut remaining = requested_page_size;
        let mut items = Vec::with_capacity(requested_page_size);
        let mut next_cursor: Option<String> = None;

        let model_provider_filter = match model_providers {
            Some(providers) => {
                if providers.is_empty() {
                    None
                } else {
                    Some(providers)
                }
            }
            None => Some(vec![self.config.model_provider_id.clone()]),
        };
        let (allowed_sources_vec, source_kind_filter) = compute_source_filters(source_kinds);
        let allowed_sources = allowed_sources_vec.as_slice();
        let store_sort_direction = match sort_direction {
            SortDirection::Asc => StoreSortDirection::Asc,
            SortDirection::Desc => StoreSortDirection::Desc,
        };

        while remaining > 0 {
            let page_size = remaining.min(THREAD_LIST_MAX_LIMIT);
            let page = self
                .thread_store
                .list_threads(StoreListThreadsParams {
                    page_size,
                    cursor: cursor_obj.clone(),
                    sort_key,
                    sort_direction: store_sort_direction,
                    allowed_sources: allowed_sources.to_vec(),
                    model_providers: model_provider_filter.clone(),
                    cwd_filters: cwd_filters.clone(),
                    archived,
                    search_term: search_term.clone(),
                    use_state_db_only,
                })
                .await
                .map_err(thread_store_list_error)?;

            let mut filtered = Vec::with_capacity(page.items.len());
            for it in page.items {
                let source = with_thread_spawn_agent_metadata(
                    it.source.clone(),
                    it.agent_nickname.clone(),
                    it.agent_role.clone(),
                );
                if source_kind_filter
                    .as_ref()
                    .is_none_or(|filter| source_kind_matches(&source, filter))
                    && cwd_filters.as_ref().is_none_or(|expected_cwds| {
                        expected_cwds.iter().any(|expected_cwd| {
                            path_utils::paths_match_after_normalization(&it.cwd, expected_cwd)
                        })
                    })
                {
                    filtered.push(it);
                    if filtered.len() >= remaining {
                        break;
                    }
                }
            }
            items.extend(filtered);
            remaining = requested_page_size.saturating_sub(items.len());

            next_cursor = page.next_cursor;
            if remaining == 0 {
                break;
            }

            let Some(cursor_val) = next_cursor.clone() else {
                break;
            };
            // Break if our pagination would reuse the same cursor again; this avoids
            // an infinite loop when filtering drops everything on the page.
            if last_cursor.as_ref() == Some(&cursor_val) {
                next_cursor = None;
                break;
            }
            last_cursor = Some(cursor_val.clone());
            cursor_obj = Some(cursor_val);
        }

        Ok((items, next_cursor))
    }
}

fn xcode_26_4_mcp_elicitations_auto_deny(
    client_name: Option<&str>,
    client_version: Option<&str>,
) -> bool {
    // Xcode 26.4 shipped before app-server MCP elicitation requests were
    // client-visible. Keep elicitations auto-denied for that client line.
    // TODO: Remove this compatibility hack once Xcode 26.4 ages out.
    client_name == Some("Xcode")
        && client_version.is_some_and(|version| version.starts_with("26.4"))
}

const THREAD_TURNS_DEFAULT_LIMIT: usize = 25;
const THREAD_TURNS_MAX_LIMIT: usize = 100;

fn thread_backwards_cursor_for_sort_key(
    thread: &StoredThread,
    sort_key: StoreThreadSortKey,
    sort_direction: SortDirection,
) -> Option<String> {
    let timestamp = match sort_key {
        StoreThreadSortKey::CreatedAt => thread.created_at,
        StoreThreadSortKey::UpdatedAt => thread.updated_at,
    };
    // The state DB stores unique millisecond timestamps. Offset the reverse cursor by one
    // millisecond so the opposite-direction query includes the page anchor.
    let timestamp = match sort_direction {
        SortDirection::Asc => timestamp.checked_add_signed(ChronoDuration::milliseconds(1))?,
        SortDirection::Desc => timestamp.checked_sub_signed(ChronoDuration::milliseconds(1))?,
    };
    Some(timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

struct ThreadTurnsPage {
    pub(super) turns: Vec<Turn>,
    pub(super) next_cursor: Option<String>,
    pub(super) backwards_cursor: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadTurnsCursor {
    turn_id: String,
    include_anchor: bool,
}

fn paginate_thread_turns(
    turns: Vec<Turn>,
    cursor: Option<&str>,
    limit: Option<u32>,
    sort_direction: SortDirection,
) -> Result<ThreadTurnsPage, JSONRPCErrorError> {
    if turns.is_empty() {
        return Ok(ThreadTurnsPage {
            turns: Vec::new(),
            next_cursor: None,
            backwards_cursor: None,
        });
    }

    let anchor = cursor.map(parse_thread_turns_cursor).transpose()?;
    let page_size = limit
        .map(|value| value as usize)
        .unwrap_or(THREAD_TURNS_DEFAULT_LIMIT)
        .clamp(1, THREAD_TURNS_MAX_LIMIT);

    let anchor_index = anchor
        .as_ref()
        .and_then(|anchor| turns.iter().position(|turn| turn.id == anchor.turn_id));
    if anchor.is_some() && anchor_index.is_none() {
        return Err(invalid_request(
            "invalid cursor: anchor turn is no longer present",
        ));
    }

    let mut keyed_turns: Vec<_> = turns.into_iter().enumerate().collect();
    match sort_direction {
        SortDirection::Asc => {
            if let (Some(anchor), Some(anchor_index)) = (anchor.as_ref(), anchor_index) {
                keyed_turns.retain(|(index, _)| {
                    if anchor.include_anchor {
                        *index >= anchor_index
                    } else {
                        *index > anchor_index
                    }
                });
            }
        }
        SortDirection::Desc => {
            keyed_turns.reverse();
            if let (Some(anchor), Some(anchor_index)) = (anchor.as_ref(), anchor_index) {
                keyed_turns.retain(|(index, _)| {
                    if anchor.include_anchor {
                        *index <= anchor_index
                    } else {
                        *index < anchor_index
                    }
                });
            }
        }
    }

    let more_turns_available = keyed_turns.len() > page_size;
    keyed_turns.truncate(page_size);
    let backwards_cursor = keyed_turns
        .first()
        .map(|(_, turn)| serialize_thread_turns_cursor(&turn.id, /*include_anchor*/ true))
        .transpose()?;
    let next_cursor = if more_turns_available {
        keyed_turns
            .last()
            .map(|(_, turn)| serialize_thread_turns_cursor(&turn.id, /*include_anchor*/ false))
            .transpose()?
    } else {
        None
    };
    let turns = keyed_turns.into_iter().map(|(_, turn)| turn).collect();

    Ok(ThreadTurnsPage {
        turns,
        next_cursor,
        backwards_cursor,
    })
}

fn serialize_thread_turns_cursor(
    turn_id: &str,
    include_anchor: bool,
) -> Result<String, JSONRPCErrorError> {
    serde_json::to_string(&ThreadTurnsCursor {
        turn_id: turn_id.to_string(),
        include_anchor,
    })
    .map_err(|err| internal_error(format!("failed to serialize cursor: {err}")))
}

fn parse_thread_turns_cursor(cursor: &str) -> Result<ThreadTurnsCursor, JSONRPCErrorError> {
    serde_json::from_str(cursor).map_err(|_| invalid_request(format!("invalid cursor: {cursor}")))
}

struct ThreadTurnsPageOptions<'a> {
    cursor: Option<&'a str>,
    limit: Option<u32>,
    sort_direction: SortDirection,
    items_view: TurnItemsView,
}

fn build_thread_turns_page_response(
    items: &[RolloutItem],
    loaded_status: ThreadStatus,
    has_live_running_thread: bool,
    active_turn: Option<Turn>,
    options: ThreadTurnsPageOptions<'_>,
) -> Result<ThreadTurnsListResponse, JSONRPCErrorError> {
    let mut turns = reconstruct_thread_turns_for_turns_list(
        items,
        loaded_status,
        has_live_running_thread,
        active_turn,
    );
    apply_thread_turns_items_view(&mut turns, options.items_view);
    let page = paginate_thread_turns(turns, options.cursor, options.limit, options.sort_direction)?;
    Ok(ThreadTurnsListResponse {
        data: page.turns,
        next_cursor: page.next_cursor,
        backwards_cursor: page.backwards_cursor,
    })
}

pub(super) fn build_thread_resume_initial_turns_page(
    items: &[RolloutItem],
    loaded_status: ThreadStatus,
    has_live_running_thread: bool,
    active_turn: Option<Turn>,
    params: &ThreadResumeInitialTurnsPageParams,
) -> Result<crewon_app_server_protocol::TurnsPage, JSONRPCErrorError> {
    build_thread_turns_page_response(
        items,
        loaded_status,
        has_live_running_thread,
        active_turn,
        ThreadTurnsPageOptions {
            cursor: None,
            limit: params.limit,
            sort_direction: params.sort_direction.unwrap_or(SortDirection::Desc),
            items_view: params.items_view.unwrap_or(TurnItemsView::Summary),
        },
    )
    .map(Into::into)
}

fn apply_thread_turns_items_view(turns: &mut [Turn], items_view: TurnItemsView) {
    for turn in turns {
        match items_view {
            TurnItemsView::NotLoaded => {
                turn.items.clear();
                turn.items_view = TurnItemsView::NotLoaded;
            }
            TurnItemsView::Summary => {
                let first_user_message = turn
                    .items
                    .iter()
                    .find(|item| matches!(item, ThreadItem::UserMessage { .. }))
                    .cloned();
                let final_agent_message = turn
                    .items
                    .iter()
                    .rev()
                    .find(|item| matches!(item, ThreadItem::AgentMessage { .. }))
                    .cloned();
                turn.items = match (first_user_message, final_agent_message) {
                    (Some(user_message), Some(agent_message))
                        if user_message.id() != agent_message.id() =>
                    {
                        vec![user_message, agent_message]
                    }
                    (Some(user_message), _) => vec![user_message],
                    (None, Some(agent_message)) => vec![agent_message],
                    (None, None) => Vec::new(),
                };
                turn.items_view = TurnItemsView::Summary;
            }
            TurnItemsView::Full => {
                turn.items_view = TurnItemsView::Full;
            }
        }
    }
}

fn reconstruct_thread_turns_for_turns_list(
    items: &[RolloutItem],
    loaded_status: ThreadStatus,
    has_live_running_thread: bool,
    active_turn: Option<Turn>,
) -> Vec<Turn> {
    let has_live_in_progress_turn = has_live_running_thread
        || active_turn
            .as_ref()
            .is_some_and(|turn| matches!(turn.status, TurnStatus::InProgress));
    let mut turns = build_api_turns_from_rollout_items(items);
    normalize_thread_turns_status(&mut turns, loaded_status, has_live_in_progress_turn);
    if let Some(active_turn) = active_turn {
        merge_turn_history_with_active_turn(&mut turns, active_turn);
    }
    turns
}

fn normalize_thread_turns_status(
    turns: &mut [Turn],
    loaded_status: ThreadStatus,
    has_live_in_progress_turn: bool,
) {
    let status = resolve_thread_status(loaded_status, has_live_in_progress_turn);
    if matches!(status, ThreadStatus::Active { .. }) {
        return;
    }
    for turn in turns {
        if matches!(turn.status, TurnStatus::InProgress) {
            turn.status = TurnStatus::Interrupted;
        }
    }
}

enum ThreadReadViewError {
    InvalidRequest(String),
    Unsupported(&'static str),
    Internal(String),
}

fn thread_read_view_error(err: ThreadReadViewError) -> JSONRPCErrorError {
    match err {
        ThreadReadViewError::InvalidRequest(message) => invalid_request(message),
        ThreadReadViewError::Unsupported(operation) => {
            unsupported_thread_store_operation(operation)
        }
        ThreadReadViewError::Internal(message) => internal_error(message),
    }
}

pub(super) fn unsupported_thread_store_operation(operation: &'static str) -> JSONRPCErrorError {
    method_not_found(format!("{operation} is not supported yet"))
}

fn thread_store_list_error(err: ThreadStoreError) -> JSONRPCErrorError {
    match err {
        ThreadStoreError::InvalidRequest { message } => invalid_request(message),
        ThreadStoreError::Unsupported { operation } => {
            unsupported_thread_store_operation(operation)
        }
        err => internal_error(format!("failed to list threads: {err}")),
    }
}

fn thread_store_resume_read_error(err: ThreadStoreError) -> JSONRPCErrorError {
    match err {
        ThreadStoreError::InvalidRequest { message } => invalid_request(message),
        ThreadStoreError::Unsupported { operation } => {
            unsupported_thread_store_operation(operation)
        }
        ThreadStoreError::ThreadNotFound { thread_id } => {
            invalid_request(format!("no rollout found for thread id {thread_id}"))
        }
        err => internal_error(format!("failed to read thread: {err}")),
    }
}

fn thread_turns_list_history_load_error(
    thread_id: ThreadId,
    err: ThreadStoreError,
) -> ThreadReadViewError {
    match err {
        ThreadStoreError::InvalidRequest { message }
            if message.starts_with("failed to resolve rollout path `") =>
        {
            ThreadReadViewError::InvalidRequest(format!(
                "thread {thread_id} is not materialized yet; thread/turns/list is unavailable before first user message"
            ))
        }
        ThreadStoreError::InvalidRequest { message } => {
            ThreadReadViewError::InvalidRequest(message)
        }
        ThreadStoreError::Unsupported { operation } => ThreadReadViewError::Unsupported(operation),
        err => ThreadReadViewError::Internal(format!(
            "failed to load thread history for thread {thread_id}: {err}"
        )),
    }
}

fn thread_read_history_load_error(
    thread_id: ThreadId,
    err: ThreadStoreError,
) -> ThreadReadViewError {
    match err {
        ThreadStoreError::InvalidRequest { message }
            if message.starts_with("failed to resolve rollout path `") =>
        {
            ThreadReadViewError::InvalidRequest(format!(
                "thread {thread_id} is not materialized yet; includeTurns is unavailable before first user message"
            ))
        }
        ThreadStoreError::ThreadNotFound {
            thread_id: missing_thread_id,
        } if missing_thread_id == thread_id => ThreadReadViewError::InvalidRequest(format!(
            "thread {thread_id} is not materialized yet; includeTurns is unavailable before first user message"
        )),
        ThreadStoreError::InvalidRequest { message } => {
            ThreadReadViewError::InvalidRequest(message)
        }
        ThreadStoreError::Unsupported { operation } => ThreadReadViewError::Unsupported(operation),
        err => ThreadReadViewError::Internal(format!(
            "failed to load thread history for thread {thread_id}: {err}"
        )),
    }
}

fn conversation_summary_thread_id_read_error(
    conversation_id: ThreadId,
    err: ThreadStoreError,
) -> JSONRPCErrorError {
    let no_rollout_message = format!("no rollout found for thread id {conversation_id}");
    match err {
        ThreadStoreError::InvalidRequest { message } if message == no_rollout_message => {
            conversation_summary_not_found_error(conversation_id)
        }
        ThreadStoreError::Unsupported { operation } => {
            unsupported_thread_store_operation(operation)
        }
        ThreadStoreError::ThreadNotFound { thread_id } if thread_id == conversation_id => {
            conversation_summary_not_found_error(conversation_id)
        }
        ThreadStoreError::InvalidRequest { message } => invalid_request(message),
        err => internal_error(format!(
            "failed to load conversation summary for {conversation_id}: {err}"
        )),
    }
}

fn conversation_summary_not_found_error(conversation_id: ThreadId) -> JSONRPCErrorError {
    invalid_request(format!(
        "no rollout found for conversation id {conversation_id}"
    ))
}

fn conversation_summary_rollout_path_read_error(
    path: &Path,
    err: ThreadStoreError,
) -> JSONRPCErrorError {
    match err {
        ThreadStoreError::InvalidRequest { message } => invalid_request(message),
        ThreadStoreError::Unsupported { operation } => {
            unsupported_thread_store_operation(operation)
        }
        err => internal_error(format!(
            "failed to load conversation summary from {}: {}",
            path.display(),
            err
        )),
    }
}

pub(super) fn core_thread_write_error(operation: &str, err: CodexErr) -> JSONRPCErrorError {
    match err {
        CodexErr::ThreadNotFound(thread_id) => {
            invalid_request(format!("thread not found: {thread_id}"))
        }
        CodexErr::InvalidRequest(message) => invalid_request(message),
        CodexErr::UnsupportedOperation(message) => method_not_found(message),
        err => internal_error(format!("failed to {operation}: {err}")),
    }
}

fn thread_store_archive_error(operation: &str, err: ThreadStoreError) -> JSONRPCErrorError {
    match err {
        ThreadStoreError::InvalidRequest { message } | ThreadStoreError::Conflict { message } => {
            invalid_request(message)
        }
        ThreadStoreError::Unsupported {
            operation: unsupported_operation,
        } => unsupported_thread_store_operation(unsupported_operation),
        err => internal_error(format!("failed to {operation} session: {err}")),
    }
}

fn set_thread_name_from_title(thread: &mut Thread, title: String) {
    if title.trim().is_empty() || thread.preview.trim() == title.trim() {
        return;
    }
    thread.name = Some(title);
}

pub(crate) fn thread_from_stored_thread(
    thread: StoredThread,
    fallback_provider: &str,
    fallback_cwd: &AbsolutePathBuf,
) -> (Thread, Option<crewon_thread_store::StoredThreadHistory>) {
    let path = thread.rollout_path;
    let git_info = thread.git_info.map(|info| ApiGitInfo {
        sha: info.commit_hash.map(|sha| sha.0),
        branch: info.branch,
        origin_url: info.repository_url,
    });
    let cwd = AbsolutePathBuf::relative_to_current_dir(path_utils::normalize_for_native_workdir(
        thread.cwd,
    ))
    .unwrap_or_else(|err| {
        warn!("failed to normalize thread cwd while reading stored thread: {err}");
        fallback_cwd.clone()
    });
    let source = with_thread_spawn_agent_metadata(
        thread.source,
        thread.agent_nickname.clone(),
        thread.agent_role.clone(),
    );
    let history = thread.history;
    let thread_id = thread.thread_id.to_string();
    let thread = Thread {
        id: thread_id.clone(),
        session_id: thread_id,
        forked_from_id: thread.forked_from_id.map(|id| id.to_string()),
        parent_thread_id: thread.parent_thread_id.map(|id| id.to_string()),
        preview: thread.preview,
        ephemeral: false,
        model_provider: if thread.model_provider.is_empty() {
            fallback_provider.to_string()
        } else {
            thread.model_provider
        },
        created_at: thread.created_at.timestamp(),
        updated_at: thread.updated_at.timestamp(),
        status: ThreadStatus::NotLoaded,
        path,
        cwd,
        client_version: thread.cli_version,
        agent_nickname: source.get_nickname(),
        agent_role: source.get_agent_role(),
        source: source.into(),
        thread_source: thread.thread_source.map(Into::into),
        git_info,
        name: thread.name,
        turns: Vec::new(),
    };
    (thread, history)
}

fn summary_from_stored_thread(
    thread: StoredThread,
    fallback_provider: &str,
) -> ConversationSummary {
    let path = thread.rollout_path.unwrap_or_default();
    let source = with_thread_spawn_agent_metadata(
        thread.source,
        thread.agent_nickname.clone(),
        thread.agent_role.clone(),
    );
    let git_info = thread.git_info.map(|git| ConversationGitInfo {
        sha: git.commit_hash.map(|sha| sha.0),
        branch: git.branch,
        origin_url: git.repository_url,
    });
    ConversationSummary {
        conversation_id: thread.thread_id,
        path,
        preview: thread.preview,
        // Preserve millisecond precision from the thread store so thread/list cursors
        // round-trip the same ordering key used by pagination queries.
        timestamp: Some(
            thread
                .created_at
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        ),
        updated_at: Some(
            thread
                .updated_at
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        ),
        model_provider: if thread.model_provider.is_empty() {
            fallback_provider.to_string()
        } else {
            thread.model_provider
        },
        cwd: thread.cwd,
        cli_version: thread.cli_version,
        source,
        git_info,
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn summary_from_state_db_metadata(
    conversation_id: ThreadId,
    path: PathBuf,
    first_user_message: Option<String>,
    preview: Option<String>,
    timestamp: String,
    updated_at: String,
    model_provider: String,
    cwd: PathBuf,
    cli_version: String,
    source: String,
    _thread_source: Option<crewon_protocol::protocol::ThreadSource>,
    agent_nickname: Option<String>,
    agent_role: Option<String>,
    git_sha: Option<String>,
    git_branch: Option<String>,
    git_origin_url: Option<String>,
) -> ConversationSummary {
    let preview = preview.or(first_user_message).unwrap_or_default();
    let source = serde_json::from_str(&source)
        .or_else(|_| serde_json::from_value(serde_json::Value::String(source.clone())))
        .unwrap_or(crewon_protocol::protocol::SessionSource::Unknown);
    let source = with_thread_spawn_agent_metadata(source, agent_nickname, agent_role);
    let git_info = if git_sha.is_none() && git_branch.is_none() && git_origin_url.is_none() {
        None
    } else {
        Some(ConversationGitInfo {
            sha: git_sha,
            branch: git_branch,
            origin_url: git_origin_url,
        })
    };
    ConversationSummary {
        conversation_id,
        path,
        preview,
        timestamp: Some(timestamp),
        updated_at: Some(updated_at),
        model_provider,
        cwd,
        cli_version,
        source,
        git_info,
    }
}

#[cfg(test)]
fn summary_from_thread_metadata(metadata: &ThreadMetadata) -> ConversationSummary {
    summary_from_state_db_metadata(
        metadata.id,
        metadata.rollout_path.clone(),
        metadata.first_user_message.clone(),
        metadata.preview.clone(),
        metadata
            .created_at
            .to_rfc3339_opts(SecondsFormat::Secs, true),
        metadata
            .updated_at
            .to_rfc3339_opts(SecondsFormat::Secs, true),
        metadata.model_provider.clone(),
        metadata.cwd.clone(),
        metadata.cli_version.clone(),
        metadata.source.clone(),
        metadata.thread_source.clone(),
        metadata.agent_nickname.clone(),
        metadata.agent_role.clone(),
        metadata.git_sha.clone(),
        metadata.git_branch.clone(),
        metadata.git_origin_url.clone(),
    )
}

fn preview_from_rollout_items(items: &[RolloutItem]) -> String {
    items
        .iter()
        .find_map(|item| match item {
            RolloutItem::ResponseItem(item) => match crewon_core::parse_turn_item(item) {
                Some(crewon_protocol::items::TurnItem::UserMessage(user)) => Some(user.message()),
                _ => None,
            },
            _ => None,
        })
        .map(|preview| match preview.find(USER_MESSAGE_BEGIN) {
            Some(idx) => preview[idx + USER_MESSAGE_BEGIN.len()..].trim().to_string(),
            None => preview,
        })
        .unwrap_or_default()
}

fn requested_permissions_trust_project(overrides: &ConfigOverrides, cwd: &Path) -> bool {
    if matches!(
        overrides.sandbox_mode,
        Some(
            crewon_protocol::config_types::SandboxMode::WorkspaceWrite
                | crewon_protocol::config_types::SandboxMode::DangerFullAccess
        )
    ) {
        return true;
    }

    if matches!(
        overrides.default_permissions.as_deref(),
        Some(
            BUILT_IN_PERMISSION_PROFILE_WORKSPACE | BUILT_IN_PERMISSION_PROFILE_DANGER_FULL_ACCESS
        )
    ) {
        return true;
    }

    overrides
        .permission_profile
        .as_ref()
        .is_some_and(|profile| permission_profile_trusts_project(profile, cwd))
}

fn permission_profile_trusts_project(
    profile: &crewon_protocol::models::PermissionProfile,
    cwd: &Path,
) -> bool {
    match profile {
        crewon_protocol::models::PermissionProfile::Disabled
        | crewon_protocol::models::PermissionProfile::External { .. } => true,
        crewon_protocol::models::PermissionProfile::Managed { .. } => profile
            .file_system_sandbox_policy()
            .can_write_path_with_cwd(cwd, cwd),
    }
}

fn build_thread_from_snapshot(
    thread_id: ThreadId,
    session_id: String,
    config_snapshot: &ThreadConfigSnapshot,
    path: Option<PathBuf>,
) -> Thread {
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    Thread {
        id: thread_id.to_string(),
        session_id,
        forked_from_id: None,
        parent_thread_id: config_snapshot.parent_thread_id.map(|id| id.to_string()),
        preview: String::new(),
        ephemeral: config_snapshot.ephemeral,
        model_provider: config_snapshot.model_provider_id.clone(),
        created_at: now,
        updated_at: now,
        status: ThreadStatus::NotLoaded,
        path,
        cwd: config_snapshot.cwd().clone(),
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        agent_nickname: config_snapshot.session_source.get_nickname(),
        agent_role: config_snapshot.session_source.get_agent_role(),
        source: config_snapshot.session_source.clone().into(),
        thread_source: config_snapshot.thread_source.clone().map(Into::into),
        git_info: None,
        name: None,
        turns: Vec::new(),
    }
}

fn paginate_background_terminals(
    terminals: &[ThreadBackgroundTerminal],
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<ThreadBackgroundTerminal>, Option<String>), JSONRPCErrorError> {
    let start = match cursor {
        Some(cursor) => {
            let cursor = cursor
                .parse::<i32>()
                .map_err(|err| invalid_request(format!("invalid cursor: {err}")))?;
            terminals
                .iter()
                .position(|terminal| {
                    terminal
                        .process_id
                        .parse::<i32>()
                        .is_ok_and(|process_id| process_id > cursor)
                })
                .unwrap_or(terminals.len())
        }
        None => 0,
    };
    let effective_limit = limit.unwrap_or(terminals.len() as u32).max(1) as usize;
    let end = start.saturating_add(effective_limit).min(terminals.len());
    let next_cursor = (end < terminals.len()).then(|| terminals[end - 1].process_id.clone());
    Ok((terminals[start..end].to_vec(), next_cursor))
}

fn build_thread_from_loaded_snapshot(
    thread_id: ThreadId,
    config_snapshot: &ThreadConfigSnapshot,
    loaded_thread: &CrewonThread,
) -> Thread {
    build_thread_from_snapshot(
        thread_id,
        loaded_thread.session_configured().session_id.to_string(),
        config_snapshot,
        loaded_thread.rollout_path(),
    )
}

#[cfg(test)]
#[path = "thread_processor_tests.rs"]
mod thread_processor_tests;
