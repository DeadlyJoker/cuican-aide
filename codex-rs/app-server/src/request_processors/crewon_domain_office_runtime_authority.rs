use serde_json::Map;
use serde_json::Value as JsonValue;

use crate::office_runtime_contract::MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS;
use crate::office_runtime_contract::MAX_OFFICE_RUNTIME_ID_CHARS;

struct RepairedRuntimeBinding {
    agent_id: String,
    member_id: Option<String>,
    member_name: Option<String>,
    thread_id: String,
    repair_source_thread_id: String,
    runtime_fields: Vec<(&'static str, JsonValue)>,
}

enum RowBindingMatch {
    Unrelated,
    Matches,
    Conflicts,
}

#[derive(Debug)]
pub(super) enum RepairedRuntimeAuthorityError {
    ConflictingBinding { agent_id: String },
    ForgedAuthority { agent_id: String },
    TooManyBindings { limit: usize },
}

pub(super) fn preserve_repaired_runtime_bindings(
    latest: &JsonValue,
    proposed: &mut JsonValue,
) -> Result<bool, RepairedRuntimeAuthorityError> {
    validate_proposed_repair_authority(Some(latest), proposed)?;
    let bindings = repaired_runtime_bindings(latest)?;
    if bindings.is_empty() {
        return Ok(false);
    }
    validate_repaired_binding_ownership(proposed, &bindings)?;
    let Some(proposed_members) = proposed
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("members"))
        .and_then(JsonValue::as_array_mut)
    else {
        return Ok(false);
    };

    let mut changed = false;
    let mut active_bindings = Vec::new();
    for binding in bindings {
        let mut preserved = false;
        let mut proposed_member_count = 0usize;
        for proposed_member in proposed_members.iter_mut() {
            if text(proposed_member, "agentId") != Some(binding.agent_id.as_str()) {
                continue;
            }
            proposed_member_count = proposed_member_count.saturating_add(1);
            if proposed_member_count > 1 {
                return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
                    agent_id: binding.agent_id,
                });
            }
            if let Some(member_id) = binding.member_id.as_deref() {
                if text(proposed_member, "memberId").is_some_and(|value| value != member_id) {
                    return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
                        agent_id: binding.agent_id.clone(),
                    });
                }
                if let Some(member_object) = proposed_member.as_object_mut() {
                    changed |= set_string(member_object, "memberId", member_id);
                }
            }
            reject_conflicting_thread_field(proposed_member, "threadId", &binding)?;
            if let Some(runtime) = proposed_member.get("runtime") {
                reject_conflicting_thread_field(runtime, "threadId", &binding)?;
            }
            let member_name = text(proposed_member, "name")
                .unwrap_or("Office member")
                .chars()
                .take(80)
                .collect::<String>();
            let member_role = text(proposed_member, "role")
                .unwrap_or("Office collaboration")
                .chars()
                .take(240)
                .collect::<String>();
            let repaired_agent_profile = format!("name={member_name}; role={member_role}");
            let Some(member_object) = proposed_member.as_object_mut() else {
                continue;
            };
            changed |= set_string(member_object, "threadId", &binding.thread_id);
            let runtime = member_object
                .entry("runtime".to_string())
                .or_insert_with(|| JsonValue::Object(Map::new()));
            if !runtime.is_object() {
                *runtime = JsonValue::Object(Map::new());
                changed = true;
            }
            if let Some(runtime_object) = runtime.as_object_mut() {
                for (key, value) in &binding.runtime_fields {
                    if runtime_object.get(*key) != Some(value) {
                        runtime_object.insert((*key).to_string(), value.clone());
                        changed = true;
                    }
                }
                changed |= set_string(runtime_object, "agentProfile", &repaired_agent_profile);
                preserved = true;
            }
        }
        if preserved {
            active_bindings.push(binding);
        }
    }
    if active_bindings.is_empty() {
        return Ok(changed);
    }

    let Some(runs) = proposed
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
    else {
        return Ok(changed);
    };
    for run in runs {
        let Some(run_object) = run.as_object_mut() else {
            continue;
        };
        if let Some(routes) = run_object
            .get_mut("delegationRoutes")
            .and_then(JsonValue::as_array_mut)
        {
            for route in routes {
                if !matches!(text(route, "targetKind"), None | Some("runtimeThread")) {
                    continue;
                }
                for binding in &active_bindings {
                    match classify_row_binding(route, binding) {
                        RowBindingMatch::Unrelated => continue,
                        RowBindingMatch::Conflicts => {
                            return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
                                agent_id: binding.agent_id.clone(),
                            });
                        }
                        RowBindingMatch::Matches => {}
                    }
                    reject_conflicting_row_thread(route, binding)?;
                    if let Some(route_object) = route.as_object_mut() {
                        changed |= set_string(route_object, "threadId", &binding.thread_id);
                        changed |= set_string(route_object, "target", &binding.thread_id);
                    }
                    break;
                }
            }
        }
        if let Some(delegations) = run_object
            .get_mut("delegations")
            .and_then(JsonValue::as_array_mut)
        {
            for delegation in delegations {
                if text(delegation, "turnId").is_some() {
                    continue;
                }
                for binding in &active_bindings {
                    match classify_row_binding(delegation, binding) {
                        RowBindingMatch::Unrelated => continue,
                        RowBindingMatch::Conflicts => {
                            return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
                                agent_id: binding.agent_id.clone(),
                            });
                        }
                        RowBindingMatch::Matches => {}
                    }
                    reject_conflicting_row_thread(delegation, binding)?;
                    if let Some(delegation_object) = delegation.as_object_mut() {
                        changed |= set_string(delegation_object, "threadId", &binding.thread_id);
                    }
                    break;
                }
            }
        }
    }
    Ok(changed)
}

