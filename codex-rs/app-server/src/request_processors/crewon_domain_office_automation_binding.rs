use super::mutate_latest_office_record;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use chrono::Utc;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeAutomationBinding;
use crewon_app_server_protocol::OfficeAutomationBindingApprovalMode;
use crewon_app_server_protocol::OfficeAutomationBindingDeleteParams;
use crewon_app_server_protocol::OfficeAutomationBindingDeleteResponse;
use crewon_app_server_protocol::OfficeAutomationBindingDispatchMode;
use crewon_app_server_protocol::OfficeAutomationBindingRiskLevel;
use crewon_app_server_protocol::OfficeAutomationBindingStatus;
use crewon_app_server_protocol::OfficeAutomationBindingUpsertParams;
use crewon_app_server_protocol::OfficeAutomationBindingUpsertResponse;
use serde_json::Value as JsonValue;
use serde_json::json;

#[path = "crewon_domain_office_automation_binding_path.rs"]
mod binding_path;

const AUTOMATION_BINDINGS_FIELD: &str = "automationBindings";
const BINDING_VERSION: u32 = 1;
const MAX_AUTOMATION_BINDINGS: usize = 16;
const MAX_BINDING_ID_CHARS: usize = 96;
const MAX_AUTOMATION_TITLE_CHARS: usize = 160;
const MAX_RECORD_REVISION_CHARS: usize = 128;
const MAX_PROMPT_BINDINGS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OfficeAutomationBindingUse {
    Auto,
    Interactive,
    Retry,
    Recovery,
    Preload,
}

pub(super) struct ResolvedOfficeAutomationBinding {
    pub(super) record: CrewonDomainConfigRecord,
}

pub(super) fn preserve_canonical_bindings(
    latest: Option<&JsonValue>,
    proposed: &mut JsonValue,
) -> Result<bool, JSONRPCErrorError> {
    let latest_value = latest.and_then(automation_bindings_value).cloned();
    if let Some(value) = latest_value.as_ref() {
        parse_bindings_value(value).map_err(|message| {
            internal_error(format!(
                "persisted Office automation binding authority is invalid: {message}"
            ))
        })?;
    }

    let proposed_value = automation_bindings_value(proposed).cloned();
    if let Some(value) = proposed_value.as_ref() {
        parse_bindings_value(value).map_err(|message| {
            invalid_params(format!(
                "workspace.{AUTOMATION_BINDINGS_FIELD} is invalid: {message}"
            ))
        })?;
    }
    if proposed_value.is_some() && proposed_value != latest_value {
        return Err(invalid_params(format!(
            "workspace.{AUTOMATION_BINDINGS_FIELD} is server-owned; use office/automation/binding/upsert or office/automation/binding/delete"
        )));
    }
    let Some(latest_value) = latest_value else {
        return Ok(false);
    };
    if proposed_value.is_some() {
        return Ok(false);
    }
    workspace_object_mut(proposed)?.insert(AUTOMATION_BINDINGS_FIELD.to_string(), latest_value);
    Ok(true)
}

pub(super) fn bindings(
    config: &JsonValue,
) -> Result<Vec<OfficeAutomationBinding>, JSONRPCErrorError> {
    automation_bindings_value(config)
        .map(parse_bindings_value)
        .transpose()
        .map_err(|message| {
            invalid_params(format!(
                "Office automation binding authority is invalid: {message}"
            ))
        })
        .map(Option::unwrap_or_default)
}

pub(super) fn binding_by_id(
    config: &JsonValue,
    binding_id: &str,
) -> Result<OfficeAutomationBinding, JSONRPCErrorError> {
    validate_binding_id(binding_id)?;
    bindings(config)?
        .into_iter()
        .find(|binding| binding.binding_id == binding_id)
        .ok_or_else(|| unbound_automation_error(binding_id))
}

pub(super) fn binding_allows_auto_dispatch(binding: &OfficeAutomationBinding) -> bool {
    binding.policy.status == OfficeAutomationBindingStatus::Enabled
        && binding.policy.dispatch_mode == OfficeAutomationBindingDispatchMode::Auto
        && binding.policy.risk_level != OfficeAutomationBindingRiskLevel::High
        && binding.policy.approval_mode == OfficeAutomationBindingApprovalMode::NotRequired
}

