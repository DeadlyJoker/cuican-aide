use pretty_assertions::assert_eq;

use crate::CloudExecutionArtifactRefRecord;
use crate::CloudExecutionSpecRecord;
use crate::ProviderExecutionRecordErrorKind;
use crate::ProviderRunEventProjectionRecord;
use crate::ProviderRunJournalAdvanceRecord;
use crate::ProviderRunJournalEventRecord;
use crate::ProviderRunJournalKey;
use crate::ProviderRunJournalRecord;
use crate::ProviderRunJournalStatus;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn cloud_execution_spec_is_digest_bound_bounded_and_reference_only() {
    let record = execution_spec();

    record.validate().expect("valid execution spec");
    assert_eq!(record.digest, record.canonical_digest());
    assert_eq!(record.context_artifacts.len(), 2);

    let mut tampered = record;
    tampered.workspace_key = "workspace-tampered".to_string();
    assert_eq!(
        tampered.validate().expect_err("digest mismatch").kind(),
        ProviderExecutionRecordErrorKind::DigestMismatch
    );

    let mut duplicate = execution_spec();
    duplicate.context_artifacts[1] = duplicate.context_artifacts[0].clone();
    duplicate.digest = duplicate.canonical_digest();
    assert_eq!(
        duplicate.validate().expect_err("duplicate Artifact").kind(),
        ProviderExecutionRecordErrorKind::Duplicate
    );

    let mut prompt_reused = execution_spec();
    prompt_reused.context_artifacts[0] = prompt_reused.prompt_artifact.clone();
    prompt_reused.digest = prompt_reused.canonical_digest();
    assert_eq!(
        prompt_reused
            .validate()
            .expect_err("prompt reused as context")
            .kind(),
        ProviderExecutionRecordErrorKind::Duplicate
    );
}

#[test]
fn provider_run_journal_and_event_advance_are_monotonic_and_digest_bound() {
    let journal = run_journal();
    journal.validate().expect("valid journal");
    assert_eq!(journal.record_hash, journal.canonical_hash());

    let mut later_replay = journal.clone();
    later_replay.created_at += 1;
    later_replay.updated_at += 1;
    assert_eq!(later_replay.canonical_hash(), journal.record_hash);

    let mut tampered = journal.clone();
    tampered.protocol_version = "3.0.1".to_string();
    assert_eq!(
        tampered
            .validate()
            .expect_err("journal hash mismatch")
            .kind(),
        ProviderExecutionRecordErrorKind::DigestMismatch
    );

    let advance = ProviderRunJournalAdvanceRecord {
        key: journal.key,
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
    };
    advance.validate().expect("valid advance");

    let mut gap = advance.clone();
    gap.event.sequence = 2;
    assert_eq!(
        gap.validate().expect_err("sequence gap").kind(),
        ProviderExecutionRecordErrorKind::OutOfRange
    );

    let mut changed_payload = advance.clone();
    changed_payload.event.projection =
        projection("runStarted", r#"{"type":"runStarted","revision":2}"#);
    assert_ne!(
        changed_payload.event.canonical_hash("provider-run-1"),
        advance.event.canonical_hash("provider-run-1")
    );

    let mut tampered_projection = advance.clone();
    tampered_projection.event.projection.projection_json =
        r#"{"type":"runStarted","revision":2}"#.to_string();
    assert_eq!(
        tampered_projection
            .validate()
            .expect_err("projection digest mismatch")
            .kind(),
        ProviderExecutionRecordErrorKind::DigestMismatch
    );

    let mut bad_revision = advance;
    bad_revision.provider_revision = Some(0);
    assert_eq!(
        bad_revision
            .validate()
            .expect_err("zero Provider revision")
            .kind(),
        ProviderExecutionRecordErrorKind::OutOfRange
    );
}

#[test]
fn provider_event_projection_is_strict_task_bound_and_debug_redacted() {
    let valid = projection(
        "completed",
        r#"{"type":"completed","outputArtifacts":[{"artifactId":"artifact-1","taskId":"task-1","kind":"report","revision":1,"retention":"task","createdAt":101}]}"#,
    );
    let debug = format!("{valid:?}");
    assert!(!debug.contains("artifact-1"));
    let decoded = valid
        .decode("completed", "task-1")
        .expect("decode canonical projection");
    assert!(matches!(
        decoded,
        crate::ProviderRunEventProjection::Completed { .. }
    ));
    assert!(!format!("{decoded:?}").contains("artifact-1"));

    let wrong_task = ProviderRunEventProjectionRecord::new(
        "completed",
        "task-1",
        r#"{"type":"completed","outputArtifacts":[{"artifactId":"artifact-1","taskId":"task-other","kind":"report","revision":1,"retention":"task","createdAt":101}]}"#.to_string(),
    )
    .expect_err("cross-task output Artifact");
    assert_eq!(
        wrong_task.kind(),
        ProviderExecutionRecordErrorKind::InconsistentFields
    );

    let unknown_field = ProviderRunEventProjectionRecord::new(
        "progress",
        "task-1",
        r#"{"type":"progress","summary":"working","rawToken":"secret"}"#.to_string(),
    )
    .expect_err("unknown projection field");
    assert_eq!(
        unknown_field.kind(),
        ProviderExecutionRecordErrorKind::InconsistentFields
    );

    let noncanonical = ProviderRunEventProjectionRecord::new(
        "runStarted",
        "task-1",
        r#"{"revision":1,"type":"runStarted"}"#.to_string(),
    )
    .expect_err("non-canonical projection order");
    assert_eq!(
        noncanonical.kind(),
        ProviderExecutionRecordErrorKind::InconsistentFields
    );
}

fn projection(event_type: &str, json: &str) -> ProviderRunEventProjectionRecord {
    ProviderRunEventProjectionRecord::new(event_type, "task-1", json.to_string())
        .expect("event projection")
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

fn run_journal() -> ProviderRunJournalRecord {
    let mut record = ProviderRunJournalRecord {
        key: ProviderRunJournalKey {
            task_id: "task-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            worker_run_id: "worker-1".to_string(),
        },
        journal_version: 0,
        execution_spec_id: "execution-spec-1".to_string(),
        execution_spec_revision: 1,
        execution_spec_digest: HASH_A.to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_id: "agent-1".to_string(),
        resource_revision: "agent-version:7".to_string(),
        credential_id: "cred_0123456789abcdef0123456789abcdef".to_string(),
        credential_revision: 3,
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

fn artifact(artifact_id: &str, revision: u64) -> CloudExecutionArtifactRefRecord {
    CloudExecutionArtifactRefRecord {
        artifact_id: artifact_id.to_string(),
        revision,
    }
}
