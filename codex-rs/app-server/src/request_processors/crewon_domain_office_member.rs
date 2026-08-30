use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeMemberAddParams;
use crewon_app_server_protocol::OfficeMemberAddResponse;
use serde_json::Map;
use serde_json::Value as JsonValue;
use uuid::Uuid;

use super::DomainKind;
use super::OfficeRuntimeRepairMutation;
use super::OfficeWriteIntent;
use super::domain_directory;
use super::office_agent_profile;
use super::office_runtime_repair_transaction;
use super::office_runtime_repair_transaction::OfficeRuntimeMutation;
use super::office_storage;
use super::office_storage::OfficeIdentityLookup;
use super::save_office_record;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crate::office_runtime_contract::MAX_OFFICE_RUNTIME_ID_CHARS;
use crate::office_runtime_contract::OFFICE_SCOPED_RUNTIME_VERSION;

const OFFICE_MEMBER_RUNTIME_SOURCE: &str = "officeMemberRepair";

#[derive(Debug)]
pub(crate) struct PreparedOfficeMemberAdd {
    pub(crate) cwd: String,
    pub(crate) file_path: String,
    pub(crate) agent_id: String,
    member: JsonValue,
    candidate_member_id: String,
}

#[derive(Debug)]
pub(crate) struct CommittedOfficeMemberAdd {
    pub(crate) response: OfficeMemberAddResponse,
    pub(crate) replacement_runtime_used: bool,
}

