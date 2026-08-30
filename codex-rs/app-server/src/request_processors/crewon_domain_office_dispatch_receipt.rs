use chrono::DateTime;
use crewon_core::UserInputOnceState;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;

use super::office_dispatch_admission_identity::OfficeDispatchAdmissionFields;
use super::office_dispatch_admission_identity::derive_office_dispatch_admission_identity;

const RECEIPT_AUTHORITY: &str = "crewon.app-server.office-dispatch-receipt/v1";
const RECEIPT_VERSION: u8 = 1;
const MAX_RECORD_ID_BYTES: usize = 128;
const MAX_ID_BYTES: usize = 256;
const MAX_PROMPT_TEXT_CHARS: usize = 4_000;
const MAX_ERROR_CHARS: usize = 512;
const DELEGATION_DISPATCH_KIND: &str = "delegation";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OfficeDispatchReceiptStatus {
    Starting,
    Admitted,
    Started,
    ExecutionUnknown,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OfficeDispatchAdmissionState {
    AdmissionOnly,
    Persisted,
}

impl From<UserInputOnceState> for OfficeDispatchAdmissionState {
    fn from(state: UserInputOnceState) -> Self {
        match state {
            UserInputOnceState::AdmissionOnly => Self::AdmissionOnly,
            UserInputOnceState::Persisted => Self::Persisted,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct OfficeDispatchReceiptToken<'a> {
    pub(crate) record_id: &'a str,
    pub(crate) intent_id: &'a str,
    pub(crate) source_thread_id: &'a str,
    pub(crate) source_turn_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) delegation_id: &'a str,
    pub(crate) target_thread_id: &'a str,
    pub(crate) prompt: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfficeDispatchReceipt {
    pub(crate) authority: String,
    pub(crate) version: u8,
    pub(crate) receipt_id: String,
    pub(crate) record_id: String,
    pub(crate) intent_id: String,
    pub(crate) source_thread_id: String,
    pub(crate) source_turn_id: String,
    pub(crate) run_id: String,
    pub(crate) delegation_id: String,
    pub(crate) target_thread_id: String,
    pub(crate) dispatch_kind: String,
    pub(crate) client_user_message_id: String,
    pub(crate) payload_hash: String,
    pub(crate) prompt_snapshot: String,
    pub(crate) status: OfficeDispatchReceiptStatus,
    pub(crate) admission_state: Option<OfficeDispatchAdmissionState>,
    pub(crate) turn_id: Option<String>,
    pub(crate) reserve_count: u32,
    pub(crate) last_error: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OfficeDispatchReceiptError {
    InvalidDelegation,
    InvalidReceipt,
    Conflict,
    InvalidTransition,
}

pub(crate) fn validate_prompt_snapshot(prompt: &str) -> Result<(), OfficeDispatchReceiptError> {
    if prompt.trim().is_empty() || prompt.chars().count() > MAX_PROMPT_TEXT_CHARS {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    Ok(())
}

pub(crate) fn reserve_starting(
    delegation: &mut JsonValue,
    token: OfficeDispatchReceiptToken<'_>,
    now: &str,
) -> Result<OfficeDispatchReceipt, OfficeDispatchReceiptError> {
    validate_prompt_snapshot(token.prompt)?;
    validate_queued_delegation(delegation, token.delegation_id)?;
    let existing = read_dispatch_receipt(delegation)?;
    let existed = existing.is_some();
    let mut receipt = match existing {
        Some(receipt) => receipt,
        None => receipt_from_token(token, now),
    };
    validate_stored_receipt(&receipt)?;
    validate_token(&receipt, token)?;
    if receipt.status != OfficeDispatchReceiptStatus::Starting {
        return Err(OfficeDispatchReceiptError::InvalidTransition);
    }
    if existed {
        validate_transition_time(&receipt, now)?;
        receipt.reserve_count = receipt
            .reserve_count
            .checked_add(1)
            .ok_or(OfficeDispatchReceiptError::InvalidReceipt)?;
        receipt.updated_at = now.to_string();
    }
    delegation
        .as_object_mut()
        .ok_or(OfficeDispatchReceiptError::InvalidDelegation)?
        .insert(
            "dispatchReceipt".to_string(),
            serde_json::to_value(&receipt)
                .map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?,
        );
    Ok(receipt)
}

pub(crate) fn mark_admitted(
    delegation: &mut JsonValue,
    token: OfficeDispatchReceiptToken<'_>,
    turn_id: &str,
    state: UserInputOnceState,
    now: &str,
) -> Result<OfficeDispatchReceipt, OfficeDispatchReceiptError> {
    validate_prompt_snapshot(token.prompt)?;
    if !valid_id(turn_id, MAX_ID_BYTES) {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    validate_queued_delegation(delegation, token.delegation_id)?;
    let mut receipt =
        read_dispatch_receipt(delegation)?.ok_or(OfficeDispatchReceiptError::InvalidReceipt)?;
    validate_token(&receipt, token)?;
    validate_transition_time(&receipt, now)?;
    let admission_state = OfficeDispatchAdmissionState::from(state);
    let delegation_turn_id = delegation.get("turnId").and_then(JsonValue::as_str);
    match receipt.status {
        OfficeDispatchReceiptStatus::Starting => {
            if delegation_turn_id.is_some() {
                return Err(OfficeDispatchReceiptError::Conflict);
            }
        }
        OfficeDispatchReceiptStatus::Admitted | OfficeDispatchReceiptStatus::Started => {
            if receipt.turn_id.as_deref() == Some(turn_id)
                && receipt.admission_state == Some(admission_state)
                && delegation_turn_id == Some(turn_id)
            {
                return Ok(receipt);
            }
            return Err(OfficeDispatchReceiptError::Conflict);
        }
        OfficeDispatchReceiptStatus::ExecutionUnknown | OfficeDispatchReceiptStatus::Failed => {
            return Err(OfficeDispatchReceiptError::InvalidTransition);
        }
    }
    receipt.status = OfficeDispatchReceiptStatus::Admitted;
    receipt.admission_state = Some(admission_state);
    receipt.turn_id = Some(turn_id.to_string());
    receipt.last_error = None;
    receipt.updated_at = now.to_string();
    let object = delegation
        .as_object_mut()
        .ok_or(OfficeDispatchReceiptError::InvalidDelegation)?;
    object.insert("turnId".to_string(), JsonValue::String(turn_id.to_string()));
    object.insert(
        "dispatchReceipt".to_string(),
        serde_json::to_value(&receipt).map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?,
    );
    Ok(receipt)
}

pub(crate) fn mark_starting_failed(
    delegation: &mut JsonValue,
    token: OfficeDispatchReceiptToken<'_>,
    error: &str,
    now: &str,
) -> Result<OfficeDispatchReceipt, OfficeDispatchReceiptError> {
    validate_prompt_snapshot(token.prompt)?;
    let error = error.trim();
    if error.is_empty() {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    let bounded_error = truncate_chars(error, MAX_ERROR_CHARS);
    if !valid_error(&bounded_error) {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    validate_queued_delegation(delegation, token.delegation_id)?;
    if delegation.get("turnId").is_some() {
        return Err(OfficeDispatchReceiptError::Conflict);
    }
    let mut receipt =
        read_dispatch_receipt(delegation)?.ok_or(OfficeDispatchReceiptError::InvalidReceipt)?;
    validate_token(&receipt, token)?;
    validate_transition_time(&receipt, now)?;
    match receipt.status {
        OfficeDispatchReceiptStatus::Starting => {}
        OfficeDispatchReceiptStatus::Failed => {
            if receipt.last_error.as_deref() == Some(bounded_error.as_str()) {
                return Ok(receipt);
            }
            return Err(OfficeDispatchReceiptError::Conflict);
        }
        OfficeDispatchReceiptStatus::Admitted
        | OfficeDispatchReceiptStatus::Started
        | OfficeDispatchReceiptStatus::ExecutionUnknown => {
            return Err(OfficeDispatchReceiptError::InvalidTransition);
        }
    }
    receipt.status = OfficeDispatchReceiptStatus::Failed;
    receipt.last_error = Some(bounded_error);
    receipt.updated_at = now.to_string();
    delegation
        .as_object_mut()
        .ok_or(OfficeDispatchReceiptError::InvalidDelegation)?
        .insert(
            "dispatchReceipt".to_string(),
            serde_json::to_value(&receipt)
                .map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?,
        );
    Ok(receipt)
}

pub(crate) fn mark_execution_unknown(
    delegation: &mut JsonValue,
    token: OfficeDispatchReceiptToken<'_>,
    turn_id: &str,
    admission_state: OfficeDispatchAdmissionState,
    error: &str,
    now: &str,
) -> Result<OfficeDispatchReceipt, OfficeDispatchReceiptError> {
    validate_prompt_snapshot(token.prompt)?;
    if !valid_id(turn_id, MAX_ID_BYTES) {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    let error = truncate_chars(error.trim(), MAX_ERROR_CHARS);
    if !valid_error(&error) {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    validate_queued_delegation(delegation, token.delegation_id)?;
    let mut receipt =
        read_dispatch_receipt(delegation)?.ok_or(OfficeDispatchReceiptError::InvalidReceipt)?;
    validate_token(&receipt, token)?;
    let delegation_turn_id = delegation.get("turnId").and_then(JsonValue::as_str);
    if receipt.status == OfficeDispatchReceiptStatus::ExecutionUnknown {
        if receipt.turn_id.as_deref() == Some(turn_id)
            && receipt.admission_state == Some(admission_state)
            && receipt.last_error.as_deref() == Some(error.as_str())
            && delegation_turn_id == Some(turn_id)
        {
            return Ok(receipt);
        }
        return Err(OfficeDispatchReceiptError::Conflict);
    }
    match receipt.status {
        OfficeDispatchReceiptStatus::Starting => {
            if delegation_turn_id.is_some() {
                return Err(OfficeDispatchReceiptError::Conflict);
            }
        }
        OfficeDispatchReceiptStatus::Admitted | OfficeDispatchReceiptStatus::Started => {
            if receipt.turn_id.as_deref() != Some(turn_id)
                || receipt.admission_state != Some(admission_state)
                || delegation_turn_id != Some(turn_id)
            {
                return Err(OfficeDispatchReceiptError::Conflict);
            }
        }
        OfficeDispatchReceiptStatus::Failed | OfficeDispatchReceiptStatus::ExecutionUnknown => {
            return Err(OfficeDispatchReceiptError::InvalidTransition);
        }
    }
    validate_transition_time(&receipt, now)?;
    receipt.status = OfficeDispatchReceiptStatus::ExecutionUnknown;
    receipt.admission_state = Some(admission_state);
    receipt.turn_id = Some(turn_id.to_string());
    receipt.last_error = Some(error);
    receipt.updated_at = now.to_string();
    let object = delegation
        .as_object_mut()
        .ok_or(OfficeDispatchReceiptError::InvalidDelegation)?;
    object.insert("turnId".to_string(), JsonValue::String(turn_id.to_string()));
    object.insert(
        "dispatchReceipt".to_string(),
        serde_json::to_value(&receipt).map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?,
    );
    Ok(receipt)
}

fn receipt_from_token(token: OfficeDispatchReceiptToken<'_>, now: &str) -> OfficeDispatchReceipt {
    let identity = derive_identity(token);
    OfficeDispatchReceipt {
        authority: RECEIPT_AUTHORITY.to_string(),
        version: RECEIPT_VERSION,
        receipt_id: identity.client_id.clone(),
        record_id: token.record_id.to_string(),
        intent_id: token.intent_id.to_string(),
        source_thread_id: token.source_thread_id.to_string(),
        source_turn_id: token.source_turn_id.to_string(),
        run_id: token.run_id.to_string(),
        delegation_id: token.delegation_id.to_string(),
        target_thread_id: token.target_thread_id.to_string(),
        dispatch_kind: DELEGATION_DISPATCH_KIND.to_string(),
        client_user_message_id: identity.client_id,
        payload_hash: identity.payload_hash,
        prompt_snapshot: token.prompt.to_string(),
        status: OfficeDispatchReceiptStatus::Starting,
        admission_state: None,
        turn_id: None,
        reserve_count: 1,
        last_error: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

fn derive_identity(
    token: OfficeDispatchReceiptToken<'_>,
) -> super::office_dispatch_admission_identity::OfficeDispatchAdmissionIdentity {
    derive_office_dispatch_admission_identity(OfficeDispatchAdmissionFields {
        record_id: token.record_id,
        intent_id: token.intent_id,
        source_thread_id: token.source_thread_id,
        source_turn_id: token.source_turn_id,
        target_thread_id: token.target_thread_id,
        run_id: token.run_id,
        dispatch_kind: DELEGATION_DISPATCH_KIND,
        subject_id: token.delegation_id,
        prompt: token.prompt,
    })
}

fn validate_token(
    receipt: &OfficeDispatchReceipt,
    token: OfficeDispatchReceiptToken<'_>,
) -> Result<(), OfficeDispatchReceiptError> {
    let expected = receipt_from_token(token, &receipt.created_at);
    let matches = receipt.authority == expected.authority
        && receipt.version == expected.version
        && receipt.receipt_id == expected.receipt_id
        && receipt.record_id == expected.record_id
        && receipt.intent_id == expected.intent_id
        && receipt.source_thread_id == expected.source_thread_id
        && receipt.source_turn_id == expected.source_turn_id
        && receipt.run_id == expected.run_id
        && receipt.delegation_id == expected.delegation_id
        && receipt.target_thread_id == expected.target_thread_id
        && receipt.dispatch_kind == expected.dispatch_kind
        && receipt.client_user_message_id == expected.client_user_message_id
        && receipt.payload_hash == expected.payload_hash
        && receipt.prompt_snapshot == expected.prompt_snapshot;
    matches
        .then_some(())
        .ok_or(OfficeDispatchReceiptError::Conflict)
}

fn validate_shape(receipt: &OfficeDispatchReceipt) -> Result<(), OfficeDispatchReceiptError> {
    let created_at = DateTime::parse_from_rfc3339(&receipt.created_at)
        .map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?;
    let updated_at = DateTime::parse_from_rfc3339(&receipt.updated_at)
        .map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?;
    if receipt.reserve_count == 0 || updated_at < created_at {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    match receipt.status {
        OfficeDispatchReceiptStatus::Starting => {
            if receipt.turn_id.is_some()
                || receipt.admission_state.is_some()
                || receipt.last_error.is_some()
            {
                return Err(OfficeDispatchReceiptError::InvalidReceipt);
            }
        }
        OfficeDispatchReceiptStatus::Admitted | OfficeDispatchReceiptStatus::Started => {
            if receipt.turn_id.is_none()
                || receipt.admission_state.is_none()
                || receipt.last_error.is_some()
            {
                return Err(OfficeDispatchReceiptError::InvalidReceipt);
            }
        }
        OfficeDispatchReceiptStatus::ExecutionUnknown => {
            if receipt.turn_id.is_none()
                || receipt.admission_state.is_none()
                || receipt
                    .last_error
                    .as_deref()
                    .is_none_or(|error| !valid_error(error))
            {
                return Err(OfficeDispatchReceiptError::InvalidReceipt);
            }
        }
        OfficeDispatchReceiptStatus::Failed => {
            if receipt.turn_id.is_some()
                || receipt.admission_state.is_some()
                || receipt
                    .last_error
                    .as_deref()
                    .is_none_or(|error| !valid_error(error))
            {
                return Err(OfficeDispatchReceiptError::InvalidReceipt);
            }
        }
    }
    Ok(())
}

pub(crate) fn read_dispatch_receipt(
    delegation: &JsonValue,
) -> Result<Option<OfficeDispatchReceipt>, OfficeDispatchReceiptError> {
    let Some(value) = delegation.get("dispatchReceipt") else {
        return Ok(None);
    };
    let prompt_snapshot = value
        .get("promptSnapshot")
        .and_then(JsonValue::as_str)
        .ok_or(OfficeDispatchReceiptError::InvalidReceipt)?;
    validate_prompt_snapshot(prompt_snapshot)?;
    let receipt = serde_json::from_value(value.clone())
        .map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?;
    validate_stored_receipt(&receipt)?;
    Ok(Some(receipt))
}

pub(crate) fn has_known_dispatch_receipt_authority(delegation: &JsonValue) -> bool {
    delegation
        .get("dispatchReceipt")
        .and_then(JsonValue::as_object)
        .and_then(|receipt| receipt.get("authority"))
        .and_then(JsonValue::as_str)
        == Some(RECEIPT_AUTHORITY)
}

fn validate_queued_delegation(
    delegation: &JsonValue,
    delegation_id: &str,
) -> Result<(), OfficeDispatchReceiptError> {
    let object = delegation
        .as_object()
        .ok_or(OfficeDispatchReceiptError::InvalidDelegation)?;
    if object.get("id").and_then(JsonValue::as_str) != Some(delegation_id)
        || object.get("status").and_then(JsonValue::as_str) != Some("queued")
    {
        return Err(OfficeDispatchReceiptError::InvalidDelegation);
    }
    Ok(())
}

fn validate_stored_receipt(
    receipt: &OfficeDispatchReceipt,
) -> Result<(), OfficeDispatchReceiptError> {
    validate_prompt_snapshot(&receipt.prompt_snapshot)?;
    if receipt.authority != RECEIPT_AUTHORITY
        || receipt.version != RECEIPT_VERSION
        || receipt.receipt_id != receipt.client_user_message_id
        || !valid_id(&receipt.receipt_id, MAX_ID_BYTES)
        || !valid_id(&receipt.record_id, MAX_RECORD_ID_BYTES)
        || !valid_id(&receipt.intent_id, MAX_ID_BYTES)
        || !valid_id(&receipt.source_thread_id, MAX_ID_BYTES)
        || !valid_id(&receipt.source_turn_id, MAX_ID_BYTES)
        || !valid_id(&receipt.run_id, MAX_ID_BYTES)
        || !valid_id(&receipt.delegation_id, MAX_ID_BYTES)
        || !valid_id(&receipt.target_thread_id, MAX_ID_BYTES)
        || receipt.dispatch_kind != DELEGATION_DISPATCH_KIND
    {
        return Err(OfficeDispatchReceiptError::InvalidReceipt);
    }
    let expected_identity =
        derive_office_dispatch_admission_identity(OfficeDispatchAdmissionFields {
            record_id: &receipt.record_id,
            intent_id: &receipt.intent_id,
            source_thread_id: &receipt.source_thread_id,
            source_turn_id: &receipt.source_turn_id,
            target_thread_id: &receipt.target_thread_id,
            run_id: &receipt.run_id,
            dispatch_kind: &receipt.dispatch_kind,
            subject_id: &receipt.delegation_id,
            prompt: &receipt.prompt_snapshot,
        });
    if receipt.client_user_message_id != expected_identity.client_id
        || receipt.payload_hash != expected_identity.payload_hash
    {
        return Err(OfficeDispatchReceiptError::Conflict);
    }
    validate_shape(receipt)
}

fn valid_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value == value.trim()
        && !value.chars().any(char::is_control)
}

fn validate_transition_time(
    receipt: &OfficeDispatchReceipt,
    now: &str,
) -> Result<(), OfficeDispatchReceiptError> {
    let now = DateTime::parse_from_rfc3339(now)
        .map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?;
    let updated_at = DateTime::parse_from_rfc3339(&receipt.updated_at)
        .map_err(|_| OfficeDispatchReceiptError::InvalidReceipt)?;
    (now >= updated_at)
        .then_some(())
        .ok_or(OfficeDispatchReceiptError::InvalidReceipt)
}

fn valid_error(error: &str) -> bool {
    !error.is_empty()
        && error == error.trim()
        && error.chars().count() <= MAX_ERROR_CHARS
        && !error.chars().any(char::is_control)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
