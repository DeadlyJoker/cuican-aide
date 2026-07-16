use crewon_app_server_protocol::JSONRPCErrorError;
use serde_json::Value as JsonValue;

use crate::error_code::invalid_params;
use crate::office_runtime_contract::MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS;
use crate::office_runtime_contract::MAX_OFFICE_RUNTIME_ID_CHARS;
use crate::office_runtime_contract::OFFICE_SCOPED_RUNTIME_VERSION;

pub(super) struct PersistedRepairBinding {
    pub(super) runtime_thread_id: String,
    pub(super) record_id: String,
    pub(super) member_id: Option<String>,
    pub(super) agent_id: String,
    pub(super) source_thread_id: String,
}

pub(super) fn persisted_repair_bindings(
    config: &JsonValue,
) -> Result<Vec<PersistedRepairBinding>, JSONRPCErrorError> {
    let Some(record_id) = raw_text(
        config.get("workspace").unwrap_or(&JsonValue::Null),
        "recordId",
    ) else {
        return Ok(Vec::new());
    };
    validate_id("recordId", record_id)?;
    let Some(members) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    else {
        return Ok(Vec::new());
    };
    let mut bindings = Vec::new();
    for member in members {
        let Some(runtime) = member.get("runtime") else {
            continue;
        };
        if runtime.get("runtimeVersion").and_then(JsonValue::as_u64)
            < Some(OFFICE_SCOPED_RUNTIME_VERSION)
            || text(runtime, "sessionScope") != Some("office")
            || text(runtime, "agentProfileSource") != Some("officeMemberRepair")
        {
            continue;
        }
        if bindings.len() >= MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS {
            return Err(invalid_params(format!(
                "office repaired runtime bindings exceed the authority limit of {MAX_OFFICE_REPAIRED_RUNTIME_BINDINGS}"
            )));
        }
        bindings.push(PersistedRepairBinding {
            runtime_thread_id: required_id(runtime, "threadId")?,
            record_id: record_id.to_string(),
            member_id: optional_id(member, "memberId")?,
            agent_id: required_id(member, "agentId")?,
            source_thread_id: required_id(runtime, "repairSourceThreadId")?,
        });
    }
    Ok(bindings)
}

fn optional_id(value: &JsonValue, key: &str) -> Result<Option<String>, JSONRPCErrorError> {
    let Some(value) = raw_text(value, key) else {
        return Ok(None);
    };
    validate_id(key, value)?;
    Ok(Some(value.to_string()))
}

fn required_id(value: &JsonValue, key: &str) -> Result<String, JSONRPCErrorError> {
    let value = raw_text(value, key)
        .ok_or_else(|| invalid_params(format!("Office repaired runtime is missing {key}")))?;
    validate_id(key, value)?;
    Ok(value.to_string())
}

fn validate_id(label: &str, value: &str) -> Result<(), JSONRPCErrorError> {
    if value.is_empty()
        || value != value.trim()
        || value.chars().any(char::is_whitespace)
        || value.chars().count() > MAX_OFFICE_RUNTIME_ID_CHARS
    {
        return Err(invalid_params(format!(
            "Office runtime owner {label} must be non-empty, contain no whitespace, and not exceed {MAX_OFFICE_RUNTIME_ID_CHARS} characters"
        )));
    }
    Ok(())
}

fn raw_text<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value.get(key).and_then(JsonValue::as_str)
}

fn text<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    raw_text(value, key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}
