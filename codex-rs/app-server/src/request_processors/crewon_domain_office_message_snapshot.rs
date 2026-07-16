use super::canonical::has_receipt;
use super::canonical::message_id;
use super::canonical::optional_receipt_string;
use super::canonical::receipt_object;
use super::canonical::required_receipt_string;
use super::*;

pub(super) fn preserve_canonical_receipt_messages(
    latest: Option<&JsonValue>,
    proposed: &mut JsonValue,
) -> Result<(), JSONRPCErrorError> {
    if latest
        .and_then(|config| config.get("workspace"))
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .any(has_invalid_server_receipt)
    {
        return Err(internal_error(
            "canonical Office message ledger contains an invalid receipt version",
        ));
    }
    let canonical = receipt_messages(latest.unwrap_or(&JsonValue::Null));
    let mut canonical_identity = std::collections::HashSet::with_capacity(canonical.len());
    for message in &canonical {
        let id = message_id(message)
            .filter(|id| id.starts_with("office-message-"))
            .ok_or_else(|| {
                internal_error("canonical Office receipt message has no server messageId")
            })?;
        let receipt = receipt_object(message)
            .ok_or_else(|| internal_error("canonical Office receipt message is invalid"))?;
        let nested_client_id = receipt
            .get("clientUserMessageId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| internal_error("canonical Office receipt has no client id"))?;
        if message
            .get("clientUserMessageId")
            .and_then(JsonValue::as_str)
            != Some(nested_client_id)
            || !canonical_identity.insert(id.to_string())
        {
            return Err(internal_error(
                "canonical Office receipt message identity is invalid or duplicated",
            ));
        }
    }
    if canonical.is_empty() {
        if let Some(messages) = proposed
            .get_mut("workspace")
            .and_then(|workspace| workspace.get_mut("messages"))
        {
            let messages = messages
                .as_array_mut()
                .ok_or_else(|| invalid_params("workspace.messages must be an array"))?;
            messages.retain(|message| !has_reserved_server_fields(message));
        }
        return Ok(());
    }
    let canonical_ids = canonical
        .iter()
        .filter_map(message_id)
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();
    let workspace = proposed
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))?;
    let messages = workspace
        .entry("messages".to_string())
        .or_insert_with(|| JsonValue::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| invalid_params("workspace.messages must be an array"))?;
    let proposed_messages = std::mem::take(messages);
    let mut preserved = Vec::with_capacity(proposed_messages.len() + canonical.len());
    let mut canonical = canonical.into_iter();
    for message in proposed_messages {
        if message_id(&message).is_some_and(|id| canonical_ids.contains(id)) {
            if let Some(canonical) = canonical.next() {
                preserved.push(canonical);
            }
            continue;
        }
        if !has_reserved_server_fields(&message) {
            preserved.push(message);
        }
    }
    preserved.extend(canonical);
    *messages = preserved;
    Ok(())
}

fn has_reserved_server_fields(message: &JsonValue) -> bool {
    has_server_receipt_authority(message)
}

fn has_invalid_server_receipt(message: &JsonValue) -> bool {
    has_server_receipt_authority(message) && !has_receipt(message)
}

fn has_server_receipt_authority(message: &JsonValue) -> bool {
    message
        .get(RECEIPT_FIELD)
        .and_then(JsonValue::as_object)
        .is_some_and(|receipt| {
            receipt.get("authority").and_then(JsonValue::as_str) == Some(RECEIPT_AUTHORITY)
        })
}

pub(super) async fn sync_receipt_sidecar(
    cwd: &str,
    config: &JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let record_id = office_record_id(config)
        .ok_or_else(|| internal_error("canonical Office receipt config has no recordId"))?;
    let record_revision = config
        .get("workspace")
        .and_then(|workspace| workspace.get("recordRevision"))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| internal_error("canonical Office receipt config has no recordRevision"))?;
    office_message_receipt::sync_from_canonical(
        cwd,
        record_id,
        record_revision,
        receipt_snapshot(config)?,
    )
    .await
}

