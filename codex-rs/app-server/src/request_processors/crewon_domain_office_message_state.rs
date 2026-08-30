use super::canonical::*;
use super::runtime::*;
use super::*;

const PROMOTED_TASK_MAX_ITERATIONS: u64 = 4;

#[derive(Clone)]
struct ReceiptProjection {
    index: usize,
    sequence: u64,
    receipt_id: String,
    payload_hash: String,
    status: String,
    action: String,
    attempts: u32,
    lease_expires_at: Option<String>,
    run_id: Option<String>,
    thread_id: Option<String>,
    expected_turn_id: Option<String>,
    turn_id: Option<String>,
    after_run_id: Option<String>,
    queue_position: Option<u32>,
}

pub(super) fn decide_and_apply(
    latest: &mut JsonValue,
    input: &ValidatedSubmit,
    now: chrono::DateTime<Utc>,
    lease_id: &str,
    lease_expires_at: &str,
) -> Result<(bool, (bool, OfficeMessageSubmitAction)), JSONRPCErrorError> {
    validate_canonical_thread(latest, input.thread_id.as_deref())?;
    validate_canonical_mentions(latest, &input.mentions)?;
    let mut existing = receipt_projection(latest, &input.client_user_message_id)?;
    if let Some(existing) = existing.as_ref()
        && existing.payload_hash != input.payload_hash
    {
        return Err(message_id_conflict(input, existing));
    }
    if existing.is_none() && adopt_matching_legacy_state(latest, input, now)? {
        existing = receipt_projection(latest, &input.client_user_message_id)?;
    }
    let replayed = existing.is_some();
    if let Some(existing) = existing.as_ref() {
        if existing.status == "delivered" {
            return Ok((false, (true, delivered_action(existing)?)));
        }
        if existing.status == "failed" {
            return Ok((false, (true, failed_delivery())));
        }
        if receipt_lease_is_active(existing, now) {
            let phase = if existing.status == "reserved" {
                OfficeMessageProcessingPhase::Reserved
            } else {
                OfficeMessageProcessingPhase::Dispatching
            };
            return Ok((
                false,
                (
                    true,
                    OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Processing {
                        phase,
                        retry_after_ms: RETRY_AFTER_MS,
                    }),
                ),
            ));
        }
        if let Some(run) = run_for_client_user_message_id(latest, &input.client_user_message_id) {
            let run_id = required_run_field(run, "id")?;
            let thread_id = required_run_field(run, "threadId")?;
            if run
                .get("turnId")
                .and_then(JsonValue::as_str)
                .is_some_and(|turn_id| !turn_id.trim().is_empty())
            {
                claim_receipt(
                    latest,
                    input,
                    "startRun",
                    Some(&run_id),
                    &thread_id,
                    None,
                    now,
                    lease_id,
                    lease_expires_at,
                )?;
                return Ok((
                    true,
                    (
                        true,
                        OfficeMessageSubmitAction::Run {
                            thread_id,
                            dispatch_mode: OfficeMessageDispatchMode::RecoverOnly,
                        },
                    ),
                ));
            }
            let status = run
                .get("status")
                .and_then(JsonValue::as_str)
                .unwrap_or("running");
            if run_status_is_terminal(status) {
                mark_receipt_failed(latest, &input.client_user_message_id, now)?;
                return Ok((true, (true, failed_delivery())));
            }
            claim_receipt(
                latest,
                input,
                "startRun",
                Some(&run_id),
                &thread_id,
                None,
                now,
                lease_id,
                lease_expires_at,
            )?;
            return Ok((
                true,
                (
                    true,
                    OfficeMessageSubmitAction::Run {
                        thread_id,
                        dispatch_mode: OfficeMessageDispatchMode::RecoverOnly,
                    },
                ),
            ));
        }
        if existing.attempts >= office_message_receipt::MAX_DISPATCH_ATTEMPTS {
            mark_receipt_failed(latest, &input.client_user_message_id, now)?;
            return Ok((true, (true, failed_delivery())));
        }
    } else {
        prune_terminal_receipts(latest)?;
        if active_receipt_count(latest) >= MAX_ACTIVE_RECEIPTS {
            return Err(invalid_params(
                "Office message queue reached its 8-item active receipt limit",
            ));
        }
        append_canonical_message(latest, input, now)?;
    }

    let projection = receipt_projection(latest, &input.client_user_message_id)?
        .ok_or_else(|| internal_error("canonical Office receipt was not appended"))?;
    if let Some(prior) = prior_active_receipt(latest, projection.index) {
        if prior.status == "queued" {
            let after_run_id = prior
                .after_run_id
                .or_else(|| blocking_run(latest).map(|run| run.run_id))
                .ok_or_else(|| {
                    internal_error("queued Office receipt has no blocking run identity")
                })?;
            let position = queue_receipt(latest, input, &after_run_id, now)?;
            return Ok((
                true,
                (
                    replayed,
                    OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Queued {
                        after_run_id,
                        position,
                    }),
                ),
            ));
        }
        reserve_receipt(latest, input, now, lease_id)?;
        return Ok((
            true,
            (
                replayed,
                OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Processing {
                    phase: OfficeMessageProcessingPhase::Reserved,
                    retry_after_ms: RETRY_AFTER_MS,
                }),
            ),
        ));
    }

    if let Some(blocking) = blocking_run(latest) {
        if blocking.manager_is_steerable {
            if OfficeMessageIntent::from_canonical_message(latest, &input.client_user_message_id)
                .unwrap_or(OfficeMessageIntent::Task)
                == OfficeMessageIntent::Task
            {
                promote_run_to_task(latest, &blocking.run_id, input)?;
            }
            let expected_turn_id = blocking
                .turn_id
                .ok_or_else(|| internal_error("steerable Office run has no turnId"))?;
            claim_receipt(
                latest,
                input,
                "steerRun",
                Some(&blocking.run_id),
                &blocking.thread_id,
                Some(&expected_turn_id),
                now,
                lease_id,
                lease_expires_at,
            )?;
            return Ok((
                true,
                (
                    replayed,
                    OfficeMessageSubmitAction::Steer {
                        run_id: blocking.run_id,
                        thread_id: blocking.thread_id,
                        expected_turn_id,
                        dispatch_mode: OfficeMessageDispatchMode::ExecuteOrRecover,
                    },
                ),
            ));
        }
        let position = queue_receipt(latest, input, &blocking.run_id, now)?;
        return Ok((
            true,
            (
                replayed,
                OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Queued {
                    after_run_id: blocking.run_id,
                    position,
                }),
            ),
        ));
    }

    let thread_id = office_thread_id(latest)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("Office workspace has no canonical manager threadId"))?
        .to_string();
    claim_receipt(
        latest,
        input,
        "startRun",
        None,
        &thread_id,
        None,
        now,
        lease_id,
        lease_expires_at,
    )?;
    Ok((
        true,
        (
            replayed,
            OfficeMessageSubmitAction::Run {
                thread_id,
                dispatch_mode: OfficeMessageDispatchMode::ExecuteOrRecover,
            },
        ),
    ))
}

