use pretty_assertions::assert_eq;

use crate::CloudAgentTurnCreateBundle;
use crate::CloudAgentTurnOrigin;
use crate::CloudAgentTurnRecord;
use crate::CloudAgentTurnRecordErrorKind;
use crate::CloudAgentTurnStatus;
use crate::CloudExecutionArtifactRefRecord;
use crate::CloudExecutionSpecRecord;
use crate::TaskAttemptRecord;
use crate::TaskCommitFencingRecord;
use crate::TaskCommitRecord;
use crate::TaskEventProducerRecord;
use crate::TaskEventRecord;
use crate::TaskInboxRecord;
use crate::TaskOutboxRecord;
use crate::TaskRecord;
use crate::TaskSnapshotRecord;
use crate::ThreadExecutionContextBindingRef;

#[test]
fn durable_create_bundle_is_digest_bound_and_redacted() {
    let bundle = create_bundle();

    bundle.validate().expect("valid bundle");
    assert_eq!(bundle.turn.creation_digest, bundle.canonical_digest());

    let debug = format!("{:?}", bundle.turn);
    assert!(!debug.contains("actor-1"));
    assert!(!debug.contains("workspace-1"));
    assert!(!debug.contains("prompt-artifact"));
    assert!(!debug.contains(&bundle.turn.creation_digest));
}

#[test]
fn create_bundle_rejects_changed_semantics_and_non_atomic_shape() {
    let mut changed = create_bundle();
    changed.accepted_commit.outbox[0].payload_json =
        r#"{"attemptId":"attempt-other","type":"enqueueAttempt"}"#.to_string();
    let error = changed.validate().expect_err("digest must change");
    assert_eq!(error.field(), "creationDigest");
    assert_eq!(error.kind(), CloudAgentTurnRecordErrorKind::DigestMismatch);

    let mut missing_outbox = create_bundle();
    missing_outbox.accepted_commit.outbox.clear();
    let error = missing_outbox
        .validate()
        .expect_err("accepted enqueue required");
    assert_eq!(error.field(), "createBundle");
    assert_eq!(
        error.kind(),
        CloudAgentTurnRecordErrorKind::InconsistentFields
    );

    let mut wrong_strategy = create_bundle();
    wrong_strategy.task_genesis.strategy = "office".to_string();
    let error = wrong_strategy
        .validate()
        .expect_err("single strategy required");
    assert_eq!(error.field(), "createBundle");
}

#[test]
fn turn_status_and_output_invariants_fail_closed() {
    let mut completed_without_output = create_bundle().turn;
    completed_without_output.status = CloudAgentTurnStatus::Completed;
    completed_without_output.completed_at = Some(101);
    completed_without_output.updated_at = 101;
    completed_without_output.record_hash = completed_without_output.canonical_hash();
    let error = completed_without_output
        .validate()
        .expect_err("completed requires primary output");
    assert_eq!(error.field(), "completedOutput");

    let mut duplicate_output = create_bundle().turn;
    let output = artifact("output-1", 1);
    duplicate_output.status = CloudAgentTurnStatus::Completed;
    duplicate_output.primary_output_artifact = Some(output.clone());
    duplicate_output.additional_output_artifacts = vec![output];
    duplicate_output.completed_at = Some(101);
    duplicate_output.updated_at = 101;
    duplicate_output.record_hash = duplicate_output.canonical_hash();
    let error = duplicate_output
        .validate()
        .expect_err("duplicate output rejected");
    assert_eq!(error.field(), "additionalOutputArtifacts");
    assert_eq!(error.kind(), CloudAgentTurnRecordErrorKind::Duplicate);
}

#[test]
fn legacy_origin_is_explicit_and_never_forges_a_task() {
    let mut turn = create_bundle().turn;
    turn.origin = CloudAgentTurnOrigin::LegacyImport {
        import_id: "legacy-import-1".to_string(),
    };
    turn.creation_digest = format!("sha256:{}", "a".repeat(64));
    turn.record_hash = turn.canonical_hash();

    turn.validate().expect("valid legacy turn record");
    assert_eq!(turn.origin.task_id(), None);
    assert_eq!(turn.origin.import_id(), Some("legacy-import-1"));
}

