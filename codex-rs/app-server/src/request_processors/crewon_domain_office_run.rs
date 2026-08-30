use std::collections::HashSet;

use chrono::DateTime;
use chrono::Duration as ChronoDuration;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::CommandExecutionStatus;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::FileUpdateChange;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeDelegationCancelParams;
use crewon_app_server_protocol::OfficeDelegationDispatchNextParams;
use crewon_app_server_protocol::OfficeDelegationDispatchParams;
use crewon_app_server_protocol::OfficeDelegationRetryParams;
use crewon_app_server_protocol::OfficeMemberContextPreviewParams;
use crewon_app_server_protocol::OfficeMemberContextPreviewResponse;
use crewon_app_server_protocol::OfficeMemoryDecideParams;
use crewon_app_server_protocol::OfficeMemoryDecideResponse;
use crewon_app_server_protocol::OfficeMemoryListParams;
use crewon_app_server_protocol::OfficeMemoryListResponse;
use crewon_app_server_protocol::OfficeRunCancelParams;
use crewon_app_server_protocol::OfficeRunParams;
use crewon_app_server_protocol::OfficeRunRetryParams;
use crewon_app_server_protocol::OfficeRunSyncParams;
use crewon_app_server_protocol::OfficeVerificationCancelParams;
use crewon_app_server_protocol::OfficeVerificationDispatchNextParams;
use crewon_app_server_protocol::OfficeVerificationRetryParams;
use crewon_app_server_protocol::PatchApplyStatus;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnStatus;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value as JsonValue;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;
use std::io;
use std::path::PathBuf;
use tokio::fs;
use uuid::Uuid;

#[path = "crewon_domain_office_dispatch_ambiguity.rs"]
mod dispatch_ambiguity;
#[path = "crewon_domain_office_run_dispatch_receipt.rs"]
mod dispatch_receipt;
#[path = "crewon_domain_office_dispatch_recovery_prepare.rs"]
mod dispatch_recovery_prepare;
#[path = "crewon_domain_office_dispatch_recovery_reload.rs"]
mod dispatch_recovery_reload;
#[path = "crewon_domain_office_dispatch_recovery_scan.rs"]
mod dispatch_recovery_scan;
pub(crate) use dispatch_ambiguity::EXECUTION_UNKNOWN_MESSAGE;
pub(crate) use dispatch_ambiguity::mark_auto_dispatch_intent_execution_unknown;
pub(crate) use dispatch_ambiguity::quarantine_dispatch_execution_unknown;
pub(crate) use dispatch_receipt::commit_delegation_admitted;
pub(crate) use dispatch_receipt::fail_delegation_starting;
pub(crate) use dispatch_receipt::quarantine_delegation_execution_unknown;
pub(crate) use dispatch_receipt::reserve_delegation_starting;
pub(crate) use dispatch_recovery_prepare::prepare_recovered_delegation_dispatch;
pub(crate) use dispatch_recovery_reload::ReloadedOfficeDispatchRecovery;
pub(crate) use dispatch_recovery_reload::reload_exact_office_dispatch_recovery;
pub(crate) use dispatch_recovery_scan::ScannedOfficeDispatchRecovery;
pub(crate) use dispatch_recovery_scan::scan_exact_office_dispatch_recovery;

use super::DomainKind;
use super::OfficeRunSyncUpdate;
use super::apply_office_artifact_file_fingerprints;
use super::domain_directory;
use super::list_records;
use super::map_io_error;
use super::office_record_lock;
use super::office_thread_id;
use super::read_record;
use super::resolve_office_member_runtimes;
use super::save_record;
use super::update_record;
use super::validate_record_file_path;
use crate::error_code::invalid_params;

const AUTO_SYNC_OFFICE_SCAN_LIMIT: usize = 500;
const MAX_PROMPT_TEXT_CHARS: usize = 4_000;
const MAX_PROMPT_TITLE_CHARS: usize = 80;
const MAX_PROMPT_FIELD_CHARS: usize = 160;
const MAX_PROMPT_MEMBERS: usize = 8;
const MAX_PROMPT_TASKS: usize = 12;
const MAX_DELEGATION_ROUTES: usize = 8;
const RUN_ERROR_CHARS: usize = 320;
const RUN_RESULT_PREVIEW_CHARS: usize = 800;
const MAX_OFFICE_UPDATE_ITEMS: usize = 12;
const MAX_OFFICE_DELEGATIONS: usize = 8;
const MAX_OFFICE_UPDATE_PARSE_CHARS: usize = 12_000;
const OFFICE_RUN_INDEX_DIRECTORY: &str = "office-runs";
const OFFICE_RUN_INDEX_FILE: &str = "index.json";
const OFFICE_SCHEDULER_FILE: &str = "scheduler.json";
const OFFICE_CHILD_DISPATCH_LEASE_SECONDS: i64 = 120;
const MAX_OFFICE_SCHEDULER_INTENTS: usize = 256;
const OFFICE_SCHEDULER_INTENT_LEASE_SECONDS: i64 = 120;
const OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHED: &str = "dispatched";
const OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING: &str = "dispatching";
const OFFICE_SCHEDULER_INTENT_STATUS_FAILED: &str = "failed";
const OFFICE_SCHEDULER_INTENT_STATUS_PENDING: &str = "pending";
const OFFICE_LOOP_MAX_ITERATIONS: u64 = 4;
const MAX_VERIFICATION_ATTEMPTS: usize = 6;

#[path = "crewon_domain_office_context.rs"]
mod office_context;
#[path = "crewon_domain_office_memory.rs"]
mod office_memory;

pub(crate) async fn list_memories(
    params: OfficeMemoryListParams,
) -> Result<OfficeMemoryListResponse, JSONRPCErrorError> {
    office_memory::list(params).await
}

pub(crate) async fn decide_memory(
    params: OfficeMemoryDecideParams,
) -> Result<OfficeMemoryDecideResponse, JSONRPCErrorError> {
    office_memory::decide(params).await
}

pub(crate) async fn preview_member_context(
    params: OfficeMemberContextPreviewParams,
) -> Result<OfficeMemberContextPreviewResponse, JSONRPCErrorError> {
    let OfficeMemberContextPreviewParams {
        cwd,
        config,
        run_id,
        task,
        member,
        agent_id,
        locale,
    } = params;
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let mut config = latest_sync_config(&cwd, config, Some(&run_id), "").await?;
    resolve_office_member_runtimes(&cwd, &mut config).await?;
    let routes = delegation_routes(&config);
    let route = find_delegation_route(&routes, member.as_deref(), agent_id.as_deref())?;
    let thread_id = route
        .get("target")
        .and_then(JsonValue::as_str)
        .or_else(|| route.get("threadId").and_then(JsonValue::as_str))
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("delegation route is missing target"))?
        .to_string();
    let member = route
        .get("member")
        .and_then(JsonValue::as_str)
        .or(member.as_deref())
        .unwrap_or("Agent")
        .to_string();
    let agent_id = route
        .get("agentId")
        .and_then(JsonValue::as_str)
        .or(agent_id.as_deref())
        .unwrap_or("agent")
        .to_string();
    let context_policy = route
        .get("contextPolicy")
        .and_then(JsonValue::as_str)
        .unwrap_or("sharedDigest")
        .to_string();
    let memory_scope = route
        .get("memoryScope")
        .and_then(JsonValue::as_str)
        .unwrap_or("privateAndShared")
        .to_string();
    let is_zh = locale.as_deref() != Some("en");
    let agent_profile = route
        .get("agentProfile")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|profile| !profile.is_empty())
        .map(|profile| truncate_chars(profile, /*max_chars*/ 640))
        .unwrap_or_else(|| {
            if is_zh {
                "未保存可用的 Agent profile。".to_string()
            } else {
                "No saved agent profile is available.".to_string()
            }
        });
    let task = task
        .as_deref()
        .map(str::trim)
        .filter(|task| !task.is_empty())
        .unwrap_or(&run_id);
    let memory_context = office_memory::preview_member_prompt_context(
        &cwd,
        &config,
        task,
        &member,
        &agent_id,
        &memory_scope,
        locale.as_deref(),
    )
    .await?;
    let memory_context = if memory_context.prompt.trim().is_empty() {
        if is_zh {
            "成员任务长期记忆：暂无可用的已接受记忆。".to_string()
        } else {
            "Member task long-term memories: no accepted memories are available.".to_string()
        }
    } else {
        memory_context.prompt
    };
    let shared_context =
        office_context::member_shared_context(&config, &run_id, &context_policy, is_zh);

    Ok(OfficeMemberContextPreviewResponse {
        run_id,
        member,
        agent_id,
        thread_id,
        context_policy,
        memory_scope,
        agent_profile,
        shared_context,
        memory_context,
    })
}

#[derive(Debug)]
pub(crate) struct PreparedOfficeRun {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) thread_id: String,
    pub(crate) run_id: String,
    pub(crate) prompt: String,
    pub(crate) client_user_message_id: Option<String>,
    pub(crate) dispatch_receipt_id: Option<String>,
}

#[derive(Debug)]
pub(crate) struct PreparedOfficeRunCancel {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) run_id: String,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) cancel_targets: Vec<OfficeRunCancelTarget>,
}

#[derive(Debug)]
pub(crate) struct PreparedOfficeChildCancel {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) run_id: String,
    pub(crate) child_id: String,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) cancel_targets: Vec<OfficeRunCancelTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OfficeRunCancelTarget {
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
}

#[derive(Debug)]
pub(crate) struct PreparedOfficeDelegationDispatch {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) run_id: String,
    pub(crate) delegation_id: String,
    pub(crate) retry_of_delegation_id: Option<String>,
    pub(crate) thread_id: String,
    pub(crate) prompt: String,
    pub(crate) client_user_message_id: Option<String>,
}

#[derive(Debug)]
pub(crate) struct PreparedOfficeVerificationDispatch {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) run_id: String,
    pub(crate) verification_check_id: String,
    pub(crate) automation_id: String,
    pub(crate) retry_of_automation_turn_id: Option<String>,
    pub(crate) automation_file_path: String,
    pub(crate) automation_config: JsonValue,
    pub(crate) note: String,
    pub(crate) locale: Option<String>,
    pub(crate) client_user_message_id: Option<String>,
}

pub(crate) struct StartedOfficeVerificationDispatch<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) verification_check_id: &'a str,
    pub(crate) automation_run_file_path: &'a str,
    pub(crate) automation_run_id: &'a str,
    pub(crate) automation_thread_id: &'a str,
    pub(crate) automation_turn_id: &'a str,
    pub(crate) runtime_repair_source_thread_id: Option<&'a str>,
    pub(crate) runtime_repaired_at: Option<&'a str>,
}

#[derive(Debug)]
pub(crate) struct SyncedOfficeRun {
    pub(crate) file_path: String,
    pub(crate) config: JsonValue,
    pub(crate) source_thread_id: String,
    pub(crate) source_turn_id: String,
}

#[derive(Debug)]
struct OfficeRunSyncDetails {
    run_id: String,
    thread_id: String,
    turn_id: Option<String>,
    status: String,
}

struct SyncedOfficeDelegation {
    run_id: String,
    delegation_id: String,
    member: String,
    agent_id: Option<String>,
    task: String,
    result_preview: Option<String>,
    error: Option<String>,
}

struct ClaimedOfficeVerificationCheck {
    check_id: String,
    check: String,
    criterion: Option<String>,
    criterion_id: Option<String>,
    acceptance_id: Option<String>,
    automation_id: String,
    artifact: Option<String>,
    command: Option<String>,
    retry_of_automation_turn_id: Option<String>,
    previous_status: Option<String>,
    previous_dispatch_status: Option<String>,
    previous_error: Option<String>,
    previous_evidence: Option<String>,
}

struct VerificationDispatchStatusUpdate<'a> {
    run_id: &'a str,
    verification_check_id: &'a str,
    dispatch_status: &'a str,
    automation_run_file_path: Option<&'a str>,
    automation_run_id: Option<&'a str>,
    automation_thread_id: Option<&'a str>,
    automation_turn_id: Option<&'a str>,
    runtime_repair_source_thread_id: Option<&'a str>,
    runtime_repaired_at: Option<&'a str>,
    error: Option<&'a str>,
}

struct AutomationVerificationResult {
    status: &'static str,
    evidence: Option<String>,
}

struct OfficeSignalSource<'a> {
    source_type: &'static str,
    thread_id: &'a str,
    turn_id: &'a str,
    observed_at: &'a str,
    delegation: Option<&'a SyncedOfficeDelegation>,
}

struct CommandEvidenceItemParams<'a> {
    id: &'a str,
    command: &'a str,
    cwd: &'a str,
    status: &'a CommandExecutionStatus,
    aggregated_output: Option<&'a str>,
    exit_code: Option<i32>,
    duration_ms: Option<i64>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeRunIndex {
    version: u32,
    runs: Vec<OfficeRunIndexEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeRunIndexEntry {
    run_id: String,
    thread_id: String,
    turn_id: Option<String>,
    file_path: String,
    status: String,
    updated_at: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeSchedulerQueue {
    version: u32,
    intents: Vec<OfficeSchedulerIntent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficeSchedulerIntent {
    pub(crate) intent_id: String,
    pub(crate) source_thread_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) status: String,
    pub(crate) reason: String,
    pub(crate) attempts: u32,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    #[serde(default)]
    pub(crate) last_error: Option<String>,
    #[serde(default)]
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    pub(crate) dispatch_kind: Option<String>,
    #[serde(default)]
    pub(crate) delegation_id: Option<String>,
    #[serde(default)]
    pub(crate) verification_check_id: Option<String>,
    #[serde(default)]
    pub(crate) file_path: Option<String>,
    #[serde(default)]
    pub(crate) dispatched_thread_id: Option<String>,
    #[serde(default)]
    pub(crate) dispatched_turn_id: Option<String>,
    #[serde(default)]
    pub(crate) lease_id: Option<String>,
    #[serde(default)]
    pub(crate) lease_started_at: Option<String>,
    #[serde(default)]
    pub(crate) lease_expires_at: Option<String>,
}

struct AppendQueuedRunParams<'a> {
    message: JsonValue,
    message_mode: &'a RunMessageMode,
    text: &'a str,
    locale: Option<&'a str>,
    thread_id: &'a str,
    run_id: &'a str,
    retry_of: Option<&'a str>,
    loop_iteration: u64,
    loop_max_iterations: u64,
    memory_refs: Option<JsonValue>,
}

enum RunMessageMode {
    Direct,
    Submitted {
        client_user_message_id: String,
        dispatch_receipt_id: String,
    },
}

struct AppendQueuedDelegationParams<'a> {
    run_id: &'a str,
    new_delegation_id: &'a str,
    member: &'a str,
    agent_id: &'a str,
    task: &'a str,
    route: &'a JsonValue,
    memory_refs: Option<JsonValue>,
}

struct AppendRetryDelegationParams<'a> {
    run_id: &'a str,
    new_delegation_id: &'a str,
    retry_of_delegation_id: &'a str,
    member: &'a str,
    agent_id: &'a str,
    task: &'a str,
    route: &'a JsonValue,
    memory_refs: Option<JsonValue>,
}

struct QueuedOfficeDelegation {
    delegation_id: String,
}

struct QueuedDelegationFields<'a> {
    delegation_id: &'a str,
    member: &'a str,
    agent_id: &'a str,
    task: &'a str,
    route: &'a JsonValue,
    memory_refs: Option<JsonValue>,
    now: DateTime<Utc>,
}

struct NextDispatchableDelegation {
    task: String,
    member: Option<String>,
    agent_id: Option<String>,
}

