use pretty_assertions::assert_eq;

use super::*;

fn config() -> JsonValue {
    json!({
        "title": "Message Office",
        "workspace": {
            "recordId": "office-record-1",
            "recordRevision": "revision-1",
            "threadId": "manager-thread-1",
            "members": [],
            "messages": [],
            "activity": { "runs": [] }
        }
    })
}

fn input(client_id: &str, text: &str) -> ValidatedSubmit {
    let payload_hash = sha256_hex(
        &serde_json::to_vec(&json!({
            "text": text,
            "threadId": "manager-thread-1",
            "mentions": [],
        }))
        .expect("serialize payload"),
    );
    ValidatedSubmit {
        cwd: "/tmp/message-office".to_string(),
        config: JsonValue::Null,
        text: text.to_string(),
        client_user_message_id: client_id.to_string(),
        locale: Some("zh".to_string()),
        thread_id: Some("manager-thread-1".to_string()),
        mentions: Vec::new(),
        payload_hash,
        receipt_id: format!("receipt-{client_id}"),
        message_id: format!("office-message-{client_id}"),
    }
}

fn decide(
    config: &mut JsonValue,
    input: &ValidatedSubmit,
    now: chrono::DateTime<Utc>,
) -> Result<(bool, (bool, OfficeMessageSubmitAction)), JSONRPCErrorError> {
    state::decide_and_apply(
        config,
        input,
        now,
        "lease-1",
        &(now + ChronoDuration::seconds(30)).to_rfc3339(),
    )
}

fn complete_claimed_message(config: &mut JsonValue, client_id: &str, run_id: &str) {
    let receipt = canonical::receipt_object_mut(
        canonical::receipt_message_mut(config, client_id).expect("claimed message"),
    )
    .expect("claimed receipt");
    canonical::set_receipt_string(receipt, "status", "delivered");
    canonical::set_receipt_string(receipt, "runId", run_id);
    canonical::set_receipt_string(receipt, "turnId", &format!("turn-{run_id}"));
    canonical::clear_dispatch_lease(receipt);
    config["workspace"]["activity"]["runs"]
        .as_array_mut()
        .expect("runs")
        .push(json!({
            "id": run_id,
            "status": "completed",
            "threadId": "manager-thread-1",
            "turnId": format!("turn-{run_id}"),
        }));
}

#[test]
fn same_id_replays_without_duplicate_canonical_message() {
    let mut config = config();
    let input = input("client-1", "Start the work");
    let now = Utc::now();
    let first = decide(&mut config, &input, now).expect("first submit");
    let second = decide(&mut config, &input, now).expect("replay submit");

    assert!(first.0);
    assert!(!first.1.0);
    assert!(!second.0);
    assert!(second.1.0);
    assert!(matches!(
        second.1.1,
        OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Processing { .. })
    ));
    assert_eq!(
        config["workspace"]["messages"]
            .as_array()
            .expect("messages")
            .len(),
        1
    );
    assert_eq!(
        config["workspace"]["messages"][0]["clientUserMessageId"],
        json!("client-1")
    );
}

#[test]
fn resolved_manager_authority_rejects_office_or_thread_rebinding() {
    let latest = json!({
        "workspace": {
            "recordId": "office-1",
            "threadId": "thread-1"
        }
    });

    assert!(ensure_resolved_manager_authority(&latest, "office-1", "thread-1").is_ok());
    assert_eq!(
        ensure_resolved_manager_authority(&latest, "office-2", "thread-1")
            .expect_err("record rebinding must fail")
            .message,
        "Office manager authority changed; reload and retry"
    );
    assert_eq!(
        ensure_resolved_manager_authority(&latest, "office-1", "thread-2")
            .expect_err("thread rebinding must fail")
            .message,
        "Office manager authority changed; reload and retry"
    );
}

#[test]
fn replay_uses_the_original_canonical_locale() {
    let mut config = config();
    let original = input("client-1", "Keep the original locale");
    let mut replay = input("client-1", "Keep the original locale");
    replay.locale = Some("en".to_string());
    let now = Utc::now();

    decide(&mut config, &original, now).expect("first submit");
    let (_, (replayed, _)) = decide(&mut config, &replay, now).expect("replay submit");
    let message = snapshot::canonical_message(&config, "client-1").expect("canonical message");

    assert!(replayed);
    assert_eq!(
        canonical_message_payload(&message).expect("canonical payload"),
        (
            "Keep the original locale".to_string(),
            Some("zh".to_string())
        )
    );
}

