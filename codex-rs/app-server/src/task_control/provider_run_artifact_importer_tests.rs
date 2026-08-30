use crewon_artifact::ArtifactExecutionProjection;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::ArtifactWorkspaceScope;
use crewon_artifact::RunId;
use crewon_artifact::SpanId;
use crewon_artifact::ThreadId;
use crewon_artifact::TraceContext;
use crewon_artifact::TraceId;
use crewon_artifact::TurnId;
use crewon_artifact::WorkspaceScopeId;
use crewon_policy::PolicyActor;
use crewon_provider_agent_platform::ProviderArtifactKind;
use crewon_provider_agent_platform::ProviderArtifactMediaType;
use crewon_provider_agent_platform::ProviderArtifactRef;
use crewon_provider_agent_platform::ProviderArtifactRetention;
use crewon_provider_agent_platform::ProviderArtifactSensitivity;
use crewon_provider_agent_platform::ProviderRunArtifactContent;
use crewon_provider_agent_platform::ProviderRunAuthorizationBinding;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_state::StateRuntime;
use crewon_task_runtime::AttemptId;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::UnixTimestamp;
use pretty_assertions::assert_eq;
use sha2::Digest;
use sha2::Sha256;

use super::*;

const BODY: &[u8] = b"verified cloud result";

#[tokio::test]
async fn output_artifact_import_is_durable_idempotent_and_exactly_correlated() {
    let home = tempfile::tempdir().expect("state home");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("state runtime");
    let importer = StateProviderRunOutputArtifactImporter::new(state.clone());

    let first = importer
        .import(request(
            BODY,
            ProviderArtifactKind::Report,
            /*now*/ 200,
        ))
        .await
        .expect("first import");
    drop(importer);
    drop(state);

    let restarted = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("restarted state runtime");
    let duplicate = StateProviderRunOutputArtifactImporter::new(restarted.clone())
        .import(request(
            BODY,
            ProviderArtifactKind::Report,
            /*now*/ 201,
        ))
        .await
        .expect("duplicate import");
    assert_eq!(duplicate, first);

    let stored = restarted
        .get_artifact_record(
            first.artifact().artifact_id().as_str(),
            first.artifact().revision().get(),
        )
        .await
        .expect("read Artifact")
        .expect("stored Artifact");
    assert_eq!(stored.payload.content.as_deref(), Some(BODY));
    assert_eq!(stored.payload.expires_at, Some(100 + 7 * 24 * 60 * 60));
    assert_eq!(stored.payload.created_at, 150);

    let projection =
        ArtifactExecutionProjection::from_manifest_json(&stored.manifest.manifest_json)
            .expect("Artifact projection");
    let manifest: serde_json::Value =
        serde_json::from_str(&stored.manifest.manifest_json).expect("manifest JSON");
    assert_eq!(
        manifest
            .pointer("/execution/type")
            .and_then(|value| value.as_str()),
        Some("task")
    );
    assert_eq!(
        manifest
            .pointer("/execution/taskId")
            .and_then(|value| value.as_str()),
        Some("task-1")
    );
    assert_eq!(
        manifest
            .pointer("/execution/runId")
            .and_then(|value| value.as_str()),
        Some("worker-run-1")
    );
    assert_eq!(
        manifest
            .pointer("/execution/attemptId")
            .and_then(|value| value.as_str()),
        Some("attempt-1")
    );
    assert_eq!(
        manifest
            .pointer("/resource/resource/resourceId")
            .and_then(|value| value.as_str()),
        Some("agent-1")
    );
    assert_eq!(projection.artifact_ref(), first.artifact());

    let association = restarted
        .get_platform_audit_event(first.association_audit_event_id().as_str())
        .await
        .expect("read association Audit")
        .expect("association Audit exists");
    let audit: serde_json::Value =
        serde_json::from_str(&association.metadata_json).expect("association Audit JSON");
    assert_eq!(association.payload_id, None);
    assert_eq!(association.occurred_at, 150);
    assert_eq!(
        audit
            .pointer("/execution/type")
            .and_then(|value| value.as_str()),
        Some("conversation")
    );
    assert_eq!(
        audit
            .pointer("/execution/threadId")
            .and_then(|value| value.as_str()),
        Some("thread-1")
    );
    assert_eq!(
        audit
            .pointer("/execution/turnId")
            .and_then(|value| value.as_str()),
        Some("turn-1")
    );
    assert_eq!(
        audit
            .pointer("/resource/resource/resourceId")
            .and_then(|value| value.as_str()),
        Some("agent-1")
    );
    assert!(
        !stored
            .manifest
            .manifest_json
            .contains("verified cloud result")
    );
    assert!(!association.metadata_json.contains("verified cloud result"));
}