struct AutoDispatchRunCandidate {
    config: JsonValue,
    run_id: String,
    locale: Option<String>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum DelegationDispatchPolicy {
    Interactive,
    Auto,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum VerificationDispatchPolicy {
    Interactive,
    Auto,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum RunRetryPolicy {
    Interactive,
    Auto,
}

struct ClaimDelegationDispatchParams {
    cwd: String,
    config: JsonValue,
    run_id: String,
    task: String,
    member: Option<String>,
    agent_id: Option<String>,
    locale: Option<String>,
    client_user_message_id: Option<String>,
}

struct OfficeDelegationPromptParams<'a> {
    config: &'a JsonValue,
    run_id: &'a str,
    member: &'a str,
    agent_id: &'a str,
    task: &'a str,
    route: &'a JsonValue,
    locale: Option<&'a str>,
    memory_context: &'a str,
}

pub(crate) async fn prepare(
    params: OfficeRunParams,
) -> Result<PreparedOfficeRun, JSONRPCErrorError> {
    prepare_with_message_mode(params, RunMessageMode::Direct).await
}

pub(crate) async fn prepare_submitted_message(
    params: OfficeRunParams,
    dispatch_receipt_id: String,
) -> Result<PreparedOfficeRun, JSONRPCErrorError> {
    let client_user_message_id = params
        .client_user_message_id
        .clone()
        .ok_or_else(|| invalid_params("submitted Office message has no clientUserMessageId"))?;
    prepare_with_message_mode(
        params,
        RunMessageMode::Submitted {
            client_user_message_id,
            dispatch_receipt_id,
        },
    )
    .await
}

async fn prepare_with_message_mode(
    params: OfficeRunParams,
    message_mode: RunMessageMode,
) -> Result<PreparedOfficeRun, JSONRPCErrorError> {
    let OfficeRunParams {
        cwd,
        mut config,
        message,
        text,
        locale,
        thread_id,
        client_user_message_id,
    } = params;
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    if !message.is_object() {
        return Err(invalid_params("message must be an object"));
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(invalid_params("text must not be empty"));
    }

    resolve_office_member_runtimes(&cwd, &mut config).await?;
    let thread_id = resolve_run_thread_id(&config, thread_id.as_deref())?;
    let run_id = format!("office-run-{}", Uuid::new_v4());
    let memory_context =
        office_memory::build_prompt_context(&cwd, &config, &text, locale.as_deref()).await?;
    let prompt = build_office_run_prompt(&config, &text, locale.as_deref(), &memory_context.prompt);
    append_queued_run(
        &mut config,
        AppendQueuedRunParams {
            message,
            message_mode: &message_mode,
            text: &text,
            locale: locale.as_deref(),
            thread_id: &thread_id,
            run_id: &run_id,
            retry_of: None,
            loop_iteration: 1,
            loop_max_iterations: OFFICE_LOOP_MAX_ITERATIONS,
            memory_refs: memory_context.refs,
        },
    )?;
    let file_path = save_record(DomainKind::Office, &cwd, config.clone()).await?;
    upsert_run_index(
        &cwd,
        OfficeRunIndexEntry {
            run_id: run_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: None,
            file_path,
            status: "queued".to_string(),
            updated_at: timestamp(),
        },
    )
    .await?;

    Ok(PreparedOfficeRun {
        cwd,
        config,
        thread_id,
        run_id,
        prompt,
        client_user_message_id,
        dispatch_receipt_id: match message_mode {
            RunMessageMode::Direct => None,
            RunMessageMode::Submitted {
                dispatch_receipt_id,
                ..
            } => Some(dispatch_receipt_id),
        },
    })
}

pub(crate) async fn prepare_retry(
    params: OfficeRunRetryParams,
) -> Result<PreparedOfficeRun, JSONRPCErrorError> {
    prepare_retry_with_policy(params, RunRetryPolicy::Interactive).await
}

pub(crate) async fn prepare_auto_retry_after_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<Option<PreparedOfficeRun>, JSONRPCErrorError> {
    if !turn_status_is_terminal(&turn.status) {
        return Ok(None);
    }
    for candidate in
        auto_dispatch_run_candidates_after_thread_turn(cwd, thread_id, &turn.id).await?
    {
        let params = OfficeRunRetryParams {
            cwd: cwd.to_string(),
            config: candidate.config,
            run_id: candidate.run_id,
            message: None,
            text: None,
            locale: candidate.locale,
            client_user_message_id: Some(format!("office-auto-replan-{}", Uuid::new_v4())),
        };
        match prepare_retry_with_policy(params, RunRetryPolicy::Auto).await {
            Ok(prepared) => return Ok(Some(prepared)),
            Err(err) if is_no_auto_retry_error(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(None)
}

async fn prepare_retry_with_policy(
    params: OfficeRunRetryParams,
    retry_policy: RunRetryPolicy,
) -> Result<PreparedOfficeRun, JSONRPCErrorError> {
    let OfficeRunRetryParams {
        cwd,
        config,
        run_id,
        message,
        text,
        locale,
        client_user_message_id,
    } = params;
    let retry_of = run_id.trim().to_string();
    if retry_of.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let mut config = latest_sync_config(&cwd, config, Some(&retry_of), "").await?;
    resolve_office_member_runtimes(&cwd, &mut config).await?;
    let source_run =
        run_by_id(&config, &retry_of).ok_or_else(|| invalid_params("runId was not found"))?;
    if retry_policy == RunRetryPolicy::Auto
        && !auto_retry_source_run_is_eligible(&config, &retry_of, source_run)
    {
        return Err(no_auto_retry_error());
    }
    let source_loop_iteration = run_loop_iteration(source_run.get("loop"));
    let source_max_iterations = run_loop_max_iterations(source_run.get("loop"));
    if source_loop_iteration >= source_max_iterations {
        if retry_policy == RunRetryPolicy::Auto {
            return Err(no_auto_retry_error());
        }
        return Err(invalid_params("office loop iteration limit reached"));
    }
    let loop_iteration = source_loop_iteration.saturating_add(1);
    let text = match text {
        Some(text) => text.trim().to_string(),
        None => retry_text_for_run(&config, &retry_of, locale.as_deref())
            .unwrap_or_default()
            .trim()
            .to_string(),
    };
    if text.is_empty() {
        return Err(invalid_params("retry text must not be empty"));
    }
    let message = match message {
        Some(message) if message.is_object() => message,
        Some(_) => return Err(invalid_params("message must be an object")),
        None => retry_message(&text, locale.as_deref()),
    };

    let thread_id = resolve_run_thread_id(&config, /*requested_thread_id*/ None)?;
    let run_id = format!("office-run-{}", Uuid::new_v4());
    let memory_context =
        office_memory::build_prompt_context(&cwd, &config, &text, locale.as_deref()).await?;
    let prompt = build_office_run_prompt(&config, &text, locale.as_deref(), &memory_context.prompt);
    append_queued_run(
        &mut config,
        AppendQueuedRunParams {
            message,
            message_mode: &RunMessageMode::Direct,
            text: &text,
            locale: locale.as_deref(),
            thread_id: &thread_id,
            run_id: &run_id,
            retry_of: Some(&retry_of),
            loop_iteration,
            loop_max_iterations: source_max_iterations,
            memory_refs: memory_context.refs,
        },
    )?;
    let file_path = save_record(DomainKind::Office, &cwd, config.clone()).await?;
    upsert_run_index(
        &cwd,
        OfficeRunIndexEntry {
            run_id: run_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: None,
            file_path,
            status: "queued".to_string(),
            updated_at: timestamp(),
        },
    )
    .await?;

    Ok(PreparedOfficeRun {
        cwd,
        config,
        thread_id,
        run_id,
        prompt,
        client_user_message_id,
        dispatch_receipt_id: None,
    })
}

fn no_auto_retry_error() -> JSONRPCErrorError {
    invalid_params("no auto office retry is eligible")
}

fn is_no_auto_retry_error(err: &JSONRPCErrorError) -> bool {
    err.message == "no auto office retry is eligible"
}

fn auto_retry_source_run_is_eligible(
    config: &JsonValue,
    source_run_id: &str,
    source_run: &JsonValue,
) -> bool {
    if auto_retry_disabled(source_run)
        || retry_run_exists_for_source(config, source_run_id)
        || run_has_active_child_dispatch(source_run)
    {
        return false;
    }
    let status = source_run
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if !run_status_is_terminal(status) {
        return false;
    }
    if run_loop_iteration(source_run.get("loop")) >= run_loop_max_iterations(source_run.get("loop"))
    {
        return false;
    }
    let Some(review) = source_run
        .get("loop")
        .and_then(|loop_value| loop_value.get("review"))
    else {
        return false;
    };
    let review_status = review
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if !matches!(review_status, "blocked" | "needsReview") {
        return false;
    }
    if review
        .get("risks")
        .and_then(|risks| risks.get("openHigh"))
        .and_then(JsonValue::as_u64)
        .is_some_and(|open_high| open_high > 0)
    {
        return false;
    }
    let next_action = review
        .get("nextAction")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    !matches!(
        next_action,
        "frameAcceptanceCriteria"
            | "runVerificationChecks"
            | "mitigateHighRisks"
            | "readyToSummarize"
    )
}

fn auto_retry_disabled(source_run: &JsonValue) -> bool {
    if json_boolish(
        source_run,
        &[
            "approvalRequired",
            "requiresApproval",
            "manualRetry",
            "manualDispatch",
        ],
    ) {
        return true;
    }
    if source_run
        .get("autoRetry")
        .or_else(|| source_run.get("autoReplan"))
        .and_then(JsonValue::as_bool)
        == Some(false)
    {
        return true;
    }
    source_run
        .get("dispatchMode")
        .or_else(|| source_run.get("dispatchPolicy"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| {
            matches!(
                value.as_str(),
                "manual" | "approval" | "requiresapproval" | "requires_approval" | "human"
            )
        })
}

fn retry_run_exists_for_source(config: &JsonValue, source_run_id: &str) -> bool {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .is_some_and(|runs| {
            runs.iter()
                .any(|run| retry_run_blocks_auto_retry(run, source_run_id))
        })
}

fn retry_run_blocks_auto_retry(run: &JsonValue, source_run_id: &str) -> bool {
    if run.get("retryOf").and_then(JsonValue::as_str) != Some(source_run_id) {
        return false;
    }
    if run
        .get("turnId")
        .and_then(JsonValue::as_str)
        .is_some_and(|turn_id| !turn_id.trim().is_empty())
    {
        return true;
    }
    match run.get("status").and_then(JsonValue::as_str) {
        Some("queued") => value_child_dispatch_lease_is_active(run, Utc::now()),
        _ => true,
    }
}

fn run_has_active_child_dispatch(source_run: &JsonValue) -> bool {
    source_run
        .get("delegations")
        .and_then(JsonValue::as_array)
        .is_some_and(|delegations| {
            delegations.iter().any(|delegation| {
                let status = delegation.get("status").and_then(JsonValue::as_str);
                match status {
                    Some("queued") => delegation_has_started_dispatch(delegation),
                    Some("running" | "canceling") => true,
                    _ => false,
                }
            })
        })
        || source_run
            .get("verificationChecks")
            .and_then(JsonValue::as_array)
            .is_some_and(|checks| {
                checks.iter().any(|check| {
                    let dispatch_status = check.get("dispatchStatus").and_then(JsonValue::as_str);
                    let automation_status =
                        check.get("automationStatus").and_then(JsonValue::as_str);
                    matches!(dispatch_status, Some("running" | "canceling"))
                        || dispatch_status == Some("queued")
                            && value_child_dispatch_lease_is_active(check, Utc::now())
                        || matches!(automation_status, Some("queued" | "running" | "canceling"))
                })
            })
}

pub(crate) async fn prepare_delegation_dispatch(
    params: OfficeDelegationDispatchParams,
) -> Result<PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
    let OfficeDelegationDispatchParams {
        cwd,
        config,
        run_id,
        task,
        member,
        agent_id,
        locale,
        client_user_message_id,
    } = params;
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err(invalid_params("task must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let _lock = acquire_run_index_lock(&cwd).await?;
    let mut config = latest_sync_config(&cwd, config, Some(&run_id), "").await?;
    resolve_office_member_runtimes(&cwd, &mut config).await?;
    prepare_claimed_delegation_dispatch(ClaimDelegationDispatchParams {
        cwd,
        config,
        run_id,
        task,
        member,
        agent_id,
        locale,
        client_user_message_id,
    })
    .await
}

pub(crate) async fn prepare_delegation_retry(
    params: OfficeDelegationRetryParams,
) -> Result<PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
    let OfficeDelegationRetryParams {
        cwd,
        config,
        run_id,
        delegation_id,
        locale,
        client_user_message_id,
    } = params;
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    let retry_of_delegation_id = delegation_id.trim().to_string();
    if retry_of_delegation_id.is_empty() {
        return Err(invalid_params("delegationId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let _lock = acquire_run_index_lock(&cwd).await?;
    let mut config = latest_sync_config(&cwd, config, Some(&run_id), "").await?;
    resolve_office_member_runtimes(&cwd, &mut config).await?;
    let source_delegation = retryable_source_delegation(&config, &run_id, &retry_of_delegation_id)?;
    if active_retry_delegation_exists(&config, &run_id, &retry_of_delegation_id) {
        return Err(invalid_params("office delegation retry is already active"));
    }
    let task = source_delegation
        .get("task")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|task| !task.is_empty())
        .ok_or_else(|| invalid_params("office delegation has no task to retry"))?
        .to_string();
    let member = source_delegation
        .get("member")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|member| !member.is_empty())
        .map(str::to_string);
    let agent_id = source_delegation
        .get("agentId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|agent_id| !agent_id.is_empty())
        .map(str::to_string);
    if member.is_none() && agent_id.is_none() {
        return Err(invalid_params(
            "office delegation retry requires member or agentId",
        ));
    }

    let routes = delegation_routes(&config);
    let route = find_delegation_route(&routes, member.as_deref(), agent_id.as_deref())?;
    let thread_id = route
        .get("target")
        .and_then(JsonValue::as_str)
        .or_else(|| route.get("threadId").and_then(JsonValue::as_str))
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("delegation route is missing target"))?
        .to_string();
    let member_name = route
        .get("member")
        .and_then(JsonValue::as_str)
        .or(member.as_deref())
        .unwrap_or("Agent")
        .to_string();
    let agent_id = route
        .get("agentId")
        .and_then(JsonValue::as_str)
        .or(agent_id.as_deref())
        .unwrap_or("agent")
        .to_string();
    let memory_scope = route
        .get("memoryScope")
        .and_then(JsonValue::as_str)
        .unwrap_or("privateAndShared");
    let new_delegation_id = format!("office-delegation-{}", Uuid::new_v4());
    let memory_context = office_memory::build_member_prompt_context(
        &cwd,
        &config,
        &task,
        &member_name,
        &agent_id,
        memory_scope,
        locale.as_deref(),
    )
    .await?;
    append_retry_delegation(
        &mut config,
        AppendRetryDelegationParams {
            run_id: &run_id,
            new_delegation_id: &new_delegation_id,
            retry_of_delegation_id: &retry_of_delegation_id,
            member: &member_name,
            agent_id: &agent_id,
            task: &task,
            route,
            memory_refs: memory_context.refs.clone(),
        },
    )?;
    let prompt_task = delegation_retry_prompt_task(&source_delegation, &task, locale.as_deref());
    let prompt = build_office_delegation_prompt(OfficeDelegationPromptParams {
        config: &config,
        run_id: &run_id,
        member: &member_name,
        agent_id: &agent_id,
        task: &prompt_task,
        route,
        locale: locale.as_deref(),
        memory_context: &memory_context.prompt,
    });
    save_record(DomainKind::Office, &cwd, config.clone()).await?;
    Ok(PreparedOfficeDelegationDispatch {
        cwd,
        config,
        run_id,
        delegation_id: new_delegation_id,
        retry_of_delegation_id: Some(retry_of_delegation_id),
        thread_id,
        prompt,
        client_user_message_id,
    })
}

async fn prepare_claimed_delegation_dispatch(
    params: ClaimDelegationDispatchParams,
) -> Result<PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
    let ClaimDelegationDispatchParams {
        cwd,
        mut config,
        run_id,
        task,
        member,
        agent_id,
        locale,
        client_user_message_id,
    } = params;
    let routes = delegation_routes(&config);
    let route = find_delegation_route(&routes, member.as_deref(), agent_id.as_deref())?;
    let thread_id = route
        .get("target")
        .and_then(JsonValue::as_str)
        .or_else(|| route.get("threadId").and_then(JsonValue::as_str))
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("delegation route is missing target"))?
        .to_string();
    let member_name = route
        .get("member")
        .and_then(JsonValue::as_str)
        .or(member.as_deref())
        .unwrap_or("Agent")
        .to_string();
    let agent_id = route
        .get("agentId")
        .and_then(JsonValue::as_str)
        .or(agent_id.as_deref())
        .unwrap_or("agent")
        .to_string();
    let memory_scope = route
        .get("memoryScope")
        .and_then(JsonValue::as_str)
        .unwrap_or("privateAndShared");
    let new_delegation_id = format!("office-delegation-{}", Uuid::new_v4());
    let memory_context = office_memory::build_member_prompt_context(
        &cwd,
        &config,
        &task,
        &member_name,
        &agent_id,
        memory_scope,
        locale.as_deref(),
    )
    .await?;
    let QueuedOfficeDelegation { delegation_id } = append_queued_delegation(
        &mut config,
        AppendQueuedDelegationParams {
            run_id: &run_id,
            new_delegation_id: &new_delegation_id,
            member: &member_name,
            agent_id: &agent_id,
            task: &task,
            route,
            memory_refs: memory_context.refs.clone(),
        },
    )?;
    let prompt = build_office_delegation_prompt(OfficeDelegationPromptParams {
        config: &config,
        run_id: &run_id,
        member: &member_name,
        agent_id: &agent_id,
        task: &task,
        route,
        locale: locale.as_deref(),
        memory_context: &memory_context.prompt,
    });
    save_record(DomainKind::Office, &cwd, config.clone()).await?;
    Ok(PreparedOfficeDelegationDispatch {
        cwd,
        config,
        run_id,
        delegation_id,
        retry_of_delegation_id: None,
        thread_id,
        prompt,
        client_user_message_id,
    })
}

pub(crate) async fn prepare_next_delegation_dispatch(
    params: OfficeDelegationDispatchNextParams,
) -> Result<PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
    let OfficeDelegationDispatchNextParams {
        cwd,
        config,
        run_id,
        dispatch_policy,
        locale,
        client_user_message_id,
    } = params;
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    let dispatch_policy = delegation_dispatch_policy(dispatch_policy.as_deref())?;

    let _lock = acquire_run_index_lock(&cwd).await?;
    let mut config = latest_sync_config(&cwd, config, Some(&run_id), "").await?;
    resolve_office_member_runtimes(&cwd, &mut config).await?;
    let Some(next) = next_dispatchable_delegation(&config, &run_id, dispatch_policy) else {
        return Err(invalid_params(
            "no dispatchable office delegation was found",
        ));
    };
    prepare_claimed_delegation_dispatch(ClaimDelegationDispatchParams {
        cwd,
        config,
        run_id,
        task: next.task,
        member: next.member,
        agent_id: next.agent_id,
        locale,
        client_user_message_id,
    })
    .await
}

pub(crate) async fn prepare_auto_delegation_dispatch_after_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<Option<PreparedOfficeDelegationDispatch>, JSONRPCErrorError> {
    if !turn_status_is_terminal(&turn.status) {
        return Ok(None);
    }
    for candidate in
        auto_dispatch_run_candidates_after_thread_turn(cwd, thread_id, &turn.id).await?
    {
        let params = OfficeDelegationDispatchNextParams {
            cwd: cwd.to_string(),
            config: candidate.config,
            run_id: candidate.run_id,
            dispatch_policy: Some("auto".to_string()),
            locale: candidate.locale,
            client_user_message_id: Some(format!("office-auto-delegation-{}", Uuid::new_v4())),
        };
        match prepare_next_delegation_dispatch(params).await {
            Ok(prepared) => return Ok(Some(prepared)),
            Err(err) if is_no_dispatchable_delegation_error(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(None)
}

pub(crate) async fn prepare_auto_verification_dispatch_after_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<Option<PreparedOfficeVerificationDispatch>, JSONRPCErrorError> {
    if !turn_status_is_terminal(&turn.status) {
        return Ok(None);
    }
    for candidate in
        auto_dispatch_run_candidates_after_thread_turn(cwd, thread_id, &turn.id).await?
    {
        let params = OfficeVerificationDispatchNextParams {
            cwd: cwd.to_string(),
            config: candidate.config,
            run_id: candidate.run_id,
            locale: candidate.locale,
            client_user_message_id: Some(format!("office-auto-verification-{}", Uuid::new_v4())),
        };
        match prepare_next_verification_dispatch_with_policy(
            params,
            VerificationDispatchPolicy::Auto,
        )
        .await
        {
            Ok(prepared) => return Ok(Some(prepared)),
            Err(err) if is_no_dispatchable_verification_error(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(None)
}

pub(crate) async fn auto_verification_automation_records_after_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<Vec<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if !turn_status_is_terminal(&turn.status) {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for candidate in
        auto_dispatch_run_candidates_after_thread_turn(cwd, thread_id, &turn.id).await?
    {
        let mut config = candidate.config;
        let claimed = match claim_next_dispatchable_verification_check(
            &mut config,
            &candidate.run_id,
            VerificationDispatchPolicy::Auto,
        ) {
            Ok(claimed) => claimed,
            Err(err) if is_no_dispatchable_verification_error(&err) => continue,
            Err(err) => return Err(err),
        };
        let Some(record) =
            read_automation_record_by_identifier(cwd, &claimed.automation_id).await?
        else {
            continue;
        };
        if seen.insert(record.file_path.clone()) {
            records.push(record);
        }
    }
    Ok(records)
}

pub(crate) async fn prepare_next_verification_dispatch(
    params: OfficeVerificationDispatchNextParams,
) -> Result<PreparedOfficeVerificationDispatch, JSONRPCErrorError> {
    prepare_next_verification_dispatch_with_policy(params, VerificationDispatchPolicy::Interactive)
        .await
}

async fn prepare_next_verification_dispatch_with_policy(
    params: OfficeVerificationDispatchNextParams,
    dispatch_policy: VerificationDispatchPolicy,
) -> Result<PreparedOfficeVerificationDispatch, JSONRPCErrorError> {
    let OfficeVerificationDispatchNextParams {
        cwd,
        config,
        run_id,
        locale,
        client_user_message_id,
    } = params;
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let _lock = acquire_run_index_lock(&cwd).await?;
    let mut config = latest_sync_config(&cwd, config, Some(&run_id), "").await?;
    let claimed =
        claim_next_dispatchable_verification_check(&mut config, &run_id, dispatch_policy)?;
    let automation_record = read_automation_record_by_identifier(&cwd, &claimed.automation_id)
        .await?
        .ok_or_else(|| {
            invalid_params(format!(
                "automationId '{}' did not match a saved automation",
                claimed.automation_id
            ))
        })?;
    let automation_thread_id = automation_record
        .config
        .get("threadId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("automation config has no threadId to start"))?
        .to_string();
    let note = build_office_verification_automation_note(
        &config,
        &run_id,
        &claimed,
        automation_record
            .config
            .get("title")
            .and_then(JsonValue::as_str),
        locale.as_deref(),
    );
    mark_verification_dispatch_queued(
        &mut config,
        &run_id,
        &claimed.check_id,
        &claimed.automation_id,
        &automation_thread_id,
        automation_record
            .config
            .get("runtimeRepairSourceThreadId")
            .and_then(JsonValue::as_str),
        automation_record
            .config
            .get("runtimeRepairedAt")
            .and_then(JsonValue::as_str),
    )?;
    save_record(DomainKind::Office, &cwd, config.clone()).await?;
    Ok(PreparedOfficeVerificationDispatch {
        cwd,
        config,
        run_id,
        verification_check_id: claimed.check_id,
        automation_id: claimed.automation_id,
        retry_of_automation_turn_id: claimed.retry_of_automation_turn_id,
        automation_file_path: automation_record.file_path,
        automation_config: automation_record.config,
        note,
        locale,
        client_user_message_id,
    })
}

pub(crate) async fn prepare_verification_retry(
    params: OfficeVerificationRetryParams,
) -> Result<PreparedOfficeVerificationDispatch, JSONRPCErrorError> {
    let OfficeVerificationRetryParams {
        cwd,
        config,
        run_id,
        verification_check_id,
        locale,
        client_user_message_id,
    } = params;
    let run_id = run_id.trim().to_string();
    let verification_check_id = verification_check_id.trim().to_string();
    if run_id.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    if verification_check_id.is_empty() {
        return Err(invalid_params("verificationCheckId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let _lock = acquire_run_index_lock(&cwd).await?;
    let mut config = latest_sync_config(&cwd, config, Some(&run_id), "").await?;
    let claimed = claim_retryable_verification_check(&mut config, &run_id, &verification_check_id)?;
    let automation_record = read_automation_record_by_identifier(&cwd, &claimed.automation_id)
        .await?
        .ok_or_else(|| {
            invalid_params(format!(
                "automationId '{}' did not match a saved automation",
                claimed.automation_id
            ))
        })?;
    let automation_thread_id = automation_record
        .config
        .get("threadId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("automation config has no threadId to start"))?
        .to_string();
    let note = build_office_verification_automation_note(
        &config,
        &run_id,
        &claimed,
        automation_record
            .config
            .get("title")
            .and_then(JsonValue::as_str),
        locale.as_deref(),
    );
    mark_verification_dispatch_queued(
        &mut config,
        &run_id,
        &claimed.check_id,
        &claimed.automation_id,
        &automation_thread_id,
        automation_record
            .config
            .get("runtimeRepairSourceThreadId")
            .and_then(JsonValue::as_str),
        automation_record
            .config
            .get("runtimeRepairedAt")
            .and_then(JsonValue::as_str),
    )?;
    save_record(DomainKind::Office, &cwd, config.clone()).await?;
    Ok(PreparedOfficeVerificationDispatch {
        cwd,
        config,
        run_id,
        verification_check_id: claimed.check_id,
        automation_id: claimed.automation_id,
        retry_of_automation_turn_id: claimed.retry_of_automation_turn_id,
        automation_file_path: automation_record.file_path,
        automation_config: automation_record.config,
        note,
        locale,
        client_user_message_id,
    })
}

pub(crate) async fn prepare_cancel(
    params: OfficeRunCancelParams,
) -> Result<PreparedOfficeRunCancel, JSONRPCErrorError> {
    let OfficeRunCancelParams {
        cwd,
        config,
        run_id,
        thread_id,
        turn_id,
        locale: _,
    } = params;
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err(invalid_params("runId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let config = latest_sync_config(
        &cwd,
        config,
        Some(&run_id),
        turn_id.as_deref().unwrap_or(""),
    )
    .await?;
    let config_thread_id = resolve_run_thread_id(&config, thread_id.as_deref())?;
    let runs = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = runs
        .iter()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id.as_str()))
    else {
        return Err(invalid_params("runId was not found"));
    };
    let status = run
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or("running");
    if run_status_is_terminal(status) {
        return Err(invalid_params("office run is already terminal"));
    }
    let resolved_turn_id = turn_id
        .or_else(|| {
            run.get("turnId")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
        })
        .filter(|turn_id| !turn_id.trim().is_empty())
        .ok_or_else(|| invalid_params("office run has no turnId to cancel"))?;
    if let Some(existing_turn_id) = run.get("turnId").and_then(JsonValue::as_str)
        && existing_turn_id != resolved_turn_id
    {
        return Err(invalid_params("turnId must match office run turnId"));
    }
    let mut cancel_targets = Vec::new();
    push_office_run_cancel_target(
        &mut cancel_targets,
        config_thread_id.as_str(),
        resolved_turn_id.as_str(),
    );
    collect_office_run_child_cancel_targets(run, &mut cancel_targets);
    Ok(PreparedOfficeRunCancel {
        cwd,
        config,
        run_id,
        thread_id: config_thread_id,
        turn_id: resolved_turn_id,
        cancel_targets,
    })
}

pub(crate) async fn prepare_delegation_cancel(
    params: OfficeDelegationCancelParams,
) -> Result<PreparedOfficeChildCancel, JSONRPCErrorError> {
    let OfficeDelegationCancelParams {
        cwd,
        config,
        run_id,
        delegation_id,
        thread_id,
        turn_id,
        locale: _,
    } = params;
    let config = latest_sync_config(
        &cwd,
        config,
        Some(&run_id),
        turn_id.as_deref().unwrap_or(""),
    )
    .await?;
    let run = office_run_value(&config, &run_id)?;
    let delegation = run
        .get("delegations")
        .and_then(JsonValue::as_array)
        .and_then(|delegations| {
            delegations.iter().find(|delegation| {
                delegation.get("id").and_then(JsonValue::as_str) == Some(delegation_id.as_str())
            })
        })
        .ok_or_else(|| invalid_params("delegationId was not found"))?;
    if !office_child_status_allows_cancel(delegation.get("status").and_then(JsonValue::as_str)) {
        return Err(invalid_params("office delegation cannot be canceled"));
    }
    let resolved_thread_id = resolve_child_cancel_thread_id(
        thread_id.as_deref(),
        delegation.get("threadId").and_then(JsonValue::as_str),
        "delegation",
    )?;
    let resolved_turn_id = resolve_child_cancel_turn_id(
        turn_id.as_deref(),
        delegation.get("turnId").and_then(JsonValue::as_str),
        "delegation",
    )?;
    let mut cancel_targets = Vec::new();
    push_office_run_cancel_target(
        &mut cancel_targets,
        resolved_thread_id.as_str(),
        resolved_turn_id.as_str(),
    );
    Ok(PreparedOfficeChildCancel {
        cwd,
        config,
        run_id,
        child_id: delegation_id,
        thread_id: resolved_thread_id,
        turn_id: resolved_turn_id,
        cancel_targets,
    })
}

pub(crate) async fn prepare_verification_cancel(
    params: OfficeVerificationCancelParams,
) -> Result<PreparedOfficeChildCancel, JSONRPCErrorError> {
    let OfficeVerificationCancelParams {
        cwd,
        config,
        run_id,
        verification_check_id,
        thread_id,
        turn_id,
        locale: _,
    } = params;
    let config = latest_sync_config(
        &cwd,
        config,
        Some(&run_id),
        turn_id.as_deref().unwrap_or(""),
    )
    .await?;
    let run = office_run_value(&config, &run_id)?;
    let check = run
        .get("verificationChecks")
        .and_then(JsonValue::as_array)
        .and_then(|checks| {
            checks
                .iter()
                .find(|check| verification_check_id_matches(check, verification_check_id.as_str()))
        })
        .ok_or_else(|| invalid_params("verificationCheckId was not found"))?;
    if !office_verification_check_allows_cancel(check) {
        return Err(invalid_params(
            "office verification check cannot be canceled",
        ));
    }
    let resolved_thread_id = resolve_child_cancel_thread_id(
        thread_id.as_deref(),
        check.get("automationThreadId").and_then(JsonValue::as_str),
        "verification check",
    )?;
    let resolved_turn_id = resolve_child_cancel_turn_id(
        turn_id.as_deref(),
        check.get("automationTurnId").and_then(JsonValue::as_str),
        "verification check",
    )?;
    let mut cancel_targets = Vec::new();
    push_office_run_cancel_target(
        &mut cancel_targets,
        resolved_thread_id.as_str(),
        resolved_turn_id.as_str(),
    );
    Ok(PreparedOfficeChildCancel {
        cwd,
        config,
        run_id,
        child_id: verification_check_id,
        thread_id: resolved_thread_id,
        turn_id: resolved_turn_id,
        cancel_targets,
    })
}

fn office_run_value<'a>(
    config: &'a JsonValue,
    run_id: &str,
) -> Result<&'a JsonValue, JSONRPCErrorError> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
        })
        .ok_or_else(|| invalid_params("runId was not found"))
}

fn office_run_object_mut<'a>(
    config: &'a mut JsonValue,
    run_id: &str,
) -> Result<&'a mut Map<String, JsonValue>, JSONRPCErrorError> {
    let workspace = workspace_object_mut(config)?;
    let runs = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = find_run_mut(runs, Some(run_id), "") else {
        return Err(invalid_params("runId was not found"));
    };
    run.as_object_mut()
        .ok_or_else(|| invalid_params("office run must be an object"))
}

fn resolve_child_cancel_thread_id(
    requested_thread_id: Option<&str>,
    stored_thread_id: Option<&str>,
    child_label: &str,
) -> Result<String, JSONRPCErrorError> {
    let stored_thread_id = stored_thread_id
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty());
    let requested_thread_id = requested_thread_id
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty());
    if let (Some(requested_thread_id), Some(stored_thread_id)) =
        (requested_thread_id, stored_thread_id)
        && requested_thread_id != stored_thread_id
    {
        return Err(invalid_params(format!(
            "threadId must match office {child_label} threadId"
        )));
    }
    requested_thread_id
        .or(stored_thread_id)
        .map(str::to_string)
        .ok_or_else(|| invalid_params(format!("office {child_label} has no threadId to cancel")))
}

fn resolve_child_cancel_turn_id(
    requested_turn_id: Option<&str>,
    stored_turn_id: Option<&str>,
    child_label: &str,
) -> Result<String, JSONRPCErrorError> {
    let stored_turn_id = stored_turn_id
        .map(str::trim)
        .filter(|turn_id| !turn_id.is_empty());
    let requested_turn_id = requested_turn_id
        .map(str::trim)
        .filter(|turn_id| !turn_id.is_empty());
    if let (Some(requested_turn_id), Some(stored_turn_id)) = (requested_turn_id, stored_turn_id)
        && requested_turn_id != stored_turn_id
    {
        return Err(invalid_params(format!(
            "turnId must match office {child_label} turnId"
        )));
    }
    requested_turn_id
        .or(stored_turn_id)
        .map(str::to_string)
        .ok_or_else(|| invalid_params(format!("office {child_label} has no turnId to cancel")))
}

fn verification_check_id_matches(check: &JsonValue, verification_check_id: &str) -> bool {
    check.get("itemId").and_then(JsonValue::as_str) == Some(verification_check_id)
        || check.get("id").and_then(JsonValue::as_str) == Some(verification_check_id)
        || check.get("checkId").and_then(JsonValue::as_str) == Some(verification_check_id)
}

pub(crate) async fn mark_cancel_requested(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    turn_id: &str,
) -> Result<(String, JsonValue), JSONRPCErrorError> {
    let mut config = latest_sync_config(cwd, config, Some(run_id), turn_id).await?;
    let thread_id = office_thread_id(&config).unwrap_or_default().to_string();
    let now = timestamp();
    let status = {
        let workspace = workspace_object_mut(&mut config)?;
        let runs = workspace
            .get_mut("activity")
            .and_then(JsonValue::as_object_mut)
            .and_then(|activity| activity.get_mut("runs"))
            .and_then(JsonValue::as_array_mut)
            .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
        let Some(run) = runs
            .iter_mut()
            .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
        else {
            return Err(invalid_params("runId was not found"));
        };
        let Some(run_object) = run.as_object_mut() else {
            return Err(invalid_params("office run must be an object"));
        };
        if let Some(existing_turn_id) = run_object.get("turnId").and_then(JsonValue::as_str)
            && existing_turn_id != turn_id
        {
            return Err(invalid_params("turnId must match office run turnId"));
        }
        let status = run_object
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or("running")
            .to_string();
        if !run_status_is_terminal(&status) {
            run_object.insert(
                "status".to_string(),
                JsonValue::String("canceling".to_string()),
            );
            run_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
            run_object.insert(
                "cancelRequestedAt".to_string(),
                JsonValue::String(now.clone()),
            );
            mark_office_run_child_cancel_requested(run_object, &now);
        }
        status
    };
    if !run_status_is_terminal(&status) {
        let Some(config_object) = config.as_object_mut() else {
            return Err(invalid_params("office config must be an object"));
        };
        config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    }
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    upsert_run_index(
        cwd,
        OfficeRunIndexEntry {
            run_id: run_id.to_string(),
            thread_id,
            turn_id: Some(turn_id.to_string()),
            file_path: file_path.clone(),
            status: if run_status_is_terminal(&status) {
                status
            } else {
                "canceling".to_string()
            },
            updated_at: timestamp(),
        },
    )
    .await?;
    Ok((file_path, config))
}

pub(crate) async fn mark_delegation_cancel_requested(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    turn_id: &str,
) -> Result<(String, JsonValue), JSONRPCErrorError> {
    let mut config = latest_sync_config(cwd, config, Some(run_id), turn_id).await?;
    let thread_id = office_thread_id(&config).unwrap_or_default().to_string();
    let now = timestamp();
    let (index_turn_id, index_status) = {
        let run_object = office_run_object_mut(&mut config, run_id)?;
        let index_turn_id = run_object
            .get("turnId")
            .and_then(JsonValue::as_str)
            .map(str::to_string);
        let index_status = run_object
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or("running")
            .to_string();
        let delegations = run_object
            .get_mut("delegations")
            .and_then(JsonValue::as_array_mut)
            .ok_or_else(|| invalid_params("run.delegations must be an array"))?;
        let Some(delegation_object) = delegations.iter_mut().find_map(|delegation| {
            let matches = delegation.get("id").and_then(JsonValue::as_str) == Some(delegation_id);
            matches.then(|| delegation.as_object_mut()).flatten()
        }) else {
            return Err(invalid_params("delegationId was not found"));
        };
        if let Some(existing_turn_id) = delegation_object.get("turnId").and_then(JsonValue::as_str)
            && existing_turn_id != turn_id
        {
            return Err(invalid_params("turnId must match office delegation turnId"));
        }
        if office_child_status_allows_cancel(
            delegation_object.get("status").and_then(JsonValue::as_str),
        ) {
            delegation_object.insert(
                "status".to_string(),
                JsonValue::String("canceling".to_string()),
            );
            delegation_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
            delegation_object.insert(
                "cancelRequestedAt".to_string(),
                JsonValue::String(now.clone()),
            );
            run_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
            refresh_run_loop_review(run_object);
        }
        (index_turn_id, index_status)
    };
    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    upsert_run_index(
        cwd,
        OfficeRunIndexEntry {
            run_id: run_id.to_string(),
            thread_id,
            turn_id: index_turn_id,
            file_path: file_path.clone(),
            status: index_status,
            updated_at: timestamp(),
        },
    )
    .await?;
    Ok((file_path, config))
}

pub(crate) async fn mark_verification_cancel_requested(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    verification_check_id: &str,
    turn_id: &str,
) -> Result<(String, JsonValue), JSONRPCErrorError> {
    let mut config = latest_sync_config(cwd, config, Some(run_id), turn_id).await?;
    let thread_id = office_thread_id(&config).unwrap_or_default().to_string();
    let now = timestamp();
    let (index_turn_id, index_status) = {
        let run_object = office_run_object_mut(&mut config, run_id)?;
        let index_turn_id = run_object
            .get("turnId")
            .and_then(JsonValue::as_str)
            .map(str::to_string);
        let index_status = run_object
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or("running")
            .to_string();
        let checks = run_object
            .get_mut("verificationChecks")
            .and_then(JsonValue::as_array_mut)
            .ok_or_else(|| invalid_params("run.verificationChecks must be an array"))?;
        let Some(check_object) = checks.iter_mut().find_map(|check| {
            verification_check_id_matches(check, verification_check_id)
                .then(|| check.as_object_mut())
                .flatten()
        }) else {
            return Err(invalid_params("verificationCheckId was not found"));
        };
        if let Some(existing_turn_id) = check_object
            .get("automationTurnId")
            .and_then(JsonValue::as_str)
            && existing_turn_id != turn_id
        {
            return Err(invalid_params(
                "turnId must match office verification automation turnId",
            ));
        }
        if office_verification_check_allows_cancel(&JsonValue::Object(check_object.clone())) {
            if check_object
                .get("itemId")
                .and_then(JsonValue::as_str)
                .is_none_or(|item_id| item_id.trim().is_empty())
            {
                check_object.insert(
                    "itemId".to_string(),
                    JsonValue::String(verification_check_id.to_string()),
                );
            }
            check_object.insert(
                "dispatchStatus".to_string(),
                JsonValue::String("canceling".to_string()),
            );
            check_object.insert(
                "automationStatus".to_string(),
                JsonValue::String("canceling".to_string()),
            );
            check_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
            check_object.insert(
                "cancelRequestedAt".to_string(),
                JsonValue::String(now.clone()),
            );
            run_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
            refresh_run_loop_review(run_object);
        }
        (index_turn_id, index_status)
    };
    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    upsert_run_index(
        cwd,
        OfficeRunIndexEntry {
            run_id: run_id.to_string(),
            thread_id,
            turn_id: index_turn_id,
            file_path: file_path.clone(),
            status: index_status,
            updated_at: timestamp(),
        },
    )
    .await?;
    Ok((file_path, config))
}

fn mark_office_run_child_cancel_requested(run_object: &mut Map<String, JsonValue>, now: &str) {
    if let Some(delegations) = run_object
        .get_mut("delegations")
        .and_then(JsonValue::as_array_mut)
    {
        for delegation in delegations {
            if !office_child_status_allows_cancel(
                delegation.get("status").and_then(JsonValue::as_str),
            ) || delegation
                .get("turnId")
                .and_then(JsonValue::as_str)
                .is_none_or(|turn_id| turn_id.trim().is_empty())
            {
                continue;
            }
            let Some(delegation_object) = delegation.as_object_mut() else {
                continue;
            };
            delegation_object.insert(
                "status".to_string(),
                JsonValue::String("canceling".to_string()),
            );
            delegation_object.insert("updatedAt".to_string(), JsonValue::String(now.to_string()));
            delegation_object.insert(
                "cancelRequestedAt".to_string(),
                JsonValue::String(now.to_string()),
            );
        }
    }
    if let Some(checks) = run_object
        .get_mut("verificationChecks")
        .and_then(JsonValue::as_array_mut)
    {
        for check in checks {
            if !office_verification_check_allows_cancel(check) {
                continue;
            }
            let Some(check_object) = check.as_object_mut() else {
                continue;
            };
            check_object.insert(
                "dispatchStatus".to_string(),
                JsonValue::String("canceling".to_string()),
            );
            check_object.insert(
                "automationStatus".to_string(),
                JsonValue::String("canceling".to_string()),
            );
            check_object.insert("updatedAt".to_string(), JsonValue::String(now.to_string()));
            check_object.insert(
                "cancelRequestedAt".to_string(),
                JsonValue::String(now.to_string()),
            );
        }
    }
}

fn collect_office_run_child_cancel_targets(
    run: &JsonValue,
    cancel_targets: &mut Vec<OfficeRunCancelTarget>,
) {
    if let Some(delegations) = run.get("delegations").and_then(JsonValue::as_array) {
        for delegation in delegations {
            if !office_child_status_allows_cancel(
                delegation.get("status").and_then(JsonValue::as_str),
            ) {
                continue;
            }
            let Some(thread_id) = delegation
                .get("threadId")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|thread_id| !thread_id.is_empty())
            else {
                continue;
            };
            let Some(turn_id) = delegation
                .get("turnId")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|turn_id| !turn_id.is_empty())
            else {
                continue;
            };
            push_office_run_cancel_target(cancel_targets, thread_id, turn_id);
        }
    }
    if let Some(checks) = run.get("verificationChecks").and_then(JsonValue::as_array) {
        for check in checks {
            if !office_verification_check_allows_cancel(check) {
                continue;
            }
            let Some(thread_id) = check
                .get("automationThreadId")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|thread_id| !thread_id.is_empty())
            else {
                continue;
            };
            let Some(turn_id) = check
                .get("automationTurnId")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|turn_id| !turn_id.is_empty())
            else {
                continue;
            };
            push_office_run_cancel_target(cancel_targets, thread_id, turn_id);
        }
    }
}

fn push_office_run_cancel_target(
    cancel_targets: &mut Vec<OfficeRunCancelTarget>,
    thread_id: &str,
    turn_id: &str,
) {
    if cancel_targets
        .iter()
        .any(|target| target.thread_id == thread_id && target.turn_id == turn_id)
    {
        return;
    }
    cancel_targets.push(OfficeRunCancelTarget {
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
    });
}

fn office_child_status_allows_cancel(status: Option<&str>) -> bool {
    !matches!(
        status.map(str::trim),
        Some("completed" | "done" | "failed" | "interrupted" | "skipped" | "blocked")
    )
}

fn office_verification_check_allows_cancel(check: &JsonValue) -> bool {
    if !office_child_status_allows_cancel(check.get("status").and_then(JsonValue::as_str)) {
        return false;
    }
    matches!(
        check
            .get("dispatchStatus")
            .and_then(JsonValue::as_str)
            .map(str::trim),
        Some("queued" | "running" | "canceling")
    )
}

pub(crate) async fn mark_started(
    cwd: &str,
    mut config: JsonValue,
    run_id: &str,
    turn_id: &str,
) -> Result<(String, JsonValue), JSONRPCErrorError> {
    update_run_status(
        &mut config,
        run_id,
        "running",
        Some(("turnId", JsonValue::String(turn_id.to_string()))),
        /*error*/ None,
    )?;
    let thread_id = office_thread_id(&config).unwrap_or_default().to_string();
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    upsert_run_index(
        cwd,
        OfficeRunIndexEntry {
            run_id: run_id.to_string(),
            thread_id,
            turn_id: Some(turn_id.to_string()),
            file_path: file_path.clone(),
            status: "running".to_string(),
            updated_at: timestamp(),
        },
    )
    .await?;
    Ok((file_path, config))
}

pub(crate) async fn mark_failed(
    cwd: &str,
    mut config: JsonValue,
    run_id: &str,
    message: &str,
) -> Result<(), JSONRPCErrorError> {
    update_run_status(
        &mut config,
        run_id,
        "failed",
        /*extra_field*/ None,
        Some(truncate_chars(message, RUN_ERROR_CHARS)),
    )?;
    let workspace = workspace_object_mut(&mut config)?;
    if let Some(task_object) = array_entry(workspace, "tasks", "workspace.tasks must be an array")?
        .iter_mut()
        .find_map(|task| {
            let matches_run = task.get("runId").and_then(JsonValue::as_str) == Some(run_id);
            matches_run.then(|| task.as_object_mut()).flatten()
        })
    {
        task_object.insert("status".to_string(), JsonValue::String("todo".to_string()));
    }
    let thread_id = office_thread_id(&config).unwrap_or_default().to_string();
    let turn_id = run_field(&config, run_id, "turnId").map(str::to_string);
    let file_path = save_record(DomainKind::Office, cwd, config).await?;
    upsert_run_index(
        cwd,
        OfficeRunIndexEntry {
            run_id: run_id.to_string(),
            thread_id,
            turn_id,
            file_path,
            status: "failed".to_string(),
            updated_at: timestamp(),
        },
    )
    .await
}

pub(crate) async fn mark_delegation_started(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    turn_id: &str,
) -> Result<(String, JsonValue), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    update_delegation_status(
        &mut config,
        run_id,
        delegation_id,
        "running",
        Some(turn_id),
        /*error*/ None,
    )?;
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    Ok((file_path, config))
}

pub(crate) async fn mark_delegation_failed(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    message: &str,
) -> Result<(), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    update_delegation_status(
        &mut config,
        run_id,
        delegation_id,
        "failed",
        /*turn_id*/ None,
        Some(message),
    )?;
    save_record(DomainKind::Office, cwd, config).await?;
    Ok(())
}

