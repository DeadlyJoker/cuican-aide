use chrono::DateTime;
use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeMemoryDecideParams;
use crewon_app_server_protocol::OfficeMemoryDecideResponse;
use crewon_app_server_protocol::OfficeMemoryEvidenceRef as ProtocolOfficeMemoryEvidenceRef;
use crewon_app_server_protocol::OfficeMemoryListParams;
use crewon_app_server_protocol::OfficeMemoryListResponse;
use crewon_app_server_protocol::OfficeMemoryRecord;
use crewon_app_server_protocol::Turn;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use serde_json::json;
use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use tokio::fs;
use tokio::time::Duration;
use tokio::time::sleep;
use uuid::Uuid;

use super::super::DomainKind;
use super::super::domain_directory;
use super::super::map_io_error;
use super::super::read_record;
use super::super::save_record;
use super::super::slugify;
use super::OfficeRunSyncDetails;
use super::office_update_from_turn;
use super::timestamp;
use super::truncate_chars;
use super::update_string;
use super::workspace_object_mut;
use crate::error_code::invalid_params;

const MAX_PROMPT_TITLE_CHARS: usize = 80;
const MAX_PROMPT_FIELD_CHARS: usize = 160;
const MAX_PROMPT_MEMORIES: usize = 6;
const MAX_MEMORY_CONTENT_CHARS: usize = 360;
const MAX_MEMORY_KEYWORDS: usize = 16;
const MAX_OFFICE_MEMORY_ITEMS: usize = 1_000;
const MAX_OFFICE_MEMORY_REFERENCE_SCAN: usize = 500;
const DEFAULT_MEMORY_LIST_LIMIT: usize = 24;
const MAX_MEMORY_LIST_LIMIT: usize = 100;
const OFFICE_MEMORY_DIRECTORY: &str = "office-memory";
const OFFICE_MEMORY_INDEX_FILE: &str = "index.json";
const OFFICE_MEMORY_LOCK_FILE: &str = "index.lock";

