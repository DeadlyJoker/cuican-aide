use super::*;

pub(super) fn append_canonical_message(
    config: &mut JsonValue,
    input: &ValidatedSubmit,
    now: chrono::DateTime<Utc>,
) -> Result<(), JSONRPCErrorError> {
    append_canonical_message_with_intent(
        config,
        input,
        now,
        OfficeMessageIntent::classify(&input.text, !input.mentions.is_empty()),
    )
}

pub(super) fn append_canonical_message_with_intent(
    config: &mut JsonValue,
    input: &ValidatedSubmit,
    now: chrono::DateTime<Utc>,
    message_intent: OfficeMessageIntent,
) -> Result<(), JSONRPCErrorError> {
    let timestamp = now.to_rfc3339();
    let sequence = next_receipt_sequence(config)?;
    let receipt = canonical_receipt(input, &timestamp, sequence, message_intent);
    let message = json!({
        "author": if input.locale.as_deref() == Some("en") { "You" } else { "你" },
        "glyph": "@",
        "accent": "slate",
        "time": now.format("%H:%M").to_string(),
        "text": input.text,
        "kind": "message",
        "messageId": input.message_id,
        "clientUserMessageId": input.client_user_message_id,
        RECEIPT_FIELD: receipt
    });
    messages_mut(workspace_mut(config)?)?.push(message);
    set_config_updated_at(config, &timestamp)
}

pub(super) fn attach_canonical_receipt(
    config: &mut JsonValue,
    message_index: usize,
    input: &ValidatedSubmit,
    now: chrono::DateTime<Utc>,
    message_intent: OfficeMessageIntent,
) -> Result<(), JSONRPCErrorError> {
    let timestamp = now.to_rfc3339();
    let sequence = next_receipt_sequence(config)?;
    let receipt = canonical_receipt(input, &timestamp, sequence, message_intent);
    let message = messages_mut(workspace_mut(config)?)?
        .get_mut(message_index)
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("legacy Office message must be an object"))?;
    message.insert(
        "messageId".to_string(),
        JsonValue::String(input.message_id.clone()),
    );
    message.insert(RECEIPT_FIELD.to_string(), receipt);
    set_config_updated_at(config, &timestamp)
}

