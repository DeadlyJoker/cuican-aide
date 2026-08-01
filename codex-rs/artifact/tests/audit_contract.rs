#![allow(
    clippy::expect_used,
    reason = "integration-test setup uses expect for precise Artifact contract failures"
)]

use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactCommit;
use crewon_artifact::ArtifactErrorKind;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactIdempotencyKey;
use crewon_artifact::ArtifactKind;
use crewon_artifact::ArtifactManifest;
use crewon_artifact::ArtifactManifestInput;
use crewon_artifact::ArtifactRef;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::ArtifactWorkspaceScope;
use crewon_artifact::AuditAction;
use crewon_artifact::AuditErrorCode;
use crewon_artifact::AuditEvent;
use crewon_artifact::AuditEventId;
use crewon_artifact::AuditEventInput;
use crewon_artifact::AuditIdempotencyKey;
use crewon_artifact::AuditOutcome;
use crewon_artifact::AuditPayloadLink;
use crewon_artifact::CostCorrelation;
use crewon_artifact::ExecutionCorrelation;
use crewon_artifact::MediaType;
use crewon_artifact::PayloadBody;
use crewon_artifact::PayloadId;
use crewon_artifact::PayloadRef;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::ResourceCorrelation;
use crewon_artifact::RetentionPolicy;
use crewon_artifact::SpanId;
use crewon_artifact::ThreadId;
use crewon_artifact::TraceContext;
use crewon_artifact::TraceId;
use crewon_artifact::TurnId;
use crewon_artifact::VerificationStatus;
use crewon_artifact::WorkspaceScopeId;
use crewon_policy::PolicyActor;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::WorkspaceKey;
use crewon_task_runtime::UnixTimestamp;
use pretty_assertions::assert_eq;

#[test]
fn trace_rejects_self_parent() {
    let error = TraceContext::child(
        TraceId::new("trace-1").expect("trace id"),
        SpanId::new("span-1").expect("span id"),
        SpanId::new("span-1").expect("parent span id"),
    )
    .expect_err("span cannot parent itself");
    assert_eq!(
        (error.field(), error.kind()),
        ("parentSpanId", ArtifactErrorKind::Mismatch)
    );
}

#[test]
fn audit_event_rejects_duplicate_artifact_refs() {
    let artifact = artifact_ref();
    let error = AuditEvent::new(audit_input(
        AuditAction::ArtifactCreated,
        vec![artifact.clone(), artifact],
        AuditPayloadLink::None,
    ))
    .expect_err("duplicates must fail");
    assert_eq!(
        (error.field(), error.kind()),
        ("artifacts", ArtifactErrorKind::Duplicate)
    );
}

#[test]
fn audit_unknown_outcome_is_bounded_and_never_carries_external_error_text() {
    let mut input = audit_input(
        AuditAction::ExternalAction,
        Vec::new(),
        AuditPayloadLink::None,
    );
    input.outcome = AuditOutcome::Unknown {
        error_code: AuditErrorCode::new("dynamicTool.timeout").expect("error code"),
    };
    let event = AuditEvent::new(input).expect("unknown audit outcome");
    let value = serde_json::to_value(event).expect("audit JSON");

    assert_eq!(
        value["outcome"],
        serde_json::json!({
            "type": "unknown",
            "errorCode": "dynamicTool.timeout"
        })
    );
    assert!(!value.to_string().contains("provider timeout body"));
}

#[test]
fn artifact_commit_requires_matching_creation_event_and_never_serializes_body() {
    let body = PayloadBody::new(
        b"raw tool output only in payload store".to_vec(),
        PayloadSensitivity::WorkspaceSensitive,
    )
    .expect("body");
    let payload = PayloadRef::from_body(
        PayloadId::new("payload-1").expect("payload id"),
        &body,
        MediaType::new("application/json").expect("media type"),
    );
    let manifest = manifest(payload.clone());
    let event = AuditEvent::new(audit_input(
        AuditAction::ArtifactCreated,
        vec![artifact_ref()],
        AuditPayloadLink::Payload {
            payload: payload.clone(),
        },
    ))
    .expect("creation event");
    let commit = ArtifactCommit::new(
        ArtifactIdempotencyKey::new("artifact-create-1").expect("idempotency key"),
        manifest.clone(),
        event.clone(),
    )
    .expect("matching commit");

    assert_eq!(commit.manifest(), &manifest);
    assert_eq!(commit.created_event(), &event);
    let metadata = serde_json::to_string(&event).expect("event JSON");
    assert!(!metadata.contains("raw tool output"));

    let mismatch = AuditEvent::new(audit_input(
        AuditAction::ArtifactRead,
        vec![artifact_ref()],
        AuditPayloadLink::Payload { payload },
    ))
    .expect("read event");
    let error = ArtifactCommit::new(
        ArtifactIdempotencyKey::new("artifact-create-2").expect("idempotency key"),
        manifest,
        mismatch,
    )
    .expect_err("non-create event must fail");
    assert_eq!(error.kind(), ArtifactErrorKind::Mismatch);
}

fn manifest(payload: PayloadRef) -> ArtifactManifest {
    ArtifactManifest::new(ArtifactManifestInput {
        artifact_ref: artifact_ref(),
        kind: ArtifactKind::StructuredResult,
        payload,
        producer: actor(),
        workspace: workspace(),
        execution: execution(),
        resource: ResourceCorrelation::None,
        approval: ApprovalCorrelation::None,
        trace: trace(),
        verification: VerificationStatus::Verified,
        retention: RetentionPolicy::UserManaged,
        created_at: timestamp(),
    })
    .expect("manifest")
}

fn audit_input(
    action: AuditAction,
    artifacts: Vec<ArtifactRef>,
    payload: AuditPayloadLink,
) -> AuditEventInput {
    AuditEventInput {
        event_id: AuditEventId::new(format!("event-{action:?}")).expect("event id"),
        idempotency_key: AuditIdempotencyKey::new(format!("audit-{action:?}"))
            .expect("audit idempotency key"),
        actor: actor(),
        workspace: workspace(),
        execution: execution(),
        action,
        outcome: AuditOutcome::Succeeded,
        trace: trace(),
        cost: CostCorrelation::None,
        resource: ResourceCorrelation::None,
        approval: ApprovalCorrelation::None,
        artifacts,
        payload,
        occurred_at: timestamp(),
    }
}

fn artifact_ref() -> ArtifactRef {
    ArtifactRef::new(
        ArtifactId::new("artifact-1").expect("artifact id"),
        ArtifactRevision::new(1).expect("revision"),
    )
}

fn actor() -> PolicyActor {
    PolicyActor::tenant_user("actor-1", "tenant-1").expect("actor")
}

fn workspace() -> ArtifactWorkspace {
    ArtifactWorkspace::new(
        WorkspaceKey::new("workspace-1").expect("workspace key"),
        BindingId::new("binding-1").expect("binding id"),
        ArtifactWorkspaceScope::Office,
        WorkspaceScopeId::new("office-1").expect("scope id"),
    )
}

fn execution() -> ExecutionCorrelation {
    ExecutionCorrelation::Conversation {
        thread_id: ThreadId::new("thread-1").expect("thread id"),
        turn_id: TurnId::new("turn-1").expect("turn id"),
    }
}

fn trace() -> TraceContext {
    TraceContext::root(
        TraceId::new("trace-1").expect("trace id"),
        SpanId::new("span-1").expect("span id"),
    )
}

fn timestamp() -> UnixTimestamp {
    UnixTimestamp::new(100).expect("timestamp")
}