#[derive(Default)]
pub(super) struct OfficeMemoryPromptContext {
    pub(super) prompt: String,
    pub(super) refs: Option<JsonValue>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeMemoryIndex {
    version: u32,
    memories: Vec<OfficeMemoryEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficeMemoryEntry {
    id: String,
    office_key: String,
    scope: String,
    member: Option<String>,
    agent_id: Option<String>,
    kind: String,
    content: String,
    confidence: String,
    #[serde(default = "default_memory_importance")]
    importance: String,
    status: String,
    evidence_refs: Vec<OfficeMemoryEvidenceRef>,
    keywords: Vec<String>,
    created_at: String,
    updated_at: String,
    last_used_at: Option<String>,
    usage_count: u32,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OfficeMemoryEvidenceRef {
    run_id: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
}

struct OfficeMemoryCandidate {
    scope: String,
    member: Option<String>,
    agent_id: Option<String>,
    kind: String,
    content: String,
    confidence: String,
    importance: String,
    status: String,
}

pub(super) async fn build_prompt_context(
    cwd: &str,
    config: &JsonValue,
    text: &str,
    locale: Option<&str>,
) -> Result<OfficeMemoryPromptContext, JSONRPCErrorError> {
    build_prompt_context_for_audience(
        cwd,
        config,
        text,
        locale,
        &OfficeMemoryPromptAudience::Office,
    )
    .await
}

pub(super) async fn build_member_prompt_context(
    cwd: &str,
    config: &JsonValue,
    text: &str,
    member: &str,
    agent_id: &str,
    memory_scope: &str,
    locale: Option<&str>,
) -> Result<OfficeMemoryPromptContext, JSONRPCErrorError> {
    build_prompt_context_for_audience(
        cwd,
        config,
        text,
        locale,
        &OfficeMemoryPromptAudience::Member {
            member,
            agent_id,
            memory_scope,
        },
    )
    .await
}

enum OfficeMemoryPromptAudience<'a> {
    Office,
    Member {
        member: &'a str,
        agent_id: &'a str,
        memory_scope: &'a str,
    },
}

pub(super) async fn list(
    params: OfficeMemoryListParams,
) -> Result<OfficeMemoryListResponse, JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(&params.config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    let offset = parse_memory_cursor(params.cursor)?;
    let limit = normalize_memory_limit(params.limit);
    let status = match params.status.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(status) if is_valid_memory_status(status) => Some(status.to_string()),
        Some(_) => return Err(invalid_params("office memory status is invalid")),
    };
    let office_key = office_memory_key(&params.config);
    let mut memories = read_office_memory_index(&params.cwd)
        .await?
        .memories
        .into_iter()
        .filter(|entry| entry.office_key == office_key)
        .filter(|entry| {
            status
                .as_deref()
                .is_none_or(|status| entry.status == status)
        })
        .collect::<Vec<_>>();
    memories.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    let next_cursor = if memories.len() > offset + limit {
        Some((offset + limit).to_string())
    } else {
        None
    };
    let data = memories
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(office_memory_record)
        .collect();
    Ok(OfficeMemoryListResponse { data, next_cursor })
}

pub(super) async fn decide(
    params: OfficeMemoryDecideParams,
) -> Result<OfficeMemoryDecideResponse, JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(&params.config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    let memory_id = params.memory_id.trim();
    if memory_id.is_empty() {
        return Err(invalid_params("memoryId must not be empty"));
    }
    let status = params.status.trim();
    if !is_valid_memory_status(status) {
        return Err(invalid_params("office memory status is invalid"));
    }

    let lock = acquire_office_memory_lock(&params.cwd).await?;
    let mut index = read_office_memory_index(&params.cwd).await?;
    let office_key = office_memory_key(&params.config);
    let Some(memory) = index
        .memories
        .iter_mut()
        .find(|entry| entry.id == memory_id && entry.office_key == office_key)
    else {
        return Err(invalid_params("office memory was not found"));
    };
    memory.status = status.to_string();
    memory.updated_at = timestamp();
    let memory = memory.clone();
    write_office_memory_index(&params.cwd, &index).await?;
    drop(lock);
    propagate_memory_ref_decision(&params.cwd, &office_key, &memory).await?;
    Ok(OfficeMemoryDecideResponse {
        memory: office_memory_record(memory),
    })
}

async fn propagate_memory_ref_decision(
    cwd: &str,
    office_key: &str,
    memory: &OfficeMemoryEntry,
) -> Result<(), JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(map_io_error(err)),
    };

    let mut scanned = 0usize;
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        if scanned >= MAX_OFFICE_MEMORY_REFERENCE_SCAN {
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
        let mut config = record.config;
        if office_memory_key(&config) != office_key {
            continue;
        }
        if update_config_memory_refs(&mut config, memory) {
            if let Some(config_object) = config.as_object_mut() {
                config_object.insert("updatedAt".to_string(), JsonValue::String(timestamp()));
            }
            save_record(DomainKind::Office, cwd, config).await?;
        }
    }

    Ok(())
}

