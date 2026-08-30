use crewon_provider_agent_platform::ProviderDynamicArtifactContent;
use crewon_provider_agent_platform::ProviderDynamicArtifactRef;
use crewon_resource_federation::ContentDigest;
use pretty_assertions::assert_eq;

use super::*;
use crate::platform_control::dynamic_tool_router::ports::DynamicToolExecutionClaimRequest;
use crate::platform_control::dynamic_tool_router::registration::DynamicToolOperation;

#[derive(Clone, Copy)]
struct FixedClock(i64);

impl ProviderConnectionClock for FixedClock {
    fn now(&self) -> i64 {
        self.0
    }
}

#[tokio::test]
async fn provider_artifact_import_is_verified_durable_and_idempotent() {
    let home = tempfile::tempdir().expect("state home");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("state runtime");
    let importer = StateProviderDynamicArtifactImporter::new(state.clone(), FixedClock(200));
    let body = br#"{"large":"result"}"#.to_vec();
    let digest = format!("sha256:{:x}", Sha256::digest(&body));
    let request = ProviderDynamicArtifactImportRequest {
        claim: claim(),
        artifact: ProviderDynamicArtifactRef::new(
            "provider-artifact-1".to_string(),
            /*revision*/ 1,
            ContentDigest::new(&digest).expect("content digest"),
        )
        .expect("provider artifact"),
        content: ProviderDynamicArtifactContent::new(
            body.clone(),
            "application/json".to_string(),
            /*workspace_sensitive*/ true,
        )
        .expect("artifact content"),
    };

    let first = importer.import(request).await.expect("first import");
    let duplicate = importer
        .import(ProviderDynamicArtifactImportRequest {
            claim: claim(),
            artifact: ProviderDynamicArtifactRef::new(
                "provider-artifact-1".to_string(),
                /*revision*/ 1,
                ContentDigest::new(&digest).expect("content digest"),
            )
            .expect("provider artifact"),
            content: ProviderDynamicArtifactContent::new(
                body.clone(),
                "application/json".to_string(),
                /*workspace_sensitive*/ true,
            )
            .expect("artifact content"),
        })
        .await
        .expect("duplicate import");

    assert_eq!(duplicate, first);
    let stored = state
        .get_artifact_record(first.artifact_id().as_str(), first.revision().get())
        .await
        .expect("read Artifact")
        .expect("stored Artifact");
    assert_eq!(stored.payload.content.as_deref(), Some(body.as_slice()));
    assert_eq!(
        stored.payload.sha256,
        format!("sha256:{:x}", Sha256::digest(&body))
    );
}

fn claim() -> DynamicToolExecutionClaimRequest {
    DynamicToolExecutionClaimRequest {
        call_id: "call-provider-1".to_string(),
        action_digest: format!("sha256:{}", "a".repeat(64)),
        access_decision_id: "decision-1".to_string(),
        approval_id: Some("approval-1".to_string()),
        actor_id: "principal:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        tenant_id: Some("7".to_string()),
        space_id: Some("11".to_string()),
        session_id: "session-1".to_string(),
        trace_id: "trace-1".to_string(),
        span_id: "span-1".to_string(),
        parent_span_id: None,
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        workspace_binding_id: "workspace-binding-1".to_string(),
        workspace_scope: crewon_app_server_protocol::WorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401".to_string(),
        binding_revision: 1,
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: crewon_state::ProviderResourceKind::McpTool,
        resource_id: "resource-9".to_string(),
        resource_revision: "resource-version:7".to_string(),
        execution_location: crewon_state::ProviderResourceExecutionLocation::Provider,
        credential_id: Some("provider-grant-1".to_string()),
        credential_revision: Some(1),
        provider_identity_binding_id: Some("identity-binding-1".to_string()),
        provider_identity_binding_revision: Some(1),
        provider_subject: Some("user:42".to_string()),
        provider_tenant_id: Some("7".to_string()),
        provider_space_id: Some("11".to_string()),
        operation: DynamicToolOperation::Call,
        claimed_at: 100,
    }
}
