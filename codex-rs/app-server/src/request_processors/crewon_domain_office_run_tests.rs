use chrono::Duration as ChronoDuration;
use chrono::Utc;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::*;

#[tokio::test]
async fn scheduler_intent_claim_blocks_requeue_until_lease_expires() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();

    let intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let claimed = claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-1")
        .await
        .expect("claim intent");
    assert!(claimed);
    let claimed_queue = read_scheduler_queue(&cwd)
        .await
        .expect("read claimed queue");

    let requeued_intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "terminalSync")
        .await
        .expect("requeue intent");
    assert_eq!(requeued_intent_id, intent_id);
    assert_eq!(read_scheduler_queue(&cwd).await.unwrap(), claimed_queue);

    let pending = pending_auto_dispatch_intents(&cwd)
        .await
        .expect("pending intents");
    assert!(pending.is_empty());
    let claimed_again =
        claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-2")
            .await
            .expect("second claim");
    assert!(!claimed_again);

    let queue = read_scheduler_queue(&cwd).await.expect("read queue");
    assert_eq!(queue.intents.len(), 1);
    let intent = &queue.intents[0];
    assert_eq!(intent.status, OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING);
    assert_eq!(intent.lease_id.as_deref(), Some("lease-1"));
}

#[tokio::test]
async fn scheduler_intent_unknown_status_is_not_requeued() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let mut queue = read_scheduler_queue(&cwd).await.expect("read queue");
    queue.intents[0].status = "future-status".to_string();
    write_scheduler_queue(&cwd, &mut queue)
        .await
        .expect("write future intent status");

    assert_eq!(
        queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "requeue")
            .await
            .expect("requeue future intent status"),
        intent_id
    );
    assert_eq!(read_scheduler_queue(&cwd).await.unwrap(), queue);
    assert!(
        pending_auto_dispatch_intents(&cwd)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn scheduler_intent_claim_recovers_expired_dispatching_lease() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();

    let intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let claimed = claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-1")
        .await
        .expect("claim intent");
    assert!(claimed);

    let mut queue = read_scheduler_queue(&cwd).await.expect("read queue");
    queue.intents[0].lease_expires_at = Some("2000-01-01T00:00:00Z".to_string());
    write_scheduler_queue(&cwd, &mut queue)
        .await
        .expect("write expired lease");

    let pending = pending_auto_dispatch_intents(&cwd)
        .await
        .expect("pending intents");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].lease_id.as_deref(), Some("lease-1"));

    let claimed_after_expiry =
        claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-2")
            .await
            .expect("claim expired lease");
    assert!(claimed_after_expiry);

    let queue = read_scheduler_queue(&cwd).await.expect("read queue");
    assert_eq!(queue.intents.len(), 1);
    let intent = &queue.intents[0];
    assert_eq!(intent.status, OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHING);
    assert_eq!(intent.lease_id.as_deref(), Some("lease-2"));
    assert_eq!(intent.attempts, 2);
}

#[tokio::test]
async fn scheduler_intent_mark_dispatched_clears_lease() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();

    let intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let claimed = claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-1")
        .await
        .expect("claim intent");
    assert!(claimed);

    mark_auto_dispatch_intent_dispatched(
        &cwd,
        &intent_id,
        "thread-1",
        "turn-1",
        "lease-1",
        AutoDispatchIntentDispatched {
            run_id: "run-1",
            dispatch_kind: "delegation",
            delegation_id: Some("delegation-1"),
            verification_check_id: None,
            file_path: "/tmp/office.json",
            dispatched_thread_id: "member-thread-1",
            dispatched_turn_id: "member-turn-1",
        },
    )
    .await
    .expect("mark dispatched");

    let queue = read_scheduler_queue(&cwd).await.expect("read queue");
    assert_eq!(queue.intents.len(), 1);
    let intent = &queue.intents[0];
    assert_eq!(intent.status, OFFICE_SCHEDULER_INTENT_STATUS_DISPATCHED);
    assert_eq!(intent.lease_id, None);
    assert_eq!(intent.lease_started_at, None);
    assert_eq!(intent.lease_expires_at, None);
    assert_eq!(
        intent.dispatched_thread_id.as_deref(),
        Some("member-thread-1")
    );
    assert_eq!(intent.dispatched_turn_id.as_deref(), Some("member-turn-1"));
}

