use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptStatus;
use crate::request_processors::crewon_domain_office_dispatch_receipt::read_dispatch_receipt;
use crate::request_processors::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery;
use crate::request_processors::crewon_domain_office_dispatch_recovery::locate_office_dispatch_recovery;

use super::*;

/// Reclaims the exact delegation named by a durable recovery receipt.
///
/// This path deliberately does not rebuild member context, choose another delegation, or derive a
/// new prompt. The persisted receipt remains authoritative for dispatch identity and payload.
pub(crate) async fn prepare_recovered_delegation_dispatch(
    cwd: &str,
    file_path: &str,
    recovery: &LocatedOfficeDispatchRecovery,
) -> Result<PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let file_path = validate_record_file_path(cwd, DomainKind::Office, file_path)?;
    let config = read_record(DomainKind::Office, &file_path)
        .await?
        .ok_or_else(|| invalid_params("Office dispatch recovery record no longer exists"))?
        .config;
    let prepared = prepare_recovered_delegation_from_latest(cwd, config, recovery, Utc::now())?;
    update_record(
        DomainKind::Office,
        cwd,
        &file_path.to_string_lossy(),
        prepared.config.clone(),
    )
    .await?;
    Ok(prepared)
}

fn prepare_recovered_delegation_from_latest(
    cwd: &str,
    mut config: JsonValue,
    recovery: &LocatedOfficeDispatchRecovery,
    now: DateTime<Utc>,
) -> Result<PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
    let latest = locate_office_dispatch_recovery(
        &config,
        &recovery.intent_id,
        &recovery.source_thread_id,
        &recovery.source_turn_id,
    )
    .map_err(|_| invalid_params("Office dispatch recovery receipt is corrupt"))?
    .ok_or_else(|| invalid_params("Office dispatch recovery receipt no longer exists"))?;
    if !same_recovery_identity(recovery, &latest) {
        return Err(invalid_params(
            "Office dispatch recovery locator does not match persisted receipt",
        ));
    }
    if recovery.status != OfficeDispatchReceiptStatus::Starting
        || latest.status != OfficeDispatchReceiptStatus::Starting
    {
        return Err(invalid_params(
            "Office dispatch recovery receipt is no longer starting",
        ));
    }

    let (run_index, delegation_index) = exact_delegation_indices(&config, &latest)?;
    let delegation = config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .and_then(|runs| runs.get_mut(run_index))
        .and_then(|run| run.get_mut("delegations"))
        .and_then(JsonValue::as_array_mut)
        .and_then(|delegations| delegations.get_mut(delegation_index))
        .ok_or_else(|| invalid_params("Office dispatch recovery locator became stale"))?;
    let retry_of_delegation_id = optional_delegation_id(delegation, "retryOfDelegationId")?;
    let delegation = delegation
        .as_object_mut()
        .ok_or_else(|| invalid_params("Office recovered delegation must be an object"))?;
    apply_child_dispatch_lease(delegation, now);

    Ok(PreparedOfficeDelegationDispatch {
        cwd: cwd.to_string(),
        config,
        run_id: latest.run_id,
        delegation_id: latest.delegation_id,
        retry_of_delegation_id,
        thread_id: latest.target_thread_id,
        prompt: latest.prompt_snapshot,
        client_user_message_id: Some(latest.client_user_message_id),
    })
}

fn same_recovery_identity(
    expected: &LocatedOfficeDispatchRecovery,
    actual: &LocatedOfficeDispatchRecovery,
) -> bool {
    expected.receipt_id == actual.receipt_id
        && expected.record_id == actual.record_id
        && expected.intent_id == actual.intent_id
        && expected.source_thread_id == actual.source_thread_id
        && expected.source_turn_id == actual.source_turn_id
        && expected.run_id == actual.run_id
        && expected.delegation_id == actual.delegation_id
        && expected.target_thread_id == actual.target_thread_id
        && expected.client_user_message_id == actual.client_user_message_id
        && expected.payload_hash == actual.payload_hash
        && expected.prompt_snapshot == actual.prompt_snapshot
}

fn exact_delegation_indices(
    config: &JsonValue,
    recovery: &LocatedOfficeDispatchRecovery,
) -> Result<(usize, usize), JSONRPCErrorError> {
    let runs = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let mut matched = None;
    for (run_index, run) in runs.iter().enumerate() {
        if run.get("id").and_then(JsonValue::as_str) != Some(recovery.run_id.as_str()) {
            continue;
        }
        let delegations = run
            .get("delegations")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| invalid_params("run.delegations must be an array"))?;
        for (delegation_index, delegation) in delegations.iter().enumerate() {
            if delegation.get("id").and_then(JsonValue::as_str)
                != Some(recovery.delegation_id.as_str())
            {
                continue;
            }
            let receipt = read_dispatch_receipt(delegation)
                .map_err(|_| invalid_params("Office dispatch recovery receipt is corrupt"))?
                .ok_or_else(|| {
                    invalid_params("Office dispatch recovery receipt no longer exists")
                })?;
            if receipt.receipt_id != recovery.receipt_id {
                continue;
            }
            if matched.replace((run_index, delegation_index)).is_some() {
                return Err(invalid_params(
                    "Office dispatch recovery locator is not unique",
                ));
            }
        }
    }
    matched.ok_or_else(|| invalid_params("Office dispatch recovery locator no longer exists"))
}

fn optional_delegation_id(
    delegation: &JsonValue,
    field: &str,
) -> Result<Option<String>, JSONRPCErrorError> {
    let Some(value) = delegation.get(field) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| invalid_params("Office recovered delegation has an invalid retry identity"))
}

#[cfg(test)]
#[path = "crewon_domain_office_dispatch_recovery_prepare_tests.rs"]
mod tests;