#[test]
fn same_id_with_different_payload_is_typed_conflict() {
    let mut config = config();
    let now = Utc::now();
    decide(&mut config, &input("client-1", "First"), now).expect("first submit");

    let error =
        decide(&mut config, &input("client-1", "Different"), now).expect_err("payload conflict");
    assert_eq!(
        error.data.as_ref().and_then(|data| data.get("type")),
        Some(&json!("officeMessageIdConflict"))
    );
}

#[test]
fn legacy_run_client_id_collision_without_verifiable_payload_fails_closed() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "legacy-run",
        "status": "completed",
        "threadId": "manager-thread-1",
        "turnId": "legacy-turn",
        "clientUserMessageId": "legacy-client-id"
    }]);

    let error = decide(
        &mut config,
        &input("legacy-client-id", "Cannot verify legacy payload"),
        Utc::now(),
    )
    .expect_err("legacy collision");
    assert_eq!(
        error.data.as_ref().and_then(|data| data.get("type")),
        Some(&json!("officeMessageIdConflict"))
    );
}

#[test]
fn matching_legacy_message_is_adopted_without_duplicate_chat_entry() {
    let mut config = config();
    config["workspace"]["messages"] = json!([{
        "author": "User",
        "text": "Adopt this legacy message",
        "kind": "message",
        "clientUserMessageId": "legacy-client-id"
    }]);
    let input = input("legacy-client-id", "Adopt this legacy message");

    let (changed, (replayed, action)) =
        decide(&mut config, &input, Utc::now()).expect("adopt legacy message");

    assert!(changed);
    assert!(replayed);
    assert!(matches!(
        action,
        OfficeMessageSubmitAction::Run {
            dispatch_mode: OfficeMessageDispatchMode::ExecuteOrRecover,
            ..
        }
    ));
    assert_eq!(
        config["workspace"]["messages"],
        json!([{
            "author": "User",
            "text": "Adopt this legacy message",
            "kind": "message",
            "clientUserMessageId": "legacy-client-id",
            "messageId": "office-message-legacy-client-id",
            RECEIPT_FIELD: config["workspace"]["messages"][0][RECEIPT_FIELD].clone()
        }])
    );
    assert_eq!(
        config["workspace"]["messages"][0][RECEIPT_FIELD]["payloadHash"],
        input.payload_hash
    );
}

#[test]
fn matching_legacy_run_is_adopted_as_a_task_replay() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "legacy-run",
        "status": "running",
        "threadId": "manager-thread-1",
        "requestText": "Recover the legacy run",
        "clientUserMessageId": "legacy-client-id"
    }]);
    let input = input("legacy-client-id", "Recover the legacy run");

    let (changed, (replayed, action)) =
        decide(&mut config, &input, Utc::now()).expect("adopt legacy run");

    assert!(changed);
    assert!(replayed);
    assert_eq!(
        action,
        OfficeMessageSubmitAction::Run {
            thread_id: "manager-thread-1".to_string(),
            dispatch_mode: OfficeMessageDispatchMode::RecoverOnly,
        }
    );
    assert_eq!(
        config["workspace"]["messages"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(
        config["workspace"]["messages"][0][RECEIPT_FIELD]["messageIntent"],
        "task"
    );
}

#[test]
fn terminal_run_without_a_turn_converges_its_receipt_to_failed() {
    let mut config = config();
    let input = input("client-1", "Start once");
    let now = Utc::now();
    decide(&mut config, &input, now).expect("reserve initial dispatch");
    config["workspace"]["messages"][0][RECEIPT_FIELD]["leaseExpiresAt"] =
        json!((now - ChronoDuration::seconds(1)).to_rfc3339());
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "failed-before-turn",
        "status": "failed",
        "threadId": "manager-thread-1",
        "clientUserMessageId": "client-1"
    }]);

    let (_, (replayed, action)) = decide(&mut config, &input, now).expect("recover receipt");
    assert!(replayed);
    assert_eq!(
        action,
        OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Failed {
            code: "officeMessageDispatchFailed".to_string(),
            message: "Office message dispatch failed after bounded retries".to_string(),
            retryable: false,
        })
    );
    assert_eq!(
        config["workspace"]["messages"][0][RECEIPT_FIELD]["status"],
        "failed"
    );
}