pub(super) fn prompt_summary(config: &JsonValue, is_zh: bool) -> String {
    let Ok(bindings) = bindings(config) else {
        return if is_zh {
            "- 授权绑定不可用；不要生成 automationId。".to_string()
        } else {
            "- Authorized bindings are unavailable; do not emit automationId.".to_string()
        };
    };
    if bindings.is_empty() {
        return if is_zh {
            "- 暂无授权 Automation 绑定；不要生成 automationId。".to_string()
        } else {
            "- No Automation bindings are authorized; do not emit automationId.".to_string()
        };
    }
    bindings
        .into_iter()
        .take(MAX_PROMPT_BINDINGS)
        .map(|binding| {
            let dispatch_mode = match binding.policy.dispatch_mode {
                OfficeAutomationBindingDispatchMode::Auto => "auto",
                OfficeAutomationBindingDispatchMode::Manual => "manual",
            };
            let risk_level = match binding.policy.risk_level {
                OfficeAutomationBindingRiskLevel::Low => "low",
                OfficeAutomationBindingRiskLevel::Medium => "medium",
                OfficeAutomationBindingRiskLevel::High => "high",
            };
            let approval_mode = match binding.policy.approval_mode {
                OfficeAutomationBindingApprovalMode::NotRequired => "notRequired",
                OfficeAutomationBindingApprovalMode::Required => "required",
            };
            let status = match binding.policy.status {
                OfficeAutomationBindingStatus::Enabled => "enabled",
                OfficeAutomationBindingStatus::Disabled => "disabled",
            };
            format!(
                "- bindingId={}; title={}; dispatch={dispatch_mode}; risk={risk_level}; approval={approval_mode}; status={status}",
                binding.binding_id, binding.automation_title
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) async fn resolve_for_execution(
    cwd: &str,
    office_config: &JsonValue,
    binding_id: &str,
    use_kind: OfficeAutomationBindingUse,
) -> Result<Option<ResolvedOfficeAutomationBinding>, JSONRPCErrorError> {
    let binding = binding_by_id(office_config, binding_id)?;
    if binding.policy.status != OfficeAutomationBindingStatus::Enabled {
        return Err(invalid_params(format!(
            "Office automation binding '{binding_id}' is disabled"
        )));
    }
    if matches!(
        use_kind,
        OfficeAutomationBindingUse::Auto | OfficeAutomationBindingUse::Preload
    ) && !binding_allows_auto_dispatch(&binding)
    {
        return Ok(None);
    }
    let (record, automation_identity) =
        binding_path::read_exact_automation_record(cwd, &binding.automation_file_path).await?;
    if automation_identity != binding.automation_identity {
        return Err(invalid_params(format!(
            "Office automation binding '{binding_id}' no longer matches its bound Automation file identity; rebind it before dispatch"
        )));
    }
    Ok(Some(ResolvedOfficeAutomationBinding { record }))
}

pub(super) async fn upsert(
    params: OfficeAutomationBindingUpsertParams,
) -> Result<OfficeAutomationBindingUpsertResponse, JSONRPCErrorError> {
    validate_record_identity_input(&params.office_record_id, "officeRecordId")?;
    validate_record_revision(&params.expected_record_revision)?;
    validate_binding_id(&params.binding_id)?;
    let (automation_record, automation_identity) =
        binding_path::read_exact_automation_record(&params.cwd, &params.automation_file_path)
            .await?;
    let automation_title = automation_binding_title(&automation_record.config);
    let target = office_record_stub(&params.office_record_id);
    let binding_id = params.binding_id.clone();
    let expected_revision = params.expected_record_revision.clone();
    let automation_file_path = automation_record.file_path;
    let policy = params.policy;
    let update = mutate_latest_office_record(&params.cwd, &target, move |latest| {
        ensure_expected_revision(latest, &expected_revision)?;
        let mut current = bindings(latest)?;
        let existing_index = current
            .iter()
            .position(|binding| binding.binding_id == binding_id);
        if existing_index.is_none() && current.len() >= MAX_AUTOMATION_BINDINGS {
            return Err(invalid_params(format!(
                "Office automation bindings must not exceed {MAX_AUTOMATION_BINDINGS} entries"
            )));
        }
        if current.iter().enumerate().any(|(index, binding)| {
            Some(index) != existing_index
                && (binding.automation_file_path == automation_file_path
                    || binding.automation_identity == automation_identity)
        }) {
            return Err(invalid_params(
                "the Automation file is already bound to this Office under another bindingId",
            ));
        }
        let now = Utc::now().timestamp();
        let created_at = existing_index
            .map(|index| current[index].created_at)
            .unwrap_or(now);
        let updated_at = now.max(created_at);
        let binding = OfficeAutomationBinding {
            binding_version: BINDING_VERSION,
            binding_id: binding_id.clone(),
            automation_file_path: automation_file_path.clone(),
            automation_identity: automation_identity.clone(),
            automation_title: automation_title.clone(),
            policy,
            created_at,
            updated_at,
        };
        validate_binding(&binding).map_err(|message| {
            internal_error(format!(
                "generated Office automation binding is invalid: {message}"
            ))
        })?;
        match existing_index {
            Some(index) => current[index] = binding,
            None => current.push(binding),
        }
        current.sort_by(|left, right| left.binding_id.cmp(&right.binding_id));
        set_bindings(latest, &current)?;
        Ok(true)
    })
    .await?
    .ok_or_else(|| internal_error("Office automation binding upsert made no persisted change"))?;
    let binding = binding_by_id(&update.config, &params.binding_id)?;
    Ok(OfficeAutomationBindingUpsertResponse {
        file_path: update.file_path,
        config: update.config,
        binding,
    })
}

pub(super) async fn delete(
    params: OfficeAutomationBindingDeleteParams,
) -> Result<OfficeAutomationBindingDeleteResponse, JSONRPCErrorError> {
    validate_record_identity_input(&params.office_record_id, "officeRecordId")?;
    validate_record_revision(&params.expected_record_revision)?;
    validate_binding_id(&params.binding_id)?;
    let target = office_record_stub(&params.office_record_id);
    let binding_id = params.binding_id.clone();
    let expected_revision = params.expected_record_revision.clone();
    let update = mutate_latest_office_record(&params.cwd, &target, move |latest| {
        ensure_expected_revision(latest, &expected_revision)?;
        let mut current = bindings(latest)?;
        let original_len = current.len();
        current.retain(|binding| binding.binding_id != binding_id);
        if current.len() == original_len {
            return Err(unbound_automation_error(&binding_id));
        }
        set_bindings(latest, &current)?;
        Ok(true)
    })
    .await?
    .ok_or_else(|| internal_error("Office automation binding delete made no persisted change"))?;
    Ok(OfficeAutomationBindingDeleteResponse {
        file_path: update.file_path,
        config: update.config,
        binding_id: params.binding_id,
        deleted: true,
    })
}

fn automation_bindings_value(config: &JsonValue) -> Option<&JsonValue> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get(AUTOMATION_BINDINGS_FIELD))
}

fn parse_bindings_value(value: &JsonValue) -> Result<Vec<OfficeAutomationBinding>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| "must be an array".to_string())?;
    if values.len() > MAX_AUTOMATION_BINDINGS {
        return Err(format!("must not exceed {MAX_AUTOMATION_BINDINGS} entries"));
    }
    let mut bindings = Vec::with_capacity(values.len());
    for value in values {
        let binding = serde_json::from_value::<OfficeAutomationBinding>(value.clone())
            .map_err(|err| format!("contains an invalid binding: {err}"))?;
        validate_binding(&binding)?;
        bindings.push(binding);
    }
    for pair in bindings.windows(2) {
        if pair[0].binding_id >= pair[1].binding_id {
            return Err("must be sorted by unique bindingId values".to_string());
        }
    }
    for (index, binding) in bindings.iter().enumerate() {
        if bindings.iter().skip(index + 1).any(|other| {
            other.automation_file_path == binding.automation_file_path
                || other.automation_identity == binding.automation_identity
        }) {
            return Err("must not bind the same Automation file more than once".to_string());
        }
    }
    Ok(bindings)
}