async fn build_prompt_context_for_audience(
    cwd: &str,
    config: &JsonValue,
    text: &str,
    locale: Option<&str>,
    audience: &OfficeMemoryPromptAudience<'_>,
) -> Result<OfficeMemoryPromptContext, JSONRPCErrorError> {
    let office_key = office_memory_key(config);
    let mut entries = read_office_memory_index(cwd)
        .await?
        .memories
        .into_iter()
        .filter(|entry| {
            entry.office_key == office_key
                && entry.status == "accepted"
                && memory_visible_to_audience(entry, audience)
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return Ok(OfficeMemoryPromptContext::default());
    }

    let query_terms = tokenize_memory_text(text);
    entries.sort_by(|left, right| {
        let right_score = memory_retrieval_score(right, &query_terms, audience);
        let left_score = memory_retrieval_score(left, &query_terms, audience);
        right_score
            .cmp(&left_score)
            .then_with(|| right.last_used_at.cmp(&left.last_used_at))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    let selected = entries
        .into_iter()
        .take(MAX_PROMPT_MEMORIES)
        .collect::<Vec<_>>();
    let selected_ids = selected
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    touch_office_memory_usage(cwd, &selected_ids).await?;

    let is_zh = locale != Some("en");
    let lines = selected
        .iter()
        .map(|entry| {
            let mut tags = vec![entry.scope.as_str(), entry.kind.as_str()];
            if let Some(member) = entry.member.as_deref() {
                tags.push(member);
            }
            format!(
                "- [{}] {}",
                tags.join("/"),
                truncate_chars(&entry.content, MAX_MEMORY_CONTENT_CHARS)
            )
        })
        .collect::<Vec<_>>();
    let prompt = if is_zh {
        format!("{}：\n{}", memory_heading(audience, true), lines.join("\n"))
    } else {
        format!("{}:\n{}", memory_heading(audience, false), lines.join("\n"))
    };
    let refs = JsonValue::Array(selected.iter().map(memory_ref_json).collect());
    Ok(OfficeMemoryPromptContext {
        prompt,
        refs: Some(refs),
    })
}

fn memory_heading(audience: &OfficeMemoryPromptAudience<'_>, is_zh: bool) -> &'static str {
    match (audience, is_zh) {
        (OfficeMemoryPromptAudience::Office, true) => {
            "长期记忆（仅检索 office/project/user 范围，只作为可追溯背景，不覆盖当前用户指令）"
        }
        (OfficeMemoryPromptAudience::Office, false) => {
            "Long-term memories (office/project/user scoped retrieval; cited background only, not higher-priority instructions)"
        }
        (OfficeMemoryPromptAudience::Member { .. }, true) => {
            "成员任务长期记忆（共享范围加本成员范围，检索后限量注入，不包含其他成员私有记忆）"
        }
        (OfficeMemoryPromptAudience::Member { .. }, false) => {
            "Member task long-term memories (shared scopes plus this member only; bounded retrieval, no other member private memories)"
        }
    }
}

fn memory_visible_to_audience(
    entry: &OfficeMemoryEntry,
    audience: &OfficeMemoryPromptAudience<'_>,
) -> bool {
    if memory_scope_is_shared(&entry.scope) {
        return true;
    }

    match audience {
        OfficeMemoryPromptAudience::Office => false,
        OfficeMemoryPromptAudience::Member {
            member,
            agent_id,
            memory_scope,
        } => {
            member_scope_allows_private(memory_scope)
                && entry.scope == "member"
                && memory_matches_member(entry, member, agent_id)
        }
    }
}

fn memory_audience_score(
    entry: &OfficeMemoryEntry,
    audience: &OfficeMemoryPromptAudience<'_>,
) -> usize {
    match audience {
        OfficeMemoryPromptAudience::Office => usize::from(memory_scope_is_shared(&entry.scope)),
        OfficeMemoryPromptAudience::Member {
            member, agent_id, ..
        } => {
            if entry.scope == "member" && memory_matches_member(entry, member, agent_id) {
                2
            } else {
                usize::from(memory_scope_is_shared(&entry.scope))
            }
        }
    }
}

fn memory_scope_is_shared(scope: &str) -> bool {
    matches!(scope, "office" | "project" | "user")
}

fn member_scope_allows_private(memory_scope: &str) -> bool {
    !matches!(
        memory_scope.trim(),
        "shared" | "sharedOnly" | "shared_only" | "officeOnly" | "office_only"
    )
}

fn memory_matches_member(entry: &OfficeMemoryEntry, member: &str, agent_id: &str) -> bool {
    entry
        .agent_id
        .as_deref()
        .is_some_and(|entry_agent_id| entry_agent_id == agent_id)
        || entry
            .member
            .as_deref()
            .is_some_and(|entry_member| entry_member == member)
}

pub(super) async fn apply_update_from_turn(
    cwd: &str,
    config: &mut JsonValue,
    details: &OfficeRunSyncDetails,
    turn: &Turn,
) -> Result<(), JSONRPCErrorError> {
    let Some(office_update) = office_update_from_turn(turn) else {
        return Ok(());
    };
    let memory_refs = upsert_office_memories(cwd, config, details, &office_update).await?;
    if !memory_refs.is_empty() {
        attach_run_memory_refs(config, &details.run_id, JsonValue::Array(memory_refs))?;
    }
    Ok(())
}

async fn upsert_office_memories(
    cwd: &str,
    config: &JsonValue,
    details: &OfficeRunSyncDetails,
    update: &JsonValue,
) -> Result<Vec<JsonValue>, JSONRPCErrorError> {
    let candidates = memory_candidates_from_update(update);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let _lock = acquire_office_memory_lock(cwd).await?;
    let mut index = read_office_memory_index(cwd).await?;
    index.version = 1;
    let office_key = office_memory_key(config);
    let now = timestamp();
    let evidence_ref = OfficeMemoryEvidenceRef {
        run_id: Some(details.run_id.clone()),
        thread_id: (!details.thread_id.is_empty()).then(|| details.thread_id.clone()),
        turn_id: details.turn_id.clone(),
    };
    let mut refs = Vec::new();

    for candidate in candidates {
        let existing_position = index
            .memories
            .iter()
            .position(|entry| memory_entry_matches_candidate(entry, &office_key, &candidate));
        if let Some(position) = existing_position {
            let entry = &mut index.memories[position];
            entry.confidence = candidate.confidence;
            entry.importance = candidate.importance;
            entry.updated_at = now.clone();
            if !entry.evidence_refs.contains(&evidence_ref) {
                entry.evidence_refs.insert(0, evidence_ref.clone());
                entry.evidence_refs.truncate(8);
            }
            refs.push(memory_ref_json(entry));
        } else {
            let keywords = memory_keywords(&candidate.content);
            let entry = OfficeMemoryEntry {
                id: format!("office-memory-{}", Uuid::new_v4()),
                office_key: office_key.clone(),
                scope: candidate.scope,
                member: candidate.member,
                agent_id: candidate.agent_id,
                kind: candidate.kind,
                content: candidate.content,
                confidence: candidate.confidence,
                importance: candidate.importance,
                status: candidate.status,
                evidence_refs: vec![evidence_ref.clone()],
                keywords,
                created_at: now.clone(),
                updated_at: now.clone(),
                last_used_at: None,
                usage_count: 0,
            };
            refs.push(memory_ref_json(&entry));
            index.memories.insert(0, entry);
        }
    }

    index.memories.truncate(MAX_OFFICE_MEMORY_ITEMS);
    write_office_memory_index(cwd, &index).await?;
    Ok(refs)
}

fn attach_run_memory_refs(
    config: &mut JsonValue,
    run_id: &str,
    memory_refs: JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let workspace = workspace_object_mut(config)?;
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
    run_object.insert("memoryRefs".to_string(), memory_refs);
    Ok(())
}

fn update_config_memory_refs(config: &mut JsonValue, memory: &OfficeMemoryEntry) -> bool {
    let Some(runs) = config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
    else {
        return false;
    };

    let replacement = memory_ref_json(memory);
    let mut changed = false;
    for run in runs {
        changed |= update_memory_refs_on_object(run, &memory.id, &replacement);
        let Some(delegations) = run.get_mut("delegations").and_then(JsonValue::as_array_mut) else {
            continue;
        };
        for delegation in delegations {
            changed |= update_memory_refs_on_object(delegation, &memory.id, &replacement);
        }
    }
    changed
}

fn update_memory_refs_on_object(
    value: &mut JsonValue,
    memory_id: &str,
    replacement: &JsonValue,
) -> bool {
    let Some(memory_refs) = value
        .get_mut("memoryRefs")
        .and_then(JsonValue::as_array_mut)
    else {
        return false;
    };

    let mut changed = false;
    for memory_ref in memory_refs {
        if memory_ref.get("id").and_then(JsonValue::as_str) == Some(memory_id) {
            *memory_ref = replacement.clone();
            changed = true;
        }
    }
    changed
}

fn memory_candidates_from_update(update: &JsonValue) -> Vec<OfficeMemoryCandidate> {
    let Some(value) = update
        .get("memories")
        .or_else(|| update.get("memoryItems"))
        .or_else(|| update.get("memory"))
    else {
        return Vec::new();
    };

    match value {
        JsonValue::Array(items) => items
            .iter()
            .filter_map(memory_candidate_from_value)
            .collect(),
        JsonValue::Object(object) => object
            .get("items")
            .and_then(JsonValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(memory_candidate_from_value)
                    .collect()
            })
            .unwrap_or_else(|| memory_candidate_from_value(value).into_iter().collect()),
        JsonValue::String(_) => memory_candidate_from_value(value).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn memory_candidate_from_value(value: &JsonValue) -> Option<OfficeMemoryCandidate> {
    if let Some(content) = value.as_str() {
        return memory_candidate_from_parts(None, None, None, None, Some(content), None, None);
    }

    memory_candidate_from_parts(
        update_string(value, &["scope"]).as_deref(),
        update_string(value, &["member", "name", "owner"]).as_deref(),
        update_string(value, &["agentId", "agent_id"]).as_deref(),
        update_string(value, &["kind", "type"]).as_deref(),
        update_string(
            value,
            &["content", "text", "summary", "memory", "lesson", "decision"],
        )
        .as_deref(),
        update_string(value, &["confidence"]).as_deref(),
        memory_importance_from_value(value).as_deref(),
    )
}

fn memory_candidate_from_parts(
    scope: Option<&str>,
    member: Option<&str>,
    agent_id: Option<&str>,
    kind: Option<&str>,
    content: Option<&str>,
    confidence: Option<&str>,
    importance: Option<&str>,
) -> Option<OfficeMemoryCandidate> {
    let content = content
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(|content| truncate_chars(content, MAX_MEMORY_CONTENT_CHARS))?;
    Some(OfficeMemoryCandidate {
        scope: normalize_memory_scope(scope),
        member: member
            .map(str::trim)
            .filter(|member| !member.is_empty())
            .map(|member| truncate_chars(member, MAX_PROMPT_TITLE_CHARS)),
        agent_id: agent_id
            .map(str::trim)
            .filter(|agent_id| !agent_id.is_empty())
            .map(|agent_id| truncate_chars(agent_id, MAX_PROMPT_FIELD_CHARS)),
        kind: normalize_memory_kind(kind),
        content,
        confidence: normalize_memory_confidence(confidence),
        importance: normalize_memory_importance(importance),
        // Model-authored memory items are review candidates. Only the
        // office/memory/decide API can promote a memory into accepted context.
        status: "pending".to_string(),
    })
}

fn normalize_memory_scope(scope: Option<&str>) -> String {
    match scope.unwrap_or("office") {
        "member" | "agent" | "private" => "member",
        "project" => "project",
        "user" => "user",
        _ => "office",
    }
    .to_string()
}

fn normalize_memory_kind(kind: Option<&str>) -> String {
    match kind.unwrap_or("runSummary") {
        "decision" | "fact" | "preference" | "lesson" | "artifact" | "runSummary" => {
            kind.unwrap_or("runSummary")
        }
        "run_summary" | "summary" => "runSummary",
        _ => "fact",
    }
    .to_string()
}

fn normalize_memory_confidence(confidence: Option<&str>) -> String {
    match confidence.unwrap_or("medium") {
        "low" | "medium" | "high" => confidence.unwrap_or("medium"),
        _ => "medium",
    }
    .to_string()
}

fn normalize_memory_importance(importance: Option<&str>) -> String {
    match importance.unwrap_or("medium").trim() {
        "low" | "minor" | "niceToHave" | "nice_to_have" => "low",
        "high" | "critical" | "mustRemember" | "must_remember" => "high",
        "medium" | "normal" | "default" => "medium",
        _ => "medium",
    }
    .to_string()
}

fn default_memory_importance() -> String {
    "medium".to_string()
}

fn memory_importance_from_value(value: &JsonValue) -> Option<String> {
    update_string(
        value,
        &["importance", "priority", "salience", "rank", "weight"],
    )
    .or_else(|| {
        value
            .get("importance")
            .or_else(|| value.get("priority"))
            .or_else(|| value.get("salience"))
            .or_else(|| value.get("rank"))
            .or_else(|| value.get("weight"))
            .and_then(JsonValue::as_f64)
            .map(|value| {
                if value >= 0.75 {
                    "high"
                } else if value <= 0.25 {
                    "low"
                } else {
                    "medium"
                }
                .to_string()
            })
    })
}

fn memory_entry_matches_candidate(
    entry: &OfficeMemoryEntry,
    office_key: &str,
    candidate: &OfficeMemoryCandidate,
) -> bool {
    entry.office_key == office_key
        && entry.scope == candidate.scope
        && entry.member == candidate.member
        && entry.agent_id == candidate.agent_id
        && entry.kind == candidate.kind
        && normalize_memory_identity(&entry.content)
            == normalize_memory_identity(&candidate.content)
}

fn memory_ref_json(entry: &OfficeMemoryEntry) -> JsonValue {
    let evidence_refs = entry
        .evidence_refs
        .iter()
        .take(8)
        .map(|evidence_ref| {
            json!({
                "runId": evidence_ref.run_id,
                "threadId": evidence_ref.thread_id,
                "turnId": evidence_ref.turn_id,
            })
        })
        .collect::<Vec<_>>();
    let mut value = json!({
        "id": entry.id,
        "scope": entry.scope,
        "kind": entry.kind,
        "content": truncate_chars(&entry.content, MAX_MEMORY_CONTENT_CHARS),
        "confidence": entry.confidence,
        "importance": entry.importance,
        "status": entry.status,
        "evidenceRefs": evidence_refs,
    });
    copy_optional_memory_string(&mut value, "member", entry.member.as_deref());
    copy_optional_memory_string(&mut value, "agentId", entry.agent_id.as_deref());
    value
}

fn copy_optional_memory_string(value: &mut JsonValue, key: &str, text: Option<&str>) {
    if let Some(text) = text {
        value[key] = JsonValue::String(text.to_string());
    }
}

fn office_memory_record(entry: OfficeMemoryEntry) -> OfficeMemoryRecord {
    OfficeMemoryRecord {
        id: entry.id,
        office_key: entry.office_key,
        scope: entry.scope,
        member: entry.member,
        agent_id: entry.agent_id,
        kind: entry.kind,
        content: entry.content,
        confidence: entry.confidence,
        importance: entry.importance,
        status: entry.status,
        evidence_refs: entry
            .evidence_refs
            .into_iter()
            .map(|evidence_ref| ProtocolOfficeMemoryEvidenceRef {
                run_id: evidence_ref.run_id,
                thread_id: evidence_ref.thread_id,
                turn_id: evidence_ref.turn_id,
            })
            .collect(),
        keywords: entry.keywords,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        last_used_at: entry.last_used_at,
        usage_count: entry.usage_count,
    }
}

fn is_valid_memory_status(status: &str) -> bool {
    matches!(status, "accepted" | "pending" | "rejected")
}

fn normalize_memory_limit(limit: Option<u32>) -> usize {
    limit
        .and_then(|limit| usize::try_from(limit).ok())
        .filter(|limit| *limit > 0)
        .map(|limit| limit.min(MAX_MEMORY_LIST_LIMIT))
        .unwrap_or(DEFAULT_MEMORY_LIST_LIMIT)
}

fn parse_memory_cursor(cursor: Option<String>) -> Result<usize, JSONRPCErrorError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .parse::<usize>()
        .map_err(|_| invalid_params("cursor must be a numeric offset"))
}

fn office_memory_key(config: &JsonValue) -> String {
    config
        .get("id")
        .and_then(JsonValue::as_str)
        .or_else(|| {
            config
                .get("workspace")
                .and_then(|workspace| workspace.get("threadId"))
                .and_then(JsonValue::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let title = config
                .get("title")
                .and_then(JsonValue::as_str)
                .unwrap_or("office");
            format!("office:{}", slugify(title, "office"))
        })
}

fn memory_prompt_score(entry: &OfficeMemoryEntry, query_terms: &HashSet<String>) -> usize {
    if query_terms.is_empty() {
        return 0;
    }
    let entry_terms = if entry.keywords.is_empty() {
        memory_keywords(&entry.content)
    } else {
        entry.keywords.clone()
    };
    entry_terms
        .iter()
        .filter(|term| query_terms.contains(*term))
        .count()
}

fn memory_retrieval_score(
    entry: &OfficeMemoryEntry,
    query_terms: &HashSet<String>,
    audience: &OfficeMemoryPromptAudience<'_>,
) -> usize {
    memory_prompt_score(entry, query_terms) * 100
        + memory_audience_score(entry, audience) * 20
        + memory_importance_score(&entry.importance) * 8
        + memory_confidence_score(&entry.confidence) * 4
        + memory_usage_score(entry)
        + memory_recency_score(entry)
}

fn memory_importance_score(importance: &str) -> usize {
    match importance {
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 2,
    }
}

fn memory_confidence_score(confidence: &str) -> usize {
    match confidence {
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 2,
    }
}

fn memory_usage_score(entry: &OfficeMemoryEntry) -> usize {
    (entry.usage_count.min(5) as usize) * 2
}

fn memory_recency_score(entry: &OfficeMemoryEntry) -> usize {
    let last_seen_at = entry.last_used_at.as_deref().unwrap_or(&entry.updated_at);
    let Ok(last_seen_at) = DateTime::parse_from_rfc3339(last_seen_at) else {
        return 0;
    };
    let age = Utc::now().signed_duration_since(last_seen_at.with_timezone(&Utc));
    if age.num_seconds() <= 86_400 {
        4
    } else if age.num_days() <= 7 {
        3
    } else if age.num_days() <= 30 {
        2
    } else if age.num_days() <= 90 {
        1
    } else {
        0
    }
}

fn memory_keywords(content: &str) -> Vec<String> {
    let mut keywords = tokenize_memory_text(content)
        .into_iter()
        .collect::<Vec<_>>();
    keywords.sort();
    keywords.truncate(MAX_MEMORY_KEYWORDS);
    keywords
}

fn tokenize_memory_text(content: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let mut word = String::new();
    let mut compact_previous: Option<char> = None;

    for ch in content.chars() {
        if ch.is_ascii_alphanumeric() {
            word.push(ch.to_ascii_lowercase());
            compact_previous = None;
            continue;
        }

        if word.len() >= 3 {
            tokens.insert(std::mem::take(&mut word));
        } else {
            word.clear();
        }

        if matches!(
            ch,
            '\u{3040}'..='\u{30FF}'
                | '\u{3400}'..='\u{4DBF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{AC00}'..='\u{D7AF}'
                | '\u{F900}'..='\u{FAFF}'
        ) {
            if let Some(previous) = compact_previous {
                tokens.insert(format!("{previous}{ch}"));
            }
            compact_previous = Some(ch);
        } else {
            compact_previous = None;
        }
    }

    if word.len() >= 3 {
        tokens.insert(word);
    }
    tokens
}

fn normalize_memory_identity(content: &str) -> String {
    let mut normalized = String::new();
    let mut needs_space = false;
    for ch in content.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            if needs_space && !normalized.is_empty() {
                normalized.push(' ');
            }
            normalized.push(ch);
            needs_space = false;
        } else {
            needs_space = true;
        }
    }
    normalized
}

async fn touch_office_memory_usage(
    cwd: &str,
    memory_ids: &[String],
) -> Result<(), JSONRPCErrorError> {
    if memory_ids.is_empty() {
        return Ok(());
    }
    let selected = memory_ids.iter().collect::<HashSet<_>>();
    let _lock = acquire_office_memory_lock(cwd).await?;
    let mut index = read_office_memory_index(cwd).await?;
    let now = timestamp();
    let mut changed = false;
    for memory in &mut index.memories {
        if selected.contains(&memory.id) {
            memory.usage_count = memory.usage_count.saturating_add(1);
            memory.last_used_at = Some(now.clone());
            changed = true;
        }
    }
    if changed {
        write_office_memory_index(cwd, &index).await?;
    }
    Ok(())
}

struct OfficeMemoryIndexLock {
    path: PathBuf,
}

impl Drop for OfficeMemoryIndexLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn acquire_office_memory_lock(cwd: &str) -> Result<OfficeMemoryIndexLock, JSONRPCErrorError> {
    let path = office_memory_lock_path(cwd)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(map_io_error)?;
    }

    for _ in 0..200 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(_) => return Ok(OfficeMemoryIndexLock { path }),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                sleep(Duration::from_millis(10)).await;
            }
            Err(err) => return Err(map_io_error(err)),
        }
    }

    Err(crate::error_code::internal_error(
        "timed out waiting for office memory index lock",
    ))
}