#[test]
fn queued_run_without_a_turn_reclaims_for_exact_receipt_recovery() {
    let mut config = config();
    let input = input("client-1", "Recover exactly once");
    let now = Utc::now();
    decide(&mut config, &input, now).expect("reserve initial dispatch");
    config["workspace"]["messages"][0][RECEIPT_FIELD]["leaseExpiresAt"] =
        json!((now - ChronoDuration::seconds(1)).to_rfc3339());
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "queued-before-crash",
        "status": "queued",
        "threadId": "manager-thread-1",
        "clientUserMessageId": "client-1",
        "dispatchReceiptId": "receipt-client-1"
    }]);

    let (changed, (replayed, action)) =
        decide(&mut config, &input, now).expect("reclaim exact recovery");

    assert!(changed);
    assert!(replayed);
    assert_eq!(
        action,
        OfficeMessageSubmitAction::Run {
            thread_id: "manager-thread-1".to_string(),
            dispatch_mode: OfficeMessageDispatchMode::RecoverOnly,
        }
    );
    assert_eq!(
        config["workspace"]["messages"][0][RECEIPT_FIELD]["runId"],
        "queued-before-crash"
    );
}

#[test]
fn exact_running_manager_routes_to_steer() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "run-1",
        "status": "running",
        "threadId": "manager-thread-1",
        "turnId": "turn-1"
    }]);

    let (_, (_, action)) =
        decide(&mut config, &input("client-1", "More context"), Utc::now()).expect("active submit");
    assert_eq!(
        action,
        OfficeMessageSubmitAction::Steer {
            run_id: "run-1".to_string(),
            thread_id: "manager-thread-1".to_string(),
            expected_turn_id: "turn-1".to_string(),
            dispatch_mode: OfficeMessageDispatchMode::ExecuteOrRecover,
        }
    );
}

#[test]
fn actionable_follow_up_promotes_a_running_conversation_before_steer() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "run-1",
        "status": "running",
        "messageIntent": "conversation",
        "threadId": "manager-thread-1",
        "turnId": "turn-1",
        "loop": {
            "mode": "officeConversation",
            "maxIterations": 1,
            "cycle": ["understand", "answer", "summarize"]
        }
    }]);

    let (_, (_, action)) = decide(
        &mut config,
        &input("client-1", "请继续执行并补齐测试"),
        Utc::now(),
    )
    .expect("promoted steer");

    assert!(matches!(action, OfficeMessageSubmitAction::Steer { .. }));
    let run = &config["workspace"]["activity"]["runs"][0];
    assert_eq!(run["messageIntent"], "task");
    assert_eq!(run["loop"]["mode"], "officeLoopEngineering");
    assert_eq!(run["loop"]["maxIterations"], 4);
    assert_eq!(run["title"], "请继续执行并补齐测试");
    assert_eq!(run["requestText"], "请继续执行并补齐测试");
    assert_eq!(run["promotedByClientUserMessageId"], "client-1");
    assert_eq!(
        config["workspace"]["messages"][0][RECEIPT_FIELD]["messageIntent"],
        "task"
    );
    assert_eq!(
        config["workspace"]["messages"][0][RECEIPT_FIELD]["intentClassifierVersion"],
        1
    );
}

#[test]
fn queued_task_does_not_promote_a_nonsteerable_conversation() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "run-1",
        "status": "running",
        "messageIntent": "conversation",
        "threadId": "manager-thread-1",
        "loop": {
            "mode": "officeConversation",
            "maxIterations": 1,
            "cycle": ["understand", "answer", "summarize"]
        }
    }]);

    let (_, (_, action)) = decide(
        &mut config,
        &input("client-1", "请继续执行并补齐测试"),
        Utc::now(),
    )
    .expect("queued task");

    assert_eq!(
        action,
        OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Queued {
            after_run_id: "run-1".to_string(),
            position: 1,
        })
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["messageIntent"],
        "conversation"
    );
}