fn canonical_receipt(
    input: &ValidatedSubmit,
    timestamp: &str,
    sequence: u64,
    message_intent: OfficeMessageIntent,
) -> JsonValue {
    json!({
        "authority": RECEIPT_AUTHORITY,
        "version": RECEIPT_VERSION,
        "receiptId": input.receipt_id,
        "clientUserMessageId": input.client_user_message_id,
        "payloadHash": input.payload_hash,
        "sequence": sequence,
        "status": "reserved",
        "action": "pending",
        "attempts": 0,
        "locale": input.locale,
        "mentions": input.mentions,
        "messageIntent": message_intent.as_str(),
        "intentClassifierVersion": OfficeMessageIntent::CLASSIFIER_VERSION,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn claim_receipt(
    config: &mut JsonValue,
    input: &ValidatedSubmit,
    action: &str,
    run_id: Option<&str>,
    thread_id: &str,
    expected_turn_id: Option<&str>,
    now: chrono::DateTime<Utc>,
    lease_id: &str,
    lease_expires_at: &str,
) -> Result<(), JSONRPCErrorError> {
    let receipt = receipt_object_mut(receipt_message_mut(config, &input.client_user_message_id)?)?;
    set_receipt_string(receipt, "status", "dispatching");
    set_receipt_string(receipt, "action", action);
    set_receipt_string(receipt, "threadId", thread_id);
    set_or_remove(receipt, "runId", run_id);
    set_or_remove(receipt, "expectedTurnId", expected_turn_id);
    set_receipt_string(receipt, "leaseId", lease_id);
    set_receipt_string(receipt, "leaseExpiresAt", lease_expires_at);
    let attempts = receipt
        .get("attempts")
        .and_then(JsonValue::as_u64)
        .unwrap_or_default()
        .saturating_add(1)
        .min(u64::from(office_message_receipt::MAX_DISPATCH_ATTEMPTS));
    receipt.insert("attempts".to_string(), json!(attempts));
    receipt.insert("updatedAt".to_string(), json!(now.to_rfc3339()));
    receipt.remove("afterRunId");
    receipt.remove("queuePosition");
    Ok(())
}

pub(super) fn reserve_receipt(
    config: &mut JsonValue,
    input: &ValidatedSubmit,
    now: chrono::DateTime<Utc>,
    lease_id: &str,
) -> Result<(), JSONRPCErrorError> {
    let receipt = receipt_object_mut(receipt_message_mut(config, &input.client_user_message_id)?)?;
    set_receipt_string(receipt, "status", "reserved");
    set_receipt_string(receipt, "action", "pending");
    set_receipt_string(receipt, "leaseId", lease_id);
    set_receipt_string(
        receipt,
        "leaseExpiresAt",
        &(now + ChronoDuration::milliseconds(i64::from(RETRY_AFTER_MS))).to_rfc3339(),
    );
    receipt.insert("updatedAt".to_string(), json!(now.to_rfc3339()));
    Ok(())
}

pub(super) fn queue_receipt(
    config: &mut JsonValue,
    input: &ValidatedSubmit,
    after_run_id: &str,
    now: chrono::DateTime<Utc>,
) -> Result<u32, JSONRPCErrorError> {
    let position = next_queue_position(config, Some(&input.client_user_message_id));
    let receipt = receipt_object_mut(receipt_message_mut(config, &input.client_user_message_id)?)?;
    set_receipt_string(receipt, "status", "queued");
    set_receipt_string(receipt, "action", "queueAfterRun");
    set_receipt_string(receipt, "afterRunId", after_run_id);
    receipt.insert("queuePosition".to_string(), json!(position));
    receipt.insert("updatedAt".to_string(), json!(now.to_rfc3339()));
    clear_dispatch_lease(receipt);
    Ok(position)
}

pub(super) fn next_queue_position(config: &JsonValue, excluding_client_id: Option<&str>) -> u32 {
    let current_sequence = excluding_client_id.and_then(|client_id| {
        receipt_iter(config)
            .find(|receipt| {
                receipt
                    .get("clientUserMessageId")
                    .and_then(JsonValue::as_str)
                    == Some(client_id)
            })
            .and_then(|receipt| receipt.get("sequence"))
            .and_then(JsonValue::as_u64)
    });
    let queued = receipt_iter(config)
        .filter(|receipt| receipt.get("status").and_then(JsonValue::as_str) == Some("queued"))
        .filter(|receipt| {
            excluding_client_id.is_none_or(|client_id| {
                receipt
                    .get("clientUserMessageId")
                    .and_then(JsonValue::as_str)
                    != Some(client_id)
            })
        })
        .filter(|receipt| {
            current_sequence.is_none_or(|sequence| {
                receipt
                    .get("sequence")
                    .and_then(JsonValue::as_u64)
                    .is_some_and(|candidate| candidate < sequence)
            })
        })
        .count();
    u32::try_from(queued.saturating_add(1)).unwrap_or(u32::MAX)
}

pub(super) fn active_receipt_count(config: &JsonValue) -> usize {
    receipt_iter(config)
        .filter(|receipt| {
            matches!(
                receipt.get("status").and_then(JsonValue::as_str),
                Some("reserved" | "dispatching" | "queued")
            )
        })
        .count()
}

pub(super) fn prune_terminal_receipts(config: &mut JsonValue) -> Result<(), JSONRPCErrorError> {
    let messages = messages_mut(workspace_mut(config)?)?;
    while messages
        .iter()
        .filter(|message| has_receipt(message))
        .count()
        >= MAX_TOTAL_RECEIPTS
    {
        let Some(index) = messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| {
                let receipt = receipt_object(message)?;
                if !matches!(
                    receipt.get("status").and_then(JsonValue::as_str),
                    Some("delivered" | "failed")
                ) {
                    return None;
                }
                Some((index, receipt.get("sequence").and_then(JsonValue::as_u64)?))
            })
            .min_by_key(|(_, sequence)| *sequence)
            .map(|(index, _)| index)
        else {
            return Err(invalid_params(
                "Office message receipt ledger reached its 256-item hard limit",
            ));
        };
        messages.remove(index);
    }
    Ok(())
}

pub(super) fn receipt_message_mut<'a>(
    config: &'a mut JsonValue,
    client_user_message_id: &str,
) -> Result<&'a mut JsonValue, JSONRPCErrorError> {
    messages_mut(workspace_mut(config)?)?
        .iter_mut()
        .find(|message| {
            receipt_object(message).is_some_and(|receipt| {
                receipt
                    .get("clientUserMessageId")
                    .and_then(JsonValue::as_str)
                    == Some(client_user_message_id)
            })
        })
        .ok_or_else(|| internal_error("canonical Office message receipt was not found"))
}

