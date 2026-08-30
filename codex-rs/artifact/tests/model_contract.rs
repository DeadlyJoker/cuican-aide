#![allow(
    clippy::expect_used,
    reason = "integration-test setup uses expect for precise Artifact model failures"
)]

use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactErrorKind;
use crewon_artifact::ArtifactExecutionProjection;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactKind;
use crewon_artifact::ArtifactManifest;
use crewon_artifact::ArtifactManifestInput;
use crewon_artifact::ArtifactRef;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::ArtifactWorkspaceScope;
use crewon_artifact::CitationId;
use crewon_artifact::CitationLocator;
use crewon_artifact::CitationRef;
use crewon_artifact::EvidenceAssessment;
use crewon_artifact::EvidenceId;
use crewon_artifact::EvidenceRef;
use crewon_artifact::EvidenceSource;
use crewon_artifact::ExecutionCorrelation;
use crewon_artifact::MediaType;
use crewon_artifact::PayloadBody;
use crewon_artifact::PayloadId;
use crewon_artifact::PayloadRef;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::ResourceCorrelation;
use crewon_artifact::RetentionPolicy;
use crewon_artifact::ThreadId;
use crewon_artifact::TraceContext;
use crewon_artifact::TurnId;
use crewon_artifact::VerificationStatus;
use crewon_artifact::WorkspaceScopeId;
use crewon_policy::PolicyActor;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::WorkspaceKey;
use crewon_task_runtime::UnixTimestamp;
use pretty_assertions::assert_eq;

#[test]
fn payload_body_is_bounded_secret_rejecting_and_debug_redacted() {
    let secret = PayloadBody::new(
        b"credential=do-not-store".to_vec(),
        PayloadSensitivity::Secret,
    )
    .expect_err("plaintext Secret storage must fail closed");
    assert_eq!(
        (secret.field(), secret.kind()),
        (
            "payloadSensitivity",
            ArtifactErrorKind::SecretPayloadUnsupported
        )
    );

    let body = PayloadBody::new(
        b"credential=do-not-log".to_vec(),
        PayloadSensitivity::WorkspaceSensitive,
    )
    .expect("bounded non-Secret body");
    assert_eq!(format!("{body:?}"), "PayloadBody(<redacted 21 bytes>)");
    assert!(!format!("{body:?}").contains("do-not-log"));
}

#[test]
fn payload_ref_detects_body_or_classification_mismatch() {
    let body = PayloadBody::new(b"exact bytes".to_vec(), PayloadSensitivity::Internal)
        .expect("payload body");
    let payload = PayloadRef::from_body(
        PayloadId::new("payload-1").expect("payload id"),
        &body,
        MediaType::new("text/plain").expect("media type"),
    );
    payload.verify_body(&body).expect("exact body");

    let reclassified = PayloadBody::new(
        b"exact bytes".to_vec(),
        PayloadSensitivity::WorkspaceSensitive,
    )
    .expect("reclassified body");
    let mismatch = payload
        .verify_body(&reclassified)
        .expect_err("classification downgrade must not verify");
    assert_eq!(
        (mismatch.field(), mismatch.kind()),
        ("payloadBody", ArtifactErrorKind::Mismatch)
    );
}

#[test]
fn manifest_contains_only_stable_metadata_and_valid_retention() {
    let body = PayloadBody::new(
        b"raw tool result that belongs only in payload".to_vec(),
        PayloadSensitivity::WorkspaceSensitive,
    )
    .expect("payload body");
    let manifest = ArtifactManifest::new(ArtifactManifestInput {
        artifact_ref: artifact_ref(),
        kind: ArtifactKind::Report,
        payload: PayloadRef::from_body(
            PayloadId::new("payload-1").expect("payload id"),
            &body,
            MediaType::new("application/json").expect("media type"),
        ),
        producer: PolicyActor::tenant_user("actor-1", "tenant-1").expect("actor"),
        workspace: workspace(),
        execution: ExecutionCorrelation::Conversation {
            thread_id: ThreadId::new("thread-1").expect("thread id"),
            turn_id: TurnId::new("turn-1").expect("turn id"),
        },
        resource: ResourceCorrelation::None,
        approval: ApprovalCorrelation::None,
        trace: trace(),
        verification: VerificationStatus::Verified,
        retention: RetentionPolicy::Session {
            expires_at: UnixTimestamp::new(200).expect("expiry"),
        },
        created_at: UnixTimestamp::new(100).expect("created at"),
    })
    .expect("valid manifest");

    let json = serde_json::to_string(&manifest).expect("manifest JSON");
    assert!(!json.contains("raw tool result"));
    assert!(!json.contains("/Users/"));
    assert!(!json.contains("credential"));
    assert!(json.contains("sha256:"));
    assert_eq!(manifest.artifact_ref(), &artifact_ref());
    assert_eq!(manifest.workspace(), &workspace());
}

