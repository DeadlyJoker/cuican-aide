use chrono::DateTime;
use chrono::Duration as ChronoDuration;
use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeMessageDelivery;
use crewon_app_server_protocol::OfficeMessageMention;
use crewon_app_server_protocol::OfficeMessageProcessingPhase;
use crewon_app_server_protocol::OfficeMessageSubmitParams;
use serde_json::Map;
use serde_json::Value as JsonValue;
use serde_json::json;
use uuid::Uuid;

use super::DomainKind;
use super::OfficeRunSyncUpdate;
use super::office_message_intent::OfficeMessageIntent;
use super::office_message_receipt;
use super::office_message_receipt::OfficeMessageReceipt;
use super::office_message_receipt::ReceiptAction;
use super::office_message_receipt::ReceiptStatus;
use super::office_storage;
use super::office_storage::office_record_id;
use super::office_thread_id;
use super::sha256_hex;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

#[path = "crewon_domain_office_message_canonical.rs"]
mod canonical;
#[path = "crewon_domain_office_message_queue.rs"]
mod queue;
#[path = "crewon_domain_office_message_runtime.rs"]
mod runtime;
#[path = "crewon_domain_office_message_snapshot.rs"]
mod snapshot;
#[path = "crewon_domain_office_message_state.rs"]
mod state;
#[path = "crewon_domain_office_message_validation.rs"]
mod validation;

use canonical::clear_dispatch_lease;
use canonical::next_queue_position;
use canonical::optional_receipt_string;
use canonical::receipt_message_mut;
use canonical::receipt_object;
use canonical::receipt_object_mut;
use canonical::set_receipt_string;
use canonical::truncate_utf8;
use snapshot::canonical_message;
use state::decide_and_apply;
use validation::ValidatedSubmit;
use validation::input_for_mutation;
use validation::validate_submit;

const RECEIPT_FIELD: &str = "officeMessageReceipt";
const RECEIPT_AUTHORITY: &str = "crewon.app-server.office-message-receipt/v1";
const RECEIPT_VERSION: u64 = 1;
const MAX_TEXT_BYTES: usize = 900;
const MAX_CLIENT_ID_BYTES: usize = 256;
const MAX_MEMBER_ID_BYTES: usize = 128;
const MAX_MENTIONS: usize = 16;
const MAX_ACTIVE_RECEIPTS: usize = 8;
const MAX_TOTAL_RECEIPTS: usize = 256;
const DISPATCH_LEASE_SECONDS: i64 = 30;
const RETRY_AFTER_MS: u32 = 250;

pub(super) fn preserve_canonical_receipt_messages(
    latest: Option<&JsonValue>,
    proposed: &mut JsonValue,
) -> Result<(), JSONRPCErrorError> {
    snapshot::preserve_canonical_receipt_messages(latest, proposed)
}

pub(super) async fn sync_receipt_sidecar_if_present(
    cwd: &str,
    config: &JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let has_receipts = config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .any(canonical::has_receipt);
    if !has_receipts {
        return Ok(());
    }
    snapshot::sync_receipt_sidecar(cwd, config).await
}

fn canonical_message_payload(
    message: &JsonValue,
) -> Result<(String, Option<String>), JSONRPCErrorError> {
    let receipt = receipt_object(message)
        .ok_or_else(|| internal_error("canonical Office message receipt is invalid"))?;
    let text = message
        .get("text")
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| internal_error("canonical Office message has no text"))?;
    Ok((text, optional_receipt_string(receipt, "locale")))
}

pub(crate) fn canonical_receipt_status<'a>(
    config: &'a JsonValue,
    client_user_message_id: &str,
) -> Option<&'a str> {
    config
        .get("workspace")?
        .get("messages")?
        .as_array()?
        .iter()
        .find_map(|message| {
            let receipt = canonical::receipt_object(message)?;
            if receipt
                .get("clientUserMessageId")
                .and_then(JsonValue::as_str)
                != Some(client_user_message_id)
            {
                return None;
            }
            receipt.get("status").and_then(JsonValue::as_str)
        })
}