async fn read_office_memory_index(cwd: &str) -> Result<OfficeMemoryIndex, JSONRPCErrorError> {
    let path = office_memory_index_path(cwd)?;
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(OfficeMemoryIndex::default());
        }
        Err(err) => return Err(map_io_error(err)),
    };
    let index = serde_json::from_slice::<OfficeMemoryIndex>(&bytes).unwrap_or_default();
    if index.version == 1 {
        Ok(index)
    } else {
        Ok(OfficeMemoryIndex::default())
    }
}

async fn write_office_memory_index(
    cwd: &str,
    index: &OfficeMemoryIndex,
) -> Result<(), JSONRPCErrorError> {
    let path = office_memory_index_path(cwd)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(map_io_error)?;
    }
    let mut bytes = serde_json::to_vec_pretty(index).map_err(|err| {
        crate::error_code::internal_error(format!("failed to serialize office memory index: {err}"))
    })?;
    bytes.push(b'\n');
    let temp_path = path.with_file_name(format!(
        "{}.tmp-{}",
        OFFICE_MEMORY_INDEX_FILE,
        Uuid::new_v4()
    ));
    fs::write(&temp_path, bytes).await.map_err(map_io_error)?;
    fs::rename(temp_path, path).await.map_err(map_io_error)
}

fn office_memory_index_path(cwd: &str) -> Result<std::path::PathBuf, JSONRPCErrorError> {
    let office_directory = domain_directory(cwd, DomainKind::Office)?;
    let Some(base_directory) = office_directory.parent() else {
        return Err(crate::error_code::internal_error(
            "failed to resolve office memory index directory",
        ));
    };
    Ok(base_directory
        .join(OFFICE_MEMORY_DIRECTORY)
        .join(OFFICE_MEMORY_INDEX_FILE))
}

fn office_memory_lock_path(cwd: &str) -> Result<std::path::PathBuf, JSONRPCErrorError> {
    let office_directory = domain_directory(cwd, DomainKind::Office)?;
    let Some(base_directory) = office_directory.parent() else {
        return Err(crate::error_code::internal_error(
            "failed to resolve office memory index lock directory",
        ));
    };
    Ok(base_directory
        .join(OFFICE_MEMORY_DIRECTORY)
        .join(OFFICE_MEMORY_LOCK_FILE))
}
