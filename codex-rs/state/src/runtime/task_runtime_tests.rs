use crate::GOALS_DB_FILENAME;
use crate::LOGS_DB_FILENAME;
use crate::MEMORIES_DB_FILENAME;
use crate::STATE_DB_FILENAME;
use crate::StateRuntime;
use crate::TaskAttemptRecord;
use crate::TaskCommitFencingRecord;
use crate::TaskCommitRecord;
use crate::TaskCreateRecordOutcome;
use crate::TaskEventProducerRecord;
use crate::TaskEventRecord;
use crate::TaskInboxRecord;
use crate::TaskLeaseRecord;
use crate::TaskOutboxRecord;
use crate::TaskRecord;
use crate::TaskSnapshotRecord;
use crate::TaskStateCommitOutcome;
use crate::migrations::STATE_MIGRATOR;
use crate::runtime::state_db_path;
use crate::runtime::test_support::unique_temp_dir;
use pretty_assertions::assert_eq;
use sqlx::Row;
use sqlx::migrate::Migrator;
use sqlx::sqlite::SqliteConnectOptions;
use std::borrow::Cow;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test]
async fn task_records_round_trip_through_close_and_reopen_in_state_db() {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string())
        .await
        .expect("initialize runtime");
    let genesis = genesis_record();
    assert_eq!(
        runtime
            .create_task_record(&genesis)
            .await
            .expect("create task"),
        TaskCreateRecordOutcome::Created
    );
    assert_eq!(
        runtime
            .create_task_record(&genesis)
            .await
            .expect("duplicate create"),
        TaskCreateRecordOutcome::AlreadyExists
    );
    let commit = authority_commit("command-1", "event-1", vec!["outbox-1"]);
    let committed = runtime
        .commit_task_record(&commit)
        .await
        .expect("commit task");
    assert!(matches!(committed, TaskStateCommitOutcome::Committed(_)));

    let expected_task = runtime
        .get_task_record("task-1")
        .await
        .expect("read task")
        .expect("task record");
    let expected_events = runtime
        .list_task_event_records("task-1", 0, 100)
        .await
        .expect("list events");
    let expected_inbox = runtime
        .get_task_inbox_result("task-1", "command", "command-1")
        .await
        .expect("read inbox")
        .expect("inbox result");
    let expected_outbox = runtime
        .list_task_outbox_records("task-1", 100)
        .await
        .expect("list outbox");
    runtime.close().await;

    let reopened = StateRuntime::init(codex_home.clone(), "test-provider".to_string())
        .await
        .expect("reopen runtime");
    assert_eq!(
        reopened.get_task_record("task-1").await.expect("read task"),
        Some(expected_task)
    );
    assert_eq!(
        reopened
            .list_task_event_records("task-1", 0, 100)
            .await
            .expect("list events"),
        expected_events
    );
    assert_eq!(
        reopened
            .get_task_inbox_result("task-1", "command", "command-1")
            .await
            .expect("read inbox"),
        Some(expected_inbox)
    );
    assert_eq!(
        reopened
            .list_task_outbox_records("task-1", 100)
            .await
            .expect("list outbox"),
        expected_outbox
    );
    reopened.close().await;

    let sqlite_files = sqlite_filenames(&codex_home).await;
    assert_eq!(
        sqlite_files,
        vec![
            GOALS_DB_FILENAME.to_string(),
            LOGS_DB_FILENAME.to_string(),
            MEMORIES_DB_FILENAME.to_string(),
            STATE_DB_FILENAME.to_string(),
        ]
    );
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn duplicate_inbox_and_event_return_without_partial_writes() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    let commit = authority_commit("command-1", "event-1", vec!["outbox-1"]);
    runtime
        .commit_task_record(&commit)
        .await
        .expect("first commit");
    let before_events = runtime
        .list_task_event_records("task-1", 0, 100)
        .await
        .expect("events");
    let before_outbox = runtime
        .list_task_outbox_records("task-1", 100)
        .await
        .expect("outbox");

    assert!(matches!(
        runtime
            .commit_task_record(&commit)
            .await
            .expect("duplicate inbox"),
        TaskStateCommitOutcome::DuplicateInbox(_)
    ));
    let mut duplicate_event = commit.clone();
    duplicate_event.inbox.receipt_id = "command-2".to_string();
    assert_eq!(
        runtime
            .commit_task_record(&duplicate_event)
            .await
            .expect("duplicate event"),
        TaskStateCommitOutcome::DuplicateEvent
    );
    assert_eq!(
        runtime
            .list_task_event_records("task-1", 0, 100)
            .await
            .expect("events"),
        before_events
    );
    assert_eq!(
        runtime
            .list_task_outbox_records("task-1", 100)
            .await
            .expect("outbox"),
        before_outbox
    );
    assert_eq!(
        runtime
            .get_task_inbox_result("task-1", "command", "command-2")
            .await
            .expect("second inbox"),
        None
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn cas_and_fencing_fail_closed_before_any_write() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    let claim = claimed_commit();
    runtime
        .commit_task_record(&claim)
        .await
        .expect("claim commit");

    let stale = authority_commit("stale-command", "stale-event", Vec::new());
    assert_eq!(
        runtime
            .commit_task_record(&stale)
            .await
            .expect("stale commit"),
        TaskStateCommitOutcome::Conflict
    );

    let mut wrong_fence = worker_commit();
    wrong_fence.fencing = TaskCommitFencingRecord::Worker {
        attempt_id: "attempt-1".to_string(),
        worker_run_id: "worker-1".to_string(),
        lease_epoch: 1,
        fencing_token_hash: HASH_B.to_string(),
    };
    wrong_fence.event.producer = TaskEventProducerRecord::Worker {
        attempt_id: "attempt-1".to_string(),
        worker_run_id: "worker-1".to_string(),
        producer_sequence: 1,
        lease_epoch: 1,
        fencing_token_hash: HASH_B.to_string(),
    };
    assert_eq!(
        runtime
            .commit_task_record(&wrong_fence)
            .await
            .expect("wrong fence"),
        TaskStateCommitOutcome::Fenced
    );
    assert_eq!(
        runtime
            .list_task_event_records("task-1", 0, 100)
            .await
            .expect("events")
            .events
            .len(),
        1
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn mid_transaction_outbox_failure_rolls_back_every_task_record() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_genesis(&codex_home).await;
    let before = runtime
        .get_task_record("task-1")
        .await
        .expect("read genesis");
    let commit = authority_commit(
        "command-1",
        "event-1",
        vec!["duplicate-outbox", "duplicate-outbox"],
    );

    assert!(runtime.commit_task_record(&commit).await.is_err());
    assert_eq!(
        runtime.get_task_record("task-1").await.expect("read task"),
        before
    );
    assert_eq!(
        runtime
            .list_task_event_records("task-1", 0, 100)
            .await
            .expect("events")
            .events,
        Vec::new()
    );
    assert_eq!(
        runtime
            .get_task_inbox_result("task-1", "command", "command-1")
            .await
            .expect("inbox"),
        None
    );
    assert_eq!(
        runtime
            .list_task_outbox_records("task-1", 100)
            .await
            .expect("outbox"),
        Vec::new()
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn runtime_migrates_the_previous_real_schema_to_task_tables() {
    let codex_home = unique_temp_dir();
    tokio::fs::create_dir_all(&codex_home)
        .await
        .expect("create home");
    let path = state_db_path(&codex_home);
    let pool = sqlx::SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .expect("open previous db");
    let migrations = STATE_MIGRATOR.migrations.as_ref();
    let task_runtime_migration = migrations
        .iter()
        .position(|migration| migration.version == 37)
        .expect("Task Runtime migration 0037");
    let previous_migrations: &'static [sqlx::migrate::Migration] =
        &migrations[..task_runtime_migration];
    let previous = Migrator {
        migrations: Cow::Borrowed(previous_migrations),
        ignore_missing: false,
        locking: STATE_MIGRATOR.locking,
        no_tx: STATE_MIGRATOR.no_tx,
        table_name: STATE_MIGRATOR.table_name.clone(),
        create_schemas: STATE_MIGRATOR.create_schemas.clone(),
    };
    previous.run(&pool).await.expect("apply previous schema");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'task_runtime_%'",
        )
        .fetch_one(&pool)
        .await
        .expect("count old task tables"),
        0
    );
    pool.close().await;

    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string())
        .await
        .expect("migrate runtime");
    assert_eq!(
        runtime
            .get_task_record("missing-task")
            .await
            .expect("query migrated table"),
        None
    );
    let verification_pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .expect("open verification pool");
    let table_names = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'task_runtime_%' ORDER BY name",
    )
    .fetch_all(&verification_pool)
    .await
    .expect("list task tables")
    .into_iter()
    .map(|row| row.get::<String, _>("name"))
    .collect::<Vec<_>>();
    assert_eq!(table_names.len(), 7);
    verification_pool.close().await;
    runtime.close().await;
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
            .expect("create genesis"),
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

