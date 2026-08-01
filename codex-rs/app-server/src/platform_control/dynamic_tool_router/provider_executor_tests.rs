use std::sync::Arc;
use std::sync::Mutex;

use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactRevision;
use crewon_policy::CredentialExpiry;
use crewon_policy::CredentialState;
use crewon_provider_agent_platform::ProviderDynamicArtifactClient;
use crewon_provider_agent_platform::ProviderDynamicArtifactContent;
use crewon_provider_agent_platform::ProviderDynamicArtifactReadRequest;
use crewon_provider_agent_platform::ProviderDynamicArtifactRef;
use crewon_provider_agent_platform::ProviderDynamicExecutionSuccess;
use crewon_provider_agent_platform::ProviderDynamicResult;
use crewon_resource_federation::ContentDigest;
use pretty_assertions::assert_eq;
use sha2::Digest;
use sha2::Sha256;

use super::*;
use crate::platform_control::dynamic_tool_router::ports::DynamicToolCredentialSnapshot;
use crate::platform_control::dynamic_tool_router::ports::DynamicToolProviderIdentitySnapshot;

#[derive(Clone)]
struct FakeClient {
    requests: Arc<Mutex<Vec<ProviderDynamicExecutionRequest>>>,
    artifact_requests: Arc<Mutex<Vec<ProviderDynamicArtifactReadRequest>>>,
    outcome: Result<ProviderDynamicExecutionOutcome, AgentPlatformProviderError>,
    artifact_content: Option<ProviderDynamicArtifactContent>,
}

impl ProviderDynamicExecutionClient for FakeClient {
    async fn execute_dynamic(
        &self,
        request: ProviderDynamicExecutionRequest,
    ) -> Result<ProviderDynamicExecutionOutcome, AgentPlatformProviderError> {
        self.requests.lock().expect("requests lock").push(request);
        self.outcome.clone()
    }
}

impl ProviderDynamicArtifactClient for FakeClient {
    async fn read_dynamic_artifact(
        &self,
        request: ProviderDynamicArtifactReadRequest,
    ) -> Result<ProviderDynamicArtifactContent, AgentPlatformProviderError> {
        self.artifact_requests
            .lock()
            .expect("artifact requests lock")
            .push(request);
        self.artifact_content
            .clone()
            .ok_or(AgentPlatformProviderError::Unavailable)
    }
}

struct FakeFactory {
    client: FakeClient,
    connections: Mutex<u32>,
}

impl ProviderDynamicClientFactory for FakeFactory {
    type Client = FakeClient;

    async fn connect(
        &self,
        provider_id: &str,
        _identity: ProviderAuthorizationIdentity,
    ) -> Result<Self::Client, AgentPlatformProviderError> {
        assert_eq!(provider_id, "agent-platform");
        *self.connections.lock().expect("connections lock") += 1;
        Ok(self.client.clone())
    }
}

struct RejectingArtifactImporter;

impl ProviderDynamicArtifactImporter for RejectingArtifactImporter {
    async fn import(
        &self,
        _request: ProviderDynamicArtifactImportRequest,
    ) -> Result<ArtifactRef, ProviderArtifactImportError> {
        Err(ProviderArtifactImportError::Unavailable)
    }
}

struct RecordingArtifactImporter {
    requests: Mutex<Vec<ProviderDynamicArtifactImportRequest>>,
    result: ArtifactRef,
}

impl ProviderDynamicArtifactImporter for RecordingArtifactImporter {
    async fn import(
        &self,
        request: ProviderDynamicArtifactImportRequest,
    ) -> Result<ArtifactRef, ProviderArtifactImportError> {
        self.requests
            .lock()
            .expect("artifact import requests lock")
            .push(request);
        Ok(self.result.clone())
    }
}

#[tokio::test]
async fn provider_executor_preserves_exact_claim_and_returns_bounded_inline_output() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let factory = FakeFactory {
        client: FakeClient {
            requests: Arc::clone(&requests),
            artifact_requests: Arc::new(Mutex::new(Vec::new())),
            outcome: Ok(ProviderDynamicExecutionOutcome::Succeeded(
                ProviderDynamicExecutionSuccess::new(
                    ProviderDynamicResult::inline_text(vec!["provider result".to_string()])
                        .expect("inline result"),
                )
                .expect("provider success"),
            )),
            artifact_content: None,
        },
        connections: Mutex::new(0),
    };
    let executor = AgentPlatformDynamicToolExecutor::new(&factory, &RejectingArtifactImporter);
    let outcome = executor.execute(request("resource-9")).await;

    let DynamicToolAdapterOutcome::Succeeded(result) = outcome else {
        panic!("expected success");
    };
    assert_eq!(
        result
            .inline_response()
            .expect("inline response")
            .content_items,
        vec![DynamicToolCallOutputContentItem::InputText {
            text: "provider result".to_string()
        }]
    );
    assert_eq!(*factory.connections.lock().expect("connections lock"), 1);
    let requests = requests.lock().expect("requests lock");
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.authorization().call_id(), "call-provider-1");
    assert_eq!(request.authorization().credential_id(), "provider-grant-1");
    assert_eq!(request.authorization().credential_revision(), 1);
    assert_eq!(
        request.authorization().resource().resource_id.as_str(),
        "resource-9"
    );
    assert_eq!(
        request.arguments(),
        &serde_json::json!({"query": "bounded"})
    );
}