#[derive(Debug)]
pub(crate) struct PreparedOfficeMessageSubmit {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) receipt_id: String,
    pub(crate) client_user_message_id: String,
    pub(crate) replayed: bool,
    pub(crate) text: String,
    pub(crate) locale: Option<String>,
    pub(crate) message: JsonValue,
    pub(crate) action: OfficeMessageSubmitAction,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum OfficeMessageSubmitAction {
    Respond(OfficeMessageDelivery),
    Run {
        thread_id: String,
        dispatch_mode: OfficeMessageDispatchMode,
    },
    Steer {
        run_id: String,
        thread_id: String,
        expected_turn_id: String,
        dispatch_mode: OfficeMessageDispatchMode,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeMessageDispatchMode {
    ExecuteOrRecover,
    RecoverOnly,
}

pub(crate) async fn prepare(
    params: OfficeMessageSubmitParams,
) -> Result<PreparedOfficeMessageSubmit, JSONRPCErrorError> {
    let input = validate_submit(params)?;
    let now = Utc::now();
    let lease_id = format!("office-message-lease-{}", Uuid::now_v7());
    let lease_expires_at = (now + ChronoDuration::seconds(DISPATCH_LEASE_SECONDS)).to_rfc3339();
    let mutation_input = input_for_mutation(&input);
    let (update, _changed, (replayed, action)) =
        office_storage::mutate_latest_office_record_with_result(
            &input.cwd,
            &input.config,
            move |latest| {
                decide_and_apply(latest, &mutation_input, now, &lease_id, &lease_expires_at)
            },
        )
        .await?;
    let message = canonical_message(&update.config, &input.client_user_message_id)?;
    let (text, locale) = canonical_message_payload(&message)?;
    Ok(PreparedOfficeMessageSubmit {
        cwd: input.cwd,
        config: update.config,
        receipt_id: input.receipt_id,
        client_user_message_id: input.client_user_message_id,
        replayed,
        text,
        locale,
        message,
        action,
    })
}

pub(crate) async fn prepare_next_queued_message(
    cwd: &str,
    config: &JsonValue,
    completed_run_id: &str,
) -> Result<Option<PreparedOfficeMessageSubmit>, JSONRPCErrorError> {
    let now = Utc::now();
    let lease_id = format!("office-message-lease-{}", Uuid::now_v7());
    let lease_expires_at = (now + ChronoDuration::seconds(DISPATCH_LEASE_SECONDS)).to_rfc3339();
    let completed_run_id = completed_run_id.to_string();
    let (update, changed, claimed) =
        office_storage::mutate_latest_office_record_with_result(cwd, config, move |latest| {
            let (changed, claimed) = queue::claim_next_queued_after_run(
                latest,
                &completed_run_id,
                now,
                &lease_id,
                &lease_expires_at,
            )?;
            Ok((changed, claimed))
        })
        .await?;
    let Some((mut input, action)) = claimed else {
        return Ok(None);
    };
    debug_assert!(changed);
    input.cwd = cwd.to_string();
    let message = canonical_message(&update.config, &input.client_user_message_id)?;
    let (text, locale) = canonical_message_payload(&message)?;
    Ok(Some(PreparedOfficeMessageSubmit {
        cwd: input.cwd,
        config: update.config,
        receipt_id: input.receipt_id,
        client_user_message_id: input.client_user_message_id,
        replayed: true,
        text,
        locale,
        message,
        action,
    }))
}

pub(crate) fn run_id_for_client_message(
    config: &JsonValue,
    client_user_message_id: &str,
) -> Result<String, JSONRPCErrorError> {
    runtime::run_for_client_user_message_id(config, client_user_message_id)
        .and_then(|run| run.get("id"))
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| internal_error("Office message receipt has no matching run"))
}

pub(crate) fn run_has_turn_for_client_message(
    config: &JsonValue,
    client_user_message_id: &str,
) -> bool {
    runtime::run_for_client_user_message_id(config, client_user_message_id).is_some_and(|run| {
        run.get("turnId")
            .and_then(JsonValue::as_str)
            .is_some_and(|turn_id| !turn_id.trim().is_empty())
    })
}

pub(crate) async fn mark_run_started(
    prepared: &PreparedOfficeMessageSubmit,
    run_id: &str,
    thread_id: &str,
    turn_id: &str,
) -> Result<OfficeRunSyncUpdate, JSONRPCErrorError> {
    mark_delivered(prepared, "startRun", Some(run_id), thread_id, turn_id).await
}

pub(crate) async fn mark_steered(
    prepared: &PreparedOfficeMessageSubmit,
    run_id: &str,
    thread_id: &str,
    turn_id: &str,
) -> Result<OfficeRunSyncUpdate, JSONRPCErrorError> {
    mark_delivered(prepared, "steerRun", Some(run_id), thread_id, turn_id).await
}

pub(crate) async fn mark_queued(
    prepared: &PreparedOfficeMessageSubmit,
    after_run_id: &str,
) -> Result<(OfficeRunSyncUpdate, u32), JSONRPCErrorError> {
    let client_id = prepared.client_user_message_id.clone();
    let after_run_id = after_run_id.to_string();
    let now = Utc::now().to_rfc3339();
    let (update, _, position) = office_storage::mutate_latest_office_record_with_result(
        &prepared.cwd,
        &prepared.config,
        move |latest| {
            let position = next_queue_position(latest, Some(&client_id));
            let receipt = receipt_object_mut(receipt_message_mut(latest, &client_id)?)?;
            set_receipt_string(receipt, "status", "queued");
            set_receipt_string(receipt, "action", "queueAfterRun");
            set_receipt_string(receipt, "afterRunId", &after_run_id);
            receipt.insert("queuePosition".to_string(), json!(position));
            receipt.insert("updatedAt".to_string(), json!(now));
            clear_dispatch_lease(receipt);
            Ok((true, position))
        },
    )
    .await?;
    Ok((update, position))
}

pub(crate) async fn mark_failed(
    prepared: &PreparedOfficeMessageSubmit,
    message: &str,
) -> Result<OfficeRunSyncUpdate, JSONRPCErrorError> {
    let client_id = prepared.client_user_message_id.clone();
    let error = truncate_utf8(message, 320);
    let now = Utc::now().to_rfc3339();
    let (update, _, ()) = office_storage::mutate_latest_office_record_with_result(
        &prepared.cwd,
        &prepared.config,
        move |latest| {
            let receipt = receipt_object_mut(receipt_message_mut(latest, &client_id)?)?;
            set_receipt_string(receipt, "status", "failed");
            set_receipt_string(receipt, "error", &error);
            receipt.insert("updatedAt".to_string(), json!(now));
            clear_dispatch_lease(receipt);
            Ok((true, ()))
        },
    )
    .await?;
    Ok(update)
}

async fn mark_delivered(
    prepared: &PreparedOfficeMessageSubmit,
    action: &str,
    run_id: Option<&str>,
    thread_id: &str,
    turn_id: &str,
) -> Result<OfficeRunSyncUpdate, JSONRPCErrorError> {
    let client_id = prepared.client_user_message_id.clone();
    let action = action.to_string();
    let run_id = run_id.map(str::to_string);
    let thread_id = thread_id.to_string();
    let turn_id = turn_id.to_string();
    let now = Utc::now().to_rfc3339();
    let (update, _, ()) = office_storage::mutate_latest_office_record_with_result(
        &prepared.cwd,
        &prepared.config,
        move |latest| {
            let receipt = receipt_object_mut(receipt_message_mut(latest, &client_id)?)?;
            set_receipt_string(receipt, "status", "delivered");
            set_receipt_string(receipt, "action", &action);
            if let Some(run_id) = run_id.as_deref() {
                set_receipt_string(receipt, "runId", run_id);
            }
            set_receipt_string(receipt, "threadId", &thread_id);
            set_receipt_string(receipt, "turnId", &turn_id);
            receipt.insert("updatedAt".to_string(), json!(now));
            clear_dispatch_lease(receipt);
            Ok((true, ()))
        },
    )
    .await?;
    Ok(update)
}

#[cfg(test)]
#[path = "crewon_domain_office_message_tests.rs"]
mod tests;