fn promote_run_to_task(
    config: &mut JsonValue,
    run_id: &str,
    input: &ValidatedSubmit,
) -> Result<(), JSONRPCErrorError> {
    let runs = config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let run = runs
        .iter_mut()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| internal_error("blocking Office run disappeared during intent promotion"))?;
    if OfficeMessageIntent::from_run(&JsonValue::Object(run.clone()))
        == OfficeMessageIntent::Conversation
    {
        run.insert(
            "messageIntent".to_string(),
            JsonValue::String(OfficeMessageIntent::Task.as_str().to_string()),
        );
        run.insert(
            "title".to_string(),
            JsonValue::String(input.text.chars().take(96).collect()),
        );
        run.insert(
            "requestText".to_string(),
            JsonValue::String(input.text.clone()),
        );
        run.insert(
            "promptPreview".to_string(),
            JsonValue::String(input.text.chars().take(160).collect()),
        );
        run.insert(
            "promotedByClientUserMessageId".to_string(),
            JsonValue::String(input.client_user_message_id.clone()),
        );
        if input.mentions.is_empty() {
            run.remove("mentionedMemberIds");
        } else {
            run.insert("mentionedMemberIds".to_string(), json!(input.mentions));
        }
        if let Some(loop_state) = run.get_mut("loop").and_then(JsonValue::as_object_mut) {
            loop_state.insert(
                "mode".to_string(),
                JsonValue::String("officeLoopEngineering".to_string()),
            );
            loop_state.insert(
                "maxIterations".to_string(),
                JsonValue::from(PROMOTED_TASK_MAX_ITERATIONS),
            );
            loop_state.insert(
                "cycle".to_string(),
                json!([
                    "frame",
                    "plan",
                    "delegate",
                    "act",
                    "observe",
                    "verify",
                    "summarize"
                ]),
            );
        }
    }
    Ok(())
}

