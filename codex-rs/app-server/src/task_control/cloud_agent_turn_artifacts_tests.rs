use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_core::context::ContextAudience;
use crewon_core::context::ContextBudget;
use crewon_core::context::ContextFreshness;
use crewon_core::context::ContextProvenance;
use crewon_core::context::ContextPurpose;
use crewon_core::context::ContextSensitivity;
use crewon_core::context::ContextSourceKind;
use crewon_core::context::ContextTrust;
use crewon_core::context::GovernedContextFragment;
use crewon_core::context::GovernedContextSpec;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;

use super::CloudAgentTurnArtifactError;
use super::CloudAgentTurnArtifactRequest;
use super::materialize_cloud_agent_turn_artifacts;
use crate::platform_control::ConnectionRequestIdentity;
use crate::platform_control::RequestIdentity;
use crate::transport::ConnectionOrigin;

#[tokio::test]
async fn prompt_and_governed_context_are_exact_idempotent_artifacts() {
    let home = tempfile::tempdir().expect("temporary State home");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State");
    let identity = identity();
    let workspace = workspace();
    let binding = binding();
    let fragments = vec![fragment(&workspace, "history-1", "verified prior result")];

    let first = materialize_cloud_agent_turn_artifacts(CloudAgentTurnArtifactRequest {
        state: &state,
        identity: &identity,
        workspace: &workspace,
        execution_binding: &binding,
        thread_id: &workspace.scope_id,
        turn_id: "turn-1",
        client_user_message_id: "client-message-1",
        prompt: "Produce the final answer",
        context_fragments: fragments.clone(),
        now: 100,
    })
    .await
    .expect("materialize artifacts");
    let second = materialize_cloud_agent_turn_artifacts(CloudAgentTurnArtifactRequest {
        state: &state,
        identity: &identity,
        workspace: &workspace,
        execution_binding: &binding,
        thread_id: &workspace.scope_id,
        turn_id: "turn-1",
        client_user_message_id: "client-message-1",
        prompt: "Produce the final answer",
        context_fragments: fragments,
        now: 200,
    })
    .await
    .expect("repeat artifacts at later time");
    assert_eq!(second, first);
    assert_eq!(first.context.len(), 1);

    let prompt = state
        .get_artifact_record(&first.prompt.artifact_id, first.prompt.revision)
        .await
        .expect("read prompt")
        .expect("prompt exists");
    assert_eq!(
        prompt.payload.content,
        Some(b"Produce the final answer".to_vec())
    );
    let context = state
        .get_artifact_record(&first.context[0].artifact_id, first.context[0].revision)
        .await
        .expect("read context")
        .expect("context exists");
    let body =
        String::from_utf8(context.payload.content.expect("context body")).expect("UTF-8 context");
    assert!(body.contains("verified prior result"));
    assert!(body.contains("<crewon_governed_context>"));
    let debug = format!("{first:?}");
    assert!(!debug.contains("Produce the final answer"));
    assert!(!debug.contains("verified prior result"));

    state.close().await;
}

#[tokio::test]
async fn invalid_prompt_or_cross_audience_context_creates_no_artifact() {
    let home = tempfile::tempdir().expect("temporary State home");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State");
    let identity = identity();
    let workspace = workspace();
    let binding = binding();
    let wrong_workspace = WorkspaceRef {
        binding_id: "workspace-binding-other".to_string(),
        ..workspace.clone()
    };
    let error = materialize_cloud_agent_turn_artifacts(CloudAgentTurnArtifactRequest {
        state: &state,
        identity: &identity,
        workspace: &workspace,
        execution_binding: &binding,
        thread_id: &workspace.scope_id,
        turn_id: "turn-1",
        client_user_message_id: "client-message-1",
        prompt: "valid prompt",
        context_fragments: vec![fragment(&wrong_workspace, "history-1", "wrong audience")],
        now: 100,
    })
    .await
    .expect_err("cross-audience context rejected");
    assert_eq!(error, CloudAgentTurnArtifactError::InvalidContext);

    let error = materialize_cloud_agent_turn_artifacts(CloudAgentTurnArtifactRequest {
        state: &state,
        identity: &identity,
        workspace: &workspace,
        execution_binding: &binding,
        thread_id: &workspace.scope_id,
        turn_id: "turn-1",
        client_user_message_id: "client-message-1",
        prompt: "   ",
        context_fragments: Vec::new(),
        now: 100,
    })
    .await
    .expect_err("blank prompt rejected");
    assert_eq!(error, CloudAgentTurnArtifactError::InvalidInput);
    state.close().await;
}

fn identity() -> RequestIdentity {
    ConnectionRequestIdentity::new(ConnectionOrigin::Stdio).derive(
        RequestIdentityClientRef {
            name: "test-client".to_string(),
            version: "1".to_string(),
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
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        binding_id: "workspace-binding-1".to_string(),
        scope: WorkspaceScope::Conversation,
        scope_id: "019f550e-ba52-7490-a248-b0d3a84103c1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}

fn fragment(workspace: &WorkspaceRef, fragment_id: &str, content: &str) -> GovernedContextFragment {
    GovernedContextFragment::build(
        GovernedContextSpec {
            fragment_id: fragment_id.to_string(),
            audience: ContextAudience::single(&workspace.binding_id, &workspace.scope_id)
                .expect("single audience"),
            provenance: ContextProvenance::new(
                ContextSourceKind::Provider,
                "agent-version-1",
                "provider-agent-1",
            )
            .expect("provenance"),
            trust: ContextTrust::UntrustedData,
            sensitivity: ContextSensitivity::Internal,
            purpose: ContextPurpose::TaskInput,
            budget: ContextBudget::new(/*token_cap*/ 500).expect("context budget"),
            freshness: ContextFreshness::current(/*observed_at*/ 100).expect("freshness"),
            content: content.to_string(),
        },
        /*now*/ 100,
    )
    .expect("governed context")
}

fn binding() -> crewon_resource_federation::ResolvedResourceBinding {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new("agent-demo").expect("resource id"),
        revision: ResourceRevision::new("agent-version:7").expect("resource revision"),
    };
    let capabilities = ProviderCapabilities::new(
        provider,
        [Capability {
            resource_kind: ResourceKind::Agent,
            binding_mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
        }],
    )
    .expect("capabilities");
    resolve_binding(
        &BindingRequest {
            binding_id: BindingId::new("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401")
                .expect("binding id"),
            workspace_key: WorkspaceKey::new("workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001")
                .expect("workspace key"),
            resource: resource.clone(),
            mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
            materialization: None,
        },
        &ResourceManifest {
            resource,
            schema_version: ManifestSchemaVersion::new("agent.manifest.v1")
                .expect("schema version"),
            content_digest: None,
        },
        &capabilities,
    )
    .expect("resolved binding")
}