pub(crate) async fn mark_verification_dispatch_started(
    cwd: &str,
    config: JsonValue,
    started: StartedOfficeVerificationDispatch<'_>,
) -> Result<(String, JsonValue), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(started.run_id), "").await?;
    update_verification_dispatch_status(
        &mut config,
        VerificationDispatchStatusUpdate {
            run_id: started.run_id,
            verification_check_id: started.verification_check_id,
            dispatch_status: "running",
            automation_run_file_path: Some(started.automation_run_file_path),
            automation_run_id: Some(started.automation_run_id),
            automation_thread_id: Some(started.automation_thread_id),
            automation_turn_id: Some(started.automation_turn_id),
            runtime_repair_source_thread_id: started.runtime_repair_source_thread_id,
            runtime_repaired_at: started.runtime_repaired_at,
            error: None,
        },
    )?;
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    Ok((file_path, config))
}

pub(crate) async fn mark_verification_dispatch_failed(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    verification_check_id: &str,
    message: &str,
) -> Result<(), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    update_verification_dispatch_status(
        &mut config,
        VerificationDispatchStatusUpdate {
            run_id,
            verification_check_id,
            dispatch_status: "failed",
            automation_run_file_path: None,
            automation_run_id: None,
            automation_thread_id: None,
            automation_turn_id: None,
            runtime_repair_source_thread_id: None,
            runtime_repaired_at: None,
            error: Some(message),
        },
    )?;
    save_record(DomainKind::Office, cwd, config).await?;
    Ok(())
}

pub(crate) async fn mark_verification_dispatch_retryable_start_failure(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    verification_check_id: &str,
    message: &str,
) -> Result<(), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    let now = timestamp();
    {
        let checks = run_verification_checks_mut(&mut config, run_id)?;
        let Some(check_object) = checks.iter_mut().find_map(|check| {
            let matches = check.get("itemId").and_then(JsonValue::as_str)
                == Some(verification_check_id)
                || check.get("id").and_then(JsonValue::as_str) == Some(verification_check_id)
                || check.get("checkId").and_then(JsonValue::as_str) == Some(verification_check_id);
            matches.then(|| check.as_object_mut()).flatten()
        }) else {
            return Err(invalid_params("verificationCheckId was not found"));
        };
        check_object.insert(
            "itemId".to_string(),
            JsonValue::String(verification_check_id.to_string()),
        );
        check_object.insert(
            "status".to_string(),
            JsonValue::String("pending".to_string()),
        );
        check_object.insert(
            "dispatchStatus".to_string(),
            JsonValue::String("failed".to_string()),
        );
        check_object.insert(
            "error".to_string(),
            JsonValue::String(truncate_chars(message, RUN_ERROR_CHARS)),
        );
        check_object.insert("updatedAt".to_string(), JsonValue::String(now));
    }
    refresh_loop_review_for_run(&mut config, run_id)?;
    save_record(DomainKind::Office, cwd, config).await?;
    Ok(())
}

pub(crate) async fn sync(
    params: OfficeRunSyncParams,
) -> Result<SyncedOfficeRun, JSONRPCErrorError> {
    let OfficeRunSyncParams {
        cwd,
        config,
        run_id,
        turn,
        locale,
    } = params;
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let mut config = latest_sync_config(&cwd, config, run_id.as_deref(), &turn.id).await?;
    if let Some(delegation_thread_id) =
        delegation_thread_id_for_turn(&config, run_id.as_deref(), &turn.id)
    {
        sync_delegation_turn_status(
            &cwd,
            &mut config,
            &delegation_thread_id,
            &turn,
            locale.as_deref(),
        )
        .await?;
        apply_office_artifact_file_fingerprints(&cwd, &mut config).await?;
        let file_path = save_record(DomainKind::Office, &cwd, config.clone()).await?;
        queue_auto_dispatch_intent_after_sync(&cwd, &delegation_thread_id, &turn, "explicitSync")
            .await?;
        return Ok(SyncedOfficeRun {
            file_path,
            config,
            source_thread_id: delegation_thread_id,
            source_turn_id: turn.id,
        });
    }
    if let Some(verification_thread_id) =
        verification_thread_id_for_turn(&config, run_id.as_deref(), &turn.id)
    {
        sync_verification_turn_status(&mut config, &verification_thread_id, &turn)?;
        apply_office_artifact_file_fingerprints(&cwd, &mut config).await?;
        let file_path = save_record(DomainKind::Office, &cwd, config.clone()).await?;
        queue_auto_dispatch_intent_after_sync(&cwd, &verification_thread_id, &turn, "explicitSync")
            .await?;
        return Ok(SyncedOfficeRun {
            file_path,
            config,
            source_thread_id: verification_thread_id,
            source_turn_id: turn.id,
        });
    }
    let details = sync_run_status(&mut config, run_id.as_deref(), &turn, locale.as_deref())?;
    office_memory::apply_update_from_turn(&cwd, &mut config, &details, &turn).await?;
    apply_office_artifact_file_fingerprints(&cwd, &mut config).await?;
    let file_path = save_record(DomainKind::Office, &cwd, config.clone()).await?;
    let details_thread_id = details.thread_id.clone();
    upsert_run_index(
        &cwd,
        OfficeRunIndexEntry {
            run_id: details.run_id,
            thread_id: details.thread_id,
            turn_id: details.turn_id,
            file_path: file_path.clone(),
            status: details.status,
            updated_at: timestamp(),
        },
    )
    .await?;
    queue_auto_dispatch_intent_after_sync(&cwd, &details_thread_id, &turn, "explicitSync").await?;
    Ok(SyncedOfficeRun {
        file_path,
        config,
        source_thread_id: details_thread_id,
        source_turn_id: turn.id,
    })
}

#[cfg(test)]
pub(crate) async fn sync_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<usize, JSONRPCErrorError> {
    Ok(drain_thread_turn_updates(cwd, thread_id, turn).await?.len())
}

pub(crate) async fn drain_thread_turn_updates(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<Vec<OfficeRunSyncUpdate>, JSONRPCErrorError> {
    // The caller holds the Office authority guard. Terminal sync only updates existing records,
    // so persist through their already-resolved paths instead of re-entering save resolution.
    let mut updates = sync_thread_turn_from_index(cwd, thread_id, turn).await?;
    let skip_indexed_run_scan = !updates.is_empty();

    let directory = domain_directory(cwd, DomainKind::Office)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(updates);
        }
        Err(err) => return Err(map_io_error(err)),
    };

    let mut scanned = 0usize;
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        if scanned >= AUTO_SYNC_OFFICE_SCAN_LIMIT {
            break;
        }
        scanned += 1;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let Some(record) = read_record(DomainKind::Office, &path).await? else {
            continue;
        };
        let should_sync_run = !skip_indexed_run_scan
            && office_thread_id(&record.config) == Some(thread_id)
            && office_has_turn_id(&record.config, &turn.id);
        let should_sync_delegation =
            office_has_delegation_turn_id(&record.config, thread_id, &turn.id);
        let should_sync_verification =
            office_has_verification_turn_id(&record.config, thread_id, &turn.id);
        if !should_sync_run && !should_sync_delegation && !should_sync_verification {
            continue;
        }

        let mut config = record.config;
        let locale = infer_office_locale(&config);
        let mut run_index_entry = None;
        let mut synced_count = 0usize;
        if should_sync_run {
            let details =
                sync_run_status(&mut config, /*requested_run_id*/ None, turn, locale)?;
            office_memory::apply_update_from_turn(cwd, &mut config, &details, turn).await?;
            run_index_entry = Some(OfficeRunIndexEntry {
                run_id: details.run_id,
                thread_id: details.thread_id,
                turn_id: details.turn_id,
                file_path: String::new(),
                status: details.status,
                updated_at: timestamp(),
            });
            synced_count += 1;
        }
        if should_sync_delegation {
            synced_count +=
                sync_delegation_turn_status(cwd, &mut config, thread_id, turn, locale).await?;
        }
        if should_sync_verification {
            synced_count += sync_verification_turn_status(&mut config, thread_id, turn)?;
        }
        if synced_count == 0 {
            continue;
        }
        apply_office_artifact_file_fingerprints(cwd, &mut config).await?;
        let file_path =
            update_record(DomainKind::Office, cwd, &record.file_path, config.clone()).await?;
        if let Some(mut entry) = run_index_entry {
            entry.file_path.clone_from(&file_path);
            upsert_run_index(cwd, entry).await?;
        }
        updates.push(OfficeRunSyncUpdate { file_path, config });
    }

    Ok(updates)
}

async fn queue_auto_dispatch_intent_after_sync(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
    reason: &str,
) -> Result<(), JSONRPCErrorError> {
    if matches!(turn.status, TurnStatus::Completed) {
        queue_auto_dispatch_intent(cwd, thread_id, &turn.id, reason).await?;
    }
    Ok(())
}

async fn auto_dispatch_run_candidates_after_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn_id: &str,
) -> Result<Vec<AutoDispatchRunCandidate>, JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(map_io_error(err)),
    };

    let mut scanned = 0usize;
    let mut candidates = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        if scanned >= AUTO_SYNC_OFFICE_SCAN_LIMIT {
            break;
        }
        scanned += 1;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let Some(record) = read_record(DomainKind::Office, &path).await? else {
            continue;
        };
        collect_auto_dispatch_run_candidates(&record.config, thread_id, turn_id, &mut candidates);
    }
    Ok(candidates)
}

fn collect_auto_dispatch_run_candidates(
    config: &JsonValue,
    thread_id: &str,
    turn_id: &str,
    candidates: &mut Vec<AutoDispatchRunCandidate>,
) {
    let Some(runs) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
    else {
        return;
    };
    let locale = infer_office_locale(config).map(str::to_string);
    let manager_thread_matches = office_thread_id(config) == Some(thread_id);
    for run in runs {
        let Some(run_id) = run
            .get("id")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|run_id| !run_id.is_empty())
        else {
            continue;
        };
        let manager_turn_matches = manager_thread_matches
            && run.get("turnId").and_then(JsonValue::as_str) == Some(turn_id)
            && office_item_status_allows_auto_dispatch(run);
        let delegation_turn_matches = run
            .get("delegations")
            .and_then(JsonValue::as_array)
            .is_some_and(|delegations| {
                delegations.iter().any(|delegation| {
                    delegation_matches_turn(delegation, thread_id, turn_id)
                        && office_item_status_allows_auto_dispatch(delegation)
                })
            });
        let verification_turn_matches = run
            .get("verificationChecks")
            .and_then(JsonValue::as_array)
            .is_some_and(|checks| {
                checks.iter().any(|check| {
                    verification_check_matches_automation_turn(check, thread_id, turn_id)
                        && office_verification_status_allows_auto_dispatch(check)
                })
            });
        if manager_turn_matches || delegation_turn_matches || verification_turn_matches {
            push_auto_dispatch_run_candidate(candidates, config, run_id, locale.as_deref());
        }
    }
}

fn office_item_status_allows_auto_dispatch(item: &JsonValue) -> bool {
    matches!(
        item.get("status").and_then(JsonValue::as_str),
        Some("completed" | "done")
    )
}

fn office_verification_status_allows_auto_dispatch(check: &JsonValue) -> bool {
    matches!(
        check.get("status").and_then(JsonValue::as_str),
        Some("passed" | "completed" | "done")
    ) && matches!(
        check.get("dispatchStatus").and_then(JsonValue::as_str),
        Some("completed") | None
    )
}

fn claim_next_dispatchable_verification_check(
    config: &mut JsonValue,
    run_id: &str,
    dispatch_policy: VerificationDispatchPolicy,
) -> Result<ClaimedOfficeVerificationCheck, JSONRPCErrorError> {
    let checks = run_verification_checks_mut(config, run_id)?;
    for check in checks {
        if !verification_check_is_dispatchable(check, dispatch_policy) {
            continue;
        }
        let Some(check_object) = check.as_object_mut() else {
            return Err(invalid_params("verification check must be an object"));
        };
        let automation_id = check_object
            .get("automationId")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|automation_id| !automation_id.is_empty())
            .ok_or_else(|| invalid_params("verification check is missing automationId"))?
            .to_string();
        let check_text = check_object
            .get("check")
            .and_then(JsonValue::as_str)
            .map(|check| truncate_chars(check, MAX_PROMPT_FIELD_CHARS))
            .unwrap_or_else(|| "Automation verification".to_string());
        let check_id = check_object
            .get("itemId")
            .or_else(|| check_object.get("id"))
            .or_else(|| check_object.get("checkId"))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|check_id| !check_id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("office-verification-{}", Uuid::new_v4()));
        check_object
            .entry("itemId".to_string())
            .or_insert_with(|| JsonValue::String(check_id.clone()));
        return Ok(ClaimedOfficeVerificationCheck {
            check_id,
            check: check_text,
            criterion: check_object
                .get("criterion")
                .and_then(JsonValue::as_str)
                .map(|criterion| truncate_chars(criterion, MAX_PROMPT_FIELD_CHARS)),
            criterion_id: check_object
                .get("criterionId")
                .or_else(|| check_object.get("criterion_id"))
                .and_then(JsonValue::as_str)
                .map(|criterion_id| truncate_chars(criterion_id, MAX_PROMPT_FIELD_CHARS)),
            acceptance_id: check_object
                .get("acceptanceId")
                .or_else(|| check_object.get("acceptance_id"))
                .and_then(JsonValue::as_str)
                .map(|acceptance_id| truncate_chars(acceptance_id, MAX_PROMPT_FIELD_CHARS)),
            automation_id,
            artifact: check_object
                .get("artifact")
                .and_then(JsonValue::as_str)
                .map(|artifact| truncate_chars(artifact, MAX_PROMPT_FIELD_CHARS)),
            command: check_object
                .get("command")
                .and_then(JsonValue::as_str)
                .map(|command| truncate_chars(command, MAX_PROMPT_FIELD_CHARS)),
            retry_of_automation_turn_id: None,
            previous_status: None,
            previous_dispatch_status: None,
            previous_error: None,
            previous_evidence: None,
        });
    }
    Err(invalid_params(
        "no dispatchable office verification check was found",
    ))
}

fn claim_retryable_verification_check(
    config: &mut JsonValue,
    run_id: &str,
    verification_check_id: &str,
) -> Result<ClaimedOfficeVerificationCheck, JSONRPCErrorError> {
    let now = timestamp();
    let checks = run_verification_checks_mut(config, run_id)?;
    for check in checks {
        if !verification_check_id_matches(check, verification_check_id) {
            continue;
        }
        let Some(check_object) = check.as_object_mut() else {
            return Err(invalid_params("verification check must be an object"));
        };
        if verification_check_has_active_dispatch(check_object) {
            return Err(invalid_params(
                "office verification retry is already active",
            ));
        }
        if !verification_check_status_allows_retry(check_object) {
            return Err(invalid_params("office verification check is not retryable"));
        }
        let automation_id = check_object
            .get("automationId")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|automation_id| !automation_id.is_empty())
            .ok_or_else(|| invalid_params("verification check is missing automationId"))?
            .to_string();
        let check_text = check_object
            .get("check")
            .and_then(JsonValue::as_str)
            .map(|check| truncate_chars(check, MAX_PROMPT_FIELD_CHARS))
            .unwrap_or_else(|| "Automation verification".to_string());
        let check_id = check_object
            .get("itemId")
            .or_else(|| check_object.get("id"))
            .or_else(|| check_object.get("checkId"))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|check_id| !check_id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| verification_check_id.to_string());
        let retry_of_automation_turn_id = check_object
            .get("automationTurnId")
            .or_else(|| check_object.get("sourceTurnId"))
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|turn_id| !turn_id.is_empty())
            .map(str::to_string);
        let previous_status = verification_check_string(check_object, "status");
        let previous_dispatch_status = verification_check_string(check_object, "dispatchStatus");
        let previous_error = verification_check_string(check_object, "error")
            .map(|error| truncate_chars(&error, RUN_ERROR_CHARS));
        let previous_evidence = verification_check_string(check_object, "evidence")
            .map(|evidence| truncate_chars(&evidence, RUN_RESULT_PREVIEW_CHARS));
        archive_verification_attempt(check_object, &now);
        clear_verification_retry_fields(check_object);
        check_object.insert("itemId".to_string(), JsonValue::String(check_id.clone()));
        check_object.insert(
            "status".to_string(),
            JsonValue::String("pending".to_string()),
        );
        check_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
        if let Some(turn_id) = retry_of_automation_turn_id.as_ref() {
            check_object.insert(
                "retryOfAutomationTurnId".to_string(),
                JsonValue::String(turn_id.clone()),
            );
        }
        return Ok(ClaimedOfficeVerificationCheck {
            check_id,
            check: check_text,
            criterion: check_object
                .get("criterion")
                .and_then(JsonValue::as_str)
                .map(|criterion| truncate_chars(criterion, MAX_PROMPT_FIELD_CHARS)),
            criterion_id: check_object
                .get("criterionId")
                .or_else(|| check_object.get("criterion_id"))
                .and_then(JsonValue::as_str)
                .map(|criterion_id| truncate_chars(criterion_id, MAX_PROMPT_FIELD_CHARS)),
            acceptance_id: check_object
                .get("acceptanceId")
                .or_else(|| check_object.get("acceptance_id"))
                .and_then(JsonValue::as_str)
                .map(|acceptance_id| truncate_chars(acceptance_id, MAX_PROMPT_FIELD_CHARS)),
            automation_id,
            artifact: check_object
                .get("artifact")
                .and_then(JsonValue::as_str)
                .map(|artifact| truncate_chars(artifact, MAX_PROMPT_FIELD_CHARS)),
            command: check_object
                .get("command")
                .and_then(JsonValue::as_str)
                .map(|command| truncate_chars(command, MAX_PROMPT_FIELD_CHARS)),
            retry_of_automation_turn_id,
            previous_status,
            previous_dispatch_status,
            previous_error,
            previous_evidence,
        });
    }
    Err(invalid_params("verificationCheckId was not found"))
}

fn run_verification_checks_mut<'a>(
    config: &'a mut JsonValue,
    run_id: &str,
) -> Result<&'a mut Vec<JsonValue>, JSONRPCErrorError> {
    let workspace = workspace_object_mut(config)?;
    let runs = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = find_run_mut(runs, Some(run_id), "") else {
        return Err(invalid_params("runId was not found"));
    };
    run.get_mut("verificationChecks")
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("run.verificationChecks must be an array"))
}

fn verification_check_is_dispatchable(
    check: &JsonValue,
    dispatch_policy: VerificationDispatchPolicy,
) -> bool {
    let status_allows_dispatch = check
        .get("status")
        .and_then(JsonValue::as_str)
        .is_none_or(|status| status == "pending");
    if !status_allows_dispatch {
        return false;
    }
    let has_automation_id = check
        .get("automationId")
        .and_then(JsonValue::as_str)
        .is_some_and(|automation_id| !automation_id.trim().is_empty());
    if !has_automation_id {
        return false;
    }
    if dispatch_policy == VerificationDispatchPolicy::Auto
        && verification_check_requires_manual_dispatch(check)
    {
        return false;
    }
    let already_has_turn = ["automationTurnId", "automationRunId"].iter().any(|key| {
        check
            .get(*key)
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    });
    if already_has_turn {
        return false;
    }
    match check.get("dispatchStatus").and_then(JsonValue::as_str) {
        Some("queued") => !value_child_dispatch_lease_is_active(check, Utc::now()),
        Some("running" | "canceling" | "completed") => false,
        _ => true,
    }
}

fn verification_check_requires_manual_dispatch(check: &JsonValue) -> bool {
    if json_boolish(
        check,
        &["approvalRequired", "requiresApproval", "manualDispatch"],
    ) {
        return true;
    }
    if check
        .get("approvalId")
        .and_then(JsonValue::as_str)
        .is_some_and(|approval_id| !approval_id.trim().is_empty())
    {
        return true;
    }
    if check
        .get("dispatchMode")
        .or_else(|| check.get("dispatchPolicy"))
        .and_then(JsonValue::as_str)
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
        .and_then(JsonValue::as_str)
        .is_some_and(|value| risk_severity(value) == "high")
}

fn verification_check_has_active_dispatch(check: &Map<String, JsonValue>) -> bool {
    match check.get("dispatchStatus").and_then(JsonValue::as_str) {
        Some("queued") => child_dispatch_lease_is_active(
            check
                .get("dispatchLeaseExpiresAt")
                .and_then(JsonValue::as_str),
            Utc::now(),
        ),
        Some("running" | "canceling") => true,
        _ => false,
    }
}

fn verification_check_status_allows_retry(check: &Map<String, JsonValue>) -> bool {
    let status = check.get("status").and_then(JsonValue::as_str);
    let dispatch_status = check.get("dispatchStatus").and_then(JsonValue::as_str);
    let automation_status = check.get("automationStatus").and_then(JsonValue::as_str);
    matches!(status, Some("failed" | "interrupted"))
        || matches!(dispatch_status, Some("failed" | "interrupted"))
        || matches!(automation_status, Some("failed" | "interrupted"))
}

fn verification_check_string(check: &Map<String, JsonValue>, key: &str) -> Option<String> {
    check
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn archive_verification_attempt(check: &mut Map<String, JsonValue>, archived_at: &str) {
    let mut attempt = Map::new();
    for key in [
        "status",
        "dispatchStatus",
        "automationStatus",
        "automationRunFilePath",
        "automationRunId",
        "automationThreadId",
        "automationTurnId",
        "sourceType",
        "sourceThreadId",
        "sourceTurnId",
        "observedAt",
        "completedAt",
        "error",
        "evidence",
    ] {
        if let Some(value) = check.get(key).cloned() {
            attempt.insert(key.to_string(), value);
        }
    }
    if attempt.is_empty() {
        return;
    }
    attempt.insert(
        "archivedAt".to_string(),
        JsonValue::String(archived_at.to_string()),
    );
    let attempts = check
        .entry("attempts".to_string())
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    if !attempts.is_array() {
        *attempts = JsonValue::Array(Vec::new());
    }
    let Some(attempts) = attempts.as_array_mut() else {
        return;
    };
    let overflow = attempts
        .len()
        .saturating_add(1)
        .saturating_sub(MAX_VERIFICATION_ATTEMPTS);
    if overflow > 0 {
        attempts.drain(0..overflow);
    }
    attempts.push(JsonValue::Object(attempt));
}

fn clear_verification_retry_fields(check: &mut Map<String, JsonValue>) {
    for key in [
        "dispatchStatus",
        "automationStatus",
        "automationRunFilePath",
        "automationRunId",
        "automationThreadId",
        "automationTurnId",
        "sourceType",
        "sourceThreadId",
        "sourceTurnId",
        "observedAt",
        "completedAt",
        "cancelRequestedAt",
        "error",
        "evidence",
    ] {
        check.remove(key);
    }
}

pub(crate) async fn read_automation_record_by_identifier(
    cwd: &str,
    automation_id: &str,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    let automation_id = automation_id.trim();
    if automation_id.is_empty() {
        return Err(invalid_params("automationId must not be empty"));
    }
    let automation_path = PathBuf::from(automation_id);
    if automation_path.is_absolute() {
        let file_path = validate_record_file_path(cwd, DomainKind::Automation, automation_id)?;
        return read_record(DomainKind::Automation, &file_path).await;
    }
    let (records, _) = list_records(
        DomainKind::Automation,
        cwd,
        /*cursor*/ None,
        Some(AUTO_SYNC_OFFICE_SCAN_LIMIT as u32),
    )
    .await?;
    Ok(records.into_iter().find(|record| {
        record.file_path == automation_id
            || record.config.get("threadId").and_then(JsonValue::as_str) == Some(automation_id)
            || record.config.get("title").and_then(JsonValue::as_str) == Some(automation_id)
            || record
                .config
                .get("automationId")
                .and_then(JsonValue::as_str)
                == Some(automation_id)
            || record.config.get("id").and_then(JsonValue::as_str) == Some(automation_id)
    }))
}

fn build_office_verification_automation_note(
    config: &JsonValue,
    run_id: &str,
    check: &ClaimedOfficeVerificationCheck,
    automation_title: Option<&str>,
    locale: Option<&str>,
) -> String {
    let is_zh = locale != Some("en");
    let office_title = config
        .get("title")
        .and_then(JsonValue::as_str)
        .map(|title| truncate_chars(title, MAX_PROMPT_TITLE_CHARS))
        .unwrap_or_else(|| "Office".to_string());
    let run_title = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
        })
        .and_then(|run| run.get("title").and_then(JsonValue::as_str))
        .map(|title| truncate_chars(title, MAX_PROMPT_TITLE_CHARS))
        .unwrap_or_else(|| "Office run".to_string());
    let automation_title = automation_title
        .map(|title| truncate_chars(title, MAX_PROMPT_TITLE_CHARS))
        .unwrap_or_else(|| check.automation_id.clone());
    let mut lines = Vec::new();
    if is_zh {
        lines.push(format!("办公室验证任务：{office_title} / {run_title}"));
        lines.push(format!("Office run id：{run_id}"));
        lines.push(format!("Verification check id：{}", check.check_id));
        lines.push(format!("Automation：{automation_title}"));
        lines.push(format!("检查项：{}", check.check));
        if let Some(criterion_id) = check.criterion_id.as_ref() {
            lines.push(format!("验收 id：{criterion_id}"));
        }
        if let Some(acceptance_id) = check.acceptance_id.as_ref() {
            lines.push(format!("Acceptance id：{acceptance_id}"));
        }
        if let Some(criterion) = check.criterion.as_ref() {
            lines.push(format!("验收标准：{criterion}"));
        }
        if let Some(artifact) = check.artifact.as_ref() {
            lines.push(format!("目标产物：{artifact}"));
        }
        if let Some(command) = check.command.as_ref() {
            lines.push(format!("相关命令：{command}"));
        }
        if let Some(turn_id) = check.retry_of_automation_turn_id.as_ref() {
            lines.push(format!("重试上一轮 automation turn：{turn_id}"));
        }
        if let Some(status) = check.previous_status.as_ref() {
            lines.push(format!("上一轮状态：{status}"));
        }
        if let Some(dispatch_status) = check.previous_dispatch_status.as_ref() {
            lines.push(format!("上一轮派发状态：{dispatch_status}"));
        }
        if let Some(error) = check.previous_error.as_ref() {
            lines.push(format!("上一轮错误：{error}"));
        }
        if let Some(evidence) = check.previous_evidence.as_ref() {
            lines.push(format!("上一轮证据摘要：{evidence}"));
        }
        lines.push("要求：只验证这一条检查；使用真实工具或可追溯证据；如果验证失败要明确 failed 和原因。最终回复请追加 JSON：{\"officeUpdate\":{\"verificationChecks\":[{\"itemId\":\"...\",\"automationId\":\"...\",\"criterionId\":\"可选\",\"acceptanceId\":\"可选\",\"status\":\"passed|failed\",\"evidence\":\"证据摘要\"}],\"evidence\":[{\"summary\":\"证据摘要\",\"status\":\"verified|blocked\",\"source\":\"automation\"}]}}。".to_string());
    } else {
        lines.push(format!(
            "Office verification task: {office_title} / {run_title}"
        ));
        lines.push(format!("Office run id: {run_id}"));
        lines.push(format!("Verification check id: {}", check.check_id));
        lines.push(format!("Automation: {automation_title}"));
        lines.push(format!("Check: {}", check.check));
        if let Some(criterion_id) = check.criterion_id.as_ref() {
            lines.push(format!("Criterion id: {criterion_id}"));
        }
        if let Some(acceptance_id) = check.acceptance_id.as_ref() {
            lines.push(format!("Acceptance id: {acceptance_id}"));
        }
        if let Some(criterion) = check.criterion.as_ref() {
            lines.push(format!("Acceptance criterion: {criterion}"));
        }
        if let Some(artifact) = check.artifact.as_ref() {
            lines.push(format!("Target artifact: {artifact}"));
        }
        if let Some(command) = check.command.as_ref() {
            lines.push(format!("Related command: {command}"));
        }
        if let Some(turn_id) = check.retry_of_automation_turn_id.as_ref() {
            lines.push(format!("Retry of automation turn: {turn_id}"));
        }
        if let Some(status) = check.previous_status.as_ref() {
            lines.push(format!("Previous status: {status}"));
        }
        if let Some(dispatch_status) = check.previous_dispatch_status.as_ref() {
            lines.push(format!("Previous dispatch status: {dispatch_status}"));
        }
        if let Some(error) = check.previous_error.as_ref() {
            lines.push(format!("Previous error: {error}"));
        }
        if let Some(evidence) = check.previous_evidence.as_ref() {
            lines.push(format!("Previous evidence summary: {evidence}"));
        }
        lines.push("Instructions: verify only this check; use real tool output or traceable evidence; if verification fails, mark it failed with the reason. Append JSON in the final response: {\"officeUpdate\":{\"verificationChecks\":[{\"itemId\":\"...\",\"automationId\":\"...\",\"criterionId\":\"optional\",\"acceptanceId\":\"optional\",\"status\":\"passed|failed\",\"evidence\":\"evidence summary\"}],\"evidence\":[{\"summary\":\"evidence summary\",\"status\":\"verified|blocked\",\"source\":\"automation\"}]}}.".to_string());
    }
    lines.join("\n")
}

fn push_auto_dispatch_run_candidate(
    candidates: &mut Vec<AutoDispatchRunCandidate>,
    config: &JsonValue,
    run_id: &str,
    locale: Option<&str>,
) {
    if candidates
        .iter()
        .any(|candidate| candidate.run_id == run_id)
    {
        return;
    }
    candidates.push(AutoDispatchRunCandidate {
        config: config.clone(),
        run_id: run_id.to_string(),
        locale: locale.map(str::to_string),
    });
}

fn is_no_dispatchable_delegation_error(error: &JSONRPCErrorError) -> bool {
    error
        .message
        .contains("no dispatchable office delegation was found")
}

fn is_no_dispatchable_verification_error(error: &JSONRPCErrorError) -> bool {
    error
        .message
        .contains("no dispatchable office verification check was found")
        || error
            .message
            .contains("run.verificationChecks must be an array")
}

