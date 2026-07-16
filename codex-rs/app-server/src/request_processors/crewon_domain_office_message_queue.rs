use super::canonical::*;
use super::runtime::blocking_run;
use super::*;

pub(super) fn claim_next_queued_after_run(
    config: &mut JsonValue,
    completed_run_id: &str,
    now: chrono::DateTime<Utc>,
    lease_id: &str,
    lease_expires_at: &str,
) -> Result<(bool, Option<(ValidatedSubmit, OfficeMessageSubmitAction)>), JSONRPCErrorError> {
    if completed_run_id.is_empty()
        || completed_run_id != completed_run_id.trim()
        || completed_run_id.len() > MAX_CLIENT_ID_BYTES
        || completed_run_id.chars().any(char::is_control)
    {
        return Err(internal_error(
            "completed Office run id is invalid for queue draining",
        ));
    }
    if blocking_run(config).is_some() {
        return Ok((false, None));
    }
    let mut changed = false;
    for _ in 0..MAX_ACTIVE_RECEIPTS {
        let Some((_, message)) = config
            .get("workspace")
            .and_then(|workspace| workspace.get("messages"))
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .filter_map(|message| {
                let receipt = receipt_object(message)?;
                if !matches!(
                    receipt.get("status").and_then(JsonValue::as_str),
                    Some("queued" | "reserved" | "dispatching")
                ) {
                    return None;
                }
                Some((
                    receipt.get("sequence").and_then(JsonValue::as_u64)?,
                    message.clone(),
                ))
            })
            .min_by_key(|(sequence, _)| *sequence)
        else {
            return Ok((changed, None));
        };
        let receipt = receipt_object(&message)
            .ok_or_else(|| internal_error("pending Office message lost its receipt"))?;
        let client_user_message_id = required_receipt_string(receipt, "clientUserMessageId")?;
        let thread_id = office_thread_id(config)
            .map(str::to_string)
            .ok_or_else(|| internal_error("pending Office message has no manager threadId"))?;
        let input = ValidatedSubmit {
            cwd: String::new(),
            config: JsonValue::Null,
            text: message
                .get("text")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .ok_or_else(|| internal_error("pending Office message has no text"))?,
            client_user_message_id,
            locale: optional_receipt_string(receipt, "locale"),
            thread_id: Some(thread_id.clone()),
            mentions: receipt
                .get("mentions")
                .and_then(JsonValue::as_array)
                .into_iter()
                .flatten()
                .map(|mention| {
                    mention
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| internal_error("pending Office mention is invalid"))
                })
                .collect::<Result<Vec<_>, _>>()?,
            payload_hash: required_receipt_string(receipt, "payloadHash")?,
            receipt_id: required_receipt_string(receipt, "receiptId")?,
            message_id: message_id(&message)
                .map(str::to_string)
                .ok_or_else(|| internal_error("pending Office message has no messageId"))?,
        };
        let (action_changed, (_, action)) =
            state::decide_and_apply(config, &input, now, lease_id, lease_expires_at)?;
        changed |= action_changed;
        match action {
            OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Failed { .. }) => continue,
            OfficeMessageSubmitAction::Respond(_) => return Ok((changed, None)),
            action => {
                let receipt = receipt_object_mut(receipt_message_mut(
                    config,
                    &input.client_user_message_id,
                )?)?;
                set_receipt_string(receipt, "dequeuedAfterRunId", completed_run_id);
                return Ok((true, Some((input, action))));
            }
        }
    }
    Ok((changed, None))
}