fn receipt_snapshot(config: &JsonValue) -> Result<Vec<OfficeMessageReceipt>, JSONRPCErrorError> {
    receipt_messages(config)
        .iter()
        .map(|message| {
            let receipt = receipt_object(message)
                .ok_or_else(|| internal_error("canonical Office receipt disappeared"))?;
            let status = match required_receipt_string(receipt, "status")?.as_str() {
                "reserved" => ReceiptStatus::Reserved,
                "dispatching" => ReceiptStatus::Dispatching,
                "queued" => ReceiptStatus::Queued,
                "delivered" => ReceiptStatus::Delivered,
                "failed" => ReceiptStatus::Failed,
                _ => return Err(internal_error("canonical Office receipt status is invalid")),
            };
            let action = match required_receipt_string(receipt, "action")?.as_str() {
                "pending" => ReceiptAction::Pending,
                "startRun" => ReceiptAction::StartRun,
                "steerRun" => ReceiptAction::SteerRun,
                "queueAfterRun" => ReceiptAction::QueueAfterRun,
                _ => return Err(internal_error("canonical Office receipt action is invalid")),
            };
            let mentions = receipt
                .get("mentions")
                .and_then(JsonValue::as_array)
                .into_iter()
                .flatten()
                .map(|mention| {
                    mention.as_str().map(str::to_string).ok_or_else(|| {
                        internal_error("canonical Office receipt mention is invalid")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(OfficeMessageReceipt {
                receipt_id: required_receipt_string(receipt, "receiptId")?,
                client_user_message_id: required_receipt_string(receipt, "clientUserMessageId")?,
                payload_hash: required_receipt_string(receipt, "payloadHash")?,
                message_id: message_id(message)
                    .map(str::to_string)
                    .ok_or_else(|| internal_error("canonical Office message has no messageId"))?,
                sequence: receipt
                    .get("sequence")
                    .and_then(JsonValue::as_u64)
                    .filter(|sequence| *sequence > 0)
                    .ok_or_else(|| internal_error("canonical Office receipt has no sequence"))?,
                text: message
                    .get("text")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| internal_error("canonical Office message has no text"))?,
                locale: optional_receipt_string(receipt, "locale"),
                mentions,
                message_intent: optional_receipt_string(receipt, "messageIntent"),
                intent_classifier_version: receipt
                    .get("intentClassifierVersion")
                    .and_then(JsonValue::as_u64),
                status,
                action,
                run_id: optional_receipt_string(receipt, "runId"),
                thread_id: optional_receipt_string(receipt, "threadId"),
                expected_turn_id: optional_receipt_string(receipt, "expectedTurnId"),
                turn_id: optional_receipt_string(receipt, "turnId"),
                after_run_id: optional_receipt_string(receipt, "afterRunId"),
                queue_position: receipt
                    .get("queuePosition")
                    .and_then(JsonValue::as_u64)
                    .and_then(|position| u32::try_from(position).ok()),
                lease_id: optional_receipt_string(receipt, "leaseId"),
                lease_expires_at: optional_receipt_string(receipt, "leaseExpiresAt"),
                attempts: receipt
                    .get("attempts")
                    .and_then(JsonValue::as_u64)
                    .and_then(|attempts| u32::try_from(attempts).ok())
                    .unwrap_or_default(),
                created_at: required_receipt_string(receipt, "createdAt")?,
                updated_at: required_receipt_string(receipt, "updatedAt")?,
                error: optional_receipt_string(receipt, "error"),
            })
        })
        .collect()
}

pub(super) fn canonical_message(
    config: &JsonValue,
    client_user_message_id: &str,
) -> Result<JsonValue, JSONRPCErrorError> {
    let messages = config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
        .ok_or_else(|| internal_error("canonical Office config has no messages array"))?;
    messages
        .iter()
        .find(|message| {
            receipt_object(message).is_some_and(|receipt| {
                receipt
                    .get("clientUserMessageId")
                    .and_then(JsonValue::as_str)
                    == Some(client_user_message_id)
            })
        })
        .cloned()
        .ok_or_else(|| internal_error("canonical Office message receipt was not found"))
}

fn receipt_messages(config: &JsonValue) -> Vec<JsonValue> {
    let mut messages = config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|message| has_receipt(message))
        .cloned()
        .collect::<Vec<_>>();
    messages.sort_by_key(|message| {
        receipt_object(message)
            .and_then(|receipt| receipt.get("sequence"))
            .and_then(JsonValue::as_u64)
            .unwrap_or(u64::MAX)
    });
    messages
}