#[test]
fn reserved_replay_rechecks_after_the_advertised_retry_interval() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "run-1",
        "status": "running",
        "threadId": "manager-thread-1",
        "turnId": "turn-1"
    }]);
    let now = Utc::now();
    decide(&mut config, &input("client-a", "First steer"), now).expect("first steer");
    let (_, (_, reserved)) =
        decide(&mut config, &input("client-b", "Second steer"), now).expect("reserve second steer");
    assert_eq!(
        reserved,
        OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Processing {
            phase: OfficeMessageProcessingPhase::Reserved,
            retry_after_ms: RETRY_AFTER_MS,
        })
    );
    let first_receipt = canonical::receipt_object_mut(
        canonical::receipt_message_mut(&mut config, "client-a").expect("first message"),
    )
    .expect("first receipt");
    canonical::set_receipt_string(first_receipt, "status", "delivered");
    canonical::clear_dispatch_lease(first_receipt);

    let (_, (_, early)) = decide(
        &mut config,
        &input("client-b", "Second steer"),
        now + ChronoDuration::milliseconds(i64::from(RETRY_AFTER_MS) - 1),
    )
    .expect("early replay");
    assert!(matches!(
        early,
        OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Processing { .. })
    ));

    let (_, (_, ready)) = decide(
        &mut config,
        &input("client-b", "Second steer"),
        now + ChronoDuration::milliseconds(i64::from(RETRY_AFTER_MS) + 1),
    )
    .expect("retry after advertised interval");
    assert_eq!(
        ready,
        OfficeMessageSubmitAction::Steer {
            run_id: "run-1".to_string(),
            thread_id: "manager-thread-1".to_string(),
            expected_turn_id: "turn-1".to_string(),
            dispatch_mode: OfficeMessageDispatchMode::ExecuteOrRecover,
        }
    );
}

#[test]
fn canceling_or_child_only_run_queues_without_retarget() {
    for run in [
        json!({
            "id": "run-cancel",
            "status": "canceling",
            "threadId": "manager-thread-1",
            "turnId": "turn-old",
            "cancelRequestedAt": "2026-07-13T00:00:00Z"
        }),
        json!({
            "id": "run-child",
            "status": "completed",
            "threadId": "manager-thread-1",
            "turnId": "turn-old",
            "delegations": [{ "status": "running" }]
        }),
    ] {
        let mut config = config();
        let run_id = run["id"].as_str().expect("run id").to_string();
        config["workspace"]["activity"]["runs"] = json!([run]);
        let (_, (_, action)) =
            decide(&mut config, &input("client-1", "Queue me"), Utc::now()).expect("queue submit");
        assert_eq!(
            action,
            OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Queued {
                after_run_id: run_id,
                position: 1,
            })
        );
    }
}

#[test]
fn running_turn_on_a_non_manager_thread_queues_without_retarget() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "run-child-thread",
        "status": "running",
        "threadId": "child-thread-1",
        "turnId": "turn-child-1"
    }]);

    let (_, (_, action)) = decide(
        &mut config,
        &input("client-1", "Do not steer the child"),
        Utc::now(),
    )
    .expect("queue mismatched thread");
    assert_eq!(
        action,
        OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Queued {
            after_run_id: "run-child-thread".to_string(),
            position: 1,
        })
    );
}

#[test]
fn canonical_member_ids_are_rechecked_inside_authority_transition() {
    let mut config = config();
    let mut input = input("client-1", "Mention someone");
    input.mentions = vec!["forged-member".to_string()];

    let error = decide(&mut config, &input, Utc::now()).expect_err("forged mention");
    assert_eq!(
        error.data.as_ref().and_then(|data| data.get("type")),
        Some(&json!("officeMessageMentionInvalid"))
    );
}

#[test]
fn active_receipts_have_a_hard_cap() {
    let mut config = config();
    let now = Utc::now();
    for index in 0..MAX_ACTIVE_RECEIPTS {
        decide(
            &mut config,
            &input(&format!("client-{index}"), "Bounded message"),
            now,
        )
        .expect("bounded receipt");
    }
    let error =
        decide(&mut config, &input("client-overflow", "Overflow"), now).expect_err("active cap");
    assert!(error.message.contains("8-item"));
}

