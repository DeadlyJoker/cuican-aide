use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::CloudExecutionArtifactRefRecord;
use crate::CloudExecutionSpecCreateOutcome;
use crate::CloudExecutionSpecRecord;
use crate::ProviderRunEventProjectionRecord;
use crate::ProviderRunJournalAdvanceOutcome;
use crate::ProviderRunJournalAdvanceRecord;
use crate::ProviderRunJournalCreateOutcome;
use crate::ProviderRunJournalEventRecord;
use crate::ProviderRunJournalKey;
use crate::ProviderRunJournalRecord;
use crate::ProviderRunJournalRecoveryQuery;
use crate::ProviderRunJournalStatus;
use crate::ProviderRunSupervisionQuery;
use crate::ProviderRunSupervisionUpdate;
use crate::ProviderRunSupervisionUpdateOutcome;
use crate::runtime::test_support::unique_temp_dir;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn execution_spec_and_run_journal_are_idempotent_and_survive_restart() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_dependencies(&runtime).await;
    let spec = execution_spec();

    assert_eq!(
        runtime
            .create_cloud_execution_spec_record(&spec)
            .await
            .expect("create execution spec"),
        CloudExecutionSpecCreateOutcome::Created
    );
    assert_eq!(
        runtime
            .create_cloud_execution_spec_record(&spec)
            .await
            .expect("repeat execution spec"),
        CloudExecutionSpecCreateOutcome::ExistingSame
    );
    let mut conflicting_spec = spec.clone();
    conflicting_spec.credential_revision = 4;
    conflicting_spec.digest = conflicting_spec.canonical_digest();
    assert_eq!(
        runtime
            .create_cloud_execution_spec_record(&conflicting_spec)
            .await
            .expect("execution spec conflict"),
        CloudExecutionSpecCreateOutcome::Conflict
    );

    let journal = run_journal(&spec);
    assert_eq!(
        runtime
            .create_provider_run_journal_record(&journal)
            .await
            .expect("create journal"),
        ProviderRunJournalCreateOutcome::Created
    );
    assert_eq!(
        runtime
            .create_provider_run_journal_record(&journal)
            .await
            .expect("repeat journal"),
        ProviderRunJournalCreateOutcome::ExistingSame
    );
    let mut later_replay = journal.clone();
    later_replay.created_at += 1;
    later_replay.updated_at += 1;
    assert_eq!(later_replay.record_hash, later_replay.canonical_hash());
    assert_eq!(
        runtime
            .create_provider_run_journal_record(&later_replay)
            .await
            .expect("repeat journal at a later local time"),
        ProviderRunJournalCreateOutcome::ExistingSame
    );
    assert_eq!(
        runtime
            .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
            .await
            .expect("read journal by Attempt"),
        Some(journal.clone())
    );

    let mut conflicting_journal = journal.clone();
    conflicting_journal.provider_run_id = "provider-run-conflict".to_string();
    conflicting_journal.record_hash = conflicting_journal.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_run_journal_record(&conflicting_journal)
            .await
            .expect("journal identity conflict"),
        ProviderRunJournalCreateOutcome::Conflict
    );

    let mut reused_provider_run = journal.clone();
    reused_provider_run.key.worker_run_id = "worker-2".to_string();
    reused_provider_run.record_hash = reused_provider_run.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_run_journal_record(&reused_provider_run)
            .await
            .expect("provider run reuse conflict"),
        ProviderRunJournalCreateOutcome::Conflict
    );

    let mut drifted_credential = journal.clone();
    drifted_credential.key.worker_run_id = "worker-3".to_string();
    drifted_credential.provider_run_id = "provider-run-3".to_string();
    drifted_credential.credential_revision = 4;
    drifted_credential.record_hash = drifted_credential.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_run_journal_record(&drifted_credential)
            .await
            .expect("credential drift decision"),
        ProviderRunJournalCreateOutcome::Conflict
    );

    let advance = first_event(&journal.key);
    let advanced = runtime
        .advance_provider_run_journal(&advance)
        .await
        .expect("advance journal");
    let ProviderRunJournalAdvanceOutcome::Advanced(expected) = advanced else {
        panic!("expected advanced journal");
    };
    assert_eq!(expected.journal_version, 1);
    assert_eq!(expected.last_sequence, 1);
    assert_eq!(expected.last_cursor.as_deref(), Some("cursor-1"));
    assert_eq!(expected.provider_revision, Some(1));

    let stored_projection = sqlx::query_as::<_, (String, String)>(
        r#"
SELECT payload_digest, projection_json
FROM provider_run_journal_events
WHERE provider_id = 'agent-platform' AND provider_run_id = 'provider-run-1'
  AND event_id = 'provider-event-1'
        "#,
    )
    .fetch_one(runtime.pool.as_ref())
    .await
    .expect("read stored Provider event projection");
    assert_eq!(
        stored_projection,
        (
            advance.event.projection.payload_digest.clone(),
            advance.event.projection.projection_json.clone(),
        )
    );

    assert_eq!(
        runtime
            .advance_provider_run_journal(&advance)
            .await
            .expect("duplicate event"),
        ProviderRunJournalAdvanceOutcome::Duplicate(expected.clone())
    );

    let mut changed_projection = advance.clone();
    changed_projection.event.projection =
        projection("runStarted", r#"{"type":"runStarted","revision":2}"#);
    assert_eq!(
        runtime
            .advance_provider_run_journal(&changed_projection)
            .await
            .expect("reject changed duplicate payload"),
        ProviderRunJournalAdvanceOutcome::Conflict
    );

    runtime.close().await;
    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_cloud_execution_spec_record("execution-spec-1", 1)
            .await
            .expect("read execution spec"),
        Some(spec)
    );
    assert_eq!(
        reopened
            .get_provider_run_journal_record(&journal.key)
            .await
            .expect("read journal"),
        Some(expected)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn missing_dependencies_and_cursor_conflicts_leave_no_partial_state() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_task(&runtime).await;
    let spec = execution_spec();

    assert_eq!(
        runtime
            .create_cloud_execution_spec_record(&spec)
            .await
            .expect("missing Artifact decision"),
        CloudExecutionSpecCreateOutcome::DependencyMissing
    );
    assert_eq!(
        runtime
            .get_cloud_execution_spec_record("execution-spec-1", 1)
            .await
            .expect("read missing spec"),
        None
    );

    seed_artifacts(&runtime).await;
    runtime
        .create_cloud_execution_spec_record(&spec)
        .await
        .expect("create execution spec");
    let journal = run_journal(&spec);
    runtime
        .create_provider_run_journal_record(&journal)
        .await
        .expect("create journal");

    let mut gap = first_event(&journal.key);
    gap.event.sequence = 2;
    assert!(gap.validate().is_err());

    let first = first_event(&journal.key);
    let mut competing = first.clone();
    competing.event.event_id = "provider-event-competing".to_string();
    competing.event.cursor = "cursor-competing".to_string();
    runtime
        .advance_provider_run_journal(&first)
        .await
        .expect("first advance");
    assert_eq!(
        runtime
            .advance_provider_run_journal(&competing)
            .await
            .expect("CAS conflict"),
        ProviderRunJournalAdvanceOutcome::Conflict
    );
    assert_eq!(
        runtime
            .get_provider_run_journal_record(&journal.key)
            .await
            .expect("read unchanged journal")
            .expect("journal")
            .last_cursor
            .as_deref(),
        Some("cursor-1")
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_event_projection_migration_allows_legacy_null_pair_but_rejects_partial_rows() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_dependencies(&runtime).await;
    let spec = execution_spec();
    runtime
        .create_cloud_execution_spec_record(&spec)
        .await
        .expect("create execution spec");
    let journal = run_journal(&spec);
    runtime
        .create_provider_run_journal_record(&journal)
        .await
        .expect("create Provider Run journal");

    sqlx::query(
        r#"
INSERT INTO provider_run_journal_events (
    provider_id, provider_run_id, event_id, sequence, cursor,
    event_type, event_hash, created_at
) VALUES ('agent-platform', 'provider-run-1', 'legacy-event', 1, 'legacy-cursor',
          'runStarted', ?, 101)
        "#,
    )
    .bind(HASH_A)
    .execute(runtime.pool.as_ref())
    .await
    .expect("legacy binary may write a null projection pair");

    let partial = sqlx::query(
        r#"
INSERT INTO provider_run_journal_events (
    provider_id, provider_run_id, event_id, sequence, cursor,
    event_type, event_hash, payload_digest, created_at
) VALUES ('agent-platform', 'provider-run-1', 'partial-event', 2, 'partial-cursor',
          'progress', ?, ?, 102)
        "#,
    )
    .bind(HASH_A)
    .bind(HASH_A)
    .execute(runtime.pool.as_ref())
    .await;
    assert!(partial.is_err());

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn recoverable_provider_runs_are_bounded_cursor_based_and_exclude_terminal_rows() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_dependencies(&runtime).await;
    let spec = execution_spec();
    runtime
        .create_cloud_execution_spec_record(&spec)
        .await
        .expect("create execution spec");
    let journal = run_journal(&spec);
    runtime
        .create_provider_run_journal_record(&journal)
        .await
        .expect("create Provider Run journal");

    assert_eq!(
        runtime
            .list_recoverable_provider_run_journal_records(&ProviderRunJournalRecoveryQuery {
                after: None,
                limit: 1,
            },)
            .await
            .expect("list recoverable Provider Runs"),
        vec![journal.clone()]
    );
    assert!(
        runtime
            .list_recoverable_provider_run_journal_records(&ProviderRunJournalRecoveryQuery {
                after: Some(journal.key.clone()),
                limit: 100,
            },)
            .await
            .expect("list after cursor")
            .is_empty()
    );
    assert!(
        runtime
            .list_recoverable_provider_run_journal_records(&ProviderRunJournalRecoveryQuery {
                after: None,
                limit: 0,
            },)
            .await
            .is_err()
    );

    let ProviderRunJournalAdvanceOutcome::Advanced(running) = runtime
        .advance_provider_run_journal(&first_event(&journal.key))
        .await
        .expect("advance to running")
    else {
        panic!("expected running Provider Run");
    };
    let completed = ProviderRunJournalAdvanceRecord {
        key: journal.key.clone(),
        expected_journal_version: running.journal_version,
        expected_sequence: running.last_sequence,
        expected_cursor: running.last_cursor.clone(),
        event: ProviderRunJournalEventRecord {
            event_id: "provider-event-2".to_string(),
            sequence: 2,
            cursor: "cursor-2".to_string(),
            event_type: "completed".to_string(),
            projection: projection("completed", r#"{"type":"completed","outputArtifacts":[]}"#),
            created_at: 102,
        },
        status: ProviderRunJournalStatus::Completed,
        provider_revision: Some(2),
        updated_at: 102,
    };
    assert!(matches!(
        runtime
            .advance_provider_run_journal(&completed)
            .await
            .expect("complete Provider Run"),
        ProviderRunJournalAdvanceOutcome::Advanced(_)
    ));
    assert!(
        runtime
            .list_recoverable_provider_run_journal_records(&ProviderRunJournalRecoveryQuery {
                after: None,
                limit: 100,
            },)
            .await
            .expect("list excludes terminal Provider Run")
            .is_empty()
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_run_supervision_schedule_is_durable_bounded_and_cas_bound() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_dependencies(&runtime).await;
    let spec = execution_spec();
    runtime
        .create_cloud_execution_spec_record(&spec)
        .await
        .expect("create execution spec");
    let journal = run_journal(&spec);
    runtime
        .create_provider_run_journal_record(&journal)
        .await
        .expect("create Provider Run journal");

    let due = runtime
        .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
            after: None,
            now: journal.updated_at,
            limit: 100,
        })
        .await
        .expect("list due Provider Runs");
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].journal, journal);
    assert_eq!(due[0].poll_attempts, 0);
    assert_eq!(due[0].available_at, journal.updated_at);
    let update = ProviderRunSupervisionUpdate {
        key: journal.key.clone(),
        expected_poll_attempts: 0,
        expected_available_at: journal.updated_at,
        next_poll_attempts: 1,
        available_at: 200,
        updated_at: 150,
    };
    assert_eq!(
        runtime
            .schedule_provider_run_supervision(&update)
            .await
            .expect("schedule Provider Run poll"),
        ProviderRunSupervisionUpdateOutcome::Updated
    );
    assert_eq!(
        runtime
            .schedule_provider_run_supervision(&update)
            .await
            .expect("reject stale schedule"),
        ProviderRunSupervisionUpdateOutcome::Conflict
    );
    assert!(
        runtime
            .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
                after: None,
                now: 199,
                limit: 100,
            })
            .await
            .expect("Provider Run remains delayed")
            .is_empty()
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    let recovered = reopened
        .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
            after: None,
            now: 200,
            limit: 100,
        })
        .await
        .expect("recover due Provider Run");
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].poll_attempts, 1);
    assert_eq!(recovered[0].available_at, 200);

    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}

