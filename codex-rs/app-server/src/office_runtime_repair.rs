use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use serde_json::Map;
use serde_json::Value as JsonValue;

use crate::office_runtime_contract::MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS;
use crate::office_runtime_contract::MAX_OFFICE_RUNTIME_ID_CHARS;
use crate::office_runtime_contract::OFFICE_SCOPED_RUNTIME_VERSION;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct OfficeRuntimeThreadRepairCandidate {
    pub(crate) agent_id: String,
}

pub(crate) fn repair_candidate(
    records: &[CrewonDomainConfigRecord],
    file_path: &str,
    target_thread_id: &str,
) -> Option<OfficeRuntimeThreadRepairCandidate> {
    for record in records {
        if record.file_path != file_path {
            continue;
        }
        let candidate = repair_candidate_from_members(&record.config, target_thread_id)?;
        return repair_scope_is_unambiguous(&record.config, target_thread_id, &candidate.agent_id)
            .then_some(candidate);
    }
    None
}

pub(crate) fn remaining_repair_capacity(
    records: &[CrewonDomainConfigRecord],
    file_path: &str,
) -> Option<usize> {
    let record = records
        .iter()
        .find(|record| record.file_path == file_path)?;
    let members = record
        .config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)?;
    Some(
        MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS
            .saturating_sub(repaired_runtime_binding_count(members)),
    )
}

#[cfg(test)]
pub(crate) fn rebind_records(
    records: &[CrewonDomainConfigRecord],
    file_path: &str,
    old_thread_id: &str,
    new_thread_id: &str,
    agent_id: &str,
) -> Vec<(usize, JsonValue)> {
    let mut updates = Vec::new();
    for (index, record) in records.iter().enumerate() {
        if record.file_path != file_path {
            continue;
        }
        let mut config = record.config.clone();
        if rebind_config(&mut config, old_thread_id, new_thread_id, agent_id) {
            updates.push((index, config));
        }
    }
    updates
}

fn repair_candidate_from_members(
    config: &JsonValue,
    target_thread_id: &str,
) -> Option<OfficeRuntimeThreadRepairCandidate> {
    let members = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)?;
    if repaired_runtime_binding_count(members) >= MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS {
        return None;
    }
    let mut matches = members
        .iter()
        .filter(|member| member_runtime_thread_id(member) == Some(target_thread_id));
    let member = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let agent_id = text(member, "agentId")?;
    if agent_id.chars().count() > MAX_OFFICE_RUNTIME_ID_CHARS {
        return None;
    }
    if members
        .iter()
        .filter(|member| text(member, "agentId") == Some(agent_id))
        .take(2)
        .count()
        != 1
    {
        return None;
    }
    Some(OfficeRuntimeThreadRepairCandidate {
        agent_id: agent_id.to_string(),
    })
}

fn repaired_runtime_binding_count(members: &[JsonValue]) -> usize {
    members
        .iter()
        .filter(|member| {
            member.get("runtime").is_some_and(|runtime| {
                runtime.get("runtimeVersion").and_then(JsonValue::as_u64)
                    >= Some(OFFICE_SCOPED_RUNTIME_VERSION)
                    && text(runtime, "sessionScope") == Some("office")
                    && text(runtime, "agentProfileSource") == Some("officeMemberRepair")
            })
        })
        .take(MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS)
        .count()
}

fn repair_scope_is_unambiguous(config: &JsonValue, target_thread_id: &str, agent_id: &str) -> bool {
    let mut matching_members = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|member| member_runtime_thread_id(member) == Some(target_thread_id));
    let matching_member = matching_members.next();
    let Some(matching_member) = matching_member else {
        return false;
    };
    if matching_members.next().is_some() || text(matching_member, "agentId") != Some(agent_id) {
        return false;
    }
    let matching_member_name =
        text(matching_member, "name").or_else(|| text(matching_member, "member"));
    let Some(runs) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
    else {
        return true;
    };
    let row_matches_agent = |row: &JsonValue| match text(row, "agentId") {
        Some(row_agent_id) => row_agent_id == agent_id,
        None => {
            text(row, "member").is_none_or(|row_member| Some(row_member) == matching_member_name)
        }
    };
    for run in runs {
        let routes_match = run
            .get("delegationRoutes")
            .and_then(JsonValue::as_array)
            .is_none_or(|routes| {
                routes
                    .iter()
                    .filter(|route| route_is_runtime_thread(route))
                    .all(|route| match route_thread_match(route, target_thread_id) {
                        Some(true) => row_matches_agent(route),
                        Some(false) => true,
                        None => false,
                    })
            });
        let delegations_match = run
            .get("delegations")
            .and_then(JsonValue::as_array)
            .is_none_or(|delegations| {
                delegations.iter().all(|delegation| {
                    let matches_thread = text(delegation, "turnId").is_none()
                        && text(delegation, "threadId") == Some(target_thread_id);
                    !matches_thread || row_matches_agent(delegation)
                })
            });
        if !routes_match || !delegations_match {
            return false;
        }
    }
    true
}

