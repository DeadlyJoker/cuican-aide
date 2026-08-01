use serde_json::Value as JsonValue;

use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchAdmissionState;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceipt;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptStatus;
use crate::request_processors::crewon_domain_office_dispatch_receipt::has_known_dispatch_receipt_authority;
use crate::request_processors::crewon_domain_office_dispatch_receipt::read_dispatch_receipt;

const MAX_RECORD_ID_BYTES: usize = 128;
const MAX_ID_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LocatedOfficeDispatchRecovery {
    pub(crate) receipt_id: String,
    pub(crate) record_id: String,
    pub(crate) intent_id: String,
    pub(crate) source_thread_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) run_id: String,
    pub(crate) delegation_id: String,
    pub(crate) target_thread_id: String,
    pub(crate) client_user_message_id: String,
    pub(crate) payload_hash: String,
    pub(crate) prompt_snapshot: String,
    pub(crate) status: OfficeDispatchReceiptStatus,
    pub(crate) admission_state: Option<OfficeDispatchAdmissionState>,
    pub(crate) turn_id: Option<String>,
    pub(crate) last_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeDispatchRecoveryLocatorError {
    Corrupt,
}

pub(crate) fn locate_office_dispatch_recovery(
    config: &JsonValue,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
) -> Result<Option<LocatedOfficeDispatchRecovery>, OfficeDispatchRecoveryLocatorError> {
    if !valid_id(intent_id, MAX_ID_BYTES)
        || !valid_id(source_thread_id, MAX_ID_BYTES)
        || !valid_id(source_turn_id, MAX_ID_BYTES)
    {
        return Err(OfficeDispatchRecoveryLocatorError::Corrupt);
    }
    let workspace = config
        .get("workspace")
        .and_then(JsonValue::as_object)
        .ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
    let record_id = workspace
        .get("recordId")
        .and_then(JsonValue::as_str)
        .filter(|record_id| valid_id(record_id, MAX_RECORD_ID_BYTES));
    let Some(activity) = workspace.get("activity") else {
        return Ok(None);
    };
    let activity = activity
        .as_object()
        .ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
    let Some(runs) = activity.get("runs") else {
        return Ok(None);
    };
    let runs = runs
        .as_array()
        .ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
    let mut matched = None;
    for run in runs {
        let Some(delegations) = run.get("delegations") else {
            continue;
        };
        let delegations = delegations
            .as_array()
            .ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
        for delegation in delegations {
            if delegation.get("dispatchReceipt").is_none() {
                continue;
            }
            if !has_known_dispatch_receipt_authority(delegation) {
                return Err(OfficeDispatchRecoveryLocatorError::Corrupt);
            }
            let Some(receipt) = read_dispatch_receipt(delegation)
                .map_err(|_| OfficeDispatchRecoveryLocatorError::Corrupt)?
            else {
                continue;
            };
            let record_id = record_id.ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
            validate_containers(&receipt, record_id, run, delegation)?;
            if receipt.intent_id != intent_id
                || receipt.source_thread_id != source_thread_id
                || receipt.source_turn_id != source_turn_id
            {
                continue;
            }
            if matched.is_some() {
                return Err(OfficeDispatchRecoveryLocatorError::Corrupt);
            }
            matched = Some(LocatedOfficeDispatchRecovery {
                receipt_id: receipt.receipt_id,
                record_id: receipt.record_id,
                intent_id: receipt.intent_id,
                source_thread_id: receipt.source_thread_id,
                source_turn_id: receipt.source_turn_id,
                run_id: receipt.run_id,
                delegation_id: receipt.delegation_id,
                target_thread_id: receipt.target_thread_id,
                client_user_message_id: receipt.client_user_message_id,
                payload_hash: receipt.payload_hash,
                prompt_snapshot: receipt.prompt_snapshot,
                status: receipt.status,
                admission_state: receipt.admission_state,
                turn_id: receipt.turn_id,
                last_error: receipt.last_error,
            });
        }
    }
    Ok(matched)
}

fn validate_containers(
    receipt: &OfficeDispatchReceipt,
    record_id: &str,
    run: &JsonValue,
    delegation: &JsonValue,
) -> Result<(), OfficeDispatchRecoveryLocatorError> {
    let run_id = run
        .get("id")
        .and_then(JsonValue::as_str)
        .filter(|id| valid_id(id, MAX_ID_BYTES))
        .ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
    let delegation_id = delegation
        .get("id")
        .and_then(JsonValue::as_str)
        .filter(|id| valid_id(id, MAX_ID_BYTES))
        .ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
    if receipt.record_id != record_id
        || receipt.run_id != run_id
        || receipt.delegation_id != delegation_id
        || !target_matches_route(delegation, &receipt.target_thread_id)?
    {
        return Err(OfficeDispatchRecoveryLocatorError::Corrupt);
    }
    Ok(())
}

fn target_matches_route(
    delegation: &JsonValue,
    target_thread_id: &str,
) -> Result<bool, OfficeDispatchRecoveryLocatorError> {
    let mut found = false;
    for field in ["target", "threadId"] {
        let Some(value) = delegation.get(field) else {
            continue;
        };
        let value = value
            .as_str()
            .filter(|value| valid_id(value, MAX_ID_BYTES))
            .ok_or(OfficeDispatchRecoveryLocatorError::Corrupt)?;
        found = true;
        if value != target_thread_id {
            return Ok(false);
        }
    }
    Ok(found)
}

fn valid_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value == value.trim()
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "crewon_domain_office_dispatch_recovery_tests.rs"]
mod tests;