async fn latest_sync_config(
    cwd: &str,
    config: JsonValue,
    requested_run_id: Option<&str>,
    turn_id: &str,
) -> Result<JsonValue, JSONRPCErrorError> {
    let turn_id = turn_id.trim();
    let lookup_turn_id = (!turn_id.is_empty()).then_some(turn_id);
    if let Some(index_entry) = find_index_entry(
        cwd,
        requested_run_id,
        lookup_turn_id,
        office_thread_id(&config),
    )
    .await?
        && let Some(config) = read_indexed_office_config(cwd, &index_entry).await?
        && requested_run_id.is_none_or(|run_id| office_has_run_id(&config, run_id))
        && lookup_turn_id.is_none_or(|turn_id| office_has_turn_id(&config, turn_id))
        && office_thread_id(&config) == Some(index_entry.thread_id.as_str())
    {
        return Ok(config);
    }

    let Some(thread_id) = office_thread_id(&config)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
    else {
        return Ok(config);
    };
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(config),
        Err(err) => return Err(map_io_error(err)),
    };

    let mut scanned = 0usize;
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        if scanned >= AUTO_SYNC_OFFICE_SCAN_LIMIT {
            break;
        }
        scanned += 1;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let Some(record) = read_record(DomainKind::Office, &path).await? else {
            continue;
        };
        if office_thread_id(&record.config) != Some(thread_id) {
            continue;
        }
        let matches_run =
            requested_run_id.is_some_and(|run_id| office_has_run_id(&record.config, run_id));
        if matches_run || office_has_turn_id(&record.config, turn_id) {
            return Ok(record.config);
        }
    }

    Ok(config)
}

async fn sync_thread_turn_from_index(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<Vec<OfficeRunSyncUpdate>, JSONRPCErrorError> {
    let entries =
        matching_index_entries(cwd, /*run_id*/ None, Some(&turn.id), Some(thread_id)).await?;
    let mut updates = Vec::new();
    for entry in entries {
        let Some(mut config) = read_indexed_office_config(cwd, &entry).await? else {
            continue;
        };
        if office_thread_id(&config) != Some(thread_id) || !office_has_turn_id(&config, &turn.id) {
            continue;
        }
        let locale = infer_office_locale(&config);
        let details = sync_run_status(&mut config, /*requested_run_id*/ None, turn, locale)?;
        office_memory::apply_update_from_turn(cwd, &mut config, &details, turn).await?;
        apply_office_artifact_file_fingerprints(cwd, &mut config).await?;
        let file_path =
            update_record(DomainKind::Office, cwd, &entry.file_path, config.clone()).await?;
        upsert_run_index(
            cwd,
            OfficeRunIndexEntry {
                run_id: details.run_id,
                thread_id: details.thread_id,
                turn_id: details.turn_id,
                file_path: file_path.clone(),
                status: details.status,
                updated_at: timestamp(),
            },
        )
        .await?;
        updates.push(OfficeRunSyncUpdate { file_path, config });
    }
    Ok(updates)
}

async fn find_index_entry(
    cwd: &str,
    run_id: Option<&str>,
    turn_id: Option<&str>,
    thread_id: Option<&str>,
) -> Result<Option<OfficeRunIndexEntry>, JSONRPCErrorError> {
    Ok(matching_index_entries(cwd, run_id, turn_id, thread_id)
        .await?
        .into_iter()
        .next())
}

async fn matching_index_entries(
    cwd: &str,
    run_id: Option<&str>,
    turn_id: Option<&str>,
    thread_id: Option<&str>,
) -> Result<Vec<OfficeRunIndexEntry>, JSONRPCErrorError> {
    let index = read_run_index(cwd).await?;
    Ok(index
        .runs
        .into_iter()
        .filter(|entry| {
            run_id.is_none_or(|run_id| entry.run_id == run_id)
                && turn_id.is_none_or(|turn_id| entry.turn_id.as_deref() == Some(turn_id))
                && thread_id.is_none_or(|thread_id| entry.thread_id == thread_id)
        })
        .collect())
}

async fn read_indexed_office_config(
    cwd: &str,
    entry: &OfficeRunIndexEntry,
) -> Result<Option<JsonValue>, JSONRPCErrorError> {
    let path = validate_record_file_path(cwd, DomainKind::Office, &entry.file_path)?;
    let metadata = match fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(map_io_error(err)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_params(
            "office run index filePath must reference a regular Office record",
        ));
    }
    let Some(record) = read_record(DomainKind::Office, &path).await? else {
        return Ok(None);
    };
    Ok(Some(record.config))
}

async fn upsert_run_index(cwd: &str, entry: OfficeRunIndexEntry) -> Result<(), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut index = read_run_index(cwd).await?;
    index.version = 1;
    index
        .runs
        .retain(|existing| existing.run_id != entry.run_id);
    index.runs.insert(0, entry);
    index.runs.truncate(1_000);
    write_run_index(cwd, &index).await
}

async fn acquire_run_index_lock(
    cwd: &str,
) -> Result<office_record_lock::OfficeRecordMutationGuard, JSONRPCErrorError> {
    let path = office_run_index_path(cwd)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(map_io_error)?;
    }
    office_record_lock::lock(&path).await.map_err(map_io_error)
}

async fn read_run_index(cwd: &str) -> Result<OfficeRunIndex, JSONRPCErrorError> {
    let path = office_run_index_path(cwd)?;
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(OfficeRunIndex::default()),
        Err(err) => return Err(map_io_error(err)),
    };
    let index = serde_json::from_slice::<OfficeRunIndex>(&bytes).unwrap_or_default();
    if index.version == 1 {
        Ok(index)
    } else {
        Ok(OfficeRunIndex::default())
    }
}

async fn write_run_index(cwd: &str, index: &OfficeRunIndex) -> Result<(), JSONRPCErrorError> {
    let path = office_run_index_path(cwd)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(map_io_error)?;
    }
    let mut bytes = serde_json::to_vec_pretty(index).map_err(|err| {
        crate::error_code::internal_error(format!("failed to serialize office run index: {err}"))
    })?;
    bytes.push(b'\n');
    let temp_path =
        path.with_file_name(format!("{}.tmp-{}", OFFICE_RUN_INDEX_FILE, Uuid::new_v4()));
    fs::write(&temp_path, bytes).await.map_err(map_io_error)?;
    fs::rename(temp_path, path).await.map_err(map_io_error)
}

pub(crate) async fn queue_auto_dispatch_intent(
    cwd: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    reason: &str,
) -> Result<String, JSONRPCErrorError> {
    let source_thread_id = source_thread_id.trim();
    let source_turn_id = source_turn_id.trim();
    if source_thread_id.is_empty() || source_turn_id.is_empty() {
        return Err(invalid_params(
            "scheduler source thread and turn ids must not be empty",
        ));
    }

    let _lock = acquire_run_index_lock(cwd).await?;
    let mut queue = read_scheduler_queue(cwd).await?;
    let now = Utc::now();
    let now_timestamp = timestamp_from_datetime(now);
    if let Some(intent) = queue.intents.iter_mut().find(|intent| {
        intent.source_thread_id == source_thread_id && intent.source_turn_id == source_turn_id
    }) {
        let can_requeue = match intent.status.as_str() {
            OFFICE_SCHEDULER_INTENT_STATUS_FAILED => true,
            OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING => {
                !office_scheduler_intent_has_active_lease(intent, now)
            }
            OFFICE_SCHEDULER_INTENT_STATUS_PENDING | OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHED => {
                false
            }
            _ => false,
        };
        if !can_requeue {
            return Ok(intent.intent_id.clone());
        }
        let intent_id = intent.intent_id.clone();
        intent.status = OFFICE_SCHEDULER_INTENT_STATUS_PENDING.to_string();
        intent.reason = truncate_chars(reason, MAX_PROMPT_TITLE_CHARS);
        intent.updated_at = now_timestamp;
        intent.last_error = None;
        clear_office_scheduler_intent_lease(intent);
        write_scheduler_queue(cwd, &mut queue).await?;
        return Ok(intent_id);
    }
    let intent_id = format!("office-scheduler-{}", Uuid::new_v4());
    queue.intents.insert(
        0,
        OfficeSchedulerIntent {
            intent_id: intent_id.clone(),
            source_thread_id: source_thread_id.to_string(),
            source_turn_id: source_turn_id.to_string(),
            status: OFFICE_SCHEDULER_INTENT_STATUS_PENDING.to_string(),
            reason: truncate_chars(reason, MAX_PROMPT_TITLE_CHARS),
            attempts: 0,
            created_at: now_timestamp.clone(),
            updated_at: now_timestamp,
            last_error: None,
            run_id: None,
            dispatch_kind: None,
            delegation_id: None,
            verification_check_id: None,
            file_path: None,
            dispatched_thread_id: None,
            dispatched_turn_id: None,
            lease_id: None,
            lease_started_at: None,
            lease_expires_at: None,
        },
    );
    write_scheduler_queue(cwd, &mut queue).await?;
    Ok(intent_id)
}

pub(crate) async fn claim_auto_dispatch_intent(
    cwd: &str,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    lease_id: &str,
) -> Result<bool, JSONRPCErrorError> {
    let intent_id = intent_id.trim();
    let source_thread_id = source_thread_id.trim();
    let source_turn_id = source_turn_id.trim();
    let lease_id = lease_id.trim();
    if intent_id.is_empty()
        || source_thread_id.is_empty()
        || source_turn_id.is_empty()
        || lease_id.is_empty()
    {
        return Err(invalid_params(
            "scheduler intent, source, and lease ids must not be empty",
        ));
    }

    let _lock = acquire_run_index_lock(cwd).await?;
    let mut queue = read_scheduler_queue(cwd).await?;
    let now = Utc::now();
    let Some(intent) = queue.intents.iter_mut().find(|intent| {
        intent.intent_id == intent_id
            && intent.source_thread_id == source_thread_id
            && intent.source_turn_id == source_turn_id
    }) else {
        return Ok(false);
    };
    if !office_scheduler_intent_can_claim(intent, now) {
        return Ok(false);
    }

    intent.status = OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING.to_string();
    intent.updated_at = timestamp_from_datetime(now);
    intent.attempts = intent.attempts.saturating_add(1);
    intent.lease_id = Some(lease_id.to_string());
    intent.lease_started_at = Some(timestamp_from_datetime(now));
    intent.lease_expires_at = Some(timestamp_from_datetime(
        now + ChronoDuration::seconds(OFFICE_SCHEDULER_INTENT_LEASE_SECONDS),
    ));
    intent.last_error = None;
    write_scheduler_queue(cwd, &mut queue).await?;
    Ok(true)
}

pub(crate) async fn pending_auto_dispatch_intents(
    cwd: &str,
) -> Result<Vec<OfficeSchedulerIntent>, JSONRPCErrorError> {
    let queue = read_scheduler_queue(cwd).await?;
    let now = Utc::now();
    Ok(queue
        .intents
        .into_iter()
        .filter(|intent| office_scheduler_intent_can_claim(intent, now))
        .take(MAX_OFFICE_SCHEDULER_INTENTS)
        .collect())
}

pub(crate) async fn mark_auto_dispatch_intent_dispatched(
    cwd: &str,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    lease_id: &str,
    dispatched: AutoDispatchIntentDispatched<'_>,
) -> Result<(), JSONRPCErrorError> {
    let intent_id = intent_id.trim();
    let source_thread_id = source_thread_id.trim();
    let source_turn_id = source_turn_id.trim();
    let lease_id = lease_id.trim();
    validate_scheduler_dispatch_lease_params(
        intent_id,
        source_thread_id,
        source_turn_id,
        lease_id,
    )?;

    let _lock = acquire_run_index_lock(cwd).await?;
    let mut queue = read_scheduler_queue(cwd).await?;
    let now = timestamp();
    let intent = scheduler_dispatching_intent_for_lease(
        &mut queue,
        intent_id,
        source_thread_id,
        source_turn_id,
        lease_id,
    )?;
    intent.status = OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHED.to_string();
    intent.updated_at = now;
    intent.run_id = Some(dispatched.run_id.to_string());
    intent.dispatch_kind = Some(dispatched.dispatch_kind.to_string());
    intent.delegation_id = dispatched.delegation_id.map(str::to_string);
    intent.verification_check_id = dispatched.verification_check_id.map(str::to_string);
    intent.file_path = Some(dispatched.file_path.to_string());
    intent.dispatched_thread_id = Some(dispatched.dispatched_thread_id.to_string());
    intent.dispatched_turn_id = Some(dispatched.dispatched_turn_id.to_string());
    intent.last_error = None;
    clear_office_scheduler_intent_lease(intent);
    write_scheduler_queue(cwd, &mut queue).await
}

pub(crate) async fn mark_auto_dispatch_intent_failed(
    cwd: &str,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    lease_id: &str,
    message: &str,
) -> Result<(), JSONRPCErrorError> {
    let intent_id = intent_id.trim();
    let source_thread_id = source_thread_id.trim();
    let source_turn_id = source_turn_id.trim();
    let lease_id = lease_id.trim();
    validate_scheduler_dispatch_lease_params(
        intent_id,
        source_thread_id,
        source_turn_id,
        lease_id,
    )?;

    let _lock = acquire_run_index_lock(cwd).await?;
    let mut queue = read_scheduler_queue(cwd).await?;
    let now = timestamp();
    let intent = scheduler_dispatching_intent_for_lease(
        &mut queue,
        intent_id,
        source_thread_id,
        source_turn_id,
        lease_id,
    )?;
    intent.status = OFFICE_SCHEDULER_INTENT_STATUS_FAILED.to_string();
    intent.updated_at = now;
    intent.last_error = Some(truncate_chars(message, RUN_ERROR_CHARS));
    clear_office_scheduler_intent_lease(intent);
    write_scheduler_queue(cwd, &mut queue).await
}

pub(crate) async fn clear_auto_dispatch_intent(
    cwd: &str,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    lease_id: &str,
) -> Result<(), JSONRPCErrorError> {
    let intent_id = intent_id.trim();
    let source_thread_id = source_thread_id.trim();
    let source_turn_id = source_turn_id.trim();
    let lease_id = lease_id.trim();
    validate_scheduler_dispatch_lease_params(
        intent_id,
        source_thread_id,
        source_turn_id,
        lease_id,
    )?;

    let _lock = acquire_run_index_lock(cwd).await?;
    let mut queue = read_scheduler_queue(cwd).await?;
    let position = scheduler_dispatching_intent_position_for_lease(
        &queue,
        intent_id,
        source_thread_id,
        source_turn_id,
        lease_id,
    )?;
    queue.intents.remove(position);
    write_scheduler_queue(cwd, &mut queue).await
}

fn validate_scheduler_dispatch_lease_params(
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    lease_id: &str,
) -> Result<(), JSONRPCErrorError> {
    if intent_id.is_empty()
        || source_thread_id.is_empty()
        || source_turn_id.is_empty()
        || lease_id.is_empty()
    {
        return Err(invalid_params(
            "scheduler intent, source, and lease ids must not be empty",
        ));
    }
    Ok(())
}

fn scheduler_dispatching_intent_for_lease<'a>(
    queue: &'a mut OfficeSchedulerQueue,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    lease_id: &str,
) -> Result<&'a mut OfficeSchedulerIntent, JSONRPCErrorError> {
    let position = scheduler_dispatching_intent_position_for_lease(
        queue,
        intent_id,
        source_thread_id,
        source_turn_id,
        lease_id,
    )?;
    Ok(&mut queue.intents[position])
}

fn scheduler_dispatching_intent_position_for_lease(
    queue: &OfficeSchedulerQueue,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
    lease_id: &str,
) -> Result<usize, JSONRPCErrorError> {
    let position = queue
        .intents
        .iter()
        .position(|intent| {
            intent.intent_id == intent_id
                && intent.source_thread_id == source_thread_id
                && intent.source_turn_id == source_turn_id
        })
        .ok_or_else(|| invalid_params("scheduler dispatch intent was not found"))?;
    let intent = &queue.intents[position];
    if intent.status != OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING {
        return Err(invalid_params(
            "scheduler dispatch intent is not dispatching",
        ));
    }
    if intent.lease_id.as_deref() != Some(lease_id) {
        return Err(invalid_params("scheduler dispatch lease does not match"));
    }
    Ok(position)
}

fn office_scheduler_intent_can_claim(intent: &OfficeSchedulerIntent, now: DateTime<Utc>) -> bool {
    match intent.status.as_str() {
        OFFICE_SCHEDULER_INTENT_STATUS_PENDING => true,
        OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING => {
            !office_scheduler_intent_has_active_lease(intent, now)
        }
        OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHED | OFFICE_SCHEDULER_INTENT_STATUS_FAILED => false,
        _ => false,
    }
}

fn office_scheduler_intent_has_active_lease(
    intent: &OfficeSchedulerIntent,
    now: DateTime<Utc>,
) -> bool {
    intent
        .lease_expires_at
        .as_deref()
        .and_then(parse_office_scheduler_timestamp)
        .is_some_and(|expires_at| expires_at > now)
}

fn parse_office_scheduler_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn clear_office_scheduler_intent_lease(intent: &mut OfficeSchedulerIntent) {
    intent.lease_id = None;
    intent.lease_started_at = None;
    intent.lease_expires_at = None;
}

fn apply_child_dispatch_lease(object: &mut Map<String, JsonValue>, now: DateTime<Utc>) {
    let lease_uuid = Uuid::new_v4();
    object.insert(
        "dispatchLeaseId".to_string(),
        JsonValue::String(format!("office-child-dispatch-{lease_uuid}")),
    );
    object.insert(
        "dispatchLeaseStartedAt".to_string(),
        JsonValue::String(timestamp_from_datetime(now)),
    );
    object.insert(
        "dispatchLeaseExpiresAt".to_string(),
        JsonValue::String(timestamp_from_datetime(
            now + ChronoDuration::seconds(OFFICE_CHILD_DISPATCH_LEASE_SECONDS),
        )),
    );
}

fn clear_child_dispatch_lease(object: &mut Map<String, JsonValue>) {
    object.remove("dispatchLeaseId");
    object.remove("dispatchLeaseStartedAt");
    object.remove("dispatchLeaseExpiresAt");
}

fn child_dispatch_lease_is_active(expires_at: Option<&str>, now: DateTime<Utc>) -> bool {
    expires_at
        .and_then(parse_office_scheduler_timestamp)
        .is_some_and(|expires_at| expires_at > now)
}

fn value_child_dispatch_lease_is_active(value: &JsonValue, now: DateTime<Utc>) -> bool {
    child_dispatch_lease_is_active(
        value
            .get("dispatchLeaseExpiresAt")
            .and_then(JsonValue::as_str),
        now,
    )
}

pub(crate) struct AutoDispatchIntentDispatched<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) dispatch_kind: &'a str,
    pub(crate) delegation_id: Option<&'a str>,
    pub(crate) verification_check_id: Option<&'a str>,
    pub(crate) file_path: &'a str,
    pub(crate) dispatched_thread_id: &'a str,
    pub(crate) dispatched_turn_id: &'a str,
}

async fn read_scheduler_queue(cwd: &str) -> Result<OfficeSchedulerQueue, JSONRPCErrorError> {
    let path = office_scheduler_path(cwd)?;
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(OfficeSchedulerQueue::default());
        }
        Err(err) => return Err(map_io_error(err)),
    };
    let queue = serde_json::from_slice::<OfficeSchedulerQueue>(&bytes).unwrap_or_default();
    if queue.version == 1 {
        Ok(queue)
    } else {
        Ok(OfficeSchedulerQueue::default())
    }
}

async fn write_scheduler_queue(
    cwd: &str,
    queue: &mut OfficeSchedulerQueue,
) -> Result<(), JSONRPCErrorError> {
    queue.version = 1;
    queue.intents.truncate(MAX_OFFICE_SCHEDULER_INTENTS);
    let path = office_scheduler_path(cwd)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(map_io_error)?;
    }
    let mut bytes = serde_json::to_vec_pretty(queue).map_err(|err| {
        crate::error_code::internal_error(format!(
            "failed to serialize office scheduler queue: {err}"
        ))
    })?;
    bytes.push(b'\n');
    let temp_path =
        path.with_file_name(format!("{}.tmp-{}", OFFICE_SCHEDULER_FILE, Uuid::new_v4()));
    fs::write(&temp_path, bytes).await.map_err(map_io_error)?;
    fs::rename(temp_path, path).await.map_err(map_io_error)
}

fn office_run_index_path(cwd: &str) -> Result<std::path::PathBuf, JSONRPCErrorError> {
    let office_directory = domain_directory(cwd, DomainKind::Office)?;
    let Some(base_directory) = office_directory.parent() else {
        return Err(crate::error_code::internal_error(
            "failed to resolve office run index directory",
        ));
    };
    Ok(base_directory
        .join(OFFICE_RUN_INDEX_DIRECTORY)
        .join(OFFICE_RUN_INDEX_FILE))
}

fn office_scheduler_path(cwd: &str) -> Result<std::path::PathBuf, JSONRPCErrorError> {
    let office_directory = domain_directory(cwd, DomainKind::Office)?;
    let Some(base_directory) = office_directory.parent() else {
        return Err(crate::error_code::internal_error(
            "failed to resolve office scheduler directory",
        ));
    };
    Ok(base_directory
        .join(OFFICE_RUN_INDEX_DIRECTORY)
        .join(OFFICE_SCHEDULER_FILE))
}

fn resolve_run_thread_id(
    config: &JsonValue,
    requested_thread_id: Option<&str>,
) -> Result<String, JSONRPCErrorError> {
    let requested_thread_id = requested_thread_id.map(str::trim);
    if requested_thread_id == Some("") {
        return Err(invalid_params("threadId must not be empty"));
    }

    let config_thread_id = office_thread_id(config)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty());
    match (requested_thread_id, config_thread_id) {
        (Some(requested_thread_id), Some(config_thread_id))
            if requested_thread_id != config_thread_id =>
        {
            Err(invalid_params(
                "threadId must match office workspace.threadId",
            ))
        }
        (Some(thread_id), _) | (None, Some(thread_id)) => Ok(thread_id.to_string()),
        (None, None) => Err(invalid_params(
            "office workspace must be bound to a threadId before it can run",
        )),
    }
}

fn append_queued_run(
    config: &mut JsonValue,
    params: AppendQueuedRunParams<'_>,
) -> Result<(), JSONRPCErrorError> {
    let AppendQueuedRunParams {
        message,
        message_mode,
        text,
        locale,
        thread_id,
        run_id,
        retry_of,
        loop_iteration,
        loop_max_iterations,
        memory_refs,
    } = params;
    let now_time = Utc::now();
    let now = timestamp_from_datetime(now_time);
    let display_time = now_time.format("%H:%M").to_string();
    let is_zh = locale != Some("en");
    let title = run_title(text);
    let goal = config
        .get("workspace")
        .and_then(|workspace| workspace.get("goal"))
        .and_then(JsonValue::as_str)
        .map(|goal| truncate_chars(goal, MAX_PROMPT_FIELD_CHARS))
        .unwrap_or_default();
    let delegation_routes = delegation_routes(config);
    let workspace = workspace_object_mut(config)?;
    workspace.insert(
        "threadId".to_string(),
        JsonValue::String(thread_id.to_string()),
    );

    if matches!(message_mode, RunMessageMode::Direct) {
        array_entry(workspace, "messages", "workspace.messages must be an array")?.push(message);
    }
    array_entry(workspace, "messages", "workspace.messages must be an array")?.push(json!({
        "author": if is_zh { "办公室" } else { "Office" },
        "glyph": "@",
        "accent": "slate",
        "time": display_time,
        "text": if is_zh {
            format!("已启动团队执行：{title}")
        } else {
            format!("Started team run: {title}")
        },
        "kind": "system"
    }));
    array_entry(workspace, "tasks", "workspace.tasks must be an array")?.insert(
        0,
        json!({
            "title": title,
            "owner": if is_zh { "团队" } else { "Team" },
            "status": "doing",
            "runId": run_id
        }),
    );

    let activity = workspace
        .entry("activity")
        .or_insert_with(|| json!({ "approvals": [], "artifacts": [], "runs": [] }));
    let Some(activity) = activity.as_object_mut() else {
        return Err(invalid_params("workspace.activity must be an object"));
    };
    activity
        .entry("approvals")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    activity
        .entry("artifacts")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    let mut run = json!({
        "id": run_id,
        "title": title,
        "status": "queued",
        "threadId": thread_id,
        "createdAt": now,
        "updatedAt": now,
        "requestText": truncate_chars(text, MAX_PROMPT_TEXT_CHARS),
        "promptPreview": truncate_chars(text, MAX_PROMPT_FIELD_CHARS),
        "goal": goal,
        "locale": locale.unwrap_or("zh"),
        "loop": {
            "mode": "officeLoopEngineering",
            "iteration": loop_iteration,
            "maxIterations": loop_max_iterations,
            "cycle": ["frame", "plan", "delegate", "act", "observe", "verify", "summarize"],
            "memoryPolicy": "boundedRetrieval"
        }
    });
    if let RunMessageMode::Submitted {
        client_user_message_id,
        dispatch_receipt_id,
    } = message_mode
    {
        run["clientUserMessageId"] = JsonValue::String(client_user_message_id.clone());
        run["dispatchReceiptId"] = JsonValue::String(dispatch_receipt_id.clone());
    }
    if let Some(retry_of) = retry_of {
        run["retryOf"] = JsonValue::String(retry_of.to_string());
    }
    if let Some(memory_refs) = memory_refs {
        run["memoryRefs"] = memory_refs;
    }
    if !delegation_routes.is_empty() {
        run["delegationRoutes"] = JsonValue::Array(delegation_routes);
    }
    let Some(run_object) = run.as_object_mut() else {
        return Err(invalid_params("office run must be an object"));
    };
    apply_child_dispatch_lease(run_object, now_time);
    refresh_run_loop_review(run_object);
    array_entry(activity, "runs", "workspace.activity.runs must be an array")?.insert(0, run);

    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    Ok(())
}

fn append_queued_delegation(
    config: &mut JsonValue,
    params: AppendQueuedDelegationParams<'_>,
) -> Result<QueuedOfficeDelegation, JSONRPCErrorError> {
    let AppendQueuedDelegationParams {
        run_id,
        new_delegation_id,
        member,
        agent_id,
        task,
        route,
        memory_refs,
    } = params;
    let now = Utc::now();
    let now_timestamp = timestamp_from_datetime(now);
    let workspace = workspace_object_mut(config)?;
    let runs = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = find_run_mut(runs, Some(run_id), "") else {
        return Err(invalid_params("runId was not found"));
    };
    let Some(run_object) = run.as_object_mut() else {
        return Err(invalid_params("office run must be an object"));
    };
    let delegations = run_object
        .entry("delegations".to_string())
        .or_insert_with(|| JsonValue::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| invalid_params("run.delegations must be an array"))?;
    if let Some(existing) = delegations
        .iter_mut()
        .find(|delegation| delegation_matches_dispatch(delegation, member, agent_id, task))
    {
        if delegation_has_started_dispatch(existing) {
            return Err(invalid_params(
                "office delegation has already been dispatched",
            ));
        }
        let delegation_id = queued_delegation_id(existing, new_delegation_id);
        set_queued_delegation_fields(
            existing,
            QueuedDelegationFields {
                delegation_id: &delegation_id,
                member,
                agent_id,
                task,
                route,
                memory_refs,
                now,
            },
        )?;

        let Some(config_object) = config.as_object_mut() else {
            return Err(invalid_params("office config must be an object"));
        };
        config_object.insert("updatedAt".to_string(), JsonValue::String(timestamp()));
        return Ok(QueuedOfficeDelegation { delegation_id });
    }
    let mut delegation = json!({
        "id": new_delegation_id,
        "member": truncate_chars(member, MAX_PROMPT_TITLE_CHARS),
        "agentId": truncate_chars(agent_id, MAX_PROMPT_FIELD_CHARS),
        "task": truncate_chars(task, MAX_PROMPT_TEXT_CHARS),
        "status": "queued",
        "createdAt": now_timestamp,
        "updatedAt": now_timestamp,
        "dispatchMethod": "turnStart"
    });
    if let Some(delegation_object) = delegation.as_object_mut() {
        apply_child_dispatch_lease(delegation_object, now);
    }
    for key in [
        "threadId",
        "target",
        "targetKind",
        "tool",
        "contextPolicy",
        "memoryScope",
        "agentProfile",
    ] {
        copy_route_string_if_missing(route, &mut delegation, key);
    }
    if let Some(memory_refs) = memory_refs {
        delegation["memoryRefs"] = memory_refs;
    }
    delegations.insert(0, delegation);

    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(timestamp()));
    Ok(QueuedOfficeDelegation {
        delegation_id: new_delegation_id.to_string(),
    })
}

fn append_retry_delegation(
    config: &mut JsonValue,
    params: AppendRetryDelegationParams<'_>,
) -> Result<(), JSONRPCErrorError> {
    let AppendRetryDelegationParams {
        run_id,
        new_delegation_id,
        retry_of_delegation_id,
        member,
        agent_id,
        task,
        route,
        memory_refs,
    } = params;
    let now = timestamp();
    let workspace = workspace_object_mut(config)?;
    let runs = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = find_run_mut(runs, Some(run_id), "") else {
        return Err(invalid_params("runId was not found"));
    };
    let Some(run_object) = run.as_object_mut() else {
        return Err(invalid_params("office run must be an object"));
    };
    let delegations = run_object
        .entry("delegations".to_string())
        .or_insert_with(|| JsonValue::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| invalid_params("run.delegations must be an array"))?;
    let mut delegation = json!({
        "id": new_delegation_id,
        "retryOf": retry_of_delegation_id,
        "member": truncate_chars(member, MAX_PROMPT_TITLE_CHARS),
        "agentId": truncate_chars(agent_id, MAX_PROMPT_FIELD_CHARS),
        "task": truncate_chars(task, MAX_PROMPT_TEXT_CHARS),
        "status": "queued",
        "createdAt": now,
        "updatedAt": now,
        "dispatchMethod": "turnStart"
    });
    for key in [
        "threadId",
        "target",
        "targetKind",
        "tool",
        "contextPolicy",
        "memoryScope",
        "agentProfile",
    ] {
        copy_route_string_if_missing(route, &mut delegation, key);
    }
    if let Some(memory_refs) = memory_refs {
        delegation["memoryRefs"] = memory_refs;
    }
    delegations.insert(0, delegation);
    run_object.insert("updatedAt".to_string(), JsonValue::String(timestamp()));
    refresh_run_loop_review(run_object);

    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(timestamp()));
    Ok(())
}

fn retryable_source_delegation(
    config: &JsonValue,
    run_id: &str,
    delegation_id: &str,
) -> Result<JsonValue, JSONRPCErrorError> {
    let run = run_by_id(config, run_id).ok_or_else(|| invalid_params("runId was not found"))?;
    let delegations = run
        .get("delegations")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid_params("run.delegations must be an array"))?;
    let Some(delegation) = delegations
        .iter()
        .find(|delegation| delegation.get("id").and_then(JsonValue::as_str) == Some(delegation_id))
    else {
        return Err(invalid_params("delegationId was not found"));
    };
    if !delegation_status_allows_retry(delegation.get("status").and_then(JsonValue::as_str)) {
        return Err(invalid_params("office delegation cannot be retried"));
    }
    Ok(delegation.clone())
}

fn active_retry_delegation_exists(config: &JsonValue, run_id: &str, retry_of: &str) -> bool {
    run_by_id(config, run_id)
        .and_then(|run| run.get("delegations"))
        .and_then(JsonValue::as_array)
        .is_some_and(|delegations| {
            delegations.iter().any(|delegation| {
                delegation.get("retryOf").and_then(JsonValue::as_str) == Some(retry_of)
                    && match delegation.get("status").and_then(JsonValue::as_str) {
                        Some("queued") => delegation_has_started_dispatch(delegation),
                        Some("running" | "canceling") => true,
                        _ => false,
                    }
            })
        })
}