#[tokio::test]
async fn scheduler_intent_stale_lease_cannot_overwrite_a_reclaimed_intent() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();

    let intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    assert!(
        claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-1",)
            .await
            .expect("claim initial lease")
    );
    let mut queue = read_scheduler_queue(&cwd).await.expect("read queue");
    queue.intents[0].lease_expires_at = Some("2000-01-01T00:00:00Z".to_string());
    write_scheduler_queue(&cwd, &mut queue)
        .await
        .expect("expire initial lease");
    assert!(
        claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-2",)
            .await
            .expect("reclaim expired intent")
    );
    let scheduler_path = office_scheduler_path(&cwd).expect("scheduler path");
    let reclaimed_bytes = tokio::fs::read(&scheduler_path)
        .await
        .expect("read reclaimed intent");

    mark_auto_dispatch_intent_failed(
        &cwd,
        "office-scheduler-wrong",
        "thread-1",
        "turn-1",
        "lease-2",
        "wrong intent",
    )
    .await
    .expect_err("wrong intent id must not mutate the claimed intent");

    mark_auto_dispatch_intent_dispatched(
        &cwd,
        &intent_id,
        "thread-1",
        "turn-1",
        "lease-1",
        AutoDispatchIntentDispatched {
            run_id: "run-1",
            dispatch_kind: "delegation",
            delegation_id: Some("delegation-1"),
            verification_check_id: None,
            file_path: "/tmp/office.json",
            dispatched_thread_id: "member-thread-1",
            dispatched_turn_id: "member-turn-1",
        },
    )
    .await
    .expect_err("stale lease must not mark dispatched");
    mark_auto_dispatch_intent_failed(&cwd, &intent_id, "thread-1", "turn-1", "lease-1", "stale")
        .await
        .expect_err("stale lease must not mark failed");
    clear_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-1")
        .await
        .expect_err("stale lease must not clear the reclaimed intent");
    assert_eq!(
        tokio::fs::read(&scheduler_path)
            .await
            .expect("read scheduler after stale writes"),
        reclaimed_bytes
    );

    clear_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-2")
        .await
        .expect("current lease may clear the intent");
    let queue = read_scheduler_queue(&cwd)
        .await
        .expect("read cleared queue");
    assert!(queue.intents.is_empty());
}

#[tokio::test]
async fn scheduler_intent_clear_removes_only_the_exact_claimed_row() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let old_intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "old")
        .await
        .expect("queue old intent");
    assert!(
        claim_auto_dispatch_intent(&cwd, &old_intent_id, "thread-1", "turn-1", "lease-old")
            .await
            .expect("claim old intent")
    );
    clear_auto_dispatch_intent(&cwd, &old_intent_id, "thread-1", "turn-1", "lease-old")
        .await
        .expect("clear old intent");

    let new_intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "new")
        .await
        .expect("queue new intent");
    assert_ne!(new_intent_id, old_intent_id);
    let scheduler_path = office_scheduler_path(&cwd).expect("scheduler path");
    let pending_bytes = tokio::fs::read(&scheduler_path)
        .await
        .expect("read new pending intent");
    assert!(
        !claim_auto_dispatch_intent(&cwd, &old_intent_id, "thread-1", "turn-1", "lease-stale")
            .await
            .expect("reject old intent")
    );
    assert_eq!(
        tokio::fs::read(&scheduler_path).await.unwrap(),
        pending_bytes
    );
    let pending = pending_auto_dispatch_intents(&cwd).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].intent_id, new_intent_id);
    assert_eq!(pending[0].status, OFFICE_SCHEDULER_INTENT_STATUS_PENDING);
}

#[tokio::test]
async fn scheduler_intent_failed_requeues_with_the_same_identity() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    assert!(
        claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-1")
            .await
            .expect("claim intent")
    );
    mark_auto_dispatch_intent_failed(
        &cwd,
        &intent_id,
        "thread-1",
        "turn-1",
        "lease-1",
        "transient",
    )
    .await
    .expect("mark failed");
    let failed = read_scheduler_queue(&cwd).await.unwrap().intents.remove(0);
    assert_eq!(failed.lease_id, None);
    assert_eq!(failed.lease_started_at, None);
    assert_eq!(failed.lease_expires_at, None);

    assert_eq!(
        queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "retry")
            .await
            .expect("requeue failed intent"),
        intent_id
    );
    let pending = read_scheduler_queue(&cwd).await.unwrap().intents.remove(0);
    let mut expected = failed;
    expected.status = OFFICE_SCHEDULER_INTENT_STATUS_PENDING.to_string();
    expected.reason = "retry".to_string();
    expected.updated_at.clone_from(&pending.updated_at);
    expected.last_error = None;
    assert_eq!(pending, expected);
}