fn validate_binding(binding: &OfficeAutomationBinding) -> Result<(), String> {
    if binding.binding_version != BINDING_VERSION {
        return Err(format!(
            "bindingVersion must be {BINDING_VERSION}, got {}",
            binding.binding_version
        ));
    }
    validate_binding_id_text(&binding.binding_id)?;
    binding_path::validate_automation_path_text(&binding.automation_file_path)?;
    binding_path::validate_automation_identity(&binding.automation_identity)?;
    if binding.automation_title.is_empty()
        || binding.automation_title != binding.automation_title.trim()
        || binding.automation_title.chars().count() > MAX_AUTOMATION_TITLE_CHARS
        || binding.automation_title.chars().any(char::is_control)
    {
        return Err(format!(
            "automationTitle must be a trimmed printable string of at most {MAX_AUTOMATION_TITLE_CHARS} characters"
        ));
    }
    if binding.created_at <= 0 || binding.updated_at <= 0 || binding.created_at > binding.updated_at
    {
        return Err("createdAt and updatedAt must be positive ordered Unix seconds".to_string());
    }
    Ok(())
}

fn automation_binding_title(config: &JsonValue) -> String {
    config
        .get("title")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .map(|title| {
            title
                .chars()
                .filter(|character| !character.is_control())
                .take(MAX_AUTOMATION_TITLE_CHARS)
                .collect::<String>()
        })
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Automation".to_string())
}