pub(super) async fn prepare(
    params: OfficeMemberAddParams,
) -> Result<PreparedOfficeMemberAdd, JSONRPCErrorError> {
    let OfficeMemberAddParams {
        cwd,
        mut config,
        agent_id,
        member,
    } = params;
    let agent_id = agent_id.trim().to_string();
    if agent_id.is_empty() {
        return Err(invalid_params("agentId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let agent_record = super::read_agent_record(&cwd, Some(&agent_id), None, None).await?;
    let member = prepare_member(
        member,
        &agent_id,
        agent_record.as_ref().map(|record| &record.config),
    )?;

    let file_path = if office_storage::office_record_id(&config).is_none() {
        let intent = OfficeWriteIntent::update_or_legacy_migration(&config);
        save_office_record(&cwd, &mut config, intent).await?
    } else {
        let record_id = office_storage::office_record_id(&config)
            .ok_or_else(|| internal_error("validated Office record lost recordId"))?;
        let directory = domain_directory(&cwd, DomainKind::Office)?;
        let record = office_storage::find_office_record(
            &directory,
            OfficeIdentityLookup::RecordId(record_id),
        )
        .await?
        .ok_or_else(|| {
            invalid_params(
                "office record identity no longer exists; reload the Office list before retrying",
            )
        })?;
        record.file_path
    };

    Ok(PreparedOfficeMemberAdd {
        cwd,
        file_path,
        agent_id,
        member,
        candidate_member_id: Uuid::now_v7().to_string(),
    })
}

pub(super) async fn commit(
    prepared: PreparedOfficeMemberAdd,
    replacement_thread_id: &str,
) -> Result<CommittedOfficeMemberAdd, JSONRPCErrorError> {
    let PreparedOfficeMemberAdd {
        cwd,
        file_path,
        agent_id,
        member,
        candidate_member_id,
    } = prepared;
    let source_thread_id = format!("member-add-{replacement_thread_id}");
    let source_thread_id_for_mutation = source_thread_id.clone();
    let replacement_thread_id_owned = replacement_thread_id.to_string();
    let agent_id_for_mutation = agent_id.clone();
    let update = office_runtime_repair_transaction::apply_server_mutation(
        &cwd,
        OfficeRuntimeRepairMutation {
            file_path: &file_path,
            source_thread_id: &source_thread_id,
            replacement_thread_id,
            agent_id: &agent_id,
        },
        move |config| {
            apply_member_update(
                config,
                &agent_id_for_mutation,
                member,
                &candidate_member_id,
                &replacement_thread_id_owned,
                &source_thread_id_for_mutation,
            )
        },
    )
    .await?
    .ok_or_else(|| internal_error("Office member add produced no persisted update"))?;
    let replacement_runtime_used =
        member_runtime_thread_id(&update.config, &agent_id) == Some(replacement_thread_id);
    Ok(CommittedOfficeMemberAdd {
        response: OfficeMemberAddResponse {
            file_path: update.file_path,
            config: update.config,
        },
        replacement_runtime_used,
    })
}

fn prepare_member(
    mut member: JsonValue,
    agent_id: &str,
    agent_config: Option<&JsonValue>,
) -> Result<JsonValue, JSONRPCErrorError> {
    let Some(member_object) = member.as_object_mut() else {
        return Err(invalid_params("member must be an object"));
    };
    for key in ["memberId", "member_id", "threadId", "thread_id"] {
        member_object.remove(key);
    }
    member_object.remove("agent_id");
    member_object.insert(
        "agentId".to_string(),
        JsonValue::String(agent_id.to_string()),
    );
    let runtime = member_object
        .entry("runtime".to_string())
        .or_insert_with(|| JsonValue::Object(Map::new()));
    if !runtime.is_object() {
        *runtime = JsonValue::Object(Map::new());
    }
    let runtime = runtime
        .as_object_mut()
        .ok_or_else(|| internal_error("member runtime normalization failed"))?;
    for key in [
        "threadId",
        "thread_id",
        "sessionScope",
        "session_scope",
        "runtimeVersion",
        "runtime_version",
        "repairSourceThreadId",
        "repair_source_thread_id",
        "repairedAt",
        "repaired_at",
        "agentProfileSource",
        "agent_profile_source",
        "permissionProfile",
        "permission_profile",
    ] {
        runtime.remove(key);
    }
    canonicalize_runtime_alias(runtime, "contextPolicy", "context_policy");
    canonicalize_runtime_alias(runtime, "memoryScope", "memory_scope");
    canonicalize_runtime_alias(runtime, "agentProfile", "agent_profile");
    if runtime
        .get("agentProfile")
        .and_then(JsonValue::as_str)
        .is_none_or(|profile| profile.trim().is_empty())
        && let Some(agent_profile) =
            agent_config.and_then(office_agent_profile::agent_profile_summary)
    {
        runtime.insert("agentProfile".to_string(), JsonValue::String(agent_profile));
    }
    Ok(member)
}

fn apply_member_update(
    config: &mut JsonValue,
    agent_id: &str,
    mut member: JsonValue,
    candidate_member_id: &str,
    replacement_thread_id: &str,
    source_thread_id: &str,
) -> Result<OfficeRuntimeMutation, JSONRPCErrorError> {
    let members = config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("members"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.members must be an array"))?;
    let matching = members
        .iter()
        .enumerate()
        .filter(|(_, existing)| text(existing, "agentId") == Some(agent_id))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matching.len() > 1 {
        return Err(invalid_params(
            "office/member/add requires one exact existing member for agentId",
        ));
    }
    let existing = matching.first().map(|index| members[*index].clone());
    let member_id = existing
        .as_ref()
        .and_then(|existing| text(existing, "memberId"))
        .unwrap_or(candidate_member_id)
        .to_string();
    validate_identity("memberId", &member_id)?;
    if members.iter().any(|existing| {
        text(existing, "memberId") == Some(member_id.as_str())
            && text(existing, "agentId") != Some(agent_id)
    }) {
        return Err(invalid_params(
            "workspace memberId is already owned by another member",
        ));
    }

    let existing_runtime = existing.as_ref().filter(|existing| {
        existing.get("runtime").is_some_and(|runtime| {
            runtime.get("runtimeVersion").and_then(JsonValue::as_u64)
                >= Some(OFFICE_SCOPED_RUNTIME_VERSION)
                && text(runtime, "sessionScope") == Some("office")
                && text(runtime, "agentProfileSource") == Some(OFFICE_MEMBER_RUNTIME_SOURCE)
                && text(runtime, "threadId").is_some()
        })
    });
    let member_object = member
        .as_object_mut()
        .ok_or_else(|| internal_error("prepared Office member is not an object"))?;
    member_object.insert("memberId".to_string(), JsonValue::String(member_id));
    let mutation = if let Some(existing) = existing_runtime {
        if let Some(thread_id) = text(existing, "threadId") {
            member_object.insert(
                "threadId".to_string(),
                JsonValue::String(thread_id.to_string()),
            );
        }
        merge_existing_runtime(member_object, existing)?;
        OfficeRuntimeMutation::Updated
    } else {
        bind_replacement_runtime(member_object, replacement_thread_id, source_thread_id)?;
        OfficeRuntimeMutation::BindReplacement {
            member_id: Some(
                member_object
                    .get("memberId")
                    .and_then(JsonValue::as_str)
                    .ok_or_else(|| internal_error("prepared Office member lost memberId"))?
                    .to_string(),
            ),
        }
    };
    members.retain(|existing| text(existing, "agentId") != Some(agent_id));
    members.push(member);
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    config["updatedAt"] = JsonValue::String(now);
    config["workspace"]["recordRevision"] = JsonValue::String(Uuid::now_v7().to_string());
    Ok(mutation)
}

fn bind_replacement_runtime(
    member: &mut Map<String, JsonValue>,
    replacement_thread_id: &str,
    source_thread_id: &str,
) -> Result<(), JSONRPCErrorError> {
    member.insert(
        "threadId".to_string(),
        JsonValue::String(replacement_thread_id.to_string()),
    );
    let runtime = member
        .entry("runtime".to_string())
        .or_insert_with(|| JsonValue::Object(Map::new()));
    let runtime = runtime
        .as_object_mut()
        .ok_or_else(|| internal_error("prepared Office member runtime is not an object"))?;
    runtime
        .entry("contextPolicy".to_string())
        .or_insert_with(|| JsonValue::String("sharedDigest".to_string()));
    runtime
        .entry("memoryScope".to_string())
        .or_insert_with(|| JsonValue::String("privateAndShared".to_string()));
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    runtime.insert(
        "threadId".to_string(),
        JsonValue::String(replacement_thread_id.to_string()),
    );
    runtime.insert(
        "sessionScope".to_string(),
        JsonValue::String("office".to_string()),
    );
    runtime.insert(
        "runtimeVersion".to_string(),
        JsonValue::from(OFFICE_SCOPED_RUNTIME_VERSION),
    );
    runtime.insert(
        "repairSourceThreadId".to_string(),
        JsonValue::String(source_thread_id.to_string()),
    );
    runtime.insert("repairedAt".to_string(), JsonValue::String(now));
    runtime.insert(
        "agentProfileSource".to_string(),
        JsonValue::String(OFFICE_MEMBER_RUNTIME_SOURCE.to_string()),
    );
    runtime.insert(
        "permissionProfile".to_string(),
        JsonValue::String("read-only".to_string()),
    );
    Ok(())
}

fn merge_existing_runtime(
    member: &mut Map<String, JsonValue>,
    existing: &JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let requested_runtime = member
        .get("runtime")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    let mut runtime = existing
        .get("runtime")
        .and_then(JsonValue::as_object)
        .cloned()
        .ok_or_else(|| internal_error("existing Office member runtime is not an object"))?;
    runtime.extend(requested_runtime);
    member.insert("runtime".to_string(), JsonValue::Object(runtime));
    Ok(())
}

fn canonicalize_runtime_alias(runtime: &mut Map<String, JsonValue>, key: &str, alias: &str) {
    if !runtime.contains_key(key)
        && let Some(value) = runtime.remove(alias)
    {
        runtime.insert(key.to_string(), value);
    } else {
        runtime.remove(alias);
    }
}

fn member_runtime_thread_id<'a>(config: &'a JsonValue, agent_id: &str) -> Option<&'a str> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .find(|member| text(member, "agentId") == Some(agent_id))
        .and_then(|member| member.get("runtime"))
        .and_then(|runtime| text(runtime, "threadId"))
}

fn validate_identity(label: &str, value: &str) -> Result<(), JSONRPCErrorError> {
    if value.is_empty()
        || value != value.trim()
        || value.chars().any(char::is_whitespace)
        || value.chars().count() > MAX_OFFICE_RUNTIME_ID_CHARS
    {
        return Err(invalid_params(format!(
            "Office member {label} must be non-empty, contain no whitespace, and not exceed {MAX_OFFICE_RUNTIME_ID_CHARS} characters"
        )));
    }
    Ok(())
}

fn text<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
#[path = "crewon_domain_office_member_tests.rs"]
mod tests;