#[tokio::test]
async fn scheduler_intent_concurrent_claim_has_one_winner() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let intent_id = queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let first = claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-1");
    let second = claim_auto_dispatch_intent(&cwd, &intent_id, "thread-1", "turn-1", "lease-2");
    let (first, second) = tokio::join!(first, second);
    let mut outcomes = vec![first.unwrap(), second.unwrap()];
    outcomes.sort_unstable();
    assert_eq!(outcomes, vec![false, true]);

    let intent = read_scheduler_queue(&cwd).await.unwrap().intents.remove(0);
    assert_eq!(intent.attempts, 1);
    assert!(matches!(
        intent.lease_id.as_deref(),
        Some("lease-1" | "lease-2")
    ));
}

#[tokio::test]
async fn scheduler_intent_dispatched_requires_an_existing_claim() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let scheduler_path = office_scheduler_path(&cwd).expect("scheduler path");

    mark_auto_dispatch_intent_dispatched(
        &cwd,
        "office-scheduler-missing",
        "thread-missing",
        "turn-missing",
        "lease-missing",
        AutoDispatchIntentDispatched {
            run_id: "run-missing",
            dispatch_kind: "delegation",
            delegation_id: Some("delegation-missing"),
            verification_check_id: None,
            file_path: "/tmp/missing-office.json",
            dispatched_thread_id: "member-thread-missing",
            dispatched_turn_id: "member-turn-missing",
        },
    )
    .await
    .expect_err("missing scheduler claim must not be fabricated as dispatched");
    assert!(
        !scheduler_path.exists(),
        "rejected dispatched mutation must not create the scheduler file"
    );
}

#[test]
fn queued_delegation_dispatch_lease_controls_reclaim() {
    let future = timestamp_from_datetime(
        Utc::now() + ChronoDuration::seconds(OFFICE_CHILD_DISPATCH_LEASE_SECONDS),
    );
    let active = json!({
        "status": "queued",
        "dispatchMethod": "turnStart",
        "dispatchLeaseExpiresAt": future
    });
    assert!(delegation_has_started_dispatch(&active));

    let expired = json!({
        "status": "queued",
        "dispatchMethod": "turnStart",
        "dispatchLeaseExpiresAt": "2000-01-01T00:00:00Z"
    });
    assert!(!delegation_has_started_dispatch(&expired));

    let legacy_without_lease = json!({
        "status": "queued",
        "dispatchMethod": "turnStart"
    });
    assert!(!delegation_has_started_dispatch(&legacy_without_lease));
}

#[test]
fn queued_retry_run_dispatch_lease_controls_auto_replan() {
    let future = timestamp_from_datetime(
        Utc::now() + ChronoDuration::seconds(OFFICE_CHILD_DISPATCH_LEASE_SECONDS),
    );
    let active = json!({
        "retryOf": "source-run",
        "status": "queued",
        "dispatchLeaseExpiresAt": future
    });
    assert!(retry_run_blocks_auto_retry(&active, "source-run"));

    let expired = json!({
        "retryOf": "source-run",
        "status": "queued",
        "dispatchLeaseExpiresAt": "2000-01-01T00:00:00Z"
    });
    assert!(!retry_run_blocks_auto_retry(&expired, "source-run"));

    let legacy_without_lease = json!({
        "retryOf": "source-run",
        "status": "queued"
    });
    assert!(!retry_run_blocks_auto_retry(
        &legacy_without_lease,
        "source-run"
    ));

    let started = json!({
        "retryOf": "source-run",
        "status": "queued",
        "turnId": "turn-1"
    });
    assert!(retry_run_blocks_auto_retry(&started, "source-run"));

    let completed = json!({
        "retryOf": "source-run",
        "status": "completed"
    });
    assert!(retry_run_blocks_auto_retry(&completed, "source-run"));

    let other_source = json!({
        "retryOf": "other-run",
        "status": "completed"
    });
    assert!(!retry_run_blocks_auto_retry(&other_source, "source-run"));
}