pub(crate) fn rebind_config(
    config: &mut JsonValue,
    old_thread_id: &str,
    new_thread_id: &str,
    agent_id: &str,
) -> bool {
    if !repair_scope_is_unambiguous(config, old_thread_id, agent_id) {
        return false;
    }
    let mut changed = false;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
    else {
        return false;
    };

    if let Some(members) = workspace
        .get_mut("members")
        .and_then(JsonValue::as_array_mut)
    {
        for member in members {
            let matches_thread = member_runtime_thread_id(member) == Some(old_thread_id);
            if !matches_thread || !row_matches_or_has_no_agent(member, agent_id) {
                continue;
            }
            let member_name = text(member, "name")
                .unwrap_or("Office member")
                .chars()
                .take(80)
                .collect::<String>();
            let member_role = text(member, "role")
                .unwrap_or("Office collaboration")
                .chars()
                .take(240)
                .collect::<String>();
            let repaired_agent_profile = format!("name={member_name}; role={member_role}");
            if let Some(member_object) = member.as_object_mut() {
                changed |= set_string(member_object, "threadId", new_thread_id);
                let runtime = member_object
                    .entry("runtime".to_string())
                    .or_insert_with(|| JsonValue::Object(Map::new()));
                if !runtime.is_object() {
                    *runtime = JsonValue::Object(Map::new());
                    changed = true;
                }
                if let Some(runtime_object) = runtime.as_object_mut() {
                    changed |= set_string(runtime_object, "threadId", new_thread_id);
                    changed |= set_string(runtime_object, "sessionScope", "office");
                    let runtime_version = JsonValue::from(OFFICE_SCOPED_RUNTIME_VERSION);
                    if runtime_object.get("runtimeVersion") != Some(&runtime_version) {
                        runtime_object.insert("runtimeVersion".to_string(), runtime_version);
                        changed = true;
                    }
                    changed |= set_string(runtime_object, "repairSourceThreadId", old_thread_id);
                    changed |= set_string(runtime_object, "repairedAt", &now);
                    changed |= set_string(runtime_object, "agentProfile", &repaired_agent_profile);
                    changed |=
                        set_string(runtime_object, "agentProfileSource", "officeMemberRepair");
                }
            }
        }
    }

    let Some(runs) = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
    else {
        return changed;
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
                if !route_is_runtime_thread(route) {
                    continue;
                }
                let matches_thread = route_thread_match(route, old_thread_id) == Some(true);
                if !matches_thread || !row_matches_or_has_no_agent(route, agent_id) {
                    continue;
                }
                if let Some(route_object) = route.as_object_mut() {
                    changed |= set_string(route_object, "threadId", new_thread_id);
                    changed |= set_string(route_object, "target", new_thread_id);
                    changed |= set_string(route_object, "repairSourceThreadId", old_thread_id);
                    changed |= set_string(route_object, "repairedAt", &now);
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
                let matches_thread = text(delegation, "threadId") == Some(old_thread_id);
                if !matches_thread || !row_matches_or_has_no_agent(delegation, agent_id) {
                    continue;
                }
                if let Some(delegation_object) = delegation.as_object_mut() {
                    changed |= set_string(delegation_object, "threadId", new_thread_id);
                    changed |= set_string(delegation_object, "repairSourceThreadId", old_thread_id);
                    changed |= set_string(delegation_object, "repairedAt", &now);
                }
            }
        }
    }

    if changed && let Some(config_object) = config.as_object_mut() {
        config_object.insert("updatedAt".to_string(), JsonValue::String(now));
    }
    changed
}

fn member_runtime_thread_id(member: &JsonValue) -> Option<&str> {
    let runtime_thread_id = member
        .get("runtime")
        .and_then(|runtime| text(runtime, "threadId"));
    let member_thread_id = text(member, "threadId");
    match (runtime_thread_id, member_thread_id) {
        (Some(runtime_thread_id), Some(member_thread_id))
            if runtime_thread_id == member_thread_id =>
        {
            Some(runtime_thread_id)
        }
        (Some(runtime_thread_id), None) => Some(runtime_thread_id),
        (None, Some(member_thread_id)) => Some(member_thread_id),
        (None, None) | (Some(_), Some(_)) => None,
    }
}

fn route_thread_match(route: &JsonValue, target_thread_id: &str) -> Option<bool> {
    let values = [text(route, "threadId"), text(route, "target")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !values.contains(&target_thread_id) {
        return Some(false);
    }
    values
        .iter()
        .all(|value| *value == target_thread_id)
        .then_some(true)
}

fn route_is_runtime_thread(route: &JsonValue) -> bool {
    matches!(
        route
            .get("targetKind")
            .and_then(JsonValue::as_str)
            .map(str::trim),
        Some("runtimeThread") | None
    )
}

fn row_matches_or_has_no_agent(value: &JsonValue, agent_id: &str) -> bool {
    match text(value, "agentId") {
        Some(value_agent_id) => value_agent_id == agent_id,
        None => true,
    }
}

fn set_string(object: &mut Map<String, JsonValue>, key: &str, value: &str) -> bool {
    if object.get(key).and_then(JsonValue::as_str) == Some(value) {
        return false;
    }
    object.insert(key.to_string(), JsonValue::String(value.to_string()));
    true
}

fn text<'a>(item: &'a JsonValue, key: &str) -> Option<&'a str> {
    item.get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
#[path = "office_runtime_repair_tests.rs"]
mod tests;