fn delivered_action(
    receipt: &ReceiptProjection,
) -> Result<OfficeMessageSubmitAction, JSONRPCErrorError> {
    match receipt.action.as_str() {
        "startRun" => Ok(OfficeMessageSubmitAction::Run {
            thread_id: receipt
                .thread_id
                .clone()
                .ok_or_else(|| internal_error("delivered Office run receipt has no threadId"))?,
            dispatch_mode: OfficeMessageDispatchMode::RecoverOnly,
        }),
        "steerRun" => Ok(OfficeMessageSubmitAction::Steer {
            run_id: receipt
                .run_id
                .clone()
                .ok_or_else(|| internal_error("delivered Office steer receipt has no runId"))?,
            thread_id: receipt
                .thread_id
                .clone()
                .ok_or_else(|| internal_error("delivered Office steer receipt has no threadId"))?,
            expected_turn_id: receipt
                .expected_turn_id
                .clone()
                .or_else(|| receipt.turn_id.clone())
                .ok_or_else(|| {
                    internal_error("delivered Office steer receipt has no expected turnId")
                })?,
            dispatch_mode: OfficeMessageDispatchMode::RecoverOnly,
        }),
        "queueAfterRun" => Ok(OfficeMessageSubmitAction::Respond(
            OfficeMessageDelivery::Queued {
                after_run_id: receipt.after_run_id.clone().ok_or_else(|| {
                    internal_error("queued Office message receipt has no afterRunId")
                })?,
                position: receipt.queue_position.unwrap_or(1),
            },
        )),
        _ => Err(internal_error(
            "delivered Office message receipt has an unknown action",
        )),
    }
}

fn failed_delivery() -> OfficeMessageSubmitAction {
    OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Failed {
        code: "officeMessageDispatchFailed".to_string(),
        message: "Office message dispatch failed after bounded retries".to_string(),
        retryable: false,
    })
}

fn receipt_projection(
    config: &JsonValue,
    client_user_message_id: &str,
) -> Result<Option<ReceiptProjection>, JSONRPCErrorError> {
    let Some(messages) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
    else {
        return Ok(None);
    };
    let mut matched = None;
    for (index, message) in messages.iter().enumerate() {
        let Some(receipt) = receipt_object(message) else {
            continue;
        };
        if receipt
            .get("clientUserMessageId")
            .and_then(JsonValue::as_str)
            != Some(client_user_message_id)
        {
            continue;
        }
        if matched.is_some() {
            return Err(internal_error(
                "multiple canonical Office receipts share clientUserMessageId",
            ));
        }
        matched = Some(projection_from_receipt(index, receipt)?);
    }
    Ok(matched)
}

fn prior_active_receipt(config: &JsonValue, before_index: usize) -> Option<ReceiptProjection> {
    let messages = config.get("workspace")?.get("messages")?.as_array()?;
    let current_sequence = messages
        .get(before_index)
        .and_then(receipt_object)
        .and_then(|receipt| receipt.get("sequence"))
        .and_then(JsonValue::as_u64)?;
    messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let receipt = receipt_object(message)?;
            let status = receipt.get("status")?.as_str()?;
            if !matches!(status, "reserved" | "dispatching" | "queued") {
                return None;
            }
            let projection = projection_from_receipt(index, receipt).ok()?;
            (projection.sequence < current_sequence).then_some(projection)
        })
        .min_by_key(|projection| projection.sequence)
}

fn projection_from_receipt(
    index: usize,
    receipt: &Map<String, JsonValue>,
) -> Result<ReceiptProjection, JSONRPCErrorError> {
    Ok(ReceiptProjection {
        index,
        sequence: receipt
            .get("sequence")
            .and_then(JsonValue::as_u64)
            .filter(|sequence| *sequence > 0)
            .ok_or_else(|| internal_error("canonical Office receipt has no sequence"))?,
        receipt_id: required_receipt_string(receipt, "receiptId")?,
        payload_hash: required_receipt_string(receipt, "payloadHash")?,
        status: required_receipt_string(receipt, "status")?,
        action: required_receipt_string(receipt, "action")?,
        attempts: receipt
            .get("attempts")
            .and_then(JsonValue::as_u64)
            .and_then(|attempts| u32::try_from(attempts).ok())
            .unwrap_or_default(),
        lease_expires_at: optional_receipt_string(receipt, "leaseExpiresAt"),
        run_id: optional_receipt_string(receipt, "runId"),
        thread_id: optional_receipt_string(receipt, "threadId"),
        expected_turn_id: optional_receipt_string(receipt, "expectedTurnId"),
        turn_id: optional_receipt_string(receipt, "turnId"),
        after_run_id: optional_receipt_string(receipt, "afterRunId"),
        queue_position: receipt
            .get("queuePosition")
            .and_then(JsonValue::as_u64)
            .and_then(|position| u32::try_from(position).ok()),
    })
}

fn receipt_lease_is_active(receipt: &ReceiptProjection, now: chrono::DateTime<Utc>) -> bool {
    receipt
        .lease_expires_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|expires_at| expires_at.with_timezone(&Utc) > now)
}

