use crate::*;
use pretty_assertions::assert_eq;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn complete_authority_commit_record_validates_as_one_consistent_object() {
    let commit = authority_commit();
    assert_eq!(commit.validate(), Ok(()));
}

#[test]
fn commit_rejects_version_offset_snapshot_and_fencing_mismatches() {
    let mut wrong_version = authority_commit();
    wrong_version.snapshot.aggregate_version = 9;
    assert_validation_kind(
        wrong_version.validate().expect_err("wrong version"),
        TaskRecordValidationErrorKind::InconsistentFields,
    );

    let mut wrong_offset = authority_commit();
    wrong_offset.inbox.result_stream_offset = 9;
    assert_validation_kind(
        wrong_offset.validate().expect_err("wrong offset"),
        TaskRecordValidationErrorKind::InconsistentFields,
    );

    let mut wrong_fencing = worker_commit();
    wrong_fencing.fencing = TaskCommitFencingRecord::Authority;
    assert_validation_kind(
        wrong_fencing.validate().expect_err("wrong fencing"),
        TaskRecordValidationErrorKind::InconsistentFields,
    );
}

#[test]
fn records_reject_unbounded_invalid_json_and_raw_token_shape() {
    let mut record = genesis_record();
    record.snapshot_json = "{".to_string();
    assert_validation_kind(
        record.validate().expect_err("invalid json"),
        TaskRecordValidationErrorKind::InvalidJson,
    );

    let mut record = genesis_record();
    record.contract_json = format!("\"{}\"", "x".repeat(MAX_TASK_RECORD_JSON_BYTES));
    assert_validation_kind(
        record.validate().expect_err("oversized json"),
        TaskRecordValidationErrorKind::TooLong,
    );

    let mut record = genesis_record();
    record.lease = Some(TaskLeaseRecord {
        worker_run_id: "worker-1".to_string(),
        lease_epoch: 1,
        fencing_token_hash: "raw-secret-token".to_string(),
        expires_at: 100,
    });
    record.active_attempt_id = Some("attempt-1".to_string());
    assert_validation_kind(
        record.validate().expect_err("raw token"),
        TaskRecordValidationErrorKind::InvalidHash,
    );
}

#[test]
fn commit_rejects_unbounded_outbox_collection() {
    let mut commit = authority_commit();
    commit.outbox = (0..=MAX_TASK_OUTBOX_PER_COMMIT)
        .map(|index| TaskOutboxRecord {
            outbox_id: format!("outbox-{index}"),
            decision_type: "dispatchAttempt".to_string(),
            payload_json: "{}".to_string(),
            available_at: 1,
            created_at: 1,
        })
        .collect();
    assert_validation_kind(
        commit.validate().expect_err("outbox cap"),
        TaskRecordValidationErrorKind::TooManyItems,
    );
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

fn authority_commit() -> TaskCommitRecord {
    TaskCommitRecord {
        task_id: "task-1".to_string(),
        expected_version: 0,
        snapshot: TaskSnapshotRecord {
            task_id: "task-1".to_string(),
            status: "queued".to_string(),
            snapshot_json: "{\"status\":\"queued\"}".to_string(),
            aggregate_version: 1,
            stream_offset: 1,
            active_attempt_id: Some("attempt-1".to_string()),
            lease: None,
            updated_at: 2,
        },
        attempt: Some(TaskAttemptRecord {
            task_id: "task-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            ordinal: 1,
            status: "created".to_string(),
            idempotency_key: "task-1:attempt-1".to_string(),
            lease: None,
            last_producer_sequence: None,
            attempt_json: "{\"status\":\"created\"}".to_string(),
            updated_at: 2,
        }),
        event: TaskEventRecord {
            task_id: "task-1".to_string(),
            stream_offset: 1,
            event_id: "event-1".to_string(),
            event_type: "taskAccepted".to_string(),
            event_json: "{\"type\":\"taskAccepted\"}".to_string(),
            producer: TaskEventProducerRecord::Authority,
            occurred_at: 2,
            received_at: 2,
        },
        inbox: TaskInboxRecord {
            receipt_kind: "command".to_string(),
            receipt_id: "command-1".to_string(),
            result_aggregate_version: 1,
            result_stream_offset: 1,
            result_snapshot_json: "{\"status\":\"queued\"}".to_string(),
            created_at: 2,
        },
        outbox: vec![TaskOutboxRecord {
            outbox_id: "outbox-1".to_string(),
            decision_type: "enqueueAttempt".to_string(),
            payload_json: "{\"attemptId\":\"attempt-1\"}".to_string(),
            available_at: 2,
            created_at: 2,
        }],
        fencing: TaskCommitFencingRecord::Authority,
    }
}

fn worker_commit() -> TaskCommitRecord {
    let mut commit = authority_commit();
    commit.event.producer = TaskEventProducerRecord::Worker {
        attempt_id: "attempt-1".to_string(),
        worker_run_id: "worker-1".to_string(),
        producer_sequence: 1,
        lease_epoch: 1,
        fencing_token_hash: HASH_A.to_string(),
    };
    commit.fencing = TaskCommitFencingRecord::Worker {
        attempt_id: "attempt-1".to_string(),
        worker_run_id: "worker-1".to_string(),
        lease_epoch: 1,
        fencing_token_hash: HASH_A.to_string(),
    };
    commit
}

fn assert_validation_kind(
    error: TaskRecordValidationError,
    expected: TaskRecordValidationErrorKind,
) {
    assert_eq!(error.kind(), expected);
}