#[test]
fn manifest_execution_projection_revalidates_exact_execution_metadata() {
    let body = PayloadBody::new(b"prompt body".to_vec(), PayloadSensitivity::Internal)
        .expect("payload body");
    let manifest = ArtifactManifest::new(ArtifactManifestInput {
        artifact_ref: artifact_ref(),
        kind: ArtifactKind::Document,
        payload: PayloadRef::from_body(
            PayloadId::new("payload-1").expect("payload id"),
            &body,
            MediaType::new("text/plain").expect("media type"),
        ),
        producer: PolicyActor::tenant_user("actor-1", "tenant-1").expect("actor"),
        workspace: workspace(),
        execution: ExecutionCorrelation::Conversation {
            thread_id: ThreadId::new("thread-1").expect("thread id"),
            turn_id: TurnId::new("turn-1").expect("turn id"),
        },
        resource: ResourceCorrelation::None,
        approval: ApprovalCorrelation::None,
        trace: trace(),
        verification: VerificationStatus::Verified,
        retention: RetentionPolicy::UserManaged,
        created_at: UnixTimestamp::new(100).expect("created at"),
    })
    .expect("manifest");
    let json = serde_json::to_string(&manifest).expect("manifest JSON");

    let projection =
        ArtifactExecutionProjection::from_manifest_json(&json).expect("execution projection");

    assert_eq!(projection.artifact_ref(), manifest.artifact_ref());
    assert_eq!(projection.kind(), ArtifactKind::Document);
    assert_eq!(projection.payload(), manifest.payload());
    assert_eq!(projection.workspace(), manifest.workspace());
    assert_eq!(projection.retention(), manifest.retention());
    assert_eq!(projection.created_at(), manifest.created_at());

    let mut unknown_schema = serde_json::from_str::<serde_json::Value>(&json).expect("JSON value");
    unknown_schema["schemaVersion"] = serde_json::json!(2);
    assert_eq!(
        ArtifactExecutionProjection::from_manifest_json(
            &serde_json::to_string(&unknown_schema).expect("unknown schema JSON")
        )
        .expect_err("unknown schema")
        .kind(),
        ArtifactErrorKind::Mismatch
    );

    let mut invalid_actor = serde_json::from_str::<serde_json::Value>(&json).expect("JSON value");
    invalid_actor["producer"]["actorId"] = serde_json::json!("actor\nforged");
    assert!(
        ArtifactExecutionProjection::from_manifest_json(
            &serde_json::to_string(&invalid_actor).expect("invalid actor JSON")
        )
        .is_err()
    );

    let mut trace_cycle = serde_json::from_str::<serde_json::Value>(&json).expect("JSON value");
    trace_cycle["trace"]["parentSpanId"] = trace_cycle["trace"]["spanId"].clone();
    assert!(
        ArtifactExecutionProjection::from_manifest_json(
            &serde_json::to_string(&trace_cycle).expect("trace cycle JSON")
        )
        .is_err()
    );
}

#[test]
fn retention_expiry_must_follow_creation_and_compliance_blocks_user_delete() {
    let created_at = UnixTimestamp::new(100).expect("created at");
    let invalid = RetentionPolicy::Task {
        expires_at: created_at,
    }
    .validate_at(created_at)
    .expect_err("equal expiry must fail");
    assert_eq!(
        (invalid.field(), invalid.kind()),
        ("retention.expiresAt", ArtifactErrorKind::OutOfRange)
    );

    let compliance = RetentionPolicy::Compliance {
        expires_at: UnixTimestamp::new(200).expect("expiry"),
    };
    assert!(!compliance.permits_user_delete());
    assert!(RetentionPolicy::UserManaged.permits_user_delete());
}

#[test]
fn citation_points_to_evidence_without_copying_body() {
    let evidence = EvidenceRef::new(
        EvidenceId::new("evidence-1").expect("evidence id"),
        EvidenceSource::Artifact {
            artifact: artifact_ref(),
        },
        EvidenceAssessment::Verified,
    );
    let citation = CitationRef::new(
        CitationId::new("citation-1").expect("citation id"),
        evidence,
        CitationLocator::new("json-pointer:/findings/0").expect("locator"),
    );

    assert_eq!(
        serde_json::to_value(citation).expect("citation JSON"),
        serde_json::json!({
            "citationId": "citation-1",
            "evidence": {
                "evidenceId": "evidence-1",
                "source": {
                    "type": "artifact",
                    "artifact": {"artifactId": "artifact-1", "revision": 1}
                },
                "assessment": "verified"
            },
            "locator": "json-pointer:/findings/0"
        })
    );
}

fn artifact_ref() -> ArtifactRef {
    ArtifactRef::new(
        ArtifactId::new("artifact-1").expect("artifact id"),
        ArtifactRevision::new(1).expect("revision"),
    )
}

fn workspace() -> ArtifactWorkspace {
    ArtifactWorkspace::new(
        WorkspaceKey::new("workspace-1").expect("workspace key"),
        BindingId::new("binding-1").expect("binding id"),
        ArtifactWorkspaceScope::Office,
        WorkspaceScopeId::new("office-1").expect("scope id"),
    )
}

fn trace() -> TraceContext {
    TraceContext::root(
        crewon_artifact::TraceId::new("trace-1").expect("trace id"),
        crewon_artifact::SpanId::new("span-1").expect("span id"),
    )
}