fn delegation_status_allows_retry(status: Option<&str>) -> bool {
    matches!(status.map(str::trim), Some("failed" | "interrupted"))
}

fn delegation_retry_prompt_task(
    source_delegation: &JsonValue,
    task: &str,
    locale: Option<&str>,
) -> String {
    let is_zh = locale != Some("en");
    let status = source_delegation
        .get("status")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .unwrap_or("unknown");
    let turn_id = source_delegation
        .get("turnId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|turn_id| !turn_id.is_empty());
    let error = source_delegation
        .get("error")
        .and_then(JsonValue::as_str)
        .map(|error| truncate_chars(error, RUN_ERROR_CHARS))
        .filter(|error| !error.is_empty());
    let result_preview = source_delegation
        .get("resultPreview")
        .and_then(JsonValue::as_str)
        .map(|result_preview| truncate_chars(result_preview, RUN_RESULT_PREVIEW_CHARS))
        .filter(|result_preview| !result_preview.is_empty());

    if is_zh {
        let mut prompt = format!(
            "重试这个已委派的成员任务。\n\n原始任务：{}\n上一次状态：{}",
            truncate_chars(task, MAX_PROMPT_TEXT_CHARS),
            truncate_chars(status, MAX_PROMPT_FIELD_CHARS)
        );
        if let Some(turn_id) = turn_id {
            prompt.push_str(&format!(
                "\n上一次 turnId：{}",
                truncate_chars(turn_id, MAX_PROMPT_FIELD_CHARS)
            ));
        }
        if let Some(error) = error {
            prompt.push_str(&format!("\n上一次错误：{error}"));
        }
        if let Some(result_preview) = result_preview {
            prompt.push_str(&format!("\n上一次结果摘要：{result_preview}"));
        }
        prompt.push_str("\n\n重试要求：不要机械重复失败步骤；先重新确认验收标准，基于已有失败证据修正方案，然后执行、观察证据、验证结果，并总结本次 retry 的结论。");
        prompt
    } else {
        let mut prompt = format!(
            "Retry this delegated member task.\n\nOriginal task: {}\nPrevious status: {}",
            truncate_chars(task, MAX_PROMPT_TEXT_CHARS),
            truncate_chars(status, MAX_PROMPT_FIELD_CHARS)
        );
        if let Some(turn_id) = turn_id {
            prompt.push_str(&format!(
                "\nPrevious turnId: {}",
                truncate_chars(turn_id, MAX_PROMPT_FIELD_CHARS)
            ));
        }
        if let Some(error) = error {
            prompt.push_str(&format!("\nPrevious error: {error}"));
        }
        if let Some(result_preview) = result_preview {
            prompt.push_str(&format!("\nPrevious result summary: {result_preview}"));
        }
        prompt.push_str("\n\nRetry instructions: do not mechanically repeat failed steps; restate the acceptance criteria, correct the approach using the previous evidence, act, observe evidence, verify, and summarize this retry result.");
        prompt
    }
}

fn delegation_matches_dispatch(
    delegation: &JsonValue,
    member: &str,
    agent_id: &str,
    task: &str,
) -> bool {
    let matches_member = delegation
        .get("member")
        .and_then(JsonValue::as_str)
        .is_some_and(|value| value.trim() == member);
    let matches_agent = delegation
        .get("agentId")
        .and_then(JsonValue::as_str)
        .is_some_and(|value| value.trim() == agent_id);
    let matches_task = delegation
        .get("task")
        .and_then(JsonValue::as_str)
        .is_some_and(|value| value.trim() == task);
    matches_task && (matches_member || matches_agent)
}

fn next_dispatchable_delegation(
    config: &JsonValue,
    run_id: &str,
    dispatch_policy: DelegationDispatchPolicy,
) -> Option<NextDispatchableDelegation> {
    let routes = delegation_routes(config);
    let run = run_by_id(config, run_id)?;
    let delegations = run.get("delegations").and_then(JsonValue::as_array)?;
    delegations.iter().find_map(|delegation| {
        if delegation_has_started_dispatch(delegation) {
            return None;
        }
        if dispatch_policy == DelegationDispatchPolicy::Auto
            && delegation_requires_manual_dispatch(delegation)
        {
            return None;
        }
        let status = delegation
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        if matches!(status, "blocked" | "done" | "skipped") {
            return None;
        }
        let task = delegation
            .get("task")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|task| !task.is_empty())?;
        let member = delegation
            .get("member")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|member| !member.is_empty());
        let agent_id = delegation
            .get("agentId")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|agent_id| !agent_id.is_empty());
        if member.is_none() && agent_id.is_none() {
            return None;
        }
        if find_delegation_route(&routes, member, agent_id).is_err() {
            return None;
        }
        Some(NextDispatchableDelegation {
            task: task.to_string(),
            member: member.map(str::to_string),
            agent_id: agent_id.map(str::to_string),
        })
    })
}

fn delegation_dispatch_policy(
    value: Option<&str>,
) -> Result<DelegationDispatchPolicy, JSONRPCErrorError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("interactive") => Ok(DelegationDispatchPolicy::Interactive),
        Some("auto") | Some("automatic") => Ok(DelegationDispatchPolicy::Auto),
        Some(_) => Err(invalid_params("dispatchPolicy must be interactive or auto")),
    }
}

fn delegation_requires_manual_dispatch(delegation: &JsonValue) -> bool {
    if json_boolish(
        delegation,
        &["approvalRequired", "requiresApproval", "manualDispatch"],
    ) {
        return true;
    }
    if delegation
        .get("approvalId")
        .and_then(JsonValue::as_str)
        .is_some_and(|approval_id| !approval_id.trim().is_empty())
    {
        return true;
    }
    if delegation
        .get("dispatchMode")
        .or_else(|| delegation.get("dispatchPolicy"))
        .and_then(JsonValue::as_str)
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
        .and_then(JsonValue::as_str)
        .is_some_and(|value| risk_severity(value) == "high")
}

fn json_boolish(value: &JsonValue, keys: &[&str]) -> bool {
    keys.iter().any(|key| match value.get(*key) {
        Some(JsonValue::Bool(value)) => *value,
        Some(JsonValue::String(value)) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "yes" | "required" | "manual"
        ),
        _ => false,
    })
}

fn delegation_has_started_dispatch(delegation: &JsonValue) -> bool {
    if delegation.get("dispatchReceipt").is_some() {
        return true;
    }
    if delegation
        .get("turnId")
        .and_then(JsonValue::as_str)
        .is_some_and(|turn_id| !turn_id.trim().is_empty())
    {
        return true;
    }
    let status = delegation.get("status").and_then(JsonValue::as_str);
    if status == Some("queued") {
        return value_child_dispatch_lease_is_active(delegation, Utc::now());
    }
    if delegation.get("dispatchMethod").and_then(JsonValue::as_str) == Some("turnStart")
        && !matches!(status, Some("failed" | "interrupted"))
    {
        return true;
    }
    matches!(status, Some("running" | "completed" | "done" | "canceling"))
}

fn queued_delegation_id(delegation: &JsonValue, new_delegation_id: &str) -> String {
    delegation
        .get("id")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(new_delegation_id)
        .to_string()
}

fn set_queued_delegation_fields(
    delegation: &mut JsonValue,
    fields: QueuedDelegationFields<'_>,
) -> Result<(), JSONRPCErrorError> {
    let QueuedDelegationFields {
        delegation_id,
        member,
        agent_id,
        task,
        route,
        memory_refs,
        now,
    } = fields;
    let now_timestamp = timestamp_from_datetime(now);
    let Some(delegation_object) = delegation.as_object_mut() else {
        return Err(invalid_params("run delegation must be an object"));
    };
    delegation_object.insert(
        "id".to_string(),
        JsonValue::String(delegation_id.to_string()),
    );
    delegation_object.insert(
        "member".to_string(),
        JsonValue::String(truncate_chars(member, MAX_PROMPT_TITLE_CHARS)),
    );
    delegation_object.insert(
        "agentId".to_string(),
        JsonValue::String(truncate_chars(agent_id, MAX_PROMPT_FIELD_CHARS)),
    );
    delegation_object.insert(
        "task".to_string(),
        JsonValue::String(truncate_chars(task, MAX_PROMPT_TEXT_CHARS)),
    );
    delegation_object.insert(
        "status".to_string(),
        JsonValue::String("queued".to_string()),
    );
    delegation_object
        .entry("createdAt".to_string())
        .or_insert_with(|| JsonValue::String(now_timestamp.clone()));
    delegation_object.insert("updatedAt".to_string(), JsonValue::String(now_timestamp));
    delegation_object.insert(
        "dispatchMethod".to_string(),
        JsonValue::String("turnStart".to_string()),
    );
    apply_child_dispatch_lease(delegation_object, now);
    delegation_object.remove("error");
    delegation_object.remove("resultPreview");
    delegation_object.remove("completedAt");

    for key in [
        "threadId",
        "target",
        "targetKind",
        "tool",
        "contextPolicy",
        "memoryScope",
        "agentProfile",
    ] {
        copy_route_string_if_missing(route, delegation, key);
    }
    if let Some(memory_refs) = memory_refs {
        delegation["memoryRefs"] = memory_refs;
    }
    Ok(())
}

fn update_delegation_status(
    config: &mut JsonValue,
    run_id: &str,
    delegation_id: &str,
    status: &str,
    turn_id: Option<&str>,
    error: Option<&str>,
) -> Result<(), JSONRPCErrorError> {
    let now = timestamp();
    let workspace = workspace_object_mut(config)?;
    let runs = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = find_run_mut(runs, Some(run_id), "") else {
        return Err(invalid_params("runId was not found"));
    };
    let Some(delegations) = run.get_mut("delegations").and_then(JsonValue::as_array_mut) else {
        return Err(invalid_params("run.delegations must be an array"));
    };
    let Some(delegation) = delegations
        .iter_mut()
        .find(|delegation| delegation.get("id").and_then(JsonValue::as_str) == Some(delegation_id))
    else {
        return Err(invalid_params("delegationId was not found"));
    };
    let Some(delegation_object) = delegation.as_object_mut() else {
        return Err(invalid_params("run delegation must be an object"));
    };
    delegation_object.insert("status".to_string(), JsonValue::String(status.to_string()));
    delegation_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
    if status != "queued" {
        clear_child_dispatch_lease(delegation_object);
    }
    if let Some(turn_id) = turn_id {
        delegation_object.insert("turnId".to_string(), JsonValue::String(turn_id.to_string()));
    }
    if let Some(error) = error {
        delegation_object.insert(
            "error".to_string(),
            JsonValue::String(truncate_chars(error, RUN_ERROR_CHARS)),
        );
    } else {
        delegation_object.remove("error");
    }

    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    Ok(())
}

async fn sync_delegation_turn_status(
    cwd: &str,
    config: &mut JsonValue,
    thread_id: &str,
    turn: &Turn,
    locale: Option<&str>,
) -> Result<usize, JSONRPCErrorError> {
    if turn.id.trim().is_empty() {
        return Err(invalid_params("turn.id must not be empty"));
    }

    let now = timestamp();
    let completed_at = turn
        .completed_at
        .and_then(unix_seconds_timestamp)
        .unwrap_or_else(|| now.clone());
    let result_preview = last_agent_message(turn);
    let office_update = office_update_from_turn(turn);
    let effective_result_preview = office_update
        .as_ref()
        .and_then(|update| update_string(update, &["summary", "resultPreview", "result_preview"]))
        .or_else(|| result_preview.clone());
    let turn_error = turn_error_message(turn);
    let (delegation_status, task_status) = delegation_and_task_status(&turn.status);
    let terminal = turn_status_is_terminal(&turn.status);
    let mut synced_delegations = Vec::new();
    let mut synced_run_ids = Vec::new();

    {
        let workspace = workspace_object_mut(config)?;
        let runs = workspace
            .get_mut("activity")
            .and_then(JsonValue::as_object_mut)
            .and_then(|activity| activity.get_mut("runs"))
            .and_then(JsonValue::as_array_mut)
            .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
        for run in runs.iter_mut() {
            let run_id = run
                .get("id")
                .and_then(JsonValue::as_str)
                .unwrap_or(&turn.id)
                .to_string();
            let Some(delegations) = run.get_mut("delegations").and_then(JsonValue::as_array_mut)
            else {
                continue;
            };
            for delegation in delegations.iter_mut() {
                if !delegation_matches_turn(delegation, thread_id, &turn.id) {
                    continue;
                }
                let Some(delegation_object) = delegation.as_object_mut() else {
                    return Err(invalid_params("run delegation must be an object"));
                };
                let delegation_id = delegation_object
                    .get("id")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("office-delegation-{}", Uuid::new_v4()));
                delegation_object
                    .entry("id".to_string())
                    .or_insert_with(|| JsonValue::String(delegation_id.clone()));
                delegation_object.insert(
                    "status".to_string(),
                    JsonValue::String(delegation_status.to_string()),
                );
                delegation_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
                clear_child_dispatch_lease(delegation_object);
                delegation_object.insert(
                    "threadId".to_string(),
                    JsonValue::String(thread_id.to_string()),
                );
                if terminal {
                    delegation_object.insert(
                        "completedAt".to_string(),
                        JsonValue::String(completed_at.clone()),
                    );
                }
                if let Some(result_preview) = effective_result_preview.as_ref() {
                    delegation_object.insert(
                        "resultPreview".to_string(),
                        JsonValue::String(result_preview.clone()),
                    );
                }
                if let Some(turn_error) = turn_error.as_ref() {
                    delegation_object
                        .insert("error".to_string(), JsonValue::String(turn_error.clone()));
                } else if matches!(turn.status, TurnStatus::Completed) {
                    delegation_object.remove("error");
                }
                let member = delegation_object
                    .get("member")
                    .and_then(JsonValue::as_str)
                    .map(|member| truncate_chars(member, MAX_PROMPT_TITLE_CHARS))
                    .unwrap_or_else(|| "Agent".to_string());
                let agent_id = delegation_object
                    .get("agentId")
                    .and_then(JsonValue::as_str)
                    .map(|agent_id| truncate_chars(agent_id, MAX_PROMPT_FIELD_CHARS));
                let task = delegation_object
                    .get("task")
                    .and_then(JsonValue::as_str)
                    .map(|task| truncate_chars(task, MAX_PROMPT_FIELD_CHARS))
                    .unwrap_or_else(|| "Delegated task".to_string());
                if !synced_run_ids.contains(&run_id) {
                    synced_run_ids.push(run_id.clone());
                }
                synced_delegations.push(SyncedOfficeDelegation {
                    run_id: run_id.clone(),
                    delegation_id,
                    member,
                    agent_id,
                    task,
                    result_preview: effective_result_preview.clone(),
                    error: turn_error.clone(),
                });
            }
        }
    }

    if synced_delegations.is_empty() {
        return Ok(0);
    }

    let workspace = workspace_object_mut(config)?;
    for run_id in &synced_run_ids {
        let delegation = synced_delegations
            .iter()
            .find(|delegation| delegation.run_id == *run_id);
        let source = OfficeSignalSource {
            source_type: "memberDelegation",
            thread_id,
            turn_id: &turn.id,
            observed_at: &now,
            delegation,
        };
        if let Some(office_update) = office_update.as_ref() {
            apply_member_structured_office_update(workspace, run_id, office_update, &source)?;
        }
        apply_turn_tool_evidence(workspace, run_id, turn, &source)?;
    }
    for delegation in &synced_delegations {
        upsert_named_task(
            workspace,
            &delegation.run_id,
            &delegation.task,
            &delegation.member,
            task_status,
        )?;
        if terminal {
            append_delegation_sync_message(
                workspace,
                delegation,
                &turn.status,
                locale != Some("en"),
            )?;
        }
    }
    for run_id in &synced_run_ids {
        let details = OfficeRunSyncDetails {
            run_id: run_id.clone(),
            thread_id: thread_id.to_string(),
            turn_id: Some(turn.id.clone()),
            status: delegation_status.to_string(),
        };
        office_memory::apply_update_from_turn(cwd, config, &details, turn).await?;
    }
    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    Ok(synced_delegations.len())
}

fn sync_verification_turn_status(
    config: &mut JsonValue,
    thread_id: &str,
    turn: &Turn,
) -> Result<usize, JSONRPCErrorError> {
    if turn.id.trim().is_empty() {
        return Err(invalid_params("turn.id must not be empty"));
    }

    let now = timestamp();
    let completed_at = turn
        .completed_at
        .and_then(unix_seconds_timestamp)
        .unwrap_or_else(|| now.clone());
    let office_update = office_update_from_turn(turn);
    let result_preview = office_update
        .as_ref()
        .and_then(|update| update_string(update, &["summary", "resultPreview", "result_preview"]))
        .or_else(|| last_agent_message(turn))
        .map(|preview| truncate_chars(&preview, RUN_RESULT_PREVIEW_CHARS));
    let terminal = turn_status_is_terminal(&turn.status);
    let turn_error = turn_error_message(turn);
    let mut synced_count = 0usize;

    {
        let workspace = workspace_object_mut(config)?;
        let runs = workspace
            .get_mut("activity")
            .and_then(JsonValue::as_object_mut)
            .and_then(|activity| activity.get_mut("runs"))
            .and_then(JsonValue::as_array_mut)
            .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
        for run in runs.iter_mut() {
            let Some(run_object) = run.as_object_mut() else {
                return Err(invalid_params("office run must be an object"));
            };
            let run_id = run_object
                .get("id")
                .and_then(JsonValue::as_str)
                .unwrap_or(&turn.id)
                .to_string();
            let mut evidence_items = Vec::new();
            let Some(checks) = run_object
                .get_mut("verificationChecks")
                .and_then(JsonValue::as_array_mut)
            else {
                continue;
            };
            for check in checks.iter_mut() {
                if !verification_check_matches_automation_turn(check, thread_id, &turn.id) {
                    continue;
                }
                let structured_result = office_update
                    .as_ref()
                    .and_then(|update| automation_verification_result_from_update(update, check));
                let Some(check_object) = check.as_object_mut() else {
                    return Err(invalid_params("verification check must be an object"));
                };
                let status = structured_result
                    .as_ref()
                    .map(|result| result.status)
                    .unwrap_or_else(|| verification_status_from_turn_status(&turn.status));
                let evidence = structured_result
                    .as_ref()
                    .and_then(|result| result.evidence.clone())
                    .or_else(|| result_preview.clone())
                    .or_else(|| turn_error.clone())
                    .unwrap_or_else(|| "Automation verification completed".to_string());
                let dispatch_status = match status {
                    "passed" => "completed",
                    "failed" => "failed",
                    _ => "running",
                };
                check_object.insert("status".to_string(), JsonValue::String(status.to_string()));
                check_object.insert(
                    "dispatchStatus".to_string(),
                    JsonValue::String(dispatch_status.to_string()),
                );
                check_object.insert(
                    "automationStatus".to_string(),
                    JsonValue::String(turn_status_name(&turn.status).to_string()),
                );
                check_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
                clear_child_dispatch_lease(check_object);
                check_object.insert(
                    "sourceType".to_string(),
                    JsonValue::String("automationRun".to_string()),
                );
                check_object.insert(
                    "sourceThreadId".to_string(),
                    JsonValue::String(thread_id.to_string()),
                );
                check_object.insert(
                    "sourceTurnId".to_string(),
                    JsonValue::String(turn.id.clone()),
                );
                check_object.insert("observedAt".to_string(), JsonValue::String(now.clone()));
                check_object.insert("evidence".to_string(), JsonValue::String(evidence.clone()));
                if terminal {
                    check_object.insert(
                        "completedAt".to_string(),
                        JsonValue::String(completed_at.clone()),
                    );
                }
                if status == "failed" {
                    if let Some(turn_error) = turn_error.as_ref() {
                        check_object
                            .insert("error".to_string(), JsonValue::String(turn_error.clone()));
                    } else if structured_result
                        .as_ref()
                        .and_then(|result| result.evidence.as_ref())
                        .is_some()
                    {
                        check_object
                            .insert("error".to_string(), JsonValue::String(evidence.clone()));
                    }
                } else {
                    check_object.remove("error");
                }
                evidence_items.push(automation_verification_evidence_item(
                    check_object,
                    status,
                    &evidence,
                    thread_id,
                    &turn.id,
                    &now,
                ));
                synced_count += 1;
            }
            if !evidence_items.is_empty() {
                merge_run_items(run_object, "evidence", JsonValue::Array(evidence_items));
                apply_verification_checks_to_acceptance_criteria(run_object);
                refresh_run_loop_review(run_object);
                run_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
                if let Some(result_preview) = result_preview.as_ref() {
                    run_object.insert(
                        "resultPreview".to_string(),
                        JsonValue::String(result_preview.clone()),
                    );
                }
                if !run_id.is_empty() {
                    run_object
                        .entry("id".to_string())
                        .or_insert_with(|| JsonValue::String(run_id));
                }
            }
        }
    }

    if synced_count > 0 {
        let Some(config_object) = config.as_object_mut() else {
            return Err(invalid_params("office config must be an object"));
        };
        config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    }
    Ok(synced_count)
}

fn sync_run_status(
    config: &mut JsonValue,
    requested_run_id: Option<&str>,
    turn: &Turn,
    locale: Option<&str>,
) -> Result<OfficeRunSyncDetails, JSONRPCErrorError> {
    if turn.id.trim().is_empty() {
        return Err(invalid_params("turn.id must not be empty"));
    }
    let requested_run_id = match requested_run_id.map(str::trim) {
        Some("") => return Err(invalid_params("runId must not be empty")),
        run_id => run_id,
    };

    let now = timestamp();
    let completed_at = turn
        .completed_at
        .and_then(unix_seconds_timestamp)
        .unwrap_or_else(|| now.clone());
    let result_preview = last_agent_message(turn);
    let office_update = office_update_from_turn(turn);
    let effective_result_preview = office_update
        .as_ref()
        .and_then(|update| update_string(update, &["summary", "resultPreview", "result_preview"]))
        .or_else(|| result_preview.clone());
    let turn_error = turn_error_message(turn);
    let (run_status, task_status) = run_and_task_status(&turn.status);
    let terminal = turn_status_is_terminal(&turn.status);
    let plan = plan_update_from_turn(turn).or_else(|| office_update.as_ref().and_then(update_plan));
    let delegation_routes = delegation_routes(config);
    let delegations = office_update
        .as_ref()
        .and_then(|update| update_delegations(update, &delegation_routes))
        .or_else(|| delegation_update_from_turn(turn));
    let config_thread_id = office_thread_id(config).map(str::to_string);

    let (actual_run_id, title, thread_id, turn_id, status) = {
        let workspace = workspace_object_mut(config)?;
        let runs = workspace
            .get_mut("activity")
            .and_then(JsonValue::as_object_mut)
            .and_then(|activity| activity.get_mut("runs"))
            .and_then(JsonValue::as_array_mut)
            .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
        let Some(run) = find_run_mut(runs, requested_run_id, &turn.id) else {
            return Err(invalid_params("runId or turn.id was not found"));
        };
        let Some(run_object) = run.as_object_mut() else {
            return Err(invalid_params("office run must be an object"));
        };
        if let Some(existing_turn_id) = run_object.get("turnId").and_then(JsonValue::as_str)
            && existing_turn_id != turn.id
        {
            return Err(invalid_params("turn.id must match office run turnId"));
        }

        let actual_run_id = run_object
            .get("id")
            .and_then(JsonValue::as_str)
            .unwrap_or(&turn.id)
            .to_string();
        let title = run_object
            .get("title")
            .and_then(JsonValue::as_str)
            .map(|title| truncate_chars(title, MAX_PROMPT_TITLE_CHARS))
            .unwrap_or_else(|| "Office run".to_string());
        let thread_id = run_object
            .get("threadId")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .or_else(|| config_thread_id.clone())
            .unwrap_or_default();
        run_object.insert("turnId".to_string(), JsonValue::String(turn.id.clone()));
        run_object.insert(
            "status".to_string(),
            JsonValue::String(run_status.to_string()),
        );
        run_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
        clear_child_dispatch_lease(run_object);
        if terminal {
            run_object.insert("completedAt".to_string(), JsonValue::String(completed_at));
        }
        if let Some(result_preview) = effective_result_preview.as_ref() {
            run_object.insert(
                "resultPreview".to_string(),
                JsonValue::String(result_preview.clone()),
            );
        }
        if let Some(plan) = plan.as_ref() {
            run_object.insert("plan".to_string(), plan.clone());
        }
        if let Some(delegations) = delegations.as_ref() {
            run_object.insert("delegations".to_string(), delegations.clone());
        }
        if let Some(turn_error) = turn_error.as_ref() {
            run_object.insert("error".to_string(), JsonValue::String(turn_error.clone()));
        } else if matches!(turn.status, TurnStatus::Completed) {
            run_object.remove("error");
        }
        (
            actual_run_id,
            title,
            thread_id,
            Some(turn.id.clone()),
            run_status.to_string(),
        )
    };

    let workspace = workspace_object_mut(config)?;
    let source = OfficeSignalSource {
        source_type: "managerRun",
        thread_id: &thread_id,
        turn_id: &turn.id,
        observed_at: &now,
        delegation: None,
    };
    if let Some(office_update) = office_update.as_ref() {
        apply_structured_office_update(workspace, &actual_run_id, office_update, &source)?;
        apply_structured_run_loop_signals(workspace, &actual_run_id, office_update, &source)?;
    }
    apply_turn_tool_evidence(workspace, &actual_run_id, turn, &source)?;
    upsert_run_task(
        workspace,
        &actual_run_id,
        &title,
        task_status,
        locale != Some("en"),
    )?;
    if terminal {
        append_run_sync_message(
            workspace,
            &actual_run_id,
            &title,
            &turn.status,
            effective_result_preview.as_deref(),
            turn_error.as_deref(),
            locale != Some("en"),
        )?;
    }

    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    Ok(OfficeRunSyncDetails {
        run_id: actual_run_id,
        thread_id,
        turn_id,
        status,
    })
}

fn find_run_mut<'a>(
    runs: &'a mut [JsonValue],
    requested_run_id: Option<&str>,
    turn_id: &str,
) -> Option<&'a mut JsonValue> {
    if let Some(requested_run_id) = requested_run_id {
        return runs
            .iter_mut()
            .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(requested_run_id));
    }
    runs.iter_mut()
        .find(|run| run.get("turnId").and_then(JsonValue::as_str) == Some(turn_id))
}

fn office_has_turn_id(config: &JsonValue, turn_id: &str) -> bool {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .is_some_and(|runs| {
            runs.iter()
                .any(|run| run.get("turnId").and_then(JsonValue::as_str) == Some(turn_id))
        })
}

fn office_has_verification_turn_id(config: &JsonValue, thread_id: &str, turn_id: &str) -> bool {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .is_some_and(|runs| {
            runs.iter().any(|run| {
                run.get("verificationChecks")
                    .and_then(JsonValue::as_array)
                    .is_some_and(|checks| {
                        checks.iter().any(|check| {
                            verification_check_matches_automation_turn(check, thread_id, turn_id)
                        })
                    })
            })
        })
}

fn verification_thread_id_for_turn(
    config: &JsonValue,
    requested_run_id: Option<&str>,
    turn_id: &str,
) -> Option<String> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .and_then(|runs| {
            runs.iter().find_map(|run| {
                if let Some(requested_run_id) = requested_run_id
                    && run.get("id").and_then(JsonValue::as_str) != Some(requested_run_id)
                {
                    return None;
                }
                run.get("verificationChecks")
                    .and_then(JsonValue::as_array)
                    .and_then(|checks| {
                        checks.iter().find_map(|check| {
                            let matches_turn =
                                check.get("automationTurnId").and_then(JsonValue::as_str)
                                    == Some(turn_id);
                            matches_turn.then(|| {
                                check
                                    .get("automationThreadId")
                                    .and_then(JsonValue::as_str)
                                    .map(str::to_string)
                            })?
                        })
                    })
            })
        })
}

fn mark_verification_dispatch_queued(
    config: &mut JsonValue,
    run_id: &str,
    verification_check_id: &str,
    automation_id: &str,
    automation_thread_id: &str,
    runtime_repair_source_thread_id: Option<&str>,
    runtime_repaired_at: Option<&str>,
) -> Result<(), JSONRPCErrorError> {
    update_verification_dispatch_status(
        config,
        VerificationDispatchStatusUpdate {
            run_id,
            verification_check_id,
            dispatch_status: "queued",
            automation_run_file_path: None,
            automation_run_id: None,
            automation_thread_id: Some(automation_thread_id),
            automation_turn_id: None,
            runtime_repair_source_thread_id,
            runtime_repaired_at,
            error: None,
        },
    )?;
    let checks = run_verification_checks_mut(config, run_id)?;
    let Some(check_object) = checks.iter_mut().find_map(|check| {
        let matches =
            check.get("itemId").and_then(JsonValue::as_str) == Some(verification_check_id);
        matches.then(|| check.as_object_mut()).flatten()
    }) else {
        return Err(invalid_params("verificationCheckId was not found"));
    };
    check_object.insert(
        "automationId".to_string(),
        JsonValue::String(automation_id.to_string()),
    );
    Ok(())
}

fn update_verification_dispatch_status(
    config: &mut JsonValue,
    update: VerificationDispatchStatusUpdate<'_>,
) -> Result<(), JSONRPCErrorError> {
    let now_time = Utc::now();
    let now = timestamp_from_datetime(now_time);
    {
        let checks = run_verification_checks_mut(config, update.run_id)?;
        let Some(check_object) = checks.iter_mut().find_map(|check| {
            let matches = check.get("itemId").and_then(JsonValue::as_str)
                == Some(update.verification_check_id)
                || check.get("id").and_then(JsonValue::as_str)
                    == Some(update.verification_check_id)
                || check.get("checkId").and_then(JsonValue::as_str)
                    == Some(update.verification_check_id);
            matches.then(|| check.as_object_mut()).flatten()
        }) else {
            return Err(invalid_params("verificationCheckId was not found"));
        };
        check_object.insert(
            "itemId".to_string(),
            JsonValue::String(update.verification_check_id.to_string()),
        );
        check_object.insert(
            "dispatchStatus".to_string(),
            JsonValue::String(update.dispatch_status.to_string()),
        );
        check_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
        if update.dispatch_status == "queued" {
            apply_child_dispatch_lease(check_object, now_time);
        } else {
            clear_child_dispatch_lease(check_object);
        }
        if matches!(update.dispatch_status, "queued" | "running") {
            check_object
                .entry("status".to_string())
                .or_insert_with(|| JsonValue::String("pending".to_string()));
        }
        if update.dispatch_status == "failed" {
            check_object.insert(
                "status".to_string(),
                JsonValue::String("failed".to_string()),
            );
        }
        for (key, value) in [
            ("automationRunFilePath", update.automation_run_file_path),
            ("automationRunId", update.automation_run_id),
            ("automationThreadId", update.automation_thread_id),
            ("automationTurnId", update.automation_turn_id),
            (
                "runtimeRepairSourceThreadId",
                update.runtime_repair_source_thread_id,
            ),
            ("runtimeRepairedAt", update.runtime_repaired_at),
        ] {
            if let Some(value) = value {
                check_object.insert(key.to_string(), JsonValue::String(value.to_string()));
            }
        }
        if let Some(error) = update.error {
            check_object.insert(
                "error".to_string(),
                JsonValue::String(truncate_chars(error, RUN_ERROR_CHARS)),
            );
        } else {
            check_object.remove("error");
        }
    }
    refresh_loop_review_for_run(config, update.run_id)?;
    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    Ok(())
}