fn validate_repaired_binding_ownership(
    proposed: &JsonValue,
    bindings: &[RepairedRuntimeBinding],
) -> Result<(), RepairedRuntimeAuthorityError> {
    if let Some(members) = proposed
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    {
        for member in members {
            for binding in bindings {
                if text(member, "agentId") == Some(binding.agent_id.as_str()) {
                    continue;
                }
                let top_level_conflict = value_references_binding_thread(member, binding);
                let runtime_conflict = member
                    .get("runtime")
                    .is_some_and(|runtime| value_references_binding_thread(runtime, binding));
                if top_level_conflict || runtime_conflict {
                    return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
                        agent_id: binding.agent_id.clone(),
                    });
                }
            }
        }
    }

    let Some(runs) = proposed
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
    else {
        return Ok(());
    };
    for run in runs {
        if let Some(routes) = run.get("delegationRoutes").and_then(JsonValue::as_array) {
            for route in routes {
                if !matches!(text(route, "targetKind"), None | Some("runtimeThread")) {
                    continue;
                }
                validate_row_binding_ownership(route, bindings)?;
            }
        }
        if let Some(delegations) = run.get("delegations").and_then(JsonValue::as_array) {
            for delegation in delegations {
                validate_row_binding_ownership(delegation, bindings)?;
            }
        }
    }
    Ok(())
}

fn validate_row_binding_ownership(
    row: &JsonValue,
    bindings: &[RepairedRuntimeBinding],
) -> Result<(), RepairedRuntimeAuthorityError> {
    for binding in bindings {
        match classify_row_binding(row, binding) {
            RowBindingMatch::Unrelated => {}
            RowBindingMatch::Conflicts => {
                return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
                    agent_id: binding.agent_id.clone(),
                });
            }
            RowBindingMatch::Matches => reject_conflicting_row_thread(row, binding)?,
        }
    }
    Ok(())
}

pub(super) fn validate_proposed_repair_authority(
    latest: Option<&JsonValue>,
    proposed: &JsonValue,
) -> Result<(), RepairedRuntimeAuthorityError> {
    let latest_bindings = match latest {
        Some(latest) => repaired_runtime_bindings(latest)?,
        None => Vec::new(),
    };
    let Some(proposed_members) = proposed
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    else {
        return Ok(());
    };
    for member in proposed_members {
        let Some(runtime) = member.get("runtime") else {
            continue;
        };
        let has_reserved_marker = text(runtime, "agentProfileSource") == Some("officeMemberRepair")
            || runtime.get("repairSourceThreadId").is_some()
            || runtime.get("repairedAt").is_some();
        if !has_reserved_marker {
            continue;
        }
        let agent_id = bounded_text(member, "agentId", MAX_OFFICE_RUNTIME_ID_CHARS)
            .unwrap_or_else(|| "unknown".to_string());
        if !latest_bindings
            .iter()
            .any(|binding| binding.agent_id == agent_id)
        {
            return Err(RepairedRuntimeAuthorityError::ForgedAuthority { agent_id });
        }
    }
    Ok(())
}

