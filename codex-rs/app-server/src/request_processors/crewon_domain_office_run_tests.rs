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

    queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let claimed = claim_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "lease-1")
        .await
        .expect("claim intent");
    assert!(claimed);

    queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "terminalSync")
        .await
        .expect("requeue intent");

    let pending = pending_auto_dispatch_intents(&cwd)
        .await
        .expect("pending intents");
    assert!(pending.is_empty());
    let claimed_again = claim_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "lease-2")
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
async fn scheduler_intent_claim_recovers_expired_dispatching_lease() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().to_string();

    queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let claimed = claim_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "lease-1")
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

    let claimed_after_expiry = claim_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "lease-2")
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

    queue_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "initial")
        .await
        .expect("queue intent");
    let claimed = claim_auto_dispatch_intent(&cwd, "thread-1", "turn-1", "lease-1")
        .await
        .expect("claim intent");
    assert!(claimed);

    mark_auto_dispatch_intent_dispatched(
        &cwd,
        "thread-1",
        "turn-1",
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