#[test]
fn ordinary_save_preserves_receipts_in_place_and_restores_omissions() {
    let mut latest = config();
    decide(&mut latest, &input("client-1", "Canonical"), Utc::now()).expect("canonical receipt");
    let canonical = latest["workspace"]["messages"][0].clone();
    latest["workspace"]["messages"] = json!([
        canonical,
        { "author": "Legacy", "text": "Keep my position" }
    ]);
    let mut proposed = latest.clone();
    proposed["workspace"]["messages"][0]["text"] = json!("forged");

    preserve_canonical_receipt_messages(Some(&latest), &mut proposed).expect("preserve receipt");
    assert_eq!(
        proposed["workspace"]["messages"],
        latest["workspace"]["messages"]
    );

    let mut omitted = json!({ "title": "Message Office", "workspace": {} });
    preserve_canonical_receipt_messages(Some(&latest), &mut omitted)
        .expect("restore omitted messages");
    assert_eq!(
        omitted["workspace"]["messages"],
        json!([latest["workspace"]["messages"][0].clone()])
    );
}

#[test]
fn legacy_message_fields_that_resemble_receipts_are_not_reserved() {
    let latest = json!({
        "title": "Legacy Office",
        "workspace": {
            "messages": [{
                "author": "Legacy client",
                "messageId": "office-message-legacy-client-id",
                "clientUserMessageId": "legacy-client-id",
                "text": "Keep this message",
                "officeMessageReceipt": {
                    "version": 1,
                    "clientUserMessageId": "legacy-client-id",
                    "status": "delivered",
                    "legacy": true
                }
            }]
        }
    });
    let mut proposed = latest.clone();
    proposed["workspace"]["messages"]
        .as_array_mut()
        .expect("messages")
        .push(json!({
            "author": "Forged client",
            "text": "Strip the exact server authority marker",
            "officeMessageReceipt": {
                "authority": RECEIPT_AUTHORITY,
                "version": 999
            }
        }));

    preserve_canonical_receipt_messages(Some(&latest), &mut proposed)
        .expect("legacy fields remain client data");

    assert_eq!(proposed, latest);
    assert_eq!(canonical_receipt_status(&latest, "legacy-client-id"), None);
}

#[test]
fn ordinary_save_cannot_reorder_fifo_receipt_sequence() {
    let mut latest = config();
    let now = Utc::now();
    decide(&mut latest, &input("client-a", "First"), now).expect("first receipt");
    decide(&mut latest, &input("client-c", "Second"), now).expect("second receipt");
    let first = latest["workspace"]["messages"][0].clone();
    let second = latest["workspace"]["messages"][1].clone();
    latest["workspace"]["messages"] = json!([
        first,
        { "author": "Legacy", "text": "Middle" },
        second
    ]);
    let mut proposed = latest.clone();
    proposed["workspace"]["messages"] = json!([
        latest["workspace"]["messages"][2].clone(),
        latest["workspace"]["messages"][1].clone(),
        latest["workspace"]["messages"][0].clone()
    ]);

    preserve_canonical_receipt_messages(Some(&latest), &mut proposed).expect("preserve FIFO order");
    assert_eq!(
        proposed["workspace"]["messages"],
        latest["workspace"]["messages"]
    );
}

