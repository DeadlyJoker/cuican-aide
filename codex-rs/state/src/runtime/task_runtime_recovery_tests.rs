use crate::StateRuntime;
use crate::TaskAttemptRecord;
use crate::TaskCommitFencingRecord;
use crate::TaskCommitRecord;
use crate::TaskCreateRecordOutcome;
use crate::TaskCursorAdvanceOutcome;
use crate::TaskCursorAdvanceRecord;
use crate::TaskEventProducerRecord;
use crate::TaskEventRecord;
use crate::TaskInboxRecord;
use crate::TaskLeaseRecord;
use crate::TaskMigrationJournalCreateOutcome;
use crate::TaskMigrationJournalRecord;
use crate::TaskOutboxDeferOutcome;
use crate::TaskOutboxDeliveryOutcome;
use crate::TaskOutboxRecord;
use crate::TaskOutboxStatus;
use crate::TaskRecord;
use crate::TaskSnapshotRecord;
use crate::TaskStateCommitOutcome;
use crate::runtime::test_support::unique_temp_dir;
use pretty_assertions::assert_eq;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test]
async fn concurrent_same_version_commits_have_one_winner() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    let commit_a = authority_commit("command-a", "event-a", "outbox-a");
    let commit_b = authority_commit("command-b", "event-b", "outbox-b");

    let (outcome_a, outcome_b) = tokio::join!(
        runtime.commit_task_record(&commit_a),
        runtime.commit_task_record(&commit_b),
    );
    let outcomes = [outcome_a.expect("commit a"), outcome_b.expect("commit b")];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, TaskStateCommitOutcome::Committed(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == TaskStateCommitOutcome::Conflict)
            .count(),
        1
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn worker_fencing_rejects_wrong_identity_epoch_hash_and_expiry() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    runtime
        .commit_task_record(&claimed_commit())
        .await
        .expect("claim commit");

    let cases = [
        worker_commit_variant("worker-wrong", 1, HASH_A, 3),
        worker_commit_variant("worker-1", 2, HASH_A, 3),
        worker_commit_variant("worker-1", 1, HASH_B, 3),
        worker_commit_variant("worker-1", 1, HASH_A, 101),
    ];
    for commit in cases {
        assert_eq!(
            runtime
                .commit_task_record(&commit)
                .await
                .expect("fenced commit"),
            TaskStateCommitOutcome::Fenced
        );
    }

    assert!(matches!(
        runtime
            .commit_task_record(&worker_commit_variant("worker-1", 1, HASH_A, 3))
            .await
            .expect("valid worker commit"),
        TaskStateCommitOutcome::Committed(_)
    ));
    assert_eq!(
        runtime
            .list_task_event_records("task-1", 0, 100)
            .await
            .expect("events")
            .events
            .len(),
        2
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn cursor_advances_only_over_existing_next_events() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    runtime
        .commit_task_record(&authority_commit("command-1", "event-1", "outbox-1"))
        .await
        .expect("first event");
    let first = cursor(0, 1);
    assert_eq!(
        runtime
            .advance_task_cursor(&first)
            .await
            .expect("advance first"),
        TaskCursorAdvanceOutcome::Advanced
    );
    assert_eq!(
        runtime
            .advance_task_cursor(&first)
            .await
            .expect("stale cursor"),
        TaskCursorAdvanceOutcome::Conflict
    );
    assert_eq!(
        runtime
            .advance_task_cursor(&cursor(1, 2))
            .await
            .expect("missing event"),
        TaskCursorAdvanceOutcome::Gap
    );

    runtime
        .commit_task_record(&claimed_commit_from_version_one())
        .await
        .expect("second event");
    assert_eq!(
        runtime
            .advance_task_cursor(&cursor(1, 2))
            .await
            .expect("advance second"),
        TaskCursorAdvanceOutcome::Advanced
    );
    assert_eq!(
        runtime
            .get_task_cursor("consumer-1", "task-1")
            .await
            .expect("read cursor"),
        Some(2)
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn pending_outbox_recovers_after_reopen_and_delivery_is_idempotent() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    runtime
        .commit_task_record(&authority_commit("command-1", "event-1", "outbox-1"))
        .await
        .expect("commit outbox");
    runtime.close().await;

    let reopened = StateRuntime::init(codex_home.clone(), "test-provider".to_string())
        .await
        .expect("reopen runtime");
    let pending = reopened
        .list_pending_task_outbox_records(2, 100)
        .await
        .expect("pending outbox");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].status, TaskOutboxStatus::Pending);
    assert_eq!(pending[0].outbox_id, "outbox-1");
    assert_eq!(
        reopened
            .mark_task_outbox_delivered("outbox-1", 3)
            .await
            .expect("mark delivered"),
        TaskOutboxDeliveryOutcome::Delivered
    );
    assert_eq!(
        reopened
            .mark_task_outbox_delivered("outbox-1", 4)
            .await
            .expect("repeat delivered"),
        TaskOutboxDeliveryOutcome::AlreadyDelivered
    );
    assert_eq!(
        reopened
            .list_pending_task_outbox_records(10, 100)
            .await
            .expect("pending after delivery"),
        Vec::new()
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn worker_outbox_query_filters_authority_decisions_and_enforces_page_bounds() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    let mut commit = authority_commit("command-1", "event-1", "unused-outbox");
    commit.outbox = [
        ("outbox-enqueue", "enqueueAttempt"),
        ("outbox-dispatch", "dispatchAttempt"),
        ("outbox-await", "awaitRetryDecision"),
        ("outbox-cancel", "cancelAttempt"),
        ("outbox-reconcile", "reconcileAttempt"),
    ]
    .into_iter()
    .map(|(outbox_id, decision_type)| TaskOutboxRecord {
        outbox_id: outbox_id.to_string(),
        decision_type: decision_type.to_string(),
        payload_json: "{}".to_string(),
        available_at: 2,
        created_at: 2,
    })
    .collect();
    runtime
        .commit_task_record(&commit)
        .await
        .expect("commit mixed outbox");

    assert_eq!(
        runtime
            .list_pending_task_worker_outbox_records(2, 2)
            .await
            .expect("list first worker page")
            .into_iter()
            .map(|record| (record.outbox_id, record.decision_type))
            .collect::<Vec<_>>(),
        vec![
            ("outbox-cancel".to_string(), "cancelAttempt".to_string()),
            ("outbox-dispatch".to_string(), "dispatchAttempt".to_string(),),
        ]
    );
    assert!(
        runtime
            .list_pending_task_worker_outbox_records(2, 0)
            .await
            .is_err()
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn worker_outbox_defer_and_delivery_are_cas_bound_and_durable() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    let mut commit = authority_commit("command-1", "event-1", "outbox-dispatch");
    commit.outbox[0].decision_type = "dispatchAttempt".to_string();
    runtime
        .commit_task_record(&commit)
        .await
        .expect("commit dispatch outbox");

    assert_eq!(
        runtime
            .defer_task_outbox_record("outbox-dispatch", 0, 10)
            .await
            .expect("defer outbox"),
        TaskOutboxDeferOutcome::Deferred
    );
    assert_eq!(
        runtime
            .defer_task_outbox_record("outbox-dispatch", 0, 20)
            .await
            .expect("reject stale defer"),
        TaskOutboxDeferOutcome::Conflict
    );
    assert!(
        runtime
            .list_pending_task_worker_outbox_records(9, 100)
            .await
            .expect("outbox remains delayed")
            .is_empty()
    );
    runtime.close().await;

    let reopened = StateRuntime::init(codex_home.clone(), "test-provider".to_string())
        .await
        .expect("reopen runtime");
    let pending = reopened
        .list_pending_task_worker_outbox_records(10, 100)
        .await
        .expect("recover deferred worker outbox");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].delivery_attempts, 1);
    assert_eq!(pending[0].available_at, 10);
    assert_eq!(
        reopened
            .mark_task_outbox_delivered_if_attempt("outbox-dispatch", 0, 11)
            .await
            .expect("reject stale delivery"),
        TaskOutboxDeliveryOutcome::Conflict
    );
    assert_eq!(
        reopened
            .mark_task_outbox_delivered_if_attempt("outbox-dispatch", 1, 11)
            .await
            .expect("deliver current attempt"),
        TaskOutboxDeliveryOutcome::Delivered
    );
    assert_eq!(
        reopened
            .defer_task_outbox_record("outbox-dispatch", 2, 20)
            .await
            .expect("delivered row cannot defer"),
        TaskOutboxDeferOutcome::AlreadyDelivered
    );

    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn migration_journal_is_idempotent_and_durable() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    let record = migration_record(HASH_A);
    assert_eq!(
        runtime
            .create_task_migration_journal(&record)
            .await
            .expect("create journal"),
        TaskMigrationJournalCreateOutcome::Created
    );
    assert_eq!(
        runtime
            .create_task_migration_journal(&record)
            .await
            .expect("same journal"),
        TaskMigrationJournalCreateOutcome::ExistingSame
    );
    assert_eq!(
        runtime
            .create_task_migration_journal(&migration_record(HASH_B))
            .await
            .expect("conflicting journal"),
        TaskMigrationJournalCreateOutcome::Conflict
    );
    runtime.close().await;

    let reopened = StateRuntime::init(codex_home.clone(), "test-provider".to_string())
        .await
        .expect("reopen runtime");
    assert_eq!(
        reopened
            .get_task_migration_journal("office", "office-1", "rev-1")
            .await
            .expect("read journal"),
        Some(record)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn initialized_with_genesis(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    let runtime = StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize runtime");
    assert_eq!(
        runtime
            .create_task_record(&genesis_record())
            .await
            .expect("create task"),
        TaskCreateRecordOutcome::Created
    );
    runtime
}

fn genesis_record() -> TaskRecord {
    TaskRecord {
        task_id: "task-1".to_string(),
        authority: "localAppServer".to_string(),
        strategy: "office".to_string(),
        status: "created".to_string(),
        contract_json: "{\"taskId\":\"task-1\"}".to_string(),
        snapshot_json: "{\"status\":\"created\"}".to_string(),
        aggregate_version: 0,
        stream_offset: 0,
        active_attempt_id: None,
        lease: None,
        created_at: 1,
        updated_at: 1,
    }
}

fn authority_commit(receipt: &str, event_id: &str, outbox_id: &str) -> TaskCommitRecord {
    commit_record(
        0,
        1,
        "queued",
        receipt,
        event_id,
        TaskEventProducerRecord::Authority,
        TaskCommitFencingRecord::Authority,
        Some(outbox_id),
        None,
        2,
    )
}

fn claimed_commit() -> TaskCommitRecord {
    let lease = lease_record();
    commit_record(
        0,
        1,
        "running",
        "claim-command",
        "claim-event",
        TaskEventProducerRecord::Authority,
        TaskCommitFencingRecord::Authority,
        Some("claim-outbox"),
        Some(lease),
        2,
    )
}

fn claimed_commit_from_version_one() -> TaskCommitRecord {
    let lease = lease_record();
    commit_record(
        1,
        2,
        "running",
        "claim-command-2",
        "claim-event-2",
        TaskEventProducerRecord::Authority,
        TaskCommitFencingRecord::Authority,
        Some("claim-outbox-2"),
        Some(lease),
        3,
    )
}

fn worker_commit_variant(
    worker_run_id: &str,
    epoch: u64,
    hash: &str,
    received_at: i64,
) -> TaskCommitRecord {
    let producer = TaskEventProducerRecord::Worker {
        attempt_id: "attempt-1".to_string(),
        worker_run_id: worker_run_id.to_string(),
        producer_sequence: 1,
        lease_epoch: epoch,
        fencing_token_hash: hash.to_string(),
    };
    let fencing = TaskCommitFencingRecord::Worker {
        attempt_id: "attempt-1".to_string(),
        worker_run_id: worker_run_id.to_string(),
        lease_epoch: epoch,
        fencing_token_hash: hash.to_string(),
    };
    commit_record(
        1,
        2,
        "running",
        &format!("worker-receipt-{worker_run_id}-{epoch}-{received_at}"),
        &format!("worker-event-{worker_run_id}-{epoch}-{received_at}"),
        producer,
        fencing,
        None,
        Some(lease_record()),
        received_at,
    )
}

#[allow(clippy::too_many_arguments)]
fn commit_record(
    expected_version: u64,
    offset: u64,
    status: &str,
    receipt: &str,
    event_id: &str,
    producer: TaskEventProducerRecord,
    fencing: TaskCommitFencingRecord,
    outbox_id: Option<&str>,
    lease: Option<TaskLeaseRecord>,
    timestamp: i64,
) -> TaskCommitRecord {
    let snapshot_json = format!("{{\"status\":\"{status}\"}}");
    TaskCommitRecord {
        task_id: "task-1".to_string(),
        expected_version,
        snapshot: TaskSnapshotRecord {
            task_id: "task-1".to_string(),
            status: status.to_string(),
            snapshot_json: snapshot_json.clone(),
            aggregate_version: expected_version + 1,
            stream_offset: offset,
            active_attempt_id: Some("attempt-1".to_string()),
            lease: lease.clone(),
            updated_at: timestamp,
        },
        attempt: Some(TaskAttemptRecord {
            task_id: "task-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            ordinal: 1,
            status: if status == "queued" {
                "created"
            } else {
                "started"
            }
            .to_string(),
            idempotency_key: "task-1:attempt-1".to_string(),
            lease,
            last_producer_sequence: matches!(producer, TaskEventProducerRecord::Worker { .. })
                .then_some(1),
            attempt_json: format!("{{\"status\":\"{status}\"}}"),
            updated_at: timestamp,
        }),
        event: TaskEventRecord {
            task_id: "task-1".to_string(),
            stream_offset: offset,
            event_id: event_id.to_string(),
            event_type: "event".to_string(),
            event_json: "{\"type\":\"event\"}".to_string(),
            producer,
            occurred_at: timestamp,
            received_at: timestamp,
        },
        inbox: TaskInboxRecord {
            receipt_kind: "command".to_string(),
            receipt_id: receipt.to_string(),
            result_aggregate_version: expected_version + 1,
            result_stream_offset: offset,
            result_snapshot_json: snapshot_json,
            created_at: timestamp,
        },
        outbox: outbox_id
            .map(|outbox_id| {
                vec![TaskOutboxRecord {
                    outbox_id: outbox_id.to_string(),
                    decision_type: "decision".to_string(),
                    payload_json: "{}".to_string(),
                    available_at: timestamp,
                    created_at: timestamp,
                }]
            })
            .unwrap_or_default(),
        fencing,
    }
}

fn lease_record() -> TaskLeaseRecord {
    TaskLeaseRecord {
        worker_run_id: "worker-1".to_string(),
        lease_epoch: 1,
        fencing_token_hash: HASH_A.to_string(),
        expires_at: 100,
    }
}

fn cursor(expected_offset: u64, next_offset: u64) -> TaskCursorAdvanceRecord {
    TaskCursorAdvanceRecord {
        consumer_id: "consumer-1".to_string(),
        task_id: "task-1".to_string(),
        expected_offset,
        next_offset,
        updated_at: 10,
    }
}

fn migration_record(hash: &str) -> TaskMigrationJournalRecord {
    TaskMigrationJournalRecord {
        source_kind: "office".to_string(),
        source_id: "office-1".to_string(),
        source_revision: "rev-1".to_string(),
        migration_hash: hash.to_string(),
        task_id: "task-1".to_string(),
        status: "completed".to_string(),
        updated_at: 20,
    }
}