pub(super) fn receipt_object(message: &JsonValue) -> Option<&Map<String, JsonValue>> {
    let receipt = message.get(RECEIPT_FIELD)?.as_object()?;
    (receipt.get("authority").and_then(JsonValue::as_str) == Some(RECEIPT_AUTHORITY)
        && receipt.get("version").and_then(JsonValue::as_u64) == Some(RECEIPT_VERSION))
    .then_some(receipt)
}

pub(super) fn receipt_object_mut(
    message: &mut JsonValue,
) -> Result<&mut Map<String, JsonValue>, JSONRPCErrorError> {
    let receipt = message
        .get_mut(RECEIPT_FIELD)
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| internal_error("canonical Office message has no receipt object"))?;
    if receipt.get("authority").and_then(JsonValue::as_str) != Some(RECEIPT_AUTHORITY)
        || receipt.get("version").and_then(JsonValue::as_u64) != Some(RECEIPT_VERSION)
    {
        return Err(internal_error(
            "canonical Office message receipt version is invalid",
        ));
    }
    Ok(receipt)
}

pub(super) fn has_receipt(message: &JsonValue) -> bool {
    receipt_object(message).is_some()
}

pub(super) fn message_id(message: &JsonValue) -> Option<&str> {
    message.get("messageId").and_then(JsonValue::as_str)
}

pub(super) fn required_receipt_string(
    receipt: &Map<String, JsonValue>,
    field: &str,
) -> Result<String, JSONRPCErrorError> {
    receipt
        .get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| internal_error(format!("canonical Office receipt has no {field}")))
}

pub(super) fn optional_receipt_string(
    receipt: &Map<String, JsonValue>,
    field: &str,
) -> Option<String> {
    receipt
        .get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(super) fn workspace_mut(
    config: &mut JsonValue,
) -> Result<&mut Map<String, JsonValue>, JSONRPCErrorError> {
    config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))
}

pub(super) fn messages_mut(
    workspace: &mut Map<String, JsonValue>,
) -> Result<&mut Vec<JsonValue>, JSONRPCErrorError> {
    workspace
        .entry("messages".to_string())
        .or_insert_with(|| JsonValue::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| invalid_params("workspace.messages must be an array"))
}

pub(super) fn validate_canonical_thread(
    config: &JsonValue,
    requested_thread_id: Option<&str>,
) -> Result<(), JSONRPCErrorError> {
    let canonical = office_thread_id(config)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("Office workspace has no canonical manager threadId"))?;
    if requested_thread_id.is_some_and(|requested| requested != canonical) {
        return Err(invalid_params(
            "threadId must match Office workspace.threadId",
        ));
    }
    Ok(())
}

pub(super) fn mark_receipt_failed(
    config: &mut JsonValue,
    client_user_message_id: &str,
    now: chrono::DateTime<Utc>,
) -> Result<(), JSONRPCErrorError> {
    let receipt = receipt_object_mut(receipt_message_mut(config, client_user_message_id)?)?;
    set_receipt_string(receipt, "status", "failed");
    set_receipt_string(
        receipt,
        "error",
        "Office message dispatch attempts exhausted",
    );
    receipt.insert("updatedAt".to_string(), json!(now.to_rfc3339()));
    clear_dispatch_lease(receipt);
    Ok(())
}

pub(super) fn set_receipt_string(receipt: &mut Map<String, JsonValue>, field: &str, value: &str) {
    receipt.insert(field.to_string(), JsonValue::String(value.to_string()));
}

pub(super) fn clear_dispatch_lease(receipt: &mut Map<String, JsonValue>) {
    receipt.remove("leaseId");
    receipt.remove("leaseExpiresAt");
}

pub(super) fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    value[..end].to_string()
}

fn receipt_iter(config: &JsonValue) -> impl Iterator<Item = &Map<String, JsonValue>> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(receipt_object)
}

fn set_or_remove(receipt: &mut Map<String, JsonValue>, field: &str, value: Option<&str>) {
    if let Some(value) = value {
        set_receipt_string(receipt, field, value);
    } else {
        receipt.remove(field);
    }
}

fn set_config_updated_at(config: &mut JsonValue, timestamp: &str) -> Result<(), JSONRPCErrorError> {
    config
        .as_object_mut()
        .ok_or_else(|| invalid_params("office config must be an object"))?
        .insert("updatedAt".to_string(), json!(timestamp));
    Ok(())
}

fn next_receipt_sequence(config: &JsonValue) -> Result<u64, JSONRPCErrorError> {
    receipt_iter(config)
        .filter_map(|receipt| receipt.get("sequence").and_then(JsonValue::as_u64))
        .max()
        .unwrap_or_default()
        .checked_add(1)
        .ok_or_else(|| internal_error("Office message receipt sequence exhausted"))
}
