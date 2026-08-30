use super::*;
use crate::platform_control::ConnectionRequestIdentity;
use crate::transport::ConnectionOrigin;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_artifact::ArtifactErrorKind;
use crewon_artifact::AuditPayloadLink;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::ThreadId;
use crewon_artifact::TurnId;
use crewon_state::ArtifactCommitOutcome;
use crewon_state::StateRuntime;

#[test]
fn adapter_derives_actor_workspace_and_trace_without_serializing_body() {
    let identity = identity();
    let prepared =
        prepare_artifact_commit(&identity, &workspace(), input(PayloadSensitivity::Internal))
            .expect("prepare Artifact commit");
    let manifest_json = serde_json::to_string(prepared.domain().manifest()).expect("manifest JSON");
    let audit_json = serde_json::to_string(prepared.domain().created_event()).expect("audit JSON");

    assert!(manifest_json.contains(identity.reference().actor_id.as_str()));
    assert!(manifest_json.contains("\"workspaceKey\":\"workspace-1\""));
    assert!(manifest_json.contains("\"scope\":\"office\""));
    assert!(manifest_json.contains("\"traceId\":\"server-trace-1\""));
    assert!(!manifest_json.contains("untrusted-client-name"));
    assert!(!manifest_json.contains("raw-tool-body"));
    assert!(!audit_json.contains("raw-tool-body"));
    assert!(matches!(
        prepared.domain().created_event().payload(),
        AuditPayloadLink::Payload { .. }
    ));

    let state = prepared.into_state_record().expect("State record");
    assert_eq!(state.payload.content, b"raw-tool-body".to_vec());
    assert!(!state.manifest.manifest_json.contains("raw-tool-body"));
    assert!(!state.created_event.metadata_json.contains("raw-tool-body"));
}

#[test]
fn adapter_rejects_secret_body_before_any_state_record_exists() {
    let error = PayloadBody::new(b"credential".to_vec(), PayloadSensitivity::Secret)
        .expect_err("Secret plaintext must fail closed");
    assert_eq!(error.kind(), ArtifactErrorKind::SecretPayloadUnsupported);
}

#[test]
fn adapter_uses_resolved_workspace_not_node_or_environment_paths() {
    let identity = identity();
    let mut workspace = workspace();
    workspace.node_id = "/Users/untrusted/path".to_string();
    workspace.environment_id = "client-secret-environment".to_string();
    let prepared = prepare_artifact_commit(
        &identity,
        &workspace,
        input(PayloadSensitivity::WorkspaceSensitive),
    )
    .expect("prepare Artifact commit");
    let manifest_json = serde_json::to_string(prepared.domain().manifest()).expect("manifest JSON");

    assert!(!manifest_json.contains("/Users/untrusted/path"));
    assert!(!manifest_json.contains("client-secret-environment"));
    assert!(manifest_json.contains("binding-1"));
}

#[tokio::test]
async fn prepared_commit_round_trips_through_the_shared_state_runtime() {
    let codex_home = tempfile::tempdir().expect("temporary Crewon home");
    let runtime = StateRuntime::init(codex_home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State Runtime");
    let record = prepare_artifact_commit(
        &identity(),
        &workspace(),
        input(PayloadSensitivity::WorkspaceSensitive),
    )
    .expect("prepare Artifact commit")
    .into_state_record()
    .expect("State record");

    assert_eq!(
        runtime
            .commit_artifact_record(&record)
            .await
            .expect("commit Artifact"),
        ArtifactCommitOutcome::Created
    );
    let stored = runtime
        .get_artifact_record("artifact-1", /*revision*/ 1)
        .await
        .expect("read Artifact")
        .expect("stored Artifact");
    assert_eq!(stored.payload.content, Some(b"raw-tool-body".to_vec()));
    assert!(stored.manifest.manifest_json.contains("server-trace-1"));
    runtime.close().await;
}

fn identity() -> RequestIdentity {
    ConnectionRequestIdentity::new(ConnectionOrigin::Stdio).derive(
        RequestIdentityClientRef {
            name: "untrusted-client-name".to_string(),
            version: "999".to_string(),
            capabilities: RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "server-trace-1".to_string(),
    )
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: "workspace-1".to_string(),
        binding_id: "binding-1".to_string(),
        scope: WorkspaceScope::Office,
        scope_id: "office-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "environment-1".to_string(),
    }
}

fn input(sensitivity: PayloadSensitivity) -> ResolvedArtifactCommitInput {
    ResolvedArtifactCommitInput {
        artifact_id: ArtifactId::new("artifact-1").expect("artifact id"),
        revision: ArtifactRevision::new(/*value*/ 1).expect("revision"),
        artifact_idempotency_key: ArtifactIdempotencyKey::new("artifact-create-1")
            .expect("idempotency key"),
        kind: ArtifactKind::StructuredResult,
        payload_id: PayloadId::new("payload-1").expect("payload id"),
        body: PayloadBody::new(b"raw-tool-body".to_vec(), sensitivity).expect("payload body"),
        media_type: MediaType::new("application/json").expect("media type"),
        execution: ExecutionCorrelation::Conversation {
            thread_id: ThreadId::new("thread-1").expect("thread id"),
            turn_id: TurnId::new("turn-1").expect("turn id"),
        },
        resource: ResourceCorrelation::None,
        approval: ApprovalCorrelation::None,
        trace: ResolvedArtifactTraceInput {
            span_id: SpanId::new("span-1").expect("span id"),
            parent_span_id: None,
        },
        cost: CostCorrelation::None,
        verification: VerificationStatus::Verified,
        retention: RetentionPolicy::UserManaged,
        event_id: AuditEventId::new("event-1").expect("event id"),
        audit_idempotency_key: AuditIdempotencyKey::new("audit-1").expect("audit idempotency key"),
        created_at: UnixTimestamp::new(/*value*/ 100).expect("timestamp"),
    }
}