pub(super) fn validate_canonical_mentions(
    config: &JsonValue,
    mentions: &[String],
) -> Result<(), JSONRPCErrorError> {
    let member_ids = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(|member| member.get("memberId").and_then(JsonValue::as_str))
        .collect::<std::collections::HashSet<_>>();
    if mentions
        .iter()
        .all(|member_id| member_ids.contains(member_id.as_str()))
    {
        return Ok(());
    }
    let mut error = invalid_params("mentions do not match canonical workspace memberId values");
    error.data = Some(json!({ "type": "officeMessageMentionInvalid" }));
    Err(error)
}

fn message_id_conflict(input: &ValidatedSubmit, existing: &ReceiptProjection) -> JSONRPCErrorError {
    let mut error = invalid_params(
        "clientUserMessageId was already used with a different Office message payload",
    );
    error.data = Some(json!({
        "type": "officeMessageIdConflict",
        "clientUserMessageId": input.client_user_message_id,
        "receiptId": existing.receipt_id,
    }));
    error
}

fn adopt_matching_legacy_state(
    config: &mut JsonValue,
    input: &ValidatedSubmit,
    now: chrono::DateTime<Utc>,
) -> Result<bool, JSONRPCErrorError> {
    let message_indexes = config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, message)| {
            (message.get(RECEIPT_FIELD).is_none()
                && message
                    .get("clientUserMessageId")
                    .and_then(JsonValue::as_str)
                    == Some(input.client_user_message_id.as_str()))
            .then_some(index)
        })
        .collect::<Vec<_>>();
    let matching_runs = config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|run| {
            run.get("clientUserMessageId").and_then(JsonValue::as_str)
                == Some(input.client_user_message_id.as_str())
        })
        .collect::<Vec<_>>();
    if message_indexes.is_empty() && matching_runs.is_empty() {
        return Ok(false);
    }
    if message_indexes.len() > 1 || matching_runs.len() > 1 {
        return Err(legacy_message_id_conflict(input));
    }

    let matching_message = message_indexes.first().and_then(|index| {
        config
            .get("workspace")?
            .get("messages")?
            .as_array()?
            .get(*index)
    });
    if matching_message.is_some_and(|message| !legacy_message_matches(message, input)) {
        return Err(legacy_message_id_conflict(input));
    }
    let has_matching_message = matching_message.is_some();
    if matching_runs
        .first()
        .is_some_and(|run| !legacy_run_matches(config, run, input, has_matching_message))
    {
        return Err(legacy_message_id_conflict(input));
    }

    let message_intent = if matching_runs.is_empty() {
        OfficeMessageIntent::classify(&input.text, !input.mentions.is_empty())
    } else {
        OfficeMessageIntent::Task
    };
    if let Some(message_index) = message_indexes.first().copied() {
        attach_canonical_receipt(config, message_index, input, now, message_intent)?;
    } else {
        append_canonical_message_with_intent(config, input, now, message_intent)?;
    }
    Ok(true)
}

fn legacy_message_matches(message: &JsonValue, input: &ValidatedSubmit) -> bool {
    message.get("text").and_then(JsonValue::as_str) == Some(input.text.as_str())
        && legacy_mentions(message).as_deref() == Some(input.mentions.as_slice())
}

fn legacy_run_matches(
    config: &JsonValue,
    run: &JsonValue,
    input: &ValidatedSubmit,
    has_matching_message: bool,
) -> bool {
    let request_matches = run
        .get("requestText")
        .and_then(JsonValue::as_str)
        .map_or(has_matching_message, |text| text == input.text);
    let thread_matches = office_thread_id(config).is_some_and(|thread_id| {
        run.get("threadId").and_then(JsonValue::as_str) == Some(thread_id)
    });
    request_matches
        && thread_matches
        && legacy_mentions(run).as_deref() == Some(input.mentions.as_slice())
}

fn legacy_mentions(value: &JsonValue) -> Option<Vec<String>> {
    let mentions = value
        .get("mentionedMemberIds")
        .or_else(|| value.get("mentions"));
    let Some(mentions) = mentions else {
        return Some(Vec::new());
    };
    mentions
        .as_array()?
        .iter()
        .map(|mention| {
            mention
                .as_str()
                .or_else(|| mention.get("memberId").and_then(JsonValue::as_str))
                .map(str::to_string)
        })
        .collect()
}

fn legacy_message_id_conflict(input: &ValidatedSubmit) -> JSONRPCErrorError {
    let mut error = invalid_params(
        "clientUserMessageId is already occupied by legacy Office state with a different or unverifiable payload",
    );
    error.data = Some(json!({
        "type": "officeMessageIdConflict",
        "clientUserMessageId": input.client_user_message_id,
        "legacy": true,
    }));
    error
}