fn authority_commit(receipt_id: &str, event_id: &str, outbox_ids: Vec<&str>) -> TaskCommitRecord {
    let snapshot_json = "{\"status\":\"queued\"}".to_string();
    TaskCommitRecord {
        task_id: "task-1".to_string(),
        expected_version: 0,
        snapshot: TaskSnapshotRecord {
            task_id: "task-1".to_string(),
            status: "queued".to_string(),
            snapshot_json: snapshot_json.clone(),
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
            event_id: event_id.to_string(),
            event_type: "taskAccepted".to_string(),
            event_json: "{\"type\":\"taskAccepted\"}".to_string(),
            producer: TaskEventProducerRecord::Authority,
            occurred_at: 2,
            received_at: 2,
        },
        inbox: TaskInboxRecord {
            receipt_kind: "command".to_string(),
            receipt_id: receipt_id.to_string(),
            result_aggregate_version: 1,
            result_stream_offset: 1,
            result_snapshot_json: snapshot_json,
            created_at: 2,
        },
        outbox: outbox_ids
            .into_iter()
            .map(|outbox_id| TaskOutboxRecord {
                outbox_id: outbox_id.to_string(),
                decision_type: "enqueueAttempt".to_string(),
                payload_json: "{\"attemptId\":\"attempt-1\"}".to_string(),
                available_at: 2,
                created_at: 2,
            })
            .collect(),
        fencing: TaskCommitFencingRecord::Authority,
    }
}