fn validate_binding_id(binding_id: &str) -> Result<(), JSONRPCErrorError> {
    validate_binding_id_text(binding_id).map_err(invalid_params)
}

fn validate_binding_id_text(binding_id: &str) -> Result<(), String> {
    if binding_id.is_empty()
        || binding_id != binding_id.trim()
        || binding_id.chars().count() > MAX_BINDING_ID_CHARS
        || !binding_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        return Err(format!(
            "bindingId must contain only ASCII letters, digits, '-', '_', '.', or ':' and must not exceed {MAX_BINDING_ID_CHARS} characters"
        ));
    }
    Ok(())
}

fn ensure_expected_revision(
    config: &JsonValue,
    expected_revision: &str,
) -> Result<(), JSONRPCErrorError> {
    let current_revision = config
        .get("workspace")
        .and_then(|workspace| workspace.get("recordRevision"))
        .and_then(JsonValue::as_str);
    if current_revision != Some(expected_revision) {
        return Err(invalid_params(
            "office automation binding update is stale; reload the latest Office record and retry",
        ));
    }
    Ok(())
}

fn validate_record_revision(record_revision: &str) -> Result<(), JSONRPCErrorError> {
    if record_revision.is_empty()
        || record_revision != record_revision.trim()
        || record_revision.chars().any(char::is_whitespace)
        || record_revision.chars().count() > MAX_RECORD_REVISION_CHARS
    {
        return Err(invalid_params(format!(
            "expectedRecordRevision must be a trimmed non-whitespace string of at most {MAX_RECORD_REVISION_CHARS} characters"
        )));
    }
    Ok(())
}

fn validate_record_identity_input(value: &str, field: &str) -> Result<(), JSONRPCErrorError> {
    if value.is_empty()
        || value != value.trim()
        || value.chars().any(char::is_whitespace)
        || value.chars().count() > MAX_RECORD_REVISION_CHARS
    {
        return Err(invalid_params(format!(
            "{field} must be a trimmed non-whitespace string of at most {MAX_RECORD_REVISION_CHARS} characters"
        )));
    }
    Ok(())
}

fn office_record_stub(record_id: &str) -> JsonValue {
    json!({
        "workspace": {
            "recordId": record_id,
        }
    })
}

fn set_bindings(
    config: &mut JsonValue,
    bindings: &[OfficeAutomationBinding],
) -> Result<(), JSONRPCErrorError> {
    let value = serde_json::to_value(bindings).map_err(|err| {
        internal_error(format!(
            "failed to serialize Office automation bindings: {err}"
        ))
    })?;
    workspace_object_mut(config)?.insert(AUTOMATION_BINDINGS_FIELD.to_string(), value);
    Ok(())
}

fn workspace_object_mut(
    config: &mut JsonValue,
) -> Result<&mut serde_json::Map<String, JsonValue>, JSONRPCErrorError> {
    config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))
}

fn unbound_automation_error(binding_id: &str) -> JSONRPCErrorError {
    invalid_params(format!(
        "Office verification automationId '{binding_id}' is not bound to this Office; bind an exact Automation file with office/automation/binding/upsert before dispatch"
    ))
}

#[cfg(test)]
#[path = "crewon_domain_office_automation_binding_tests.rs"]
mod tests;