pub(crate) fn create_bundle() -> CloudAgentTurnCreateBundle {
    let task_genesis = TaskRecord {
        task_id: "task-1".to_string(),
        authority: "localAppServer".to_string(),
        strategy: "single".to_string(),
        status: "created".to_string(),
        contract_json: r#"{"contract":"single"}"#.to_string(),
        snapshot_json: r#"{"status":"created"}"#.to_string(),
        aggregate_version: 0,
        stream_offset: 0,
        active_attempt_id: None,
        lease: None,
        created_at: 100,
        updated_at: 100,
    };
    let accepted_snapshot = r#"{"status":"queued"}"#.to_string();
    let accepted_commit = TaskCommitRecord {
        task_id: "task-1".to_string(),
        expected_version: 0,
        snapshot: TaskSnapshotRecord {
            task_id: "task-1".to_string(),
            status: "queued".to_string(),
            snapshot_json: accepted_snapshot.clone(),
            aggregate_version: 1,
            stream_offset: 1,
            active_attempt_id: Some("attempt-1".to_string()),
            lease: None,
            updated_at: 101,
        },
        attempt: Some(TaskAttemptRecord {
            task_id: "task-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            ordinal: 1,
            status: "created".to_string(),
            idempotency_key: "attempt-key-1".to_string(),
            lease: None,
            last_producer_sequence: None,
            attempt_json: r#"{"status":"created"}"#.to_string(),
            updated_at: 101,
        }),
        event: TaskEventRecord {
            task_id: "task-1".to_string(),
            stream_offset: 1,
            event_id: "event-accepted-1".to_string(),
            event_type: "taskAccepted".to_string(),
            event_json: r#"{"type":"taskAccepted"}"#.to_string(),
            producer: TaskEventProducerRecord::Authority,
            occurred_at: 101,
            received_at: 101,
        },
        inbox: TaskInboxRecord {
            receipt_kind: "command".to_string(),
            receipt_id: "command-accept-1".to_string(),
            result_aggregate_version: 1,
            result_stream_offset: 1,
            result_snapshot_json: accepted_snapshot,
            created_at: 101,
        },
        outbox: vec![TaskOutboxRecord {
            outbox_id: "outbox-enqueue-1".to_string(),
            decision_type: "enqueueAttempt".to_string(),
            payload_json: r#"{"attemptId":"attempt-1","type":"enqueueAttempt"}"#.to_string(),
            available_at: 101,
            created_at: 101,
        }],
        fencing: TaskCommitFencingRecord::Authority,
    };
    let mut execution_spec = CloudExecutionSpecRecord {
        execution_spec_id: "execution-spec-1".to_string(),
        revision: 1,
        digest: String::new(),
        task_id: "task-1".to_string(),
        workspace_key: "workspace-1".to_string(),
        binding_id: "resource-binding-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: "agent".to_string(),
        resource_id: "agent-1".to_string(),
        resource_revision: "agent-version:1".to_string(),
        credential_id: "credential-1".to_string(),
        credential_revision: 1,
        prompt_artifact: artifact("prompt-artifact", 1),
        context_artifacts: Vec::new(),
        created_at: 100,
    };
    execution_spec.digest = execution_spec.canonical_digest();
    let turn = CloudAgentTurnRecord {
        thread_id: "019f0000-0000-7000-8000-000000000001".to_string(),
        turn_id: "turn-1".to_string(),
        client_user_message_id: "client-message-1".to_string(),
        origin: CloudAgentTurnOrigin::DurableTask {
            task_id: "task-1".to_string(),
        },
        local_actor_id: "actor-1".to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        workspace_key: "workspace-1".to_string(),
        execution_binding: ThreadExecutionContextBindingRef {
            binding_id: "resource-binding-1".to_string(),
            revision: 1,
        },
        prompt_artifact: artifact("prompt-artifact", 1),
        status: CloudAgentTurnStatus::Queued,
        last_provider_sequence: 0,
        primary_output_artifact: None,
        additional_output_artifacts: Vec::new(),
        error_code: None,
        trace_id: Some("trace-1".to_string()),
        revision: 1,
        creation_digest: String::new(),
        record_hash: String::new(),
        created_at: 100,
        updated_at: 101,
        completed_at: None,
    };
    let mut bundle = CloudAgentTurnCreateBundle {
        task_genesis,
        accepted_commit,
        execution_spec,
        turn,
    };
    bundle.turn.creation_digest = bundle.canonical_digest();
    bundle.turn.record_hash = bundle.turn.canonical_hash();
    bundle
}

fn artifact(artifact_id: &str, revision: u64) -> CloudExecutionArtifactRefRecord {
    CloudExecutionArtifactRefRecord {
        artifact_id: artifact_id.to_string(),
        revision,
    }
}