#[test]
fn append_queued_run_writes_dispatch_lease() {
    let mut config = json!({
        "workspace": {
            "goal": "Ship the feature",
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": []
            }
        }
    });

    append_queued_run(
        &mut config,
        AppendQueuedRunParams {
            message: json!({
                "author": "user",
                "text": "Build it"
            }),
            message_mode: &RunMessageMode::Direct,
            text: "Build it",
            locale: Some("en"),
            thread_id: "thread-1",
            run_id: "run-1",
            retry_of: Some("source-run"),
            loop_iteration: 2,
            loop_max_iterations: 4,
            memory_refs: None,
        },
    )
    .expect("queue run");

    let run = &config["workspace"]["activity"]["runs"][0];
    assert_eq!(run["id"], "run-1");
    assert_eq!(run["status"], "queued");
    assert_eq!(run["retryOf"], "source-run");
    assert!(run["dispatchLeaseId"].as_str().is_some());
    assert!(run["dispatchLeaseStartedAt"].as_str().is_some());
    assert!(run["dispatchLeaseExpiresAt"].as_str().is_some());
    assert!(retry_run_blocks_auto_retry(run, "source-run"));
}

#[test]
fn submitted_message_run_persists_business_and_dispatch_identities() {
    let mut config = json!({
        "workspace": {
            "messages": [{ "author": "user", "text": "Build it" }],
            "tasks": [],
            "activity": { "runs": [] }
        }
    });
    let message_mode = RunMessageMode::Submitted {
        client_user_message_id: "client-message-1".to_string(),
        dispatch_receipt_id: "office-message-receipt-1".to_string(),
    };

    append_queued_run(
        &mut config,
        AppendQueuedRunParams {
            message: json!({ "author": "user", "text": "Build it" }),
            message_mode: &message_mode,
            text: "Build it",
            locale: Some("en"),
            thread_id: "thread-1",
            run_id: "run-1",
            retry_of: None,
            loop_iteration: 1,
            loop_max_iterations: 4,
            memory_refs: None,
        },
    )
    .expect("queue submitted run");

    let run = &config["workspace"]["activity"]["runs"][0];
    assert_eq!(
        (
            run["clientUserMessageId"].as_str(),
            run["dispatchReceiptId"].as_str(),
            config["workspace"]["messages"].as_array().map(Vec::len),
        ),
        (
            Some("client-message-1"),
            Some("office-message-receipt-1"),
            Some(2),
        )
    );
}

#[test]
fn append_queued_delegation_writes_dispatch_lease() {
    let mut config = json!({
        "workspace": {
            "activity": {
                "runs": [
                    {
                        "id": "run-1",
                        "delegations": []
                    }
                ]
            }
        }
    });
    let route = json!({
        "member": "Engineer",
        "agentId": "agent-engineer",
        "target": "thread-1",
        "targetKind": "runtimeThread",
        "tool": "followup_task"
    });

    let queued = append_queued_delegation(
        &mut config,
        AppendQueuedDelegationParams {
            run_id: "run-1",
            new_delegation_id: "delegation-1",
            member: "Engineer",
            agent_id: "agent-engineer",
            task: "Build it",
            route: &route,
            memory_refs: None,
        },
    )
    .expect("queue delegation");
    assert_eq!(queued.delegation_id, "delegation-1");

    let delegation = &config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(delegation["status"], "queued");
    assert!(delegation["dispatchLeaseId"].as_str().is_some());
    assert!(delegation["dispatchLeaseStartedAt"].as_str().is_some());
    assert!(delegation["dispatchLeaseExpiresAt"].as_str().is_some());
    assert!(delegation_has_started_dispatch(delegation));
}

#[test]
fn queued_verification_dispatch_lease_controls_reclaim() {
    let future = timestamp_from_datetime(
        Utc::now() + ChronoDuration::seconds(OFFICE_CHILD_DISPATCH_LEASE_SECONDS),
    );
    let active = json!({
        "status": "pending",
        "automationId": "automation-1",
        "dispatchStatus": "queued",
        "dispatchLeaseExpiresAt": future
    });
    assert!(!verification_check_is_dispatchable(
        &active,
        VerificationDispatchPolicy::Auto
    ));

    let expired = json!({
        "status": "pending",
        "automationId": "automation-1",
        "dispatchStatus": "queued",
        "dispatchLeaseExpiresAt": "2000-01-01T00:00:00Z"
    });
    assert!(verification_check_is_dispatchable(
        &expired,
        VerificationDispatchPolicy::Auto
    ));

    let legacy_without_lease = json!({
        "status": "pending",
        "automationId": "automation-1",
        "dispatchStatus": "queued"
    });
    assert!(verification_check_is_dispatchable(
        &legacy_without_lease,
        VerificationDispatchPolicy::Auto
    ));
}