fn repaired_runtime_bindings(
    config: &JsonValue,
) -> Result<Vec<RepairedRuntimeBinding>, RepairedRuntimeAuthorityError> {
    let Some(members) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    else {
        return Ok(Vec::new());
    };
    let mut bindings = Vec::new();
    for member in members {
        let Some(binding) = repaired_runtime_binding(member) else {
            continue;
        };
        if bindings.len() >= MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS {
            return Err(RepairedRuntimeAuthorityError::TooManyBindings {
                limit: MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS,
            });
        }
        if bindings.iter().any(|existing: &RepairedRuntimeBinding| {
            existing.agent_id == binding.agent_id
                || (existing.member_id.is_some() && existing.member_id == binding.member_id)
                || existing.thread_id == binding.thread_id
                || existing.thread_id == binding.repair_source_thread_id
                || existing.repair_source_thread_id == binding.thread_id
                || existing.repair_source_thread_id == binding.repair_source_thread_id
        }) {
            return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
                agent_id: binding.agent_id,
            });
        }
        bindings.push(binding);
    }
    Ok(bindings)
}

fn repaired_runtime_binding(member: &JsonValue) -> Option<RepairedRuntimeBinding> {
    let agent_id = bounded_text(member, "agentId", MAX_OFFICE_RUNTIME_ID_CHARS)?;
    let member_id = bounded_text(member, "memberId", MAX_OFFICE_RUNTIME_ID_CHARS);
    let runtime = member.get("runtime")?;
    if runtime.get("runtimeVersion").and_then(JsonValue::as_u64)? < 2
        || text(runtime, "sessionScope") != Some("office")
        || text(runtime, "agentProfileSource") != Some("officeMemberRepair")
    {
        return None;
    }
    let thread_id = bounded_text(runtime, "threadId", MAX_OFFICE_RUNTIME_ID_CHARS)?;
    let repair_source_thread_id =
        bounded_text(runtime, "repairSourceThreadId", MAX_OFFICE_RUNTIME_ID_CHARS)?;
    let runtime_fields = [
        "threadId",
        "sessionScope",
        "runtimeVersion",
        "repairSourceThreadId",
        "repairedAt",
        "agentProfileSource",
    ]
    .into_iter()
    .filter_map(|key| runtime.get(key).cloned().map(|value| (key, value)))
    .collect();
    Some(RepairedRuntimeBinding {
        agent_id,
        member_id,
        member_name: text(member, "name").map(str::to_string),
        thread_id,
        repair_source_thread_id,
        runtime_fields,
    })
}

fn classify_row_binding(row: &JsonValue, binding: &RepairedRuntimeBinding) -> RowBindingMatch {
    let references_binding = ["threadId", "target"].into_iter().any(|key| {
        text(row, key).is_some_and(|thread_id| {
            thread_id == binding.thread_id || thread_id == binding.repair_source_thread_id
        })
    });
    if let Some(agent_id) = text(row, "agentId") {
        return if agent_id == binding.agent_id {
            RowBindingMatch::Matches
        } else if references_binding {
            RowBindingMatch::Conflicts
        } else {
            RowBindingMatch::Unrelated
        };
    }
    if !references_binding {
        return RowBindingMatch::Unrelated;
    }
    match text(row, "member") {
        None => RowBindingMatch::Matches,
        Some(member_name) if binding.member_name.as_deref() == Some(member_name) => {
            RowBindingMatch::Matches
        }
        Some(_) => RowBindingMatch::Conflicts,
    }
}

fn reject_conflicting_row_thread(
    row: &JsonValue,
    binding: &RepairedRuntimeBinding,
) -> Result<(), RepairedRuntimeAuthorityError> {
    for key in ["threadId", "target"] {
        reject_conflicting_thread_field(row, key, binding)?;
    }
    Ok(())
}

fn reject_conflicting_thread_field(
    value: &JsonValue,
    key: &str,
    binding: &RepairedRuntimeBinding,
) -> Result<(), RepairedRuntimeAuthorityError> {
    if text(value, key).is_some_and(|thread_id| {
        thread_id != binding.thread_id && thread_id != binding.repair_source_thread_id
    }) {
        return Err(RepairedRuntimeAuthorityError::ConflictingBinding {
            agent_id: binding.agent_id.clone(),
        });
    }
    Ok(())
}

fn value_references_binding_thread(value: &JsonValue, binding: &RepairedRuntimeBinding) -> bool {
    ["threadId", "target"].into_iter().any(|key| {
        text(value, key).is_some_and(|thread_id| {
            thread_id == binding.thread_id || thread_id == binding.repair_source_thread_id
        })
    })
}

fn bounded_text(value: &JsonValue, key: &str, max_chars: usize) -> Option<String> {
    let value = text(value, key)?;
    (value.chars().count() <= max_chars).then(|| value.to_string())
}

fn set_string(object: &mut Map<String, JsonValue>, key: &str, value: &str) -> bool {
    if object.get(key).and_then(JsonValue::as_str) == Some(value) {
        return false;
    }
    object.insert(key.to_string(), JsonValue::String(value.to_string()));
    true
}

fn text<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
#[path = "crewon_domain_office_runtime_authority_tests.rs"]
mod tests;