async fn seed_dependencies(runtime: &StateRuntime) {
    seed_task(runtime).await;
    seed_artifacts(runtime).await;
}

async fn seed_task(runtime: &StateRuntime) {
    sqlx::query(
        r#"
INSERT INTO task_runtime_tasks (
    task_id, authority, strategy, status, contract_json, snapshot_json,
    aggregate_version, stream_offset, created_at, updated_at
) VALUES ('task-1', 'localAppServer', 'single', 'created', '{}', '{}', 0, 0, 100, 100)
        "#,
    )
    .execute(runtime.pool.as_ref())
    .await
    .expect("seed task");
}

async fn seed_artifacts(runtime: &StateRuntime) {
    for (artifact_id, revision) in [
        ("prompt-artifact", 1_i64),
        ("context-a", 2_i64),
        ("context-b", 1_i64),
    ] {
        let payload_id = format!("payload-{artifact_id}");
        sqlx::query(
            r#"
INSERT INTO artifact_payloads (
    payload_id, sha256, byte_len, media_type, sensitivity, retention_kind,
    expires_at, status, content, created_at
) VALUES (?, ?, 1, 'text/plain', 'internal', 'user_managed', NULL, 'available', X'78', 100)
            "#,
        )
        .bind(&payload_id)
        .bind(HASH_A)
        .execute(runtime.pool.as_ref())
        .await
        .expect("seed payload");
        sqlx::query(
            r#"
INSERT INTO artifact_manifests (
    artifact_id, revision, idempotency_key, commit_hash, payload_id, manifest_json, created_at
) VALUES (?, ?, ?, ?, ?, '{}', 100)
            "#,
        )
        .bind(artifact_id)
        .bind(revision)
        .bind(format!("idempotency-{artifact_id}"))
        .bind(HASH_A)
        .bind(payload_id)
        .execute(runtime.pool.as_ref())
        .await
        .expect("seed manifest");
    }
}