fn office_has_delegation_turn_id(config: &JsonValue, thread_id: &str, turn_id: &str) -> bool {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .is_some_and(|runs| {
            runs.iter().any(|run| {
                run.get("delegations")
                    .and_then(JsonValue::as_array)
                    .is_some_and(|delegations| {
                        delegations.iter().any(|delegation| {
                            delegation_matches_turn(delegation, thread_id, turn_id)
                        })
                    })
            })
        })
}

fn delegation_thread_id_for_turn(
    config: &JsonValue,
    requested_run_id: Option<&str>,
    turn_id: &str,
) -> Option<String> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .and_then(|runs| {
            runs.iter().find_map(|run| {
                if requested_run_id
                    .is_some_and(|run_id| run.get("id").and_then(JsonValue::as_str) != Some(run_id))
                {
                    return None;
                }
                run.get("delegations")
                    .and_then(JsonValue::as_array)?
                    .iter()
                    .find_map(|delegation| {
                        let matches_turn =
                            delegation.get("turnId").and_then(JsonValue::as_str) == Some(turn_id);
                        matches_turn.then(|| {
                            delegation
                                .get("threadId")
                                .and_then(JsonValue::as_str)
                                .or_else(|| delegation.get("target").and_then(JsonValue::as_str))
                                .map(str::trim)
                                .filter(|thread_id| !thread_id.is_empty())
                                .map(str::to_string)
                        })?
                    })
            })
        })
}

fn delegation_matches_turn(delegation: &JsonValue, thread_id: &str, turn_id: &str) -> bool {
    if delegation.get("turnId").and_then(JsonValue::as_str) != Some(turn_id) {
        return false;
    }
    let target_thread = delegation
        .get("threadId")
        .and_then(JsonValue::as_str)
        .or_else(|| delegation.get("target").and_then(JsonValue::as_str))
        .map(str::trim)
        .filter(|target| !target.is_empty());
    target_thread.is_none_or(|target_thread| target_thread == thread_id)
}

fn office_has_run_id(config: &JsonValue, run_id: &str) -> bool {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .is_some_and(|runs| {
            runs.iter()
                .any(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
        })
}

fn infer_office_locale(config: &JsonValue) -> Option<&'static str> {
    let messages = config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)?;
    if messages.iter().any(|message| {
        message
            .get("text")
            .and_then(JsonValue::as_str)
            .is_some_and(|text| text.starts_with("Started team run:"))
    }) {
        return Some("en");
    }
    if messages.iter().any(|message| {
        message
            .get("text")
            .and_then(JsonValue::as_str)
            .is_some_and(|text| text.starts_with("已启动团队执行："))
    }) {
        return Some("zh");
    }
    None
}

fn run_and_task_status(status: &TurnStatus) -> (&'static str, &'static str) {
    match status {
        TurnStatus::Completed => ("completed", "done"),
        TurnStatus::Interrupted => ("interrupted", "todo"),
        TurnStatus::Failed => ("failed", "todo"),
        TurnStatus::InProgress => ("running", "doing"),
    }
}

fn delegation_and_task_status(status: &TurnStatus) -> (&'static str, &'static str) {
    match status {
        TurnStatus::Completed => ("completed", "done"),
        TurnStatus::Interrupted => ("interrupted", "todo"),
        TurnStatus::Failed => ("failed", "todo"),
        TurnStatus::InProgress => ("running", "doing"),
    }
}

fn verification_status_from_turn_status(status: &TurnStatus) -> &'static str {
    match status {
        TurnStatus::Completed => "passed",
        TurnStatus::Interrupted => "failed",
        TurnStatus::Failed => "failed",
        TurnStatus::InProgress => "pending",
    }
}

fn turn_status_name(status: &TurnStatus) -> &'static str {
    match status {
        TurnStatus::Completed => "completed",
        TurnStatus::Interrupted => "interrupted",
        TurnStatus::Failed => "failed",
        TurnStatus::InProgress => "inProgress",
    }
}

fn run_status_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

fn turn_status_is_terminal(status: &TurnStatus) -> bool {
    match status {
        TurnStatus::Completed | TurnStatus::Interrupted | TurnStatus::Failed => true,
        TurnStatus::InProgress => false,
    }
}

fn retry_message(text: &str, locale: Option<&str>) -> JsonValue {
    let is_zh = locale != Some("en");
    json!({
        "author": if is_zh { "你" } else { "You" },
        "glyph": "@",
        "accent": "slate",
        "time": if is_zh { "现在" } else { "now" },
        "text": if is_zh {
            format!("重试团队执行：{text}")
        } else {
            format!("Retry team run: {text}")
        },
        "kind": "message"
    })
}

fn retry_text_for_run(config: &JsonValue, run_id: &str, locale: Option<&str>) -> Option<String> {
    loop_review_retry_text(config, run_id, locale)
        .or_else(|| run_field(config, run_id, "requestText").map(str::to_string))
        .or_else(|| run_field(config, run_id, "promptPreview").map(str::to_string))
        .or_else(|| run_field(config, run_id, "title").map(str::to_string))
}

fn loop_review_retry_text(
    config: &JsonValue,
    run_id: &str,
    locale: Option<&str>,
) -> Option<String> {
    let run = run_by_id(config, run_id)?;
    let review = run
        .get("loop")
        .and_then(|loop_value| loop_value.get("review"))?;
    let status = review.get("status").and_then(JsonValue::as_str)?;
    if matches!(status, "passed") {
        return None;
    }
    let next_action = review
        .get("nextAction")
        .and_then(JsonValue::as_str)
        .unwrap_or("collectVerificationEvidence");
    let original_request = run_field(config, run_id, "requestText")
        .or_else(|| run_field(config, run_id, "promptPreview"))
        .or_else(|| run_field(config, run_id, "title"))
        .map(|text| truncate_chars(text, MAX_PROMPT_FIELD_CHARS))
        .unwrap_or_else(|| "Office run".to_string());
    let criteria = retry_signal_lines(
        run,
        "acceptanceCriteria",
        |item| {
            item.get("status")
                .and_then(JsonValue::as_str)
                .is_none_or(|status| status != "passed")
        },
        &["criterion", "criteria", "title", "text", "description"],
        &["evidence", "source"],
    );
    let evidence = retry_signal_lines(
        run,
        "evidence",
        |item| {
            item.get("status")
                .and_then(JsonValue::as_str)
                .is_none_or(|status| status != "verified")
        },
        &[
            "summary",
            "evidence",
            "observation",
            "result",
            "proof",
            "text",
        ],
        &["status", "source"],
    );
    let verification_checks = retry_signal_lines(
        run,
        "verificationChecks",
        |item| {
            item.get("status")
                .and_then(JsonValue::as_str)
                .is_none_or(|status| status != "passed")
        },
        &["check", "name", "title", "command", "automationId", "text"],
        &["status", "command", "automationId", "evidence", "source"],
    );
    let risks = retry_signal_lines(
        run,
        "risks",
        |item| {
            item.get("severity").and_then(JsonValue::as_str) == Some("high")
                && item
                    .get("mitigation")
                    .and_then(JsonValue::as_str)
                    .is_none_or(|mitigation| mitigation.trim().is_empty())
        },
        &["summary", "risk", "text", "description"],
        &["mitigation", "owner"],
    );
    let is_zh = locale != Some("en");
    let run_verification_checks = next_action == "runVerificationChecks";
    let mut text = match (is_zh, run_verification_checks) {
        (true, true) => {
            format!(
                "继续上一轮 Office Loop，优先运行待验证检查。\n原始请求：{original_request}\nReview 状态：{status}\n下一步：{next_action}\n"
            )
        }
        (true, false) => {
            format!(
                "继续上一轮 Office Loop，按 review 结果修复或补验证。\n原始请求：{original_request}\nReview 状态：{status}\n下一步：{next_action}\n"
            )
        }
        (false, true) => {
            format!(
                "Continue the previous Office Loop by running the pending verification checks.\nOriginal request: {original_request}\nReview status: {status}\nNext action: {next_action}\n"
            )
        }
        (false, false) => {
            format!(
                "Continue the previous Office Loop using the review result.\nOriginal request: {original_request}\nReview status: {status}\nNext action: {next_action}\n"
            )
        }
    };
    append_retry_section(
        &mut text,
        if is_zh {
            "未通过或待复核的验收"
        } else {
            "Failed or pending acceptance"
        },
        &criteria,
    );
    append_retry_section(
        &mut text,
        if is_zh {
            "阻塞或待验证的证据"
        } else {
            "Blocked or unverified evidence"
        },
        &evidence,
    );
    append_retry_section(
        &mut text,
        if is_zh {
            "失败或待运行的验证检查"
        } else {
            "Failed or pending verification checks"
        },
        &verification_checks,
    );
    append_retry_section(
        &mut text,
        if is_zh {
            "开放高风险"
        } else {
            "Open high risks"
        },
        &risks,
    );
    match (is_zh, run_verification_checks) {
        (true, true) => text.push_str("要求：优先执行 verificationChecks 中列出的安全命令或自动化引用；需要审批时走正常审批路径；没有真实工具证据时不要把检查标为 passed。执行后 observe/verify，并在最终回复追加新的 officeUpdate.verificationChecks 和 evidence。\n"),
        (true, false) => text.push_str("要求：不要重复已通过工作；重新 frame 验收差距，plan 修复路径，必要时 delegate，执行后 observe/verify，并在最终回复追加新的 officeUpdate。\n"),
        (false, true) => text.push_str("Instructions: prioritize executing the safe commands or automation references listed in verificationChecks; use the normal approval path when approval is required; do not mark checks passed without real tool evidence. After execution, observe/verify and append fresh officeUpdate.verificationChecks and evidence in the final response.\n"),
        (false, false) => text.push_str("Instructions: do not repeat already-passed work; re-frame the acceptance gaps, plan the repair path, delegate when useful, act, observe/verify, and append a fresh officeUpdate in the final response.\n"),
    }
    Some(truncate_chars(&text, MAX_PROMPT_TEXT_CHARS))
}

fn retry_signal_lines(
    run: &JsonValue,
    key: &str,
    include: impl Fn(&JsonValue) -> bool,
    summary_keys: &[&str],
    detail_keys: &[&str],
) -> Vec<String> {
    let Some(value) = run.get(key) else {
        return Vec::new();
    };
    signal_items(value)
        .into_iter()
        .filter(|item| include(item))
        .take(5)
        .filter_map(|item| {
            let summary = item
                .as_str()
                .map(|text| truncate_chars(text, MAX_PROMPT_FIELD_CHARS))
                .or_else(|| update_string(item, summary_keys))?;
            let details = detail_keys
                .iter()
                .filter_map(|key| {
                    item.get(*key).and_then(JsonValue::as_str).map(|value| {
                        format!("{key}={}", truncate_chars(value, MAX_PROMPT_TITLE_CHARS))
                    })
                })
                .collect::<Vec<_>>();
            if details.is_empty() {
                Some(format!("- {summary}"))
            } else {
                Some(format!("- {summary} ({})", details.join("; ")))
            }
        })
        .collect()
}

fn append_retry_section(text: &mut String, heading: &str, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    text.push_str(heading);
    text.push_str(":\n");
    text.push_str(&lines.join("\n"));
    text.push('\n');
}

fn run_field<'a>(config: &'a JsonValue, run_id: &str, field: &str) -> Option<&'a str> {
    run_by_id(config, run_id)?
        .get(field)
        .and_then(JsonValue::as_str)
}

fn run_by_id<'a>(config: &'a JsonValue, run_id: &str) -> Option<&'a JsonValue> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)?
        .iter()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
}

fn run_loop_iteration(loop_value: Option<&JsonValue>) -> u64 {
    loop_value
        .and_then(|loop_value| loop_value.get("iteration"))
        .and_then(JsonValue::as_u64)
        .unwrap_or(1)
}

fn run_loop_max_iterations(loop_value: Option<&JsonValue>) -> u64 {
    loop_value
        .and_then(|loop_value| loop_value.get("maxIterations"))
        .and_then(JsonValue::as_u64)
        .unwrap_or(OFFICE_LOOP_MAX_ITERATIONS)
}

fn upsert_run_task(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    title: &str,
    status: &str,
    is_zh: bool,
) -> Result<(), JSONRPCErrorError> {
    let tasks = array_entry(workspace, "tasks", "workspace.tasks must be an array")?;
    if let Some(task_object) = tasks.iter_mut().find_map(|task| {
        let matches_run = task.get("runId").and_then(JsonValue::as_str) == Some(run_id);
        matches_run.then(|| task.as_object_mut()).flatten()
    }) {
        task_object.insert("status".to_string(), JsonValue::String(status.to_string()));
        return Ok(());
    }

    tasks.insert(
        0,
        json!({
            "title": title,
            "owner": if is_zh { "团队" } else { "Team" },
            "status": status,
            "runId": run_id
        }),
    );
    Ok(())
}

fn upsert_named_task(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    title: &str,
    owner: &str,
    status: &str,
) -> Result<(), JSONRPCErrorError> {
    let tasks = array_entry(workspace, "tasks", "workspace.tasks must be an array")?;
    if let Some(task_object) = tasks.iter_mut().find_map(|task| {
        let same_title = task.get("title").and_then(JsonValue::as_str) == Some(title);
        same_title.then(|| task.as_object_mut()).flatten()
    }) {
        task_object.insert("owner".to_string(), JsonValue::String(owner.to_string()));
        task_object.insert("status".to_string(), JsonValue::String(status.to_string()));
        task_object.insert("runId".to_string(), JsonValue::String(run_id.to_string()));
        return Ok(());
    }

    tasks.insert(
        0,
        json!({
            "title": title,
            "owner": owner,
            "status": status,
            "runId": run_id
        }),
    );
    Ok(())
}

fn append_run_sync_message(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    title: &str,
    status: &TurnStatus,
    result_preview: Option<&str>,
    error: Option<&str>,
    is_zh: bool,
) -> Result<(), JSONRPCErrorError> {
    let messages = array_entry(workspace, "messages", "workspace.messages must be an array")?;
    if messages.iter().any(|message| {
        message.get("runId").and_then(JsonValue::as_str) == Some(run_id)
            && message.get("event").and_then(JsonValue::as_str) == Some("runSync")
    }) {
        return Ok(());
    }

    messages.push(json!({
        "author": if is_zh { "办公室" } else { "Office" },
        "glyph": "@",
        "accent": match status {
            TurnStatus::Completed => "green",
            TurnStatus::Interrupted => "amber",
            TurnStatus::Failed => "rose",
            TurnStatus::InProgress => "slate",
        },
        "time": Utc::now().format("%H:%M").to_string(),
        "text": run_sync_message_text(status, title, result_preview, error, is_zh),
        "kind": "system",
        "runId": run_id,
        "event": "runSync"
    }));
    Ok(())
}

fn run_sync_message_text(
    status: &TurnStatus,
    title: &str,
    result_preview: Option<&str>,
    error: Option<&str>,
    is_zh: bool,
) -> String {
    let detail = error.or(result_preview).unwrap_or("");
    let heading = match (status, is_zh) {
        (TurnStatus::Completed, true) => format!("团队执行已完成：{title}"),
        (TurnStatus::Completed, false) => format!("Team run completed: {title}"),
        (TurnStatus::Interrupted, true) => format!("团队执行已中断：{title}"),
        (TurnStatus::Interrupted, false) => format!("Team run interrupted: {title}"),
        (TurnStatus::Failed, true) => format!("团队执行失败：{title}"),
        (TurnStatus::Failed, false) => format!("Team run failed: {title}"),
        (TurnStatus::InProgress, true) => format!("团队执行中：{title}"),
        (TurnStatus::InProgress, false) => format!("Team run in progress: {title}"),
    };
    if detail.is_empty() {
        heading
    } else {
        format!("{heading}\n\n{detail}")
    }
}

fn append_delegation_sync_message(
    workspace: &mut Map<String, JsonValue>,
    delegation: &SyncedOfficeDelegation,
    status: &TurnStatus,
    is_zh: bool,
) -> Result<(), JSONRPCErrorError> {
    let messages = array_entry(workspace, "messages", "workspace.messages must be an array")?;
    if messages.iter().any(|message| {
        message.get("delegationId").and_then(JsonValue::as_str)
            == Some(delegation.delegation_id.as_str())
            && message.get("event").and_then(JsonValue::as_str) == Some("delegationSync")
    }) {
        return Ok(());
    }

    messages.push(json!({
        "author": if is_zh { "办公室" } else { "Office" },
        "glyph": "@",
        "accent": match status {
            TurnStatus::Completed => "green",
            TurnStatus::Interrupted => "amber",
            TurnStatus::Failed => "rose",
            TurnStatus::InProgress => "slate",
        },
        "time": Utc::now().format("%H:%M").to_string(),
        "text": delegation_sync_message_text(delegation, status, is_zh),
        "kind": "system",
        "runId": delegation.run_id,
        "delegationId": delegation.delegation_id,
        "event": "delegationSync"
    }));
    Ok(())
}

fn delegation_sync_message_text(
    delegation: &SyncedOfficeDelegation,
    status: &TurnStatus,
    is_zh: bool,
) -> String {
    let detail = delegation
        .error
        .as_deref()
        .or(delegation.result_preview.as_deref())
        .unwrap_or("");
    let heading = match (status, is_zh) {
        (TurnStatus::Completed, true) => {
            format!("成员 {} 已完成委派：{}", delegation.member, delegation.task)
        }
        (TurnStatus::Completed, false) => format!(
            "Member {} completed delegation: {}",
            delegation.member, delegation.task
        ),
        (TurnStatus::Interrupted, true) => {
            format!(
                "成员 {} 的委派已中断：{}",
                delegation.member, delegation.task
            )
        }
        (TurnStatus::Interrupted, false) => format!(
            "Member {} delegation interrupted: {}",
            delegation.member, delegation.task
        ),
        (TurnStatus::Failed, true) => {
            format!("成员 {} 的委派失败：{}", delegation.member, delegation.task)
        }
        (TurnStatus::Failed, false) => {
            format!(
                "Member {} delegation failed: {}",
                delegation.member, delegation.task
            )
        }
        (TurnStatus::InProgress, true) => {
            format!(
                "成员 {} 的委派执行中：{}",
                delegation.member, delegation.task
            )
        }
        (TurnStatus::InProgress, false) => format!(
            "Member {} delegation in progress: {}",
            delegation.member, delegation.task
        ),
    };
    if detail.is_empty() {
        heading
    } else {
        format!("{heading}\n\n{detail}")
    }
}

fn last_agent_message(turn: &Turn) -> Option<String> {
    last_agent_message_text(turn).map(|text| truncate_chars(text, RUN_RESULT_PREVIEW_CHARS))
}

fn last_agent_message_text(turn: &Turn) -> Option<&str> {
    turn.items.iter().rev().find_map(|item| match item {
        ThreadItem::AgentMessage { text, .. } if !text.trim().is_empty() => Some(text.as_str()),
        _ => None,
    })
}

fn office_update_from_turn(turn: &Turn) -> Option<JsonValue> {
    let message = last_agent_message_text(turn)?;
    extract_office_update(message_tail_chars(message, MAX_OFFICE_UPDATE_PARSE_CHARS))
}

fn message_tail_chars(text: &str, max_chars: usize) -> &str {
    if text.chars().count() <= max_chars {
        return text;
    }
    let mut count = 0usize;
    for (index, _) in text.char_indices().rev() {
        count += 1;
        if count == max_chars {
            return &text[index..];
        }
    }
    text
}

fn turn_error_message(turn: &Turn) -> Option<String> {
    turn.error
        .as_ref()
        .map(|error| truncate_chars(&error.message, RUN_ERROR_CHARS))
}

fn extract_office_update(message: &str) -> Option<JsonValue> {
    let trimmed = message.trim();
    let candidates = [json_fence(trimmed), Some(trimmed)];
    candidates.into_iter().flatten().find_map(|candidate| {
        let value = serde_json::from_str::<JsonValue>(candidate).ok()?;
        if let Some(update) = value
            .get("officeUpdate")
            .or_else(|| value.get("office_update"))
            .or_else(|| value.get("office"))
        {
            return update.as_object().map(|_| update.clone());
        }
        let looks_like_update = value.get("summary").is_some()
            || value.get("tasks").is_some()
            || value.get("artifacts").is_some()
            || value.get("plan").is_some()
            || value.get("delegations").is_some()
            || value.get("goal").is_some()
            || value.get("goalUpdate").is_some();
        looks_like_update.then_some(value)
    })
}

fn json_fence(message: &str) -> Option<&str> {
    let start = message
        .find("```json")
        .map(|index| index + "```json".len())
        .or_else(|| message.find("```").map(|index| index + "```".len()))?;
    let rest = &message[start..];
    let end = rest.find("```")?;
    Some(rest[..end].trim())
}

fn update_string(update: &JsonValue, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        update
            .get(*key)
            .and_then(JsonValue::as_str)
            .map(|value| truncate_chars(value, MAX_PROMPT_FIELD_CHARS))
            .filter(|value| !value.trim().is_empty())
    })
}