#[tokio::test]
async fn output_artifact_import_rejects_cross_task_expired_and_mutated_source() {
    let home = tempfile::tempdir().expect("state home");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("state runtime");
    let importer = StateProviderRunOutputArtifactImporter::new(state);

    let mut cross_task = request(BODY, ProviderArtifactKind::Report, /*now*/ 200);
    cross_task.task_id = TaskId::new("task-other").expect("Task ID");
    assert_eq!(
        importer.import(cross_task).await,
        Err(ProviderRunOutputArtifactImportError::InvalidCorrelation)
    );

    assert_eq!(
        importer
            .import(request(
                BODY,
                ProviderArtifactKind::Report,
                100 + 7 * 24 * 60 * 60,
            ))
            .await,
        Err(ProviderRunOutputArtifactImportError::Expired)
    );
    assert_eq!(
        importer
            .import(request(BODY, ProviderArtifactKind::Image, /*now*/ 200))
            .await,
        Err(ProviderRunOutputArtifactImportError::UnsupportedArtifact)
    );
    let mut future_observation = request(BODY, ProviderArtifactKind::Report, /*now*/ 200);
    future_observation.observed_at = UnixTimestamp::new(/*value*/ 231).expect("future observed at");
    assert_eq!(
        importer.import(future_observation).await,
        Err(ProviderRunOutputArtifactImportError::InvalidCorrelation)
    );

    importer
        .import(request(
            BODY,
            ProviderArtifactKind::Report,
            /*now*/ 200,
        ))
        .await
        .expect("original import");
    assert_eq!(
        importer
            .import(request(
                b"mutated cloud result",
                ProviderArtifactKind::Report,
                /*now*/ 201
            ))
            .await,
        Err(ProviderRunOutputArtifactImportError::Conflict)
    );
}

#[test]
fn output_artifact_import_debug_redacts_body() {
    let request = request(BODY, ProviderArtifactKind::Report, /*now*/ 200);
    let debug = format!("{request:?}");
    assert!(!debug.contains("verified cloud result"));
    assert!(debug.contains("[REDACTED]"));
}

fn request(
    body: &[u8],
    kind: ProviderArtifactKind,
    now: i64,
) -> ProviderRunOutputArtifactImportRequest {
    let artifact = ProviderArtifactRef::new(
        "output-attempt-1",
        "task-1",
        kind,
        /*revision*/ 1,
        ProviderArtifactRetention::Task,
        /*created_at*/ 100,
    )
    .expect("Provider Artifact");
    let digest = format!("sha256:{:x}", Sha256::digest(body));
    ProviderRunOutputArtifactImportRequest {
        actor: PolicyActor::space_user("principal-1", "tenant-1", "space-1").expect("Policy actor"),
        workspace: ArtifactWorkspace::new(
            WorkspaceKey::new("workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001")
                .expect("Workspace key"),
            BindingId::new("workspace-binding-1").expect("Workspace binding"),
            ArtifactWorkspaceScope::Conversation,
            WorkspaceScopeId::new("thread-1").expect("Workspace scope ID"),
        ),
        task_id: TaskId::new("task-1").expect("Task ID"),
        run_id: RunId::new("worker-run-1").expect("Run ID"),
        attempt_id: AttemptId::new("attempt-1").expect("Attempt ID"),
        thread_id: ThreadId::new("thread-1").expect("Thread ID"),
        turn_id: TurnId::new("turn-1").expect("Turn ID"),
        provider_run_id: "provider-run-1".to_string(),
        trace: TraceContext::root(
            TraceId::new("trace-1").expect("Trace ID"),
            SpanId::new("span-1").expect("Span ID"),
        ),
        content: ProviderRunArtifactContent::new(
            ProviderRunAuthorizationBinding::new(
                agent_resource(),
                "task-1",
                "credential-1",
                /*credential_revision*/ 1,
            )
            .expect("Run authorization"),
            artifact,
            ProviderArtifactMediaType::TextMarkdown,
            ProviderArtifactSensitivity::WorkspaceSensitive,
            digest,
            body.to_vec(),
        )
        .expect("Provider Artifact content"),
        observed_at: UnixTimestamp::new(/*value*/ 150).expect("observed at"),
        now: UnixTimestamp::new(now).expect("now"),
    }
}

fn agent_resource() -> ResourceRef {
    ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new("agent-platform").expect("Provider ID"),
            protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol version"),
        },
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new("agent-1").expect("Resource ID"),
        revision: ResourceRevision::new("agent-version:1").expect("Resource revision"),
    }
}