fn claimed_commit() -> TaskCommitRecord {
    let mut commit = authority_commit("claim-command", "claim-event", vec!["claim-outbox"]);
    let lease = TaskLeaseRecord {
        worker_run_id: "worker-1".to_string(),
        lease_epoch: 1,
        fencing_token_hash: HASH_A.to_string(),
        expires_at: 100,
    };
    commit.snapshot.status = "running".to_string();
    commit.snapshot.snapshot_json = "{\"status\":\"running\"}".to_string();
    commit.snapshot.lease = Some(lease.clone());
    commit.inbox.result_snapshot_json = commit.snapshot.snapshot_json.clone();
    commit.attempt.as_mut().expect("attempt").status = "started".to_string();
    commit.attempt.as_mut().expect("attempt").lease = Some(lease);
    commit.event.event_type = "attemptClaimed".to_string();
    commit.event.event_json = "{\"type\":\"attemptClaimed\"}".to_string();
    commit
}

fn worker_commit() -> TaskCommitRecord {
    let snapshot_json = "{\"status\":\"running\",\"progress\":1}".to_string();
    let lease = TaskLeaseRecord {
        worker_run_id: "worker-1".to_string(),
        lease_epoch: 1,
        fencing_token_hash: HASH_A.to_string(),
        expires_at: 100,
    };
    TaskCommitRecord {
        task_id: "task-1".to_string(),
        expected_version: 1,
        snapshot: TaskSnapshotRecord {
            task_id: "task-1".to_string(),
            status: "running".to_string(),
            snapshot_json: snapshot_json.clone(),
            aggregate_version: 2,
            stream_offset: 2,
            active_attempt_id: Some("attempt-1".to_string()),
            lease: Some(lease.clone()),
            updated_at: 3,
        },
        attempt: Some(TaskAttemptRecord {
            task_id: "task-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            ordinal: 1,
            status: "started".to_string(),
            idempotency_key: "task-1:attempt-1".to_string(),
            lease: Some(lease),
            last_producer_sequence: Some(1),
            attempt_json: "{\"status\":\"started\",\"sequence\":1}".to_string(),
            updated_at: 3,
        }),
        event: TaskEventRecord {
            task_id: "task-1".to_string(),
            stream_offset: 2,
            event_id: "worker-event-1".to_string(),
            event_type: "progressed".to_string(),
            event_json: "{\"type\":\"progressed\"}".to_string(),
            producer: TaskEventProducerRecord::Worker {
                attempt_id: "attempt-1".to_string(),
                worker_run_id: "worker-1".to_string(),
                producer_sequence: 1,
                lease_epoch: 1,
                fencing_token_hash: HASH_A.to_string(),
            },
            occurred_at: 3,
            received_at: 3,
        },
        inbox: TaskInboxRecord {
            receipt_kind: "workerEvent".to_string(),
            receipt_id: "worker-event-1".to_string(),
            result_aggregate_version: 2,
            result_stream_offset: 2,
            result_snapshot_json: snapshot_json,
            created_at: 3,
        },
        outbox: Vec::new(),
        fencing: TaskCommitFencingRecord::Worker {
            attempt_id: "attempt-1".to_string(),
            worker_run_id: "worker-1".to_string(),
            lease_epoch: 1,
            fencing_token_hash: HASH_A.to_string(),
        },
    }
}

async fn sqlite_filenames(codex_home: &std::path::Path) -> Vec<String> {
    let mut entries = tokio::fs::read_dir(codex_home)
        .await
        .expect("read state directory");
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.expect("read entry") {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".sqlite") {
            names.push(name);
        }
    }
    names.sort();
    names
}
