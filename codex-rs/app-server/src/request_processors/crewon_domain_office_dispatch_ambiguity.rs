use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptStatus;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken;
use crate::request_processors::crewon_domain_office_dispatch_receipt::mark_execution_unknown;
use crate::request_processors::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery;
use crate::request_processors::crewon_domain_office_dispatch_recovery::locate_office_dispatch_recovery;
use crewon_core::UserInputOnceState;

use super::*;

const EXECUTION_UNKNOWN_STATE: &str = "executionUnknown";
pub(crate) const EXECUTION_UNKNOWN_MESSAGE: &str =
    "Office dispatch execution is unknown and requires reconciliation";

pub(crate) fn quarantine_dispatch_execution_unknown(
    mut config: JsonValue,
    expected: &LocatedOfficeDispatchRecovery,
    turn_id: &str,
    state: UserInputOnceState,
) -> Result<(JsonValue, bool, LocatedOfficeDispatchRecovery), JSONRPCErrorError> {
    let current = locate_office_dispatch_recovery(
        &config,
        &expected.intent_id,
        &expected.source_thread_id,
        &expected.source_turn_id,
    )
    .map_err(|_| invalid_params("Office dispatch recovery receipt is corrupt"))?
    .ok_or_else(|| invalid_params("Office dispatch recovery receipt no longer exists"))?;
    if current != *expected {
        return Err(invalid_params(
            "Office dispatch recovery receipt changed before reconciliation",
        ));
    }
    let admission_state = state.into();
    let already_quarantined = current.status == OfficeDispatchReceiptStatus::ExecutionUnknown
        && current.turn_id.as_deref() == Some(turn_id)
        && current.admission_state == Some(admission_state)
        && current.last_error.as_deref() == Some(EXECUTION_UNKNOWN_MESSAGE);
    let record_id = expected.record_id.clone();
    let token = OfficeDispatchReceiptToken {
        record_id: &record_id,
        intent_id: &expected.intent_id,
        source_thread_id: &expected.source_thread_id,
        source_turn_id: &expected.source_turn_id,
        run_id: &expected.run_id,
        delegation_id: &expected.delegation_id,
        target_thread_id: &expected.target_thread_id,
        prompt: &expected.prompt_snapshot,
    };
    let delegation = exact_delegation_mut(&mut config, expected)?;
    mark_execution_unknown(
        delegation,
        token,
        turn_id,
        admission_state,
        EXECUTION_UNKNOWN_MESSAGE,
        &timestamp(),
    )
    .map_err(|_| invalid_params("Office dispatch receipt cannot enter execution reconciliation"))?;
    let object = delegation
        .as_object_mut()
        .ok_or_else(|| invalid_params("Office recovered delegation must be an object"))?;
    let mut changed = !already_quarantined;
    for field in [
        "dispatchLeaseId",
        "dispatchLeaseStartedAt",
        "dispatchLeaseExpiresAt",
    ] {
        changed |= object.remove(field).is_some();
    }
    let updated = locate_office_dispatch_recovery(
        &config,
        &expected.intent_id,
        &expected.source_thread_id,
        &expected.source_turn_id,
    )
    .map_err(|_| invalid_params("Office dispatch reconciliation receipt is corrupt"))?
    .ok_or_else(|| invalid_params("Office dispatch reconciliation receipt is missing"))?;
    Ok((config, changed, updated))
}

pub(crate) async fn mark_auto_dispatch_intent_execution_unknown(
    cwd: &str,
    lease_id: &str,
    recovery: &LocatedOfficeDispatchRecovery,
    file_path: &str,
    turn_id: &str,
) -> Result<(), JSONRPCErrorError> {
    validate_scheduler_dispatch_lease_params(
        &recovery.intent_id,
        &recovery.source_thread_id,
        &recovery.source_turn_id,
        lease_id,
    )?;
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut queue = read_scheduler_queue(cwd).await?;
    let intent = queue
        .intents
        .iter_mut()
        .find(|intent| {
            intent.intent_id == recovery.intent_id
                && intent.source_thread_id == recovery.source_thread_id
                && intent.source_turn_id == recovery.source_turn_id
        })
        .ok_or_else(|| invalid_params("scheduler dispatch intent was not found"))?;
    if intent.status == EXECUTION_UNKNOWN_STATE {
        if intent.run_id.as_deref() == Some(recovery.run_id.as_str())
            && intent.dispatch_kind.as_deref() == Some("delegation")
            && intent.delegation_id.as_deref() == Some(recovery.delegation_id.as_str())
            && intent.verification_check_id.is_none()
            && intent.file_path.as_deref() == Some(file_path)
            && intent.dispatched_thread_id.as_deref() == Some(recovery.target_thread_id.as_str())
            && intent.dispatched_turn_id.as_deref() == Some(turn_id)
            && intent.last_error.as_deref() == Some(EXECUTION_UNKNOWN_MESSAGE)
            && intent.lease_id.is_none()
            && intent.lease_started_at.is_none()
            && intent.lease_expires_at.is_none()
        {
            return Ok(());
        }
        return Err(invalid_params(
            "scheduler execution reconciliation state conflicts with persisted identity",
        ));
    }
    if intent.status != OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING {
        return Err(invalid_params(
            "scheduler dispatch intent is not dispatching",
        ));
    }
    if intent.lease_id.as_deref() != Some(lease_id) {
        return Err(invalid_params("scheduler dispatch lease does not match"));
    }
    intent.status = EXECUTION_UNKNOWN_STATE.to_string();
    intent.updated_at = timestamp();
    intent.run_id = Some(recovery.run_id.clone());
    intent.dispatch_kind = Some("delegation".to_string());
    intent.delegation_id = Some(recovery.delegation_id.clone());
    intent.verification_check_id = None;
    intent.file_path = Some(file_path.to_string());
    intent.dispatched_thread_id = Some(recovery.target_thread_id.clone());
    intent.dispatched_turn_id = Some(turn_id.to_string());
    intent.last_error = Some(EXECUTION_UNKNOWN_MESSAGE.to_string());
    clear_office_scheduler_intent_lease(intent);
    write_scheduler_queue(cwd, &mut queue).await
}

fn exact_delegation_mut<'a>(
    config: &'a mut JsonValue,
    expected: &LocatedOfficeDispatchRecovery,
) -> Result<&'a mut JsonValue, JSONRPCErrorError> {
    config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .and_then(|runs| {
            runs.iter_mut()
                .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(&expected.run_id))
        })
        .and_then(|run| run.get_mut("delegations"))
        .and_then(JsonValue::as_array_mut)
        .and_then(|delegations| {
            delegations.iter_mut().find(|delegation| {
                delegation.get("id").and_then(JsonValue::as_str) == Some(&expected.delegation_id)
            })
        })
        .ok_or_else(|| invalid_params("Office dispatch recovery delegation no longer exists"))
}

#[cfg(test)]
#[path = "crewon_domain_office_dispatch_ambiguity_tests.rs"]
mod tests;