fn plan_update_from_turn(turn: &Turn) -> Option<JsonValue> {
    let plan = turn.items.iter().rev().find_map(|item| match item {
        ThreadItem::Plan { text, .. } if !text.trim().is_empty() => Some(text),
        _ => None,
    })?;
    let items = plan
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(MAX_OFFICE_UPDATE_ITEMS)
        .map(|line| {
            json!({
                "step": truncate_chars(line.trim_start_matches("- ").trim(), MAX_PROMPT_FIELD_CHARS),
                "status": plan_line_status(line)
            })
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn plan_line_status(line: &str) -> &'static str {
    let lower = line.to_ascii_lowercase();
    if lower.contains("[x]") || lower.contains("completed") || lower.contains("done") {
        "completed"
    } else if lower.contains("in_progress")
        || lower.contains("in progress")
        || lower.contains("running")
        || lower.contains("doing")
    {
        "inProgress"
    } else {
        "pending"
    }
}

fn update_plan(update: &JsonValue) -> Option<JsonValue> {
    let plan = update.get("plan")?.as_array()?;
    let items = plan
        .iter()
        .take(MAX_OFFICE_UPDATE_ITEMS)
        .filter_map(|item| {
            if let Some(step) = item.as_str() {
                return Some(json!({
                    "step": truncate_chars(step, MAX_PROMPT_FIELD_CHARS),
                    "status": "pending"
                }));
            }
            let step = update_string(item, &["step", "title", "task"])?;
            let status = item
                .get("status")
                .and_then(JsonValue::as_str)
                .map(plan_status)
                .unwrap_or("pending");
            Some(json!({ "step": step, "status": status }))
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn plan_status(status: &str) -> &'static str {
    match status {
        "completed" | "complete" | "done" => "completed",
        "inProgress" | "in_progress" | "running" | "doing" => "inProgress",
        _ => "pending",
    }
}

fn update_delegations(update: &JsonValue, routes: &[JsonValue]) -> Option<JsonValue> {
    let delegations = update.get("delegations")?.as_array()?;
    let items = delegations
        .iter()
        .take(MAX_OFFICE_DELEGATIONS)
        .filter_map(|delegation| {
            let member = update_string(delegation, &["member", "name", "owner"])?;
            let mut value = json!({ "member": member });
            copy_update_string(delegation, &mut value, "agentId", &["agentId", "agent_id"]);
            copy_update_string(delegation, &mut value, "task", &["task", "title", "prompt"]);
            copy_update_string(delegation, &mut value, "status", &["status"]);
            copy_update_string(
                delegation,
                &mut value,
                "dispatchMode",
                &["dispatchMode", "dispatch_mode", "mode"],
            );
            copy_update_string(
                delegation,
                &mut value,
                "riskSeverity",
                &["riskSeverity", "risk_severity", "risk", "severity"],
            );
            copy_update_string(
                delegation,
                &mut value,
                "approvalId",
                &["approvalId", "approval_id"],
            );
            copy_update_bool(
                delegation,
                &mut value,
                "approvalRequired",
                &["approvalRequired", "approval_required", "requiresApproval"],
            );
            copy_update_bool(
                delegation,
                &mut value,
                "manualDispatch",
                &["manualDispatch", "manual_dispatch"],
            );
            copy_update_string(delegation, &mut value, "target", &["target"]);
            copy_update_string(
                delegation,
                &mut value,
                "targetKind",
                &["targetKind", "target_kind"],
            );
            copy_update_string(delegation, &mut value, "tool", &["tool"]);
            copy_update_string(
                delegation,
                &mut value,
                "threadId",
                &["threadId", "thread_id"],
            );
            enrich_delegation_with_route(&mut value, routes);
            Some(value)
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn enrich_delegation_with_route(delegation: &mut JsonValue, routes: &[JsonValue]) {
    let member = delegation.get("member").and_then(JsonValue::as_str);
    let agent_id = delegation.get("agentId").and_then(JsonValue::as_str);
    let Some(route) = routes
        .iter()
        .find(|route| delegation_route_matches(route, member, agent_id))
    else {
        return;
    };
    for key in [
        "threadId",
        "target",
        "targetKind",
        "tool",
        "contextPolicy",
        "memoryScope",
        "agentProfile",
    ] {
        copy_route_string_if_missing(route, delegation, key);
    }
}

fn delegation_route_matches(
    route: &JsonValue,
    member: Option<&str>,
    agent_id: Option<&str>,
) -> bool {
    if let Some(agent_id) = agent_id
        && route.get("agentId").and_then(JsonValue::as_str) == Some(agent_id)
    {
        return true;
    }
    member.is_some_and(|member| route.get("member").and_then(JsonValue::as_str) == Some(member))
}

fn copy_route_string_if_missing(source: &JsonValue, target: &mut JsonValue, key: &str) {
    let target_has_value = target
        .get(key)
        .and_then(JsonValue::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    if target_has_value {
        return;
    }
    if let Some(value) = source
        .get(key)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        target[key] = JsonValue::String(value.to_string());
    }
}

fn delegation_update_from_turn(turn: &Turn) -> Option<JsonValue> {
    let items = turn
        .items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::CollabAgentToolCall {
                tool,
                status,
                receiver_thread_ids,
                prompt,
                ..
            } => Some(json!({
                "member": "Agent",
                "tool": serde_json::to_value(tool).unwrap_or(JsonValue::Null),
                "status": serde_json::to_value(status).unwrap_or(JsonValue::Null),
                "task": prompt
                    .as_deref()
                    .map(|prompt| truncate_chars(prompt, MAX_PROMPT_FIELD_CHARS))
                    .unwrap_or_default(),
                "threadId": receiver_thread_ids.first().cloned().unwrap_or_default()
            })),
            ThreadItem::SubAgentActivity {
                kind,
                agent_thread_id,
                agent_path,
                ..
            } => Some(json!({
                "member": "Agent",
                "status": serde_json::to_value(kind).unwrap_or(JsonValue::Null),
                "threadId": agent_thread_id,
                "agentPath": truncate_chars(agent_path, MAX_PROMPT_FIELD_CHARS)
            })),
            _ => None,
        })
        .take(MAX_OFFICE_DELEGATIONS)
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn apply_structured_office_update(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    update: &JsonValue,
    source: &OfficeSignalSource<'_>,
) -> Result<(), JSONRPCErrorError> {
    if let Some(goal) = update_string(update, &["goal", "goalUpdate", "goal_update"]) {
        workspace.insert("goal".to_string(), JsonValue::String(goal));
    }
    apply_structured_tasks(workspace, run_id, update)?;
    apply_structured_artifacts(workspace, update, source)?;
    Ok(())
}

fn apply_member_structured_office_update(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    update: &JsonValue,
    source: &OfficeSignalSource<'_>,
) -> Result<(), JSONRPCErrorError> {
    apply_structured_tasks(workspace, run_id, update)?;
    apply_structured_artifacts(workspace, update, source)?;
    apply_structured_run_loop_signals(workspace, run_id, update, source)?;
    Ok(())
}

fn apply_structured_run_loop_signals(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    update: &JsonValue,
    source: &OfficeSignalSource<'_>,
) -> Result<(), JSONRPCErrorError> {
    let activity = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("workspace.activity must be an object"))?;
    let runs = activity
        .get_mut("runs")
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = runs
        .iter_mut()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
    else {
        return Err(invalid_params("runId was not found"));
    };
    let Some(run_object) = run.as_object_mut() else {
        return Err(invalid_params("office run must be an object"));
    };
    if let Some(items) = update_acceptance_criteria(update, source) {
        merge_run_items(run_object, "acceptanceCriteria", items);
    }
    if let Some(items) = update_verification_checks(update, source) {
        merge_run_items(run_object, "verificationChecks", items);
    }
    if let Some(items) = update_evidence(update, source) {
        merge_run_items(run_object, "evidence", items);
    }
    if let Some(items) = update_risks(update, source) {
        merge_run_items(run_object, "risks", items);
    }
    apply_verification_checks_to_acceptance_criteria(run_object);
    refresh_run_loop_review(run_object);
    Ok(())
}

fn apply_turn_tool_evidence(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    turn: &Turn,
    source: &OfficeSignalSource<'_>,
) -> Result<(), JSONRPCErrorError> {
    let Some(items) = turn_tool_evidence(turn, source) else {
        return Ok(());
    };
    let evidence_items = items.as_array().cloned().unwrap_or_default();
    let activity = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("workspace.activity must be an object"))?;
    let runs = activity
        .get_mut("runs")
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run_object) = runs
        .iter_mut()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("runId was not found"));
    };
    merge_run_items(run_object, "evidence", items);
    apply_tool_evidence_to_verification_checks(run_object, &evidence_items);
    apply_verification_checks_to_acceptance_criteria(run_object);
    refresh_run_loop_review(run_object);
    Ok(())
}

fn turn_tool_evidence(turn: &Turn, source: &OfficeSignalSource<'_>) -> Option<JsonValue> {
    let items = turn
        .items
        .iter()
        .filter_map(|item| tool_evidence_item(item, source))
        .take(MAX_OFFICE_UPDATE_ITEMS)
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn tool_evidence_item(item: &ThreadItem, source: &OfficeSignalSource<'_>) -> Option<JsonValue> {
    match item {
        ThreadItem::CommandExecution {
            id,
            command,
            cwd,
            status,
            aggregated_output,
            exit_code,
            duration_ms,
            ..
        } => command_evidence_item(
            CommandEvidenceItemParams {
                id,
                command,
                cwd: cwd.as_path().to_string_lossy().as_ref(),
                status,
                aggregated_output: aggregated_output.as_deref(),
                exit_code: *exit_code,
                duration_ms: *duration_ms,
            },
            source,
        ),
        ThreadItem::FileChange {
            id,
            changes,
            status,
        } => file_change_evidence_item(id, changes, status, source),
        _ => None,
    }
}

fn command_evidence_item(
    params: CommandEvidenceItemParams<'_>,
    source: &OfficeSignalSource<'_>,
) -> Option<JsonValue> {
    let evidence_status = match params.status {
        CommandExecutionStatus::Completed => "verified",
        CommandExecutionStatus::Failed | CommandExecutionStatus::Declined => "blocked",
        CommandExecutionStatus::InProgress => return None,
    };
    let mut value = json!({
        "summary": format!(
            "Command {}: {}",
            match params.status {
                CommandExecutionStatus::Completed => "completed",
                CommandExecutionStatus::Failed => "failed",
                CommandExecutionStatus::Declined => "declined",
                CommandExecutionStatus::InProgress => unreachable!(),
            },
            truncate_chars(params.command, MAX_PROMPT_FIELD_CHARS)
        ),
        "status": evidence_status,
        "source": "commandExecution",
        "evidenceKind": "commandExecution",
        "itemId": truncate_chars(params.id, MAX_PROMPT_FIELD_CHARS),
        "command": truncate_chars(params.command, MAX_PROMPT_FIELD_CHARS),
        "cwd": truncate_chars(params.cwd, MAX_PROMPT_FIELD_CHARS)
    });
    if let Some(exit_code) = params.exit_code {
        value["exitCode"] = JsonValue::Number(exit_code.into());
    }
    if let Some(duration_ms) = params.duration_ms {
        value["durationMs"] = JsonValue::Number(duration_ms.into());
    }
    if let Some(output) = params
        .aggregated_output
        .map(str::trim)
        .filter(|output| !output.is_empty())
    {
        value["outputPreview"] = JsonValue::String(truncate_chars(output, MAX_PROMPT_FIELD_CHARS));
        value["outputSha256"] = JsonValue::String(sha256_hex(output.as_bytes()));
    }
    apply_signal_source(&mut value, source);
    Some(value)
}

fn file_change_evidence_item(
    id: &str,
    changes: &[FileUpdateChange],
    status: &PatchApplyStatus,
    source: &OfficeSignalSource<'_>,
) -> Option<JsonValue> {
    let evidence_status = match status {
        PatchApplyStatus::Completed => "verified",
        PatchApplyStatus::Failed | PatchApplyStatus::Declined => "blocked",
        PatchApplyStatus::InProgress => return None,
    };
    let paths = changes
        .iter()
        .take(5)
        .map(|change| JsonValue::String(truncate_chars(&change.path, MAX_PROMPT_FIELD_CHARS)))
        .collect::<Vec<_>>();
    let first_path = changes
        .first()
        .map(|change| truncate_chars(&change.path, MAX_PROMPT_FIELD_CHARS))
        .unwrap_or_else(|| "unknown path".to_string());
    let mut value = json!({
        "summary": format!(
            "File change {}: {}",
            match status {
                PatchApplyStatus::Completed => "applied",
                PatchApplyStatus::Failed => "failed",
                PatchApplyStatus::Declined => "declined",
                PatchApplyStatus::InProgress => unreachable!(),
            },
            first_path
        ),
        "status": evidence_status,
        "source": "fileChange",
        "evidenceKind": "fileChange",
        "itemId": truncate_chars(id, MAX_PROMPT_FIELD_CHARS),
        "changeCount": changes.len(),
        "changesSha256": file_changes_sha256(changes),
        "paths": paths
    });
    apply_signal_source(&mut value, source);
    Some(value)
}

fn file_changes_sha256(changes: &[FileUpdateChange]) -> String {
    let bytes = serde_json::to_vec(changes).unwrap_or_default();
    sha256_hex(&bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn apply_structured_tasks(
    workspace: &mut Map<String, JsonValue>,
    run_id: &str,
    update: &JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let Some(tasks) = update.get("tasks").and_then(JsonValue::as_array) else {
        return Ok(());
    };
    for task in tasks.iter().take(MAX_OFFICE_UPDATE_ITEMS).rev() {
        let Some(title) = update_string(task, &["title", "task", "step"]) else {
            continue;
        };
        let owner = update_string(task, &["owner", "member", "assignee"])
            .unwrap_or_else(|| "Team".to_string());
        let status = task
            .get("status")
            .and_then(JsonValue::as_str)
            .map(office_task_status)
            .unwrap_or("todo");
        upsert_named_task(workspace, run_id, &title, &owner, status)?;
    }
    Ok(())
}

fn apply_structured_artifacts(
    workspace: &mut Map<String, JsonValue>,
    update: &JsonValue,
    source: &OfficeSignalSource<'_>,
) -> Result<(), JSONRPCErrorError> {
    let Some(new_artifacts) = update.get("artifacts").and_then(JsonValue::as_array) else {
        return Ok(());
    };
    let activity = workspace
        .entry("activity")
        .or_insert_with(|| json!({ "approvals": [], "artifacts": [], "runs": [] }));
    let Some(activity) = activity.as_object_mut() else {
        return Err(invalid_params("workspace.activity must be an object"));
    };
    let artifacts = array_entry(
        activity,
        "artifacts",
        "workspace.activity.artifacts must be an array",
    )?;
    for artifact in new_artifacts.iter().take(MAX_OFFICE_UPDATE_ITEMS).rev() {
        let Some(title) = update_string(artifact, &["title", "name"]) else {
            continue;
        };
        artifacts.retain(|existing| {
            existing.get("title").and_then(JsonValue::as_str) != Some(title.as_str())
        });
        let mut value = json!({
            "title": title,
            "kind": update_string(artifact, &["kind", "type"]).unwrap_or_else(|| "doc".to_string()),
            "glyph": update_string(artifact, &["glyph"]).unwrap_or_else(|| "D".to_string()),
            "accent": update_string(artifact, &["accent"]).unwrap_or_else(|| "blue".to_string()),
            "meta": update_string(artifact, &["meta", "summary", "description"]).unwrap_or_default()
        });
        copy_update_string(artifact, &mut value, "path", &["path", "file", "filePath"]);
        copy_update_string(artifact, &mut value, "url", &["url", "href"]);
        apply_signal_source(&mut value, source);
        artifacts.insert(0, value);
    }
    Ok(())
}

fn update_acceptance_criteria(
    update: &JsonValue,
    source: &OfficeSignalSource<'_>,
) -> Option<JsonValue> {
    let value = update
        .get("acceptanceCriteria")
        .or_else(|| update.get("acceptance_criteria"))
        .or_else(|| update.get("criteria"))
        .or_else(|| update.get("acceptance"))?;
    let items = signal_items(value)
        .into_iter()
        .take(MAX_OFFICE_UPDATE_ITEMS)
        .filter_map(|item| {
            let mut value = if let Some(text) = item.as_str() {
                json!({ "criterion": truncate_chars(text, MAX_PROMPT_FIELD_CHARS), "status": "pending" })
            } else {
                let criterion =
                    update_string(item, &["criterion", "criteria", "title", "text", "description"])?;
                json!({
                    "criterion": criterion,
                    "status": item
                        .get("status")
                        .and_then(JsonValue::as_str)
                        .map(acceptance_status)
                        .unwrap_or("pending")
                })
            };
            copy_update_string(
                item,
                &mut value,
                "criterionId",
                &["criterionId", "criterion_id", "acceptanceId", "acceptance_id"],
            );
            copy_update_string(item, &mut value, "itemId", &["itemId", "item_id", "id"]);
            copy_update_string(item, &mut value, "evidence", &["evidence", "proof", "result"]);
            copy_update_string(item, &mut value, "source", &["source", "file", "url", "command"]);
            apply_signal_source(&mut value, source);
            Some(value)
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn update_verification_checks(
    update: &JsonValue,
    source: &OfficeSignalSource<'_>,
) -> Option<JsonValue> {
    let value = update
        .get("verificationChecks")
        .or_else(|| update.get("verification_checks"))
        .or_else(|| update.get("checks"))
        .or_else(|| update.get("testChecks"))
        .or_else(|| update.get("test_checks"))
        .or_else(|| {
            update
                .get("verification")
                .and_then(|verification| verification.get("checks"))
        })?;
    let items = signal_items(value)
        .into_iter()
        .take(MAX_OFFICE_UPDATE_ITEMS)
        .filter_map(|item| {
            let mut value = if let Some(text) = item.as_str() {
                json!({ "check": truncate_chars(text, MAX_PROMPT_FIELD_CHARS), "status": "pending" })
            } else {
                let check = update_string(
                    item,
                    &["check", "name", "title", "command", "automationId", "text"],
                )?;
                let status = item
                    .get("status")
                    .and_then(JsonValue::as_str)
                    .map(verification_status)
                    .unwrap_or("pending");
                let status = if status == "passed" && !signal_source_has_backend_evidence(source) {
                    "pending"
                } else {
                    status
                };
                json!({
                    "check": check,
                    "status": status
                })
            };
            copy_update_string(
                item,
                &mut value,
                "criterion",
                &[
                    "criterion",
                    "criteria",
                    "acceptanceCriterion",
                    "acceptance_criterion",
                ],
            );
            copy_update_string(
                item,
                &mut value,
                "criterionId",
                &["criterionId", "criterion_id"],
            );
            copy_update_string(
                item,
                &mut value,
                "acceptanceId",
                &["acceptanceId", "acceptance_id"],
            );
            copy_update_string(item, &mut value, "command", &["command", "cmd"]);
            copy_update_string(item, &mut value, "itemId", &["itemId", "item_id"]);
            copy_update_string(
                item,
                &mut value,
                "automationId",
                &["automationId", "automation_id", "automation"],
            );
            copy_update_string(item, &mut value, "artifact", &["artifact", "path", "file"]);
            copy_update_string(item, &mut value, "evidence", &["evidence", "proof", "result"]);
            copy_update_string(item, &mut value, "source", &["source", "url", "href"]);
            apply_signal_source(&mut value, source);
            Some(value)
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn update_evidence(update: &JsonValue, source: &OfficeSignalSource<'_>) -> Option<JsonValue> {
    let value = update
        .get("evidence")
        .or_else(|| update.get("evidences"))
        .or_else(|| update.get("observations"))
        .or_else(|| update.get("verification"))?;
    let items = signal_items(value)
        .into_iter()
        .take(MAX_OFFICE_UPDATE_ITEMS)
        .filter_map(|item| {
            let mut value = if let Some(text) = item.as_str() {
                json!({ "summary": truncate_chars(text, MAX_PROMPT_FIELD_CHARS), "status": "observed" })
            } else {
                let summary = update_string(
                    item,
                    &["summary", "evidence", "observation", "result", "proof", "text"],
                )?;
                let status = item
                    .get("status")
                    .and_then(JsonValue::as_str)
                    .map(evidence_status)
                    .unwrap_or("observed");
                let status = if status == "verified" && !signal_source_has_backend_evidence(source) {
                    "observed"
                } else {
                    status
                };
                json!({
                    "summary": summary,
                    "status": status
                })
            };
            copy_update_string(item, &mut value, "source", &["source", "file", "command"]);
            copy_update_string(item, &mut value, "url", &["url", "href"]);
            apply_signal_source(&mut value, source);
            Some(value)
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn update_risks(update: &JsonValue, source: &OfficeSignalSource<'_>) -> Option<JsonValue> {
    let value = update.get("risks").or_else(|| update.get("risk"))?;
    let items = signal_items(value)
        .into_iter()
        .take(MAX_OFFICE_UPDATE_ITEMS)
        .filter_map(|item| {
            let mut value = if let Some(text) = item.as_str() {
                json!({ "summary": truncate_chars(text, MAX_PROMPT_FIELD_CHARS), "severity": "medium" })
            } else {
                let summary = update_string(item, &["summary", "risk", "text", "description"])?;
                json!({
                    "summary": summary,
                    "severity": item
                        .get("severity")
                        .or_else(|| item.get("level"))
                        .and_then(JsonValue::as_str)
                        .map(risk_severity)
                        .unwrap_or("medium")
                })
            };
            copy_update_string(item, &mut value, "mitigation", &["mitigation", "nextStep", "next_step"]);
            copy_update_string(item, &mut value, "owner", &["owner", "member", "assignee"]);
            apply_signal_source(&mut value, source);
            Some(value)
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then_some(JsonValue::Array(items))
}

fn signal_items(value: &JsonValue) -> Vec<&JsonValue> {
    match value {
        JsonValue::Array(items) => items.iter().collect(),
        JsonValue::Object(object) => object
            .get("items")
            .and_then(JsonValue::as_array)
            .map(|items| items.iter().collect())
            .unwrap_or_else(|| vec![value]),
        JsonValue::String(_) => vec![value],
        _ => Vec::new(),
    }
}

fn signal_source_has_backend_evidence(source: &OfficeSignalSource<'_>) -> bool {
    matches!(
        source.source_type,
        "automationRun" | "commandExecution" | "fileChange"
    )
}

fn apply_signal_source(value: &mut JsonValue, source: &OfficeSignalSource<'_>) {
    value["sourceType"] = JsonValue::String(source.source_type.to_string());
    value["sourceThreadId"] = JsonValue::String(source.thread_id.to_string());
    value["sourceTurnId"] = JsonValue::String(source.turn_id.to_string());
    value["observedAt"] = JsonValue::String(source.observed_at.to_string());

    let Some(delegation) = source.delegation else {
        return;
    };
    if value.get("member").and_then(JsonValue::as_str).is_none() {
        value["member"] = JsonValue::String(delegation.member.clone());
    }
    if value
        .get("delegationId")
        .and_then(JsonValue::as_str)
        .is_none()
    {
        value["delegationId"] = JsonValue::String(delegation.delegation_id.clone());
    }
    if let Some(agent_id) = delegation.agent_id.as_ref()
        && value.get("agentId").and_then(JsonValue::as_str).is_none()
    {
        value["agentId"] = JsonValue::String(agent_id.clone());
    }
}

fn merge_run_items(run_object: &mut Map<String, JsonValue>, key: &str, incoming: JsonValue) {
    let mut items = run_object
        .get(key)
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let JsonValue::Array(incoming_items) = incoming else {
        return;
    };
    for item in incoming_items.into_iter().rev() {
        let identity = signal_item_identity(&item);
        items.retain(|existing| signal_item_identity(existing) != identity);
        items.insert(0, item);
    }
    items.truncate(MAX_OFFICE_UPDATE_ITEMS);
    run_object.insert(key.to_string(), JsonValue::Array(items));
}

fn apply_tool_evidence_to_verification_checks(
    run_object: &mut Map<String, JsonValue>,
    evidence_items: &[JsonValue],
) {
    let Some(checks) = run_object
        .get_mut("verificationChecks")
        .and_then(JsonValue::as_array_mut)
    else {
        return;
    };
    for evidence in evidence_items {
        if evidence.get("evidenceKind").and_then(JsonValue::as_str) != Some("commandExecution") {
            continue;
        }
        let Some(command) = evidence.get("command").and_then(JsonValue::as_str) else {
            continue;
        };
        let command_key = command_match_key(command);
        let item_id = evidence.get("itemId").and_then(JsonValue::as_str);
        let Some(status) = evidence.get("status").and_then(JsonValue::as_str) else {
            continue;
        };
        let check_status = match status {
            "verified" => "passed",
            "blocked" => "failed",
            _ => continue,
        };
        for check in checks.iter_mut() {
            if !verification_check_matches_command(check, &command_key, item_id) {
                continue;
            }
            let Some(check_object) = check.as_object_mut() else {
                continue;
            };
            check_object.insert(
                "status".to_string(),
                JsonValue::String(check_status.to_string()),
            );
            check_object.insert(
                "command".to_string(),
                JsonValue::String(command.to_string()),
            );
            if let Some(summary) = evidence.get("summary").and_then(JsonValue::as_str) {
                check_object.insert(
                    "evidence".to_string(),
                    JsonValue::String(summary.to_string()),
                );
            }
            for key in [
                "itemId",
                "evidenceKind",
                "source",
                "sourceType",
                "sourceThreadId",
                "sourceTurnId",
                "observedAt",
                "exitCode",
                "durationMs",
                "outputPreview",
                "outputSha256",
                "member",
                "agentId",
                "delegationId",
            ] {
                if let Some(value) = evidence.get(key) {
                    check_object.insert(key.to_string(), value.clone());
                }
            }
        }
    }
}

fn apply_verification_checks_to_acceptance_criteria(run_object: &mut Map<String, JsonValue>) {
    let passed_checks = run_object
        .get("verificationChecks")
        .and_then(JsonValue::as_array)
        .map(|checks| {
            checks
                .iter()
                .filter(|check| check.get("status").and_then(JsonValue::as_str) == Some("passed"))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if passed_checks.is_empty() {
        return;
    }
    let Some(criteria) = run_object
        .get_mut("acceptanceCriteria")
        .and_then(JsonValue::as_array_mut)
    else {
        return;
    };
    for criterion in criteria {
        if criterion.get("status").and_then(JsonValue::as_str) == Some("passed") {
            continue;
        }
        let Some(check) = passed_checks
            .iter()
            .find(|check| verification_check_proves_acceptance(check, criterion))
        else {
            continue;
        };
        let Some(criterion_object) = criterion.as_object_mut() else {
            continue;
        };
        criterion_object.insert(
            "status".to_string(),
            JsonValue::String("passed".to_string()),
        );
        let evidence = check
            .get("evidence")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .or_else(|| {
                check
                    .get("check")
                    .and_then(JsonValue::as_str)
                    .map(|check| format!("Verification check passed: {check}"))
            });
        if let Some(evidence) = evidence {
            criterion_object.insert("evidence".to_string(), JsonValue::String(evidence));
        }
        if let Some(check_text) = check.get("check").and_then(JsonValue::as_str) {
            criterion_object.insert(
                "verifiedByCheck".to_string(),
                JsonValue::String(check_text.to_string()),
            );
        }
        if let Some(item_id) = check.get("itemId").and_then(JsonValue::as_str) {
            criterion_object.insert(
                "verifiedByCheckItemId".to_string(),
                JsonValue::String(item_id.to_string()),
            );
        }
        for key in [
            "source",
            "sourceType",
            "sourceThreadId",
            "sourceTurnId",
            "observedAt",
            "member",
            "agentId",
            "delegationId",
        ] {
            if let Some(value) = check.get(key) {
                criterion_object.insert(key.to_string(), value.clone());
            }
        }
    }
}

fn verification_check_proves_acceptance(check: &JsonValue, criterion: &JsonValue) -> bool {
    if let Some(check_criterion_id) = signal_string(
        check,
        &[
            "criterionId",
            "criterion_id",
            "acceptanceId",
            "acceptance_id",
        ],
    ) {
        return signal_string(
            criterion,
            &[
                "criterionId",
                "criterion_id",
                "acceptanceId",
                "acceptance_id",
                "itemId",
                "item_id",
            ],
        )
        .is_some_and(|criterion_id| {
            signal_text_key(criterion_id) == signal_text_key(check_criterion_id)
        });
    }
    let Some(check_criterion) = signal_string(
        check,
        &[
            "criterion",
            "criteria",
            "acceptanceCriterion",
            "acceptance_criterion",
        ],
    ) else {
        return false;
    };
    criterion
        .get("criterion")
        .and_then(JsonValue::as_str)
        .is_some_and(|criterion| signal_text_key(criterion) == signal_text_key(check_criterion))
}

fn verification_check_matches_command(
    check: &JsonValue,
    command_key: &str,
    item_id: Option<&str>,
) -> bool {
    if let Some(check_item_id) = check.get("itemId").and_then(JsonValue::as_str)
        && item_id == Some(check_item_id)
    {
        return true;
    }
    check
        .get("command")
        .or_else(|| check.get("check"))
        .and_then(JsonValue::as_str)
        .is_some_and(|command| command_match_key(command) == command_key)
}

fn automation_verification_result_from_update(
    update: &JsonValue,
    check: &JsonValue,
) -> Option<AutomationVerificationResult> {
    let value = update
        .get("verificationChecks")
        .or_else(|| update.get("verification_checks"))
        .or_else(|| update.get("checks"))
        .or_else(|| {
            update
                .get("verification")
                .and_then(|verification| verification.get("checks"))
        })?;
    signal_items(value).into_iter().find_map(|item| {
        if !verification_update_matches_check(item, check) {
            return None;
        }
        let status = item.get("status").and_then(JsonValue::as_str)?;
        let status = verification_status(status);
        if !matches!(status, "passed" | "failed") {
            return None;
        }
        Some(AutomationVerificationResult {
            status,
            evidence: update_string(item, &["evidence", "proof", "result", "summary", "text"])
                .map(|evidence| truncate_chars(&evidence, RUN_RESULT_PREVIEW_CHARS)),
        })
    })
}

fn verification_update_matches_check(update: &JsonValue, check: &JsonValue) -> bool {
    if signal_string(update, &["itemId", "item_id", "id", "checkId", "check_id"]).is_some_and(
        |item_id| {
            signal_string(check, &["itemId", "item_id", "id", "checkId", "check_id"])
                .is_some_and(|check_id| signal_text_key(item_id) == signal_text_key(check_id))
        },
    ) {
        return true;
    }
    if signal_string(
        update,
        &[
            "criterionId",
            "criterion_id",
            "acceptanceId",
            "acceptance_id",
        ],
    )
    .is_some_and(|criterion_id| {
        signal_string(
            check,
            &[
                "criterionId",
                "criterion_id",
                "acceptanceId",
                "acceptance_id",
            ],
        )
        .is_some_and(|check_id| signal_text_key(criterion_id) == signal_text_key(check_id))
    }) {
        return true;
    }
    let automation_matches =
        signal_string(update, &["automationId", "automation_id", "automation"]).is_some_and(
            |automation_id| {
                signal_string(check, &["automationId", "automation_id", "automation"]).is_some_and(
                    |check_automation_id| {
                        signal_text_key(automation_id) == signal_text_key(check_automation_id)
                    },
                )
            },
        );
    let check_text_matches = signal_string(update, &["check", "name", "title", "text"])
        .is_some_and(|check_text| {
            signal_string(check, &["check", "name", "title", "text"]).is_some_and(
                |current_check_text| {
                    signal_text_key(check_text) == signal_text_key(current_check_text)
                },
            )
        });
    automation_matches && check_text_matches
}

fn verification_check_matches_automation_turn(
    check: &JsonValue,
    thread_id: &str,
    turn_id: &str,
) -> bool {
    let turn_matches = check
        .get("automationTurnId")
        .or_else(|| check.get("sourceTurnId"))
        .and_then(JsonValue::as_str)
        == Some(turn_id);
    if !turn_matches {
        return false;
    }
    check
        .get("automationThreadId")
        .or_else(|| check.get("sourceThreadId"))
        .and_then(JsonValue::as_str)
        == Some(thread_id)
}

fn automation_verification_evidence_item(
    check: &Map<String, JsonValue>,
    status: &str,
    evidence: &str,
    thread_id: &str,
    turn_id: &str,
    observed_at: &str,
) -> JsonValue {
    let evidence_status = match status {
        "passed" => "verified",
        "failed" => "blocked",
        _ => "observed",
    };
    let item_id = check
        .get("itemId")
        .and_then(JsonValue::as_str)
        .unwrap_or("automation-verification");
    let mut item = json!({
        "summary": truncate_chars(evidence, RUN_RESULT_PREVIEW_CHARS),
        "status": evidence_status,
        "source": check
            .get("automationId")
            .and_then(JsonValue::as_str)
            .unwrap_or("automation"),
        "sourceType": "automationRun",
        "sourceThreadId": thread_id,
        "sourceTurnId": turn_id,
        "observedAt": observed_at,
        "evidenceKind": "automationRun",
        "itemId": item_id
    });
    if let Some(item_object) = item.as_object_mut() {
        for key in [
            "check",
            "criterion",
            "criterionId",
            "acceptanceId",
            "automationId",
            "automationRunId",
            "automationRunFilePath",
            "automationThreadId",
            "automationTurnId",
        ] {
            if let Some(value) = check.get(key) {
                item_object.insert(key.to_string(), value.clone());
            }
        }
    }
    item
}

fn command_match_key(command: &str) -> String {
    command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn signal_text_key(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn signal_string<'a>(value: &'a JsonValue, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn verification_check_has_runnable_reference(check: &JsonValue) -> bool {
    if ["automationTurnId", "automationRunId"].iter().any(|key| {
        check
            .get(*key)
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    }) {
        return false;
    }
    if matches!(
        check.get("dispatchStatus").and_then(JsonValue::as_str),
        Some("queued" | "running" | "canceling" | "completed")
    ) {
        return false;
    }
    ["command", "automationId"].iter().any(|key| {
        check
            .get(key)
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn refresh_run_loop_review(run_object: &mut Map<String, JsonValue>) {
    let loop_iteration = run_loop_iteration(run_object.get("loop"));
    let max_iterations = run_loop_max_iterations(run_object.get("loop"));
    let retry_budget_remaining = max_iterations.saturating_sub(loop_iteration);
    let acceptance_total = run_signal_count(run_object, "acceptanceCriteria", |_| true);
    let acceptance_passed = run_signal_count(run_object, "acceptanceCriteria", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("passed")
    });
    let acceptance_failed = run_signal_count(run_object, "acceptanceCriteria", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("failed")
    });
    let acceptance_pending = acceptance_total.saturating_sub(acceptance_passed + acceptance_failed);
    let verification_total = run_signal_count(run_object, "verificationChecks", |_| true);
    let verification_passed = run_signal_count(run_object, "verificationChecks", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("passed")
    });
    let verification_failed = run_signal_count(run_object, "verificationChecks", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("failed")
    });
    let verification_pending =
        verification_total.saturating_sub(verification_passed + verification_failed);
    let verification_runnable_pending =
        run_signal_count(run_object, "verificationChecks", |item| {
            item.get("status")
                .and_then(JsonValue::as_str)
                .is_none_or(|status| status == "pending")
                && verification_check_has_runnable_reference(item)
        });
    let verification_missing_runnable_pending =
        verification_pending.saturating_sub(verification_runnable_pending);
    let evidence_total = run_signal_count(run_object, "evidence", |_| true);
    let evidence_verified = run_signal_count(run_object, "evidence", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("verified")
    });
    let evidence_blocked = run_signal_count(run_object, "evidence", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("blocked")
    });
    let high_risks = run_signal_count(run_object, "risks", |item| {
        item.get("severity").and_then(JsonValue::as_str) == Some("high")
    });
    let mitigated_high_risks = run_signal_count(run_object, "risks", |item| {
        item.get("severity").and_then(JsonValue::as_str) == Some("high")
            && item
                .get("mitigation")
                .and_then(JsonValue::as_str)
                .is_some_and(|mitigation| !mitigation.trim().is_empty())
    });
    let open_high_risks = high_risks.saturating_sub(mitigated_high_risks);
    let risk_total = run_signal_count(run_object, "risks", |_| true);
    let delegation_total = run_signal_count(run_object, "delegations", |_| true);
    let delegation_queued = run_signal_count(run_object, "delegations", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("queued")
    });
    let delegation_running = run_signal_count(run_object, "delegations", |item| {
        item.get("status").and_then(JsonValue::as_str) == Some("running")
    });
    let delegation_completed = run_signal_count(run_object, "delegations", |item| {
        matches!(
            item.get("status").and_then(JsonValue::as_str),
            Some("completed" | "done")
        )
    });
    let delegation_failed = run_signal_count(run_object, "delegations", |item| {
        matches!(
            item.get("status").and_then(JsonValue::as_str),
            Some("failed" | "interrupted")
        )
    });

    let (status, next_action) = if acceptance_total == 0 {
        ("incomplete", "frameAcceptanceCriteria")
    } else if acceptance_failed > 0 || verification_failed > 0 || evidence_blocked > 0 {
        ("blocked", "repairFailedCriteria")
    } else if verification_runnable_pending > 0 {
        ("needsReview", "runVerificationChecks")
    } else if verification_pending > 0 || acceptance_pending > 0 || evidence_verified == 0 {
        ("needsReview", "collectVerificationEvidence")
    } else if open_high_risks > 0 {
        ("needsReview", "mitigateHighRisks")
    } else {
        ("passed", "readyToSummarize")
    };
    let phase = match next_action {
        "frameAcceptanceCriteria" => "frame",
        "runVerificationChecks" => "verify",
        "collectVerificationEvidence" => "observe",
        "mitigateHighRisks" | "repairFailedCriteria" => "correct",
        "readyToSummarize" => "summarize",
        _ => "observe",
    };
    let stop_status = match status {
        "passed" => "ready",
        "blocked" => "blocked",
        _ if loop_iteration >= max_iterations => "iterationLimit",
        _ => "continue",
    };
    let updated_at = timestamp();

    let review = json!({
        "status": status,
        "nextAction": next_action,
        "acceptance": {
            "total": acceptance_total,
            "passed": acceptance_passed,
            "failed": acceptance_failed,
            "pending": acceptance_pending
        },
        "verification": {
            "total": verification_total,
            "passed": verification_passed,
            "failed": verification_failed,
            "pending": verification_pending,
            "runnablePending": verification_runnable_pending,
            "missingRunnablePending": verification_missing_runnable_pending
        },
        "evidence": {
            "total": evidence_total,
            "verified": evidence_verified,
            "blocked": evidence_blocked
        },
        "risks": {
            "total": risk_total,
            "high": high_risks,
            "openHigh": open_high_risks
        },
        "updatedAt": updated_at
    });
    let metrics = json!({
        "iteration": loop_iteration,
        "maxIterations": max_iterations,
        "retryBudgetRemaining": retry_budget_remaining,
        "acceptance": {
            "total": acceptance_total,
            "passed": acceptance_passed,
            "failed": acceptance_failed,
            "pending": acceptance_pending
        },
        "verification": {
            "total": verification_total,
            "passed": verification_passed,
            "failed": verification_failed,
            "pending": verification_pending,
            "runnablePending": verification_runnable_pending,
            "missingRunnablePending": verification_missing_runnable_pending
        },
        "evidence": {
            "total": evidence_total,
            "verified": evidence_verified,
            "blocked": evidence_blocked
        },
        "risks": {
            "total": risk_total,
            "high": high_risks,
            "openHigh": open_high_risks
        },
        "delegations": {
            "total": delegation_total,
            "queued": delegation_queued,
            "running": delegation_running,
            "completed": delegation_completed,
            "failed": delegation_failed
        },
        "updatedAt": updated_at
    });
    let stop_conditions = json!([
        {
            "condition": "acceptanceCriteriaDefined",
            "met": acceptance_total > 0
        },
        {
            "condition": "allAcceptanceCriteriaPassed",
            "met": acceptance_total > 0 && acceptance_failed == 0 && acceptance_pending == 0
        },
        {
            "condition": "verificationComplete",
            "met": verification_failed == 0 && verification_pending == 0
        },
        {
            "condition": "evidenceCollected",
            "met": evidence_verified > 0
        },
        {
            "condition": "noBlockedEvidence",
            "met": evidence_blocked == 0
        },
        {
            "condition": "noOpenHighRisk",
            "met": open_high_risks == 0
        },
        {
            "condition": "withinIterationLimit",
            "met": loop_iteration <= max_iterations
        },
        {
            "condition": "hasRetryBudget",
            "met": loop_iteration < max_iterations
        }
    ]);
    let loop_value = run_object
        .entry("loop".to_string())
        .or_insert_with(|| json!({ "mode": "officeLoopEngineering" }));
    if !loop_value.is_object() {
        *loop_value = json!({ "mode": "officeLoopEngineering" });
    }
    if let Some(loop_object) = loop_value.as_object_mut() {
        loop_object
            .entry("mode".to_string())
            .or_insert_with(|| JsonValue::String("officeLoopEngineering".to_string()));
        loop_object
            .entry("iteration".to_string())
            .or_insert_with(|| json!(loop_iteration));
        loop_object
            .entry("maxIterations".to_string())
            .or_insert_with(|| json!(max_iterations));
        loop_object.entry("cycle".to_string()).or_insert_with(|| {
            json!([
                "frame",
                "plan",
                "delegate",
                "act",
                "observe",
                "verify",
                "summarize"
            ])
        });
        loop_object
            .entry("memoryPolicy".to_string())
            .or_insert_with(|| JsonValue::String("boundedRetrieval".to_string()));
        loop_object.insert("phase".to_string(), JsonValue::String(phase.to_string()));
        loop_object.insert(
            "status".to_string(),
            JsonValue::String(stop_status.to_string()),
        );
        loop_object.insert("metrics".to_string(), metrics);
        loop_object.insert("stopConditions".to_string(), stop_conditions);
        loop_object.insert("review".to_string(), review);
    }
}

fn refresh_loop_review_for_run(
    config: &mut JsonValue,
    run_id: &str,
) -> Result<(), JSONRPCErrorError> {
    let workspace = workspace_object_mut(config)?;
    let runs = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let Some(run) = find_run_mut(runs, Some(run_id), "") else {
        return Err(invalid_params("runId was not found"));
    };
    let Some(run_object) = run.as_object_mut() else {
        return Err(invalid_params("office run must be an object"));
    };
    apply_verification_checks_to_acceptance_criteria(run_object);
    refresh_run_loop_review(run_object);
    Ok(())
}

fn run_signal_count(
    run_object: &Map<String, JsonValue>,
    key: &str,
    predicate: impl Fn(&JsonValue) -> bool,
) -> usize {
    run_object
        .get(key)
        .and_then(JsonValue::as_array)
        .map(|items| items.iter().filter(|item| predicate(item)).count())
        .unwrap_or(0)
}

fn signal_item_identity(value: &JsonValue) -> String {
    if let Some(item_id) = value.get("itemId").and_then(JsonValue::as_str) {
        return [
            value.get("sourceThreadId").and_then(JsonValue::as_str),
            value.get("sourceTurnId").and_then(JsonValue::as_str),
            value.get("evidenceKind").and_then(JsonValue::as_str),
            Some(item_id),
        ]
        .into_iter()
        .flatten()
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join("|");
    }
    [
        value.get("delegationId").and_then(JsonValue::as_str),
        value.get("member").and_then(JsonValue::as_str),
        value.get("criterion").and_then(JsonValue::as_str),
        value.get("check").and_then(JsonValue::as_str),
        value.get("summary").and_then(JsonValue::as_str),
        value.get("source").and_then(JsonValue::as_str),
    ]
    .into_iter()
    .flatten()
    .map(str::to_ascii_lowercase)
    .collect::<Vec<_>>()
    .join("|")
}

fn copy_update_string(source: &JsonValue, target: &mut JsonValue, target_key: &str, keys: &[&str]) {
    if let Some(value) = update_string(source, keys) {
        target[target_key] = JsonValue::String(value);
    }
}

fn copy_update_bool(source: &JsonValue, target: &mut JsonValue, target_key: &str, keys: &[&str]) {
    let Some(value) = keys.iter().find_map(|key| source.get(*key)) else {
        return;
    };
    match value {
        JsonValue::Bool(value) => target[target_key] = JsonValue::Bool(*value),
        JsonValue::String(value) => {
            let value = value.trim().to_ascii_lowercase();
            if matches!(
                value.as_str(),
                "true" | "yes" | "required" | "manual" | "false" | "no"
            ) {
                target[target_key] = JsonValue::Bool(matches!(
                    value.as_str(),
                    "true" | "yes" | "required" | "manual"
                ));
            }
        }
        _ => {}
    }
}

fn acceptance_status(status: &str) -> &'static str {
    let status = status.trim().to_ascii_lowercase();
    match status.as_str() {
        "passed" | "pass" | "done" | "completed" | "verified" => "passed",
        "failed" | "fail" | "blocked" => "failed",
        _ => "pending",
    }
}

fn verification_status(status: &str) -> &'static str {
    let status = status.trim().to_ascii_lowercase();
    match status.as_str() {
        "passed" | "pass" | "done" | "completed" | "verified" | "success" => "passed",
        "failed" | "fail" | "blocked" | "error" => "failed",
        _ => "pending",
    }
}

fn evidence_status(status: &str) -> &'static str {
    let status = status.trim().to_ascii_lowercase();
    match status.as_str() {
        "verified" | "passed" | "pass" | "done" | "completed" => "verified",
        "blocked" | "failed" | "fail" => "blocked",
        _ => "observed",
    }
}

fn risk_severity(severity: &str) -> &'static str {
    let severity = severity.trim().to_ascii_lowercase();
    match severity.as_str() {
        "low" => "low",
        "high" => "high",
        _ => "medium",
    }
}

fn office_task_status(status: &str) -> &'static str {
    let status = status.trim().to_ascii_lowercase();
    match status.as_str() {
        "done" | "completed" | "complete" => "done",
        "doing" | "running" | "inprogress" | "in_progress" => "doing",
        _ => "todo",
    }
}

fn unix_seconds_timestamp(seconds: i64) -> Option<String> {
    chrono::DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn update_run_status(
    config: &mut JsonValue,
    run_id: &str,
    status: &str,
    extra_field: Option<(&str, JsonValue)>,
    error: Option<String>,
) -> Result<(), JSONRPCErrorError> {
    let now = timestamp();
    let Some(runs) = workspace_object_mut(config)?
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
    else {
        return Err(invalid_params("workspace.activity.runs must be an array"));
    };
    let Some(run) = runs
        .iter_mut()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
    else {
        return Err(invalid_params("runId was not found"));
    };
    let Some(run_object) = run.as_object_mut() else {
        return Err(invalid_params("office run must be an object"));
    };
    run_object.insert("status".to_string(), JsonValue::String(status.to_string()));
    run_object.insert("updatedAt".to_string(), JsonValue::String(now.clone()));
    if status != "queued" {
        clear_child_dispatch_lease(run_object);
    }
    if let Some((key, value)) = extra_field {
        run_object.insert(key.to_string(), value);
    }
    if let Some(error) = error {
        run_object.insert("error".to_string(), JsonValue::String(error));
    }

    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("office config must be an object"));
    };
    config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    Ok(())
}

fn workspace_object_mut(
    config: &mut JsonValue,
) -> Result<&mut Map<String, JsonValue>, JSONRPCErrorError> {
    config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))
}

fn array_entry<'a>(
    object: &'a mut Map<String, JsonValue>,
    key: &str,
    message: &str,
) -> Result<&'a mut Vec<JsonValue>, JSONRPCErrorError> {
    let entry = object
        .entry(key.to_string())
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    entry.as_array_mut().ok_or_else(|| invalid_params(message))
}

fn build_office_run_prompt(
    config: &JsonValue,
    text: &str,
    locale: Option<&str>,
    memory_context: &str,
) -> String {
    let is_zh = locale != Some("en");
    let title = config
        .get("title")
        .and_then(JsonValue::as_str)
        .map(|title| truncate_chars(title, MAX_PROMPT_TITLE_CHARS))
        .unwrap_or_else(|| "Office".to_string());
    let goal = config
        .get("workspace")
        .and_then(|workspace| workspace.get("goal"))
        .and_then(JsonValue::as_str)
        .map(|goal| truncate_chars(goal, MAX_PROMPT_FIELD_CHARS))
        .unwrap_or_else(|| title.clone());
    let members = prompt_members(config, is_zh);
    let delegation_routes = prompt_delegation_routes(config, is_zh);
    let tasks = prompt_tasks(config, is_zh);
    let memories = if memory_context.trim().is_empty() {
        if is_zh {
            "长期记忆：暂无可用的已接受记忆。".to_string()
        } else {
            "Long-term memories: no accepted memories are available.".to_string()
        }
    } else {
        memory_context.to_string()
    };
    let text = truncate_chars(text, MAX_PROMPT_TEXT_CHARS);
    let verification_linking_note = if is_zh {
        "\n\n验证结构补充：acceptanceCriteria 可写 criterionId 作为稳定验收 id；verificationChecks 如果验证某条验收标准，必须写 criterion、criterionId 或 acceptanceId 之一，例如 {\"check\":\"运行测试\",\"criterionId\":\"criteria-tests\",\"status\":\"passed\",\"command\":\"just test\",\"evidence\":\"真实工具证据\"}。没有真实工具证据不要把 status 写成 passed。"
    } else {
        "\n\nVerification schema supplement: acceptanceCriteria may include criterionId as a stable acceptance id; when verificationChecks prove an acceptance criterion, include criterion, criterionId, or acceptanceId, for example {\"check\":\"Run tests\",\"criterionId\":\"criteria-tests\",\"status\":\"passed\",\"command\":\"just test\",\"evidence\":\"real tool evidence\"}. Do not mark passed without real tool evidence."
    };

    let mut prompt = if is_zh {
        format!(
            "你是「{title}」办公室的主控智能体，负责接收群聊信息、识别是否形成任务、规划下一步，并在有必要时派发给成员。\n\n目标：{goal}\n\n成员（有边界上限）：\n{members}\n\n委派路由（有边界上限）：\n{delegation_routes}\n\n当前任务（有边界上限）：\n{tasks}\n\n{memories}\n\n本次用户请求：\n{text}\n\n执行要求：\n1. 使用 Loop Engineering 循环：先 frame 目标和验收标准，再判断群聊消息是在提问、催办、补充背景还是提出新目标，然后 plan，必要时 delegate，执行后 observe 证据，verify 结果，最后 summarize。\n2. 不要把每一句群聊消息都当成任务；只有明确可执行、需要跟踪的工作才写入 officeUpdate.tasks。任务看板是规范状态，更新时要合并现有任务，避免重复。\n3. 如果现有 multi-agent 工具可用，并且并行执行能实际推进工作，可以派发清晰、互不重叠、可验证的子任务；有匹配委派路由时，优先用列出的 exact target 调用 followup_task 或 send_message，再考虑匿名 spawn_agent；不要为了形式而派发。\n4. 保持办公室状态可追踪：说明正在做什么、谁负责、下一步、证据和风险。\n5. 长期记忆只作为可追溯背景；如果与当前用户请求或工具事实冲突，以当前请求和工具事实为准。\n6. 所有工具调用必须遵守当前 thread 的权限、审批和沙箱策略。\n7. 最终回复请先给用户可执行结论和验证方式；如果办公室状态有更新，请在末尾追加一个 fenced JSON 块，形如：\n```json\n{{\"officeUpdate\":{{\"summary\":\"一句话结果\",\"goalUpdate\":\"可选目标更新\",\"plan\":[{{\"step\":\"步骤\",\"status\":\"pending|inProgress|completed\"}}],\"acceptanceCriteria\":[{{\"criterion\":\"验收标准\",\"status\":\"pending|passed|failed\",\"evidence\":\"可选证据\"}}],\"verificationChecks\":[{{\"check\":\"验证项\",\"status\":\"pending|passed|failed\",\"command\":\"可选命令\",\"evidence\":\"可选证据\"}}],\"evidence\":[{{\"summary\":\"观察到的证据\",\"status\":\"observed|verified|blocked\",\"source\":\"可选来源\"}}],\"risks\":[{{\"summary\":\"风险\",\"severity\":\"low|medium|high\",\"mitigation\":\"缓解方式\"}}],\"tasks\":[{{\"title\":\"任务\",\"owner\":\"成员名\",\"status\":\"todo|doing|done\"}}],\"artifacts\":[{{\"title\":\"产物\",\"kind\":\"doc|code|screenshot|diff\",\"meta\":\"短说明\"}}],\"delegations\":[{{\"member\":\"成员名\",\"agentId\":\"可选 agentId\",\"task\":\"派发任务\",\"status\":\"running|done|blocked\",\"dispatchMode\":\"auto|manual\",\"riskSeverity\":\"low|medium|high\",\"approvalRequired\":false,\"threadId\":\"可选子线程\",\"target\":\"可选工具 target\",\"tool\":\"followup_task|send_message|spawn_agent\"}}],\"memories\":[{{\"scope\":\"office|member|project|user\",\"member\":\"可选成员名\",\"agentId\":\"可选 agentId\",\"kind\":\"decision|fact|preference|lesson|artifact|runSummary\",\"content\":\"应长期保留的短事实\",\"confidence\":\"low|medium|high\",\"status\":\"accepted|pending|rejected\"}}]}}}}\n```\n所有数组最多 12 项，delegations 最多 8 项，memories 最多 8 项，字段保持短文本。只有确实应长期复用的事实才写 memories。"
        )
    } else {
        format!(
            "You are the manager agent for the \"{title}\" office. Receive group-chat input, decide whether it creates actionable work, plan next steps, and dispatch to members when useful.\n\nGoal: {goal}\n\nMembers (bounded):\n{members}\n\nDelegation routes (bounded):\n{delegation_routes}\n\nCurrent tasks (bounded):\n{tasks}\n\n{memories}\n\nUser request:\n{text}\n\nExecution contract:\n1. Use a Loop Engineering cycle: frame the goal and acceptance criteria, decide whether the group-chat message is a question, status nudge, added context, or new goal, then plan, delegate when useful, act, observe evidence, verify the result, and summarize.\n2. Do not treat every chat message as a task; only write clear, trackable actionable work into officeUpdate.tasks. The task board is canonical state, so merge with existing tasks and avoid duplicates.\n3. If multi-agent tools are available and parallel work materially helps, delegate concrete, non-overlapping, verifiable subtasks; when a matching delegation route is listed, use its exact target with followup_task or send_message before considering an anonymous spawn_agent, and do not delegate just for show.\n4. Keep office state trackable: state what is happening, who owns it, next steps, evidence, and risks.\n5. Treat long-term memories as cited background only; current user requests and fresh tool facts override memory conflicts.\n6. All tool calls must follow this thread's permission, approval, and sandbox policy.\n7. In the final response, first include the actionable result and verification path. If office state changed, append a fenced JSON block with this shape:\n```json\n{{\"officeUpdate\":{{\"summary\":\"one-line result\",\"goalUpdate\":\"optional goal update\",\"plan\":[{{\"step\":\"step\",\"status\":\"pending|inProgress|completed\"}}],\"acceptanceCriteria\":[{{\"criterion\":\"acceptance criterion\",\"status\":\"pending|passed|failed\",\"evidence\":\"optional proof\"}}],\"verificationChecks\":[{{\"check\":\"verification check\",\"status\":\"pending|passed|failed\",\"command\":\"optional command\",\"evidence\":\"optional proof\"}}],\"evidence\":[{{\"summary\":\"observed evidence\",\"status\":\"observed|verified|blocked\",\"source\":\"optional source\"}}],\"risks\":[{{\"summary\":\"risk\",\"severity\":\"low|medium|high\",\"mitigation\":\"mitigation\"}}],\"tasks\":[{{\"title\":\"task\",\"owner\":\"member name\",\"status\":\"todo|doing|done\"}}],\"artifacts\":[{{\"title\":\"artifact\",\"kind\":\"doc|code|screenshot|diff\",\"meta\":\"short note\"}}],\"delegations\":[{{\"member\":\"member name\",\"agentId\":\"optional agentId\",\"task\":\"delegated task\",\"status\":\"running|done|blocked\",\"dispatchMode\":\"auto|manual\",\"riskSeverity\":\"low|medium|high\",\"approvalRequired\":false,\"threadId\":\"optional child thread\",\"target\":\"optional tool target\",\"tool\":\"followup_task|send_message|spawn_agent\"}}],\"memories\":[{{\"scope\":\"office|member|project|user\",\"member\":\"optional member name\",\"agentId\":\"optional agentId\",\"kind\":\"decision|fact|preference|lesson|artifact|runSummary\",\"content\":\"short durable fact\",\"confidence\":\"low|medium|high\",\"status\":\"accepted|pending|rejected\"}}]}}}}\n```\nKeep arrays to at most 12 items, delegations to at most 8 items, memories to at most 8 items, and fields short. Only write memories for facts that should be reused in future runs."
        )
    };
    prompt.push_str(verification_linking_note);
    prompt
}

fn delegation_routes(config: &JsonValue) -> Vec<JsonValue> {
    let Some(members) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    else {
        return Vec::new();
    };
    members
        .iter()
        .take(MAX_DELEGATION_ROUTES)
        .filter_map(delegation_route)
        .collect()
}

fn find_delegation_route<'a>(
    routes: &'a [JsonValue],
    member: Option<&str>,
    agent_id: Option<&str>,
) -> Result<&'a JsonValue, JSONRPCErrorError> {
    let member = member.map(str::trim).filter(|member| !member.is_empty());
    let agent_id = agent_id
        .map(str::trim)
        .filter(|agent_id| !agent_id.is_empty());
    if member.is_none() && agent_id.is_none() {
        return Err(invalid_params("member or agentId is required"));
    }
    routes
        .iter()
        .find(|route| delegation_route_matches(route, member, agent_id))
        .ok_or_else(|| invalid_params("no delegation route matches member or agentId"))
}

fn delegation_route(member: &JsonValue) -> Option<JsonValue> {
    let name = member.get("name").and_then(JsonValue::as_str)?;
    let agent_id = member
        .get("agentId")
        .and_then(JsonValue::as_str)
        .or_else(|| member.get("agent_id").and_then(JsonValue::as_str))?;
    let runtime = member.get("runtime");
    let thread_id = runtime
        .and_then(|runtime| runtime.get("threadId"))
        .and_then(JsonValue::as_str)
        .or_else(|| member.get("threadId").and_then(JsonValue::as_str))
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())?;
    let context_policy = runtime
        .and_then(|runtime| runtime.get("contextPolicy"))
        .and_then(JsonValue::as_str)
        .unwrap_or("sharedDigest");
    let memory_scope = runtime
        .and_then(|runtime| runtime.get("memoryScope"))
        .and_then(JsonValue::as_str)
        .unwrap_or("privateAndShared");
    let agent_profile = runtime
        .and_then(|runtime| runtime.get("agentProfile"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|profile| !profile.is_empty());
    let mut route = json!({
        "member": truncate_chars(name, MAX_PROMPT_TITLE_CHARS),
        "agentId": truncate_chars(agent_id, MAX_PROMPT_FIELD_CHARS),
        "threadId": truncate_chars(thread_id, MAX_PROMPT_FIELD_CHARS),
        "target": truncate_chars(thread_id, MAX_PROMPT_FIELD_CHARS),
        "targetKind": "runtimeThread",
        "tool": "followup_task",
        "contextPolicy": truncate_chars(context_policy, MAX_PROMPT_TITLE_CHARS),
        "memoryScope": truncate_chars(memory_scope, MAX_PROMPT_TITLE_CHARS)
    });
    if let Some(agent_profile) = agent_profile {
        route["agentProfile"] =
            JsonValue::String(truncate_chars(agent_profile, /*max_chars*/ 640));
    }
    Some(route)
}

fn build_office_delegation_prompt(params: OfficeDelegationPromptParams<'_>) -> String {
    let OfficeDelegationPromptParams {
        config,
        run_id,
        member,
        agent_id,
        task,
        route,
        locale,
        memory_context,
    } = params;
    let is_zh = locale != Some("en");
    let title = config
        .get("title")
        .and_then(JsonValue::as_str)
        .map(|title| truncate_chars(title, MAX_PROMPT_TITLE_CHARS))
        .unwrap_or_else(|| "Office".to_string());
    let goal = config
        .get("workspace")
        .and_then(|workspace| workspace.get("goal"))
        .and_then(JsonValue::as_str)
        .map(|goal| truncate_chars(goal, MAX_PROMPT_FIELD_CHARS))
        .unwrap_or_else(|| title.clone());
    let target = route
        .get("target")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let context_policy = route
        .get("contextPolicy")
        .and_then(JsonValue::as_str)
        .unwrap_or("sharedDigest");
    let memory_scope = route
        .get("memoryScope")
        .and_then(JsonValue::as_str)
        .unwrap_or("privateAndShared");
    let agent_profile = route
        .get("agentProfile")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|profile| !profile.is_empty())
        .map(|profile| truncate_chars(profile, /*max_chars*/ 640))
        .unwrap_or_else(|| {
            if is_zh {
                "未保存可用的 Agent profile。".to_string()
            } else {
                "No saved agent profile is available.".to_string()
            }
        });
    let memories = if memory_context.trim().is_empty() {
        if is_zh {
            "成员任务长期记忆：暂无可用的已接受记忆。".to_string()
        } else {
            "Member task long-term memories: no accepted memories are available.".to_string()
        }
    } else {
        memory_context.to_string()
    };
    let shared_context =
        office_context::member_shared_context(config, run_id, context_policy, is_zh);
    let task = truncate_chars(task, MAX_PROMPT_TEXT_CHARS);
    let verification_linking_note = if is_zh {
        "\n\n验证结构补充：acceptanceCriteria 可写 criterionId；verificationChecks 如果验证某条验收标准，必须写 criterion、criterionId 或 acceptanceId 之一，例如 {\"check\":\"运行成员验证\",\"criterionId\":\"criteria-tests\",\"status\":\"passed\",\"command\":\"just test\",\"evidence\":\"真实工具证据\"}。没有真实工具证据不要把 status 写成 passed。"
    } else {
        "\n\nVerification schema supplement: acceptanceCriteria may include criterionId; when verificationChecks prove an acceptance criterion, include criterion, criterionId, or acceptanceId, for example {\"check\":\"Run member verification\",\"criterionId\":\"criteria-tests\",\"status\":\"passed\",\"command\":\"just test\",\"evidence\":\"real tool evidence\"}. Do not mark passed without real tool evidence."
    };

    let mut prompt = if is_zh {
        format!(
            "你是「{title}」办公室成员 {member}（agentId={agent_id}）。\n\n办公室目标：{goal}\n办公室 run：{run_id}\n派发 target：{target}\n上下文策略：{context_policy}\n记忆范围：{memory_scope}\nAgent profile（有边界上限）：{agent_profile}\n\n{shared_context}\n\n{memories}\n\n派发任务：\n{task}\n\n执行要求：使用 Loop Engineering 小循环：frame 验收标准，plan，act，observe 证据，verify，最后 summarize。只在当前成员线程内执行；遵守本线程权限、审批和沙箱策略。长期记忆和共享摘要只作为可追溯背景；若与本任务、Agent profile 或工具事实冲突，以本任务和工具事实为准。最终回复包含结果、证据、风险和下一步。若有共享状态更新，请追加 fenced JSON：{{\"officeUpdate\":{{\"summary\":\"一句话结果\",\"acceptanceCriteria\":[{{\"criterion\":\"验收标准\",\"status\":\"passed|failed|pending\",\"evidence\":\"证据\"}}],\"verificationChecks\":[{{\"check\":\"验证项\",\"status\":\"pending|passed|failed\",\"command\":\"可选命令\",\"evidence\":\"证据\"}}],\"evidence\":[{{\"summary\":\"证据\",\"status\":\"observed|verified|blocked\",\"source\":\"来源\"}}],\"risks\":[{{\"summary\":\"风险\",\"severity\":\"low|medium|high\",\"mitigation\":\"缓解\"}}],\"tasks\":[{{\"title\":\"任务\",\"owner\":\"{member}\",\"status\":\"todo|doing|done\"}}],\"artifacts\":[{{\"title\":\"产物\",\"kind\":\"doc|code|screenshot|diff\",\"meta\":\"短说明\"}}],\"memories\":[{{\"scope\":\"office|member|project|user\",\"member\":\"可选成员名\",\"agentId\":\"可选 agentId\",\"kind\":\"decision|fact|preference|lesson|artifact|runSummary\",\"content\":\"应长期保留的短事实\",\"confidence\":\"low|medium|high\",\"status\":\"accepted|pending|rejected\"}}]}}}}。"
        )
    } else {
        format!(
            "You are Office member {member} (agentId={agent_id}) for the \"{title}\" office.\n\nOffice goal: {goal}\nOffice run: {run_id}\nDispatch target: {target}\nContext policy: {context_policy}\nMemory scope: {memory_scope}\nAgent profile (bounded): {agent_profile}\n\n{shared_context}\n\n{memories}\n\nDelegated task:\n{task}\n\nExecution contract: use a small Loop Engineering cycle: frame acceptance criteria, plan, act, observe evidence, verify, then summarize. Work inside this member thread only; follow this thread's permission, approval, and sandbox policy. Treat long-term memories and shared digests as cited background only; this task and fresh tool facts override memory, shared digest, or agent-profile conflicts. Final response should include result, evidence, risks, and next steps. If shared office state changed, append fenced JSON: {{\"officeUpdate\":{{\"summary\":\"one-line result\",\"acceptanceCriteria\":[{{\"criterion\":\"criterion\",\"status\":\"passed|failed|pending\",\"evidence\":\"proof\"}}],\"verificationChecks\":[{{\"check\":\"verification check\",\"status\":\"pending|passed|failed\",\"command\":\"optional command\",\"evidence\":\"proof\"}}],\"evidence\":[{{\"summary\":\"evidence\",\"status\":\"observed|verified|blocked\",\"source\":\"source\"}}],\"risks\":[{{\"summary\":\"risk\",\"severity\":\"low|medium|high\",\"mitigation\":\"mitigation\"}}],\"tasks\":[{{\"title\":\"task\",\"owner\":\"{member}\",\"status\":\"todo|doing|done\"}}],\"artifacts\":[{{\"title\":\"artifact\",\"kind\":\"doc|code|screenshot|diff\",\"meta\":\"short note\"}}],\"memories\":[{{\"scope\":\"office|member|project|user\",\"member\":\"optional member name\",\"agentId\":\"optional agentId\",\"kind\":\"decision|fact|preference|lesson|artifact|runSummary\",\"content\":\"short durable fact\",\"confidence\":\"low|medium|high\",\"status\":\"accepted|pending|rejected\"}}]}}}}."
        )
    };
    prompt.push_str(verification_linking_note);
    prompt
}

fn prompt_delegation_routes(config: &JsonValue, is_zh: bool) -> String {
    let lines = delegation_routes(config)
        .into_iter()
        .filter_map(|route| {
            let member = route.get("member").and_then(JsonValue::as_str)?;
            let agent_id = route.get("agentId").and_then(JsonValue::as_str)?;
            let target = route.get("target").and_then(JsonValue::as_str)?;
            let context_policy = route
                .get("contextPolicy")
                .and_then(JsonValue::as_str)
                .unwrap_or("sharedDigest");
            let memory_scope = route
                .get("memoryScope")
                .and_then(JsonValue::as_str)
                .unwrap_or("privateAndShared");
            let agent_profile = route
                .get("agentProfile")
                .and_then(JsonValue::as_str)
                .map(|profile| truncate_chars(profile, MAX_PROMPT_FIELD_CHARS))
                .unwrap_or_else(|| "none".to_string());
            Some(format!(
                "- {member}: agentId={agent_id}, tool=followup_task, target={target}, targetKind=runtimeThread, contextPolicy={context_policy}, memoryScope={memory_scope}, agentProfile={agent_profile}"
            ))
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        if is_zh {
            "- 暂无可用的成员 runtime 路由；需要委派时只能创建一次性子 agent。".to_string()
        } else {
            "- No member runtime routes are available; create one-off sub-agents only when delegation is useful.".to_string()
        }
    } else {
        lines.join("\n")
    }
}

fn prompt_members(config: &JsonValue, is_zh: bool) -> String {
    let Some(members) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    else {
        return if is_zh {
            "- 尚未保存成员".to_string()
        } else {
            "- No saved members".to_string()
        };
    };
    let lines = members
        .iter()
        .take(MAX_PROMPT_MEMBERS)
        .filter_map(|member| {
            let name = member.get("name").and_then(JsonValue::as_str)?;
            let role = member
                .get("role")
                .and_then(JsonValue::as_str)
                .unwrap_or("member");
            let status = member
                .get("status")
                .and_then(JsonValue::as_str)
                .unwrap_or("unknown");
            let agent_id = member
                .get("agentId")
                .and_then(JsonValue::as_str)
                .or_else(|| member.get("agent_id").and_then(JsonValue::as_str))
                .unwrap_or("none");
            let runtime = member.get("runtime");
            let runtime_thread_id = runtime
                .and_then(|runtime| runtime.get("threadId"))
                .and_then(JsonValue::as_str)
                .or_else(|| member.get("threadId").and_then(JsonValue::as_str))
                .unwrap_or("none");
            let context_policy = runtime
                .and_then(|runtime| runtime.get("contextPolicy"))
                .and_then(JsonValue::as_str)
                .unwrap_or("sharedDigest");
            let memory_scope = runtime
                .and_then(|runtime| runtime.get("memoryScope"))
                .and_then(JsonValue::as_str)
                .unwrap_or("privateAndShared");
            let agent_profile = runtime
                .and_then(|runtime| runtime.get("agentProfile"))
                .and_then(JsonValue::as_str)
                .map(|profile| truncate_chars(profile, MAX_PROMPT_FIELD_CHARS))
                .unwrap_or_else(|| "none".to_string());
            Some(format!(
                "- {}: role={}, status={}, agentId={}, runtimeThreadId={}, contextPolicy={}, memoryScope={}, agentProfile={}",
                truncate_chars(name, MAX_PROMPT_TITLE_CHARS),
                truncate_chars(role, MAX_PROMPT_FIELD_CHARS),
                truncate_chars(status, MAX_PROMPT_TITLE_CHARS),
                truncate_chars(agent_id, MAX_PROMPT_FIELD_CHARS),
                truncate_chars(runtime_thread_id, MAX_PROMPT_FIELD_CHARS),
                truncate_chars(context_policy, MAX_PROMPT_TITLE_CHARS),
                truncate_chars(memory_scope, MAX_PROMPT_TITLE_CHARS),
                agent_profile
            ))
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        if is_zh {
            "- 尚未保存成员".to_string()
        } else {
            "- No saved members".to_string()
        }
    } else {
        lines.join("\n")
    }
}

fn prompt_tasks(config: &JsonValue, is_zh: bool) -> String {
    let Some(tasks) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("tasks"))
        .and_then(JsonValue::as_array)
    else {
        return if is_zh {
            "- 暂无任务".to_string()
        } else {
            "- No tasks".to_string()
        };
    };
    let lines = tasks
        .iter()
        .take(MAX_PROMPT_TASKS)
        .filter_map(|task| {
            let title = task.get("title").and_then(JsonValue::as_str)?;
            let owner = task
                .get("owner")
                .and_then(JsonValue::as_str)
                .unwrap_or("Team");
            let status = task
                .get("status")
                .and_then(JsonValue::as_str)
                .unwrap_or("todo");
            Some(format!(
                "- [{}] {} ({})",
                truncate_chars(status, MAX_PROMPT_TITLE_CHARS),
                truncate_chars(title, MAX_PROMPT_FIELD_CHARS),
                truncate_chars(owner, MAX_PROMPT_TITLE_CHARS)
            ))
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        if is_zh {
            "- 暂无任务".to_string()
        } else {
            "- No tasks".to_string()
        }
    } else {
        lines.join("\n")
    }
}

fn run_title(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or(text);
    let title = truncate_chars(first_line, MAX_PROMPT_TITLE_CHARS);
    if title.is_empty() {
        "Office run".to_string()
    } else {
        title
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    let mut chars = value.chars();
    let mut truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}

fn timestamp() -> String {
    timestamp_from_datetime(Utc::now())
}

fn timestamp_from_datetime(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
#[path = "crewon_domain_office_run_tests.rs"]
mod tests;