#[tokio::test]
async fn provider_executor_reads_and_imports_exact_artifact_before_success() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let artifact_requests = Arc::new(Mutex::new(Vec::new()));
    let body = br#"{"large":"result"}"#.to_vec();
    let digest = format!("sha256:{:x}", Sha256::digest(&body));
    let provider_artifact = ProviderDynamicArtifactRef::new(
        "provider-artifact-1".to_string(),
        /*revision*/ 1,
        ContentDigest::new(&digest).expect("content digest"),
    )
    .expect("provider artifact");
    let factory = FakeFactory {
        client: FakeClient {
            requests: Arc::clone(&requests),
            artifact_requests: Arc::clone(&artifact_requests),
            outcome: Ok(ProviderDynamicExecutionOutcome::Succeeded(
                ProviderDynamicExecutionSuccess::new(ProviderDynamicResult::Artifact(
                    provider_artifact.clone(),
                ))
                .expect("provider success"),
            )),
            artifact_content: Some(
                ProviderDynamicArtifactContent::new(
                    body.clone(),
                    "application/json".to_string(),
                    /*workspace_sensitive*/ true,
                )
                .expect("artifact content"),
            ),
        },
        connections: Mutex::new(0),
    };
    let local_artifact = ArtifactRef::new(
        ArtifactId::new("local-artifact-1").expect("Artifact id"),
        ArtifactRevision::new(/*value*/ 1).expect("Artifact revision"),
    );
    let importer = RecordingArtifactImporter {
        requests: Mutex::new(Vec::new()),
        result: local_artifact.clone(),
    };
    let executor = AgentPlatformDynamicToolExecutor::new(&factory, &importer);

    let outcome = executor.execute(request("resource-9")).await;

    let DynamicToolAdapterOutcome::Succeeded(result) = outcome else {
        panic!("expected success");
    };
    assert_eq!(result.artifact_ref(), Some(&local_artifact));
    assert_eq!(requests.lock().expect("requests lock").len(), 1);
    let artifact_requests = artifact_requests.lock().expect("artifact requests lock");
    assert_eq!(artifact_requests.len(), 1);
    assert_eq!(
        artifact_requests[0].artifact().artifact_id(),
        provider_artifact.artifact_id()
    );
    let imports = importer
        .requests
        .lock()
        .expect("artifact import requests lock");
    assert_eq!(imports.len(), 1);
    assert_eq!(
        imports[0].claim.action_digest,
        format!("sha256:{}", "a".repeat(64))
    );
    assert_eq!(imports[0].content.bytes(), body);
}

#[tokio::test]
async fn provider_executor_rejects_target_drift_before_network_and_maps_timeout_to_unknown() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let factory = FakeFactory {
        client: FakeClient {
            requests: Arc::clone(&requests),
            artifact_requests: Arc::new(Mutex::new(Vec::new())),
            outcome: Err(AgentPlatformProviderError::Timeout),
            artifact_content: None,
        },
        connections: Mutex::new(0),
    };
    let executor = AgentPlatformDynamicToolExecutor::new(&factory, &RejectingArtifactImporter);

    assert!(matches!(
        executor.execute(request("drifted-resource")).await,
        DynamicToolAdapterOutcome::Unknown(DynamicToolExecutionUnknown::InvalidResponse)
    ));
    assert_eq!(*factory.connections.lock().expect("connections lock"), 0);
    assert!(requests.lock().expect("requests lock").is_empty());

    assert!(matches!(
        executor.execute(request("resource-9")).await,
        DynamicToolAdapterOutcome::Unknown(DynamicToolExecutionUnknown::Timeout)
    ));
    assert_eq!(*factory.connections.lock().expect("connections lock"), 1);
    assert_eq!(requests.lock().expect("requests lock").len(), 1);
}

fn request(target_resource_id: &str) -> ProviderDynamicToolExecutionRequest {
    ProviderDynamicToolExecutionRequest::new(
        claim(),
        DynamicToolCredentialSnapshot::provider_reference(
            "provider-grant-1",
            ProviderId::new("agent-platform").expect("provider id"),
            CredentialState::Available,
            /*revision*/ 1,
            CredentialExpiry::Never,
            DynamicToolProviderIdentitySnapshot {
                binding_id: "identity-binding-1".to_string(),
                binding_revision: 1,
                subject: "user:42".to_string(),
                tenant_id: "7".to_string(),
                space_id: "11".to_string(),
            },
        )
        .expect("credential"),
        DynamicToolOperation::Call,
        serde_json::json!({"query": "bounded"}),
        "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        target_resource_id.to_string(),
    )
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
