use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::CloudExecutionArtifactRefRecord;
use crate::CloudExecutionSpecCreateOutcome;
use crate::CloudExecutionSpecRecord;
use crate::ProviderRunEventProjectionRecord;
use crate::ProviderRunJournalAdvanceOutcome;
use crate::ProviderRunJournalAdvanceRecord;
use crate::ProviderRunJournalCreateOutcome;
use crate::ProviderRunJournalEventPage;
use crate::ProviderRunJournalEventPageQuery;
use crate::ProviderRunJournalEventRecord;
use crate::ProviderRunJournalKey;
use crate::ProviderRunJournalRecord;
use crate::ProviderRunJournalStatus;
use crate::runtime::test_support::unique_temp_dir;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn provider_event_pages_are_bounded_contiguous_and_survive_restart() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let journal = seed_journal(&runtime).await;
    let advances = vec![
        run_started(&journal.key),
        progress(&journal.key),
        completed(&journal.key),
    ];
    let expected_events = advances
        .iter()
        .map(|advance| advance.event.clone())
        .collect::<Vec<_>>();
    for advance in &advances {
        assert!(matches!(
            runtime
                .advance_provider_run_journal(advance)
                .await
                .expect("advance Provider event"),
            ProviderRunJournalAdvanceOutcome::Advanced(_)
        ));
    }

    let first_query = ProviderRunJournalEventPageQuery {
        key: journal.key.clone(),
        after_sequence: 0,
        limit: 2,
    };
    assert!(!format!("{first_query:?}").contains("task-1"));
    assert_eq!(
        runtime
            .read_provider_run_journal_event_page(&first_query)
            .await
            .expect("read first Provider event page"),
        Some(ProviderRunJournalEventPage {
            journal_last_sequence: 3,
            events: expected_events[..2].to_vec(),
        })
    );
    assert_eq!(
        runtime
            .read_provider_run_journal_event_page(&ProviderRunJournalEventPageQuery {
                key: journal.key.clone(),
                after_sequence: 2,
                limit: 2,
            })
            .await
            .expect("read final Provider event page"),
        Some(ProviderRunJournalEventPage {
            journal_last_sequence: 3,
            events: expected_events[2..].to_vec(),
        })
    );
    assert_eq!(
        runtime
            .read_provider_run_journal_event_page(&ProviderRunJournalEventPageQuery {
                key: journal.key.clone(),
                after_sequence: 3,
                limit: 2,
            })
            .await
            .expect("read exhausted Provider event page"),
        Some(ProviderRunJournalEventPage {
            journal_last_sequence: 3,
            events: Vec::new(),
        })
    );

    runtime.close().await;
    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .read_provider_run_journal_event_page(&ProviderRunJournalEventPageQuery {
                key: journal.key.clone(),
                after_sequence: 0,
                limit: 100,
            })
            .await
            .expect("read Provider event projections after restart"),
        Some(ProviderRunJournalEventPage {
            journal_last_sequence: 3,
            events: expected_events,
        })
    );
    assert_eq!(
        reopened
            .read_provider_run_journal_event_page(&ProviderRunJournalEventPageQuery {
                key: ProviderRunJournalKey {
                    task_id: "missing-task".to_string(),
                    attempt_id: "missing-attempt".to_string(),
                    worker_run_id: "missing-worker".to_string(),
                },
                after_sequence: 0,
                limit: 1,
            })
            .await
            .expect("read missing Provider Run"),
        None
    );

    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_event_page_rejects_invalid_bounds_and_missing_projection() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let journal = seed_journal(&runtime).await;
    runtime
        .advance_provider_run_journal(&run_started(&journal.key))
        .await
        .expect("advance first Provider event");

    for query in [
        ProviderRunJournalEventPageQuery {
            key: journal.key.clone(),
            after_sequence: 0,
            limit: 0,
        },
        ProviderRunJournalEventPageQuery {
            key: journal.key.clone(),
            after_sequence: 0,
            limit: 101,
        },
        ProviderRunJournalEventPageQuery {
            key: journal.key.clone(),
            after_sequence: 2,
            limit: 1,
        },
    ] {
        assert!(
            runtime
                .read_provider_run_journal_event_page(&query)
                .await
                .is_err()
        );
    }

    sqlx::query(
        r#"
UPDATE provider_run_journal_events
SET payload_digest = NULL, projection_json = NULL
WHERE provider_id = 'agent-platform' AND provider_run_id = 'provider-run-1'
  AND event_id = 'provider-event-1'
        "#,
    )
    .execute(runtime.pool.as_ref())
    .await
    .expect("simulate legacy metadata-only event");
    assert!(
        runtime
            .read_provider_run_journal_event_page(&ProviderRunJournalEventPageQuery {
                key: journal.key,
                after_sequence: 0,
                limit: 1,
            })
            .await
            .is_err()
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_event_page_rejects_a_durable_sequence_gap_without_advancing() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let journal = seed_journal(&runtime).await;
    for advance in [
        run_started(&journal.key),
        progress(&journal.key),
        completed(&journal.key),
    ] {
        runtime
            .advance_provider_run_journal(&advance)
            .await
            .expect("advance Provider event");
    }
    sqlx::query(
        r#"
DELETE FROM provider_run_journal_events
WHERE provider_id = 'agent-platform' AND provider_run_id = 'provider-run-1'
  AND sequence = 2
        "#,
    )
    .execute(runtime.pool.as_ref())
    .await
    .expect("simulate durable event gap");

    assert!(
        runtime
            .read_provider_run_journal_event_page(&ProviderRunJournalEventPageQuery {
                key: journal.key.clone(),
                after_sequence: 0,
                limit: 100,
            })
            .await
            .is_err()
    );
    assert_eq!(
        runtime
            .get_provider_run_journal_event_record(&journal.key, 2)
            .await
            .expect("read missing exact event"),
        None
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}

async fn seed_journal(runtime: &StateRuntime) -> ProviderRunJournalRecord {
    seed_task_and_prompt(runtime).await;
    let spec = execution_spec();
    assert_eq!(
        runtime
            .create_cloud_execution_spec_record(&spec)
            .await
            .expect("create execution spec"),
        CloudExecutionSpecCreateOutcome::Created
    );
    let journal = run_journal(&spec);
    assert_eq!(
        runtime
            .create_provider_run_journal_record(&journal)
            .await
            .expect("create Provider Run journal"),
        ProviderRunJournalCreateOutcome::Created
    );
    journal
}

async fn seed_task_and_prompt(runtime: &StateRuntime) {
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
    sqlx::query(
        r#"
INSERT INTO artifact_payloads (
    payload_id, sha256, byte_len, media_type, sensitivity, retention_kind,
    expires_at, status, content, created_at
) VALUES ('payload-prompt', ?, 1, 'text/plain', 'internal', 'user_managed',
          NULL, 'available', X'78', 100)
        "#,
    )
    .bind(HASH_A)
    .execute(runtime.pool.as_ref())
    .await
    .expect("seed prompt payload");
    sqlx::query(
        r#"
INSERT INTO artifact_manifests (
    artifact_id, revision, idempotency_key, commit_hash, payload_id, manifest_json, created_at
) VALUES ('prompt-artifact', 1, 'idempotency-prompt', ?, 'payload-prompt', '{}', 100)
        "#,
    )
    .bind(HASH_A)
    .execute(runtime.pool.as_ref())
    .await
    .expect("seed prompt manifest");
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
        prompt_artifact: CloudExecutionArtifactRefRecord {
            artifact_id: "prompt-artifact".to_string(),
            revision: 1,
        },
        context_artifacts: Vec::new(),
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

fn run_started(key: &ProviderRunJournalKey) -> ProviderRunJournalAdvanceRecord {
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

fn progress(key: &ProviderRunJournalKey) -> ProviderRunJournalAdvanceRecord {
    ProviderRunJournalAdvanceRecord {
        key: key.clone(),
        expected_journal_version: 1,
        expected_sequence: 1,
        expected_cursor: Some("cursor-1".to_string()),
        event: ProviderRunJournalEventRecord {
            event_id: "provider-event-2".to_string(),
            sequence: 2,
            cursor: "cursor-2".to_string(),
            event_type: "progress".to_string(),
            projection: projection("progress", r#"{"type":"progress","summary":"working"}"#),
            created_at: 102,
        },
        status: ProviderRunJournalStatus::Running,
        provider_revision: Some(1),
        updated_at: 102,
    }
}

fn completed(key: &ProviderRunJournalKey) -> ProviderRunJournalAdvanceRecord {
    ProviderRunJournalAdvanceRecord {
        key: key.clone(),
        expected_journal_version: 2,
        expected_sequence: 2,
        expected_cursor: Some("cursor-2".to_string()),
        event: ProviderRunJournalEventRecord {
            event_id: "provider-event-3".to_string(),
            sequence: 3,
            cursor: "cursor-3".to_string(),
            event_type: "completed".to_string(),
            projection: projection("completed", r#"{"type":"completed","outputArtifacts":[]}"#),
            created_at: 103,
        },
        status: ProviderRunJournalStatus::Completed,
        provider_revision: Some(2),
        updated_at: 103,
    }
}

fn projection(event_type: &str, json: &str) -> ProviderRunEventProjectionRecord {
    ProviderRunEventProjectionRecord::new(event_type, "task-1", json.to_string())
        .expect("event projection")
}