#[test]
fn three_queued_messages_chain_fifo_across_successive_run_completions() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "blocking-run",
        "status": "canceling",
        "threadId": "manager-thread-1",
        "turnId": "turn-blocking",
        "cancelRequestedAt": "2026-07-13T00:00:00Z"
    }]);
    let now = Utc::now();
    for client_id in ["client-a", "client-b", "client-c"] {
        decide(&mut config, &input(client_id, client_id), now).expect("queue message");
    }
    config["workspace"]["activity"]["runs"][0]["status"] = json!("completed");
    config["workspace"]["activity"]["runs"][0]
        .as_object_mut()
        .expect("blocking run")
        .remove("cancelRequestedAt");

    let triggers = ["blocking-run", "run-a", "run-b"];
    let expected_clients = ["client-a", "client-b", "client-c"];
    let completed_runs = ["run-a", "run-b", "run-c"];
    for (index, ((trigger_run_id, expected_client_id), completed_run_id)) in triggers
        .into_iter()
        .zip(expected_clients)
        .zip(completed_runs)
        .enumerate()
    {
        let claim_now = now + ChronoDuration::seconds(i64::try_from(index).expect("bounded index"));
        let claimed = queue::claim_next_queued_after_run(
            &mut config,
            trigger_run_id,
            claim_now,
            &format!("lease-{expected_client_id}"),
            &(claim_now + ChronoDuration::seconds(30)).to_rfc3339(),
        )
        .expect("claim queued message")
        .1
        .unwrap_or_else(|| panic!("no queued message after {trigger_run_id}: {config:#}"));
        assert_eq!(claimed.0.client_user_message_id, expected_client_id);
        assert_eq!(
            canonical::receipt_object(
                canonical::receipt_message_mut(&mut config, expected_client_id)
                    .expect("claimed message")
            )
            .and_then(|receipt| receipt.get("dequeuedAfterRunId"))
            .and_then(JsonValue::as_str),
            Some(trigger_run_id)
        );
        if expected_client_id == "client-a" {
            let (_, (replayed, action)) = decide(&mut config, &input("client-b", "client-b"), now)
                .expect("retry later queued message while first dispatches");
            assert!(replayed);
            assert_eq!(
                action,
                OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Processing {
                    phase: OfficeMessageProcessingPhase::Reserved,
                    retry_after_ms: RETRY_AFTER_MS,
                })
            );
        }
        assert!(
            queue::claim_next_queued_after_run(
                &mut config,
                trigger_run_id,
                claim_now,
                "duplicate-lease",
                &(claim_now + ChronoDuration::seconds(30)).to_rfc3339(),
            )
            .expect("duplicate completion callback")
            .1
            .is_none(),
            "an in-flight receipt must prevent a second claim"
        );
        complete_claimed_message(&mut config, expected_client_id, completed_run_id);
    }

    assert!(
        queue::claim_next_queued_after_run(
            &mut config,
            "run-c",
            now,
            "empty-lease",
            &(now + ChronoDuration::seconds(30)).to_rfc3339(),
        )
        .expect("empty queue")
        .1
        .is_none()
    );
}

#[test]
fn exhausted_queued_message_is_failed_before_claiming_the_next_message() {
    let mut config = config();
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "blocking-run",
        "status": "canceling",
        "threadId": "manager-thread-1",
        "turnId": "turn-blocking",
        "cancelRequestedAt": "2026-07-13T00:00:00Z"
    }]);
    let now = Utc::now();
    decide(&mut config, &input("client-a", "first"), now).expect("queue first message");
    decide(&mut config, &input("client-b", "second"), now).expect("queue second message");
    config["workspace"]["activity"]["runs"][0]["status"] = json!("completed");
    config["workspace"]["activity"]["runs"][0]
        .as_object_mut()
        .expect("blocking run")
        .remove("cancelRequestedAt");
    let first_receipt = canonical::receipt_object_mut(
        canonical::receipt_message_mut(&mut config, "client-a").expect("first message"),
    )
    .expect("first receipt");
    first_receipt.insert(
        "attempts".to_string(),
        json!(office_message_receipt::MAX_DISPATCH_ATTEMPTS),
    );

    let (changed, claimed) = queue::claim_next_queued_after_run(
        &mut config,
        "blocking-run",
        now,
        "lease-client-b",
        &(now + ChronoDuration::seconds(30)).to_rfc3339(),
    )
    .expect("skip exhausted message and claim next");

    assert!(changed);
    assert_eq!(
        claimed
            .expect("second message should be claimed")
            .0
            .client_user_message_id,
        "client-b"
    );
    assert_eq!(
        canonical::receipt_object(
            canonical::receipt_message_mut(&mut config, "client-a").expect("first message")
        )
        .and_then(|receipt| receipt.get("status"))
        .and_then(JsonValue::as_str),
        Some("failed")
    );
}