fn execution_spec() -> CloudExecutionSpecRecord {
    let mut record = CloudExecutionSpecRecord {
        execution_spec_id: "execution-spec-1".to_string(),
        revision: 1,
        digest: String::new(),
        task_id: "task-1".to_string(),
        workspace_key: "workspace-1".to_string(),
        binding_id: "binding-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: "agent".to_string(),
        resource_id: "agent-1".to_string(),
        resource_revision: "agent-version:7".to_string(),
        credential_id: "cred_0123456789abcdef0123456789abcdef".to_string(),
        credential_revision: 3,
        prompt_artifact: artifact("prompt-artifact", 1),
        context_artifacts: vec![artifact("context-a", 2), artifact("context-b", 1)],
        created_at: 100,
    };
    record.digest = record.canonical_digest();
    record
}

fn run_journal(spec: &CloudExecutionSpecRecord) -> ProviderRunJournalRecord {
    let mut record = ProviderRunJournalRecord {
        key: ProviderRunJournalKey {
            task_id: spec.task_id.clone(),
            attempt_id: "attempt-1".to_string(),
            worker_run_id: "worker-1".to_string(),
        },
        journal_version: 0,
        execution_spec_id: spec.execution_spec_id.clone(),
        execution_spec_revision: spec.revision,
        execution_spec_digest: spec.digest.clone(),
        provider_id: spec.provider_id.clone(),
        protocol_version: spec.protocol_version.clone(),
        resource_id: spec.resource_id.clone(),
        resource_revision: spec.resource_revision.clone(),
        credential_id: spec.credential_id.clone(),
        credential_revision: spec.credential_revision,
        provider_run_id: "provider-run-1".to_string(),
        provider_attempt_id: "provider-attempt-1".to_string(),
        provider_revision: None,
        last_sequence: 0,
        last_cursor: None,
        status: ProviderRunJournalStatus::Starting,
        start_command_id: "start-command-1".to_string(),
        start_idempotency_key: "task-1:attempt-1".to_string(),
        request_digest: HASH_A.to_string(),
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    record.record_hash = record.canonical_hash();
    record
}

fn first_event(key: &ProviderRunJournalKey) -> ProviderRunJournalAdvanceRecord {
    ProviderRunJournalAdvanceRecord {
        key: key.clone(),
        expected_journal_version: 0,
        expected_sequence: 0,
        expected_cursor: None,
        event: ProviderRunJournalEventRecord {
            event_id: "provider-event-1".to_string(),
            sequence: 1,
            cursor: "cursor-1".to_string(),
            event_type: "runStarted".to_string(),
            projection: projection("runStarted", r#"{"type":"runStarted","revision":1}"#),
            created_at: 101,
        },
        status: ProviderRunJournalStatus::Running,
        provider_revision: Some(1),
        updated_at: 101,
    }
}

fn projection(event_type: &str, json: &str) -> ProviderRunEventProjectionRecord {
    ProviderRunEventProjectionRecord::new(event_type, "task-1", json.to_string())
        .expect("event projection")
}

fn artifact(artifact_id: &str, revision: u64) -> CloudExecutionArtifactRefRecord {
    CloudExecutionArtifactRefRecord {
        artifact_id: artifact_id.to_string(),
        revision,
    }
}
