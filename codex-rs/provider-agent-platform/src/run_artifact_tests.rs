use std::sync::Mutex;

use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use pretty_assertions::assert_eq;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

use crate::AgentPlatformProviderClient;
use crate::AgentPlatformProviderConnector;
use crate::AgentPlatformProviderError;
use crate::DelegationToken;
use crate::DiscoveryAuthorizationOperation;
use crate::ProviderArtifactKind;
use crate::ProviderArtifactMediaType;
use crate::ProviderArtifactRef;
use crate::ProviderArtifactRetention;
use crate::ProviderArtifactSensitivity;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationHeaders;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::ProviderRunArtifactClient;
use crate::ProviderRunArtifactContent;
use crate::ProviderRunArtifactImportInput;
use crate::ProviderRunArtifactImportRequest;
use crate::ProviderRunArtifactReadRequest;
use crate::ProviderRunAuthorizationBinding;
use crate::RunAuthorizationOperation;
use crate::ServiceBearerToken;

const DISCOVERY_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_discovery.v1.json");

#[derive(Default)]
struct RecordingAuthorizer {
    requests: Mutex<Vec<ProviderAuthorizationRequest>>,
}

impl ProviderAuthorizer for RecordingAuthorizer {
    async fn authorize(
        &self,
        request: ProviderAuthorizationRequest,
    ) -> Result<ProviderAuthorizationHeaders, ProviderAuthorizationError> {
        self.requests.lock().expect("requests lock").push(request);
        ProviderAuthorizationHeaders::new(
            ServiceBearerToken::new("service-artifact-token").expect("service token"),
            DelegationToken::new("delegation-artifact-token").expect("delegation token"),
        )
    }
}

#[tokio::test]
async fn run_artifact_client_imports_and_reads_exact_verified_text() {
    let server = MockServer::start().await;
    let client = connected_client(&server).await;
    let artifact = artifact("artifact-context-demo", "task-demo");
    let content = b"bounded context".to_vec();
    let digest = digest(&content);
    Mock::given(method("PUT"))
        .and(path(
            "/provider/v3/artifacts/artifact-context-demo/revisions/1",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "artifact": artifact_json("artifact-context-demo", "task-demo"),
            "mediaType": "text/plain",
            "sensitivity": "workspaceSensitive",
            "contentDigest": digest,
            "byteLength": content.len(),
            "created": true,
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/artifacts:read"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/plain; charset=utf-8")
                .insert_header("x-crewon-artifact-id", "artifact-context-demo")
                .insert_header("x-crewon-artifact-revision", "1")
                .insert_header("x-crewon-artifact-sensitivity", "workspaceSensitive")
                .insert_header("x-crewon-content-digest", digest.as_str())
                .set_body_bytes(content.clone()),
        )
        .expect(1)
        .mount(&server)
        .await;
    let import_request = ProviderRunArtifactImportRequest::new(
        binding(),
        artifact.clone(),
        ProviderRunArtifactImportInput {
            media_type: ProviderArtifactMediaType::TextPlain,
            sensitivity: ProviderArtifactSensitivity::WorkspaceSensitive,
            content: content.clone(),
            idempotency_key: "artifact-context-demo:import:1".to_string(),
            now: 100,
            expires_at: 160,
        },
    )
    .expect("import request");
    assert!(!format!("{import_request:?}").contains("bounded context"));

    let imported = client
        .import_context_artifact(import_request)
        .await
        .expect("import context Artifact");
    let read = client
        .read_artifact(
            ProviderRunArtifactReadRequest::new(binding(), artifact.clone()).expect("read request"),
        )
        .await
        .expect("read Artifact");

    assert_eq!(imported.artifact(), &artifact);
    assert_eq!(imported.media_type(), ProviderArtifactMediaType::TextPlain);
    assert_eq!(
        imported.sensitivity(),
        ProviderArtifactSensitivity::WorkspaceSensitive
    );
    assert_eq!(imported.content_digest(), digest);
    assert_eq!(imported.byte_length(), content.len());
    assert!(imported.created());
    assert_eq!(read.artifact(), &artifact);
    assert_eq!(read.bytes(), content);
    assert_eq!(read.media_type(), ProviderArtifactMediaType::TextPlain);
    assert_eq!(
        read.sensitivity(),
        ProviderArtifactSensitivity::WorkspaceSensitive
    );
    assert!(!format!("{read:?}").contains("bounded context"));

    let authorization_requests = client
        .authorizer
        .requests
        .lock()
        .expect("requests lock")
        .clone();
    assert_eq!(authorization_requests.len(), 3);
    assert_eq!(
        authorization_requests[0],
        ProviderAuthorizationRequest::Discovery(DiscoveryAuthorizationOperation::ReadDescriptor)
    );
    for (request, expected) in authorization_requests[1..].iter().zip([
        RunAuthorizationOperation::Start,
        RunAuthorizationOperation::Read,
    ]) {
        let ProviderAuthorizationRequest::Run { operation, binding } = request else {
            panic!("expected Run authorization");
        };
        assert_eq!(*operation, expected);
        assert_eq!(binding.task_id(), "task-demo");
    }

    let requests = server.received_requests().await.expect("received requests");
    let upload = requests
        .iter()
        .find(|request| request.method.as_str() == "PUT")
        .expect("upload request");
    assert_eq!(upload.body, content);
    assert_eq!(
        upload.headers["idempotency-key"],
        "artifact-context-demo:import:1"
    );
    assert_eq!(upload.headers["x-crewon-content-digest"], digest);
    assert_eq!(upload.headers["x-crewon-artifact-task-id"], "task-demo");
    let read_request = requests
        .iter()
        .find(|request| request.url.path().ends_with("/artifacts:read"))
        .expect("read request");
    assert_eq!(
        serde_json::from_slice::<Value>(&read_request.body).expect("read JSON"),
        artifact_json("artifact-context-demo", "task-demo")
    );
}

#[test]
fn run_artifact_requests_reject_unbounded_or_cross_task_content() {
    let context_artifact = artifact("artifact-context-demo", "task-demo");
    assert_eq!(
        ProviderRunArtifactImportRequest::new(
            binding(),
            context_artifact.clone(),
            ProviderRunArtifactImportInput {
                media_type: ProviderArtifactMediaType::TextPlain,
                sensitivity: ProviderArtifactSensitivity::Internal,
                content: vec![b'x'; 64 * 1024 + 1],
                idempotency_key: "artifact-import".to_string(),
                now: 100,
                expires_at: 160,
            },
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderRunArtifactImportRequest::new(
            binding(),
            context_artifact.clone(),
            ProviderRunArtifactImportInput {
                media_type: ProviderArtifactMediaType::ApplicationJson,
                sensitivity: ProviderArtifactSensitivity::Internal,
                content: b"{}".to_vec(),
                idempotency_key: "artifact-import".to_string(),
                now: 100,
                expires_at: 160,
            },
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderRunArtifactImportRequest::new(
            binding(),
            artifact("artifact-other", "other-task"),
            ProviderRunArtifactImportInput {
                media_type: ProviderArtifactMediaType::TextPlain,
                sensitivity: ProviderArtifactSensitivity::Internal,
                content: b"context".to_vec(),
                idempotency_key: "artifact-import".to_string(),
                now: 100,
                expires_at: 160,
            },
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderRunArtifactReadRequest::new(binding(), artifact("artifact-other", "other-task")),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderRunArtifactContent::new(
            binding(),
            artifact("artifact-other", "other-task"),
            ProviderArtifactMediaType::TextPlain,
            ProviderArtifactSensitivity::Internal,
            digest(b"result"),
            b"result".to_vec(),
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
    assert_eq!(
        ProviderRunArtifactContent::new(
            binding(),
            context_artifact.clone(),
            ProviderArtifactMediaType::TextPlain,
            ProviderArtifactSensitivity::Internal,
            digest(b"different"),
            b"result".to_vec(),
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
    assert_eq!(
        ProviderRunArtifactImportRequest::new(
            binding(),
            context_artifact.clone(),
            ProviderRunArtifactImportInput {
                media_type: ProviderArtifactMediaType::TextPlain,
                sensitivity: ProviderArtifactSensitivity::Internal,
                content: b"context".to_vec(),
                idempotency_key: "artifact-import".to_string(),
                now: 100,
                expires_at: 100,
            },
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(context_artifact.task_id(), "task-demo");
}

#[tokio::test]
async fn run_artifact_read_rejects_changed_digest_and_upload_does_not_retry_unknown_outcome() {
    let server = MockServer::start().await;
    let client = connected_client(&server).await;
    let artifact = artifact("artifact-context-demo", "task-demo");
    Mock::given(method("POST"))
        .and(path("/provider/v3/artifacts:read"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/plain")
                .insert_header("x-crewon-artifact-id", "artifact-context-demo")
                .insert_header("x-crewon-artifact-revision", "1")
                .insert_header("x-crewon-artifact-sensitivity", "internal")
                .insert_header("x-crewon-content-digest", digest(b"expected"))
                .set_body_bytes(b"changed"),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(
            "/provider/v3/artifacts/artifact-context-demo/revisions/1",
        ))
        .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
            "code": "unknownOutcome",
            "retryable": false,
            "providerRunId": null,
            "traceId": "trace-artifact-unknown",
        })))
        .expect(1)
        .mount(&server)
        .await;

    assert_eq!(
        client
            .read_artifact(
                ProviderRunArtifactReadRequest::new(binding(), artifact.clone())
                    .expect("read request")
            )
            .await,
        Err(AgentPlatformProviderError::InvalidResponse)
    );
    assert_eq!(
        client
            .import_context_artifact(
                ProviderRunArtifactImportRequest::new(
                    binding(),
                    artifact,
                    ProviderRunArtifactImportInput {
                        media_type: ProviderArtifactMediaType::TextPlain,
                        sensitivity: ProviderArtifactSensitivity::Internal,
                        content: b"context".to_vec(),
                        idempotency_key: "artifact-import-unknown".to_string(),
                        now: 100,
                        expires_at: 160,
                    },
                )
                .expect("import request")
            )
            .await,
        Err(AgentPlatformProviderError::UnknownOutcome)
    );
}

async fn connected_client(server: &MockServer) -> AgentPlatformProviderClient<RecordingAuthorizer> {
    let discovery: Value = serde_json::from_str(DISCOVERY_FIXTURE).expect("discovery fixture");
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(discovery["descriptor"].clone()))
        .expect(1)
        .mount(server)
        .await;
    AgentPlatformProviderConnector::development_loopback(&format!("{}/provider/v3/", server.uri()))
        .await
        .expect("connector")
        .connect(RecordingAuthorizer::default())
        .await
        .expect("client")
}

fn binding() -> ProviderRunAuthorizationBinding {
    ProviderRunAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind: ResourceKind::Agent,
            resource_id: ResourceId::new("agent-demo").expect("resource id"),
            revision: ResourceRevision::new("agent-version:7").expect("revision"),
        },
        "task-demo",
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("binding")
}

fn artifact(artifact_id: &str, task_id: &str) -> ProviderArtifactRef {
    ProviderArtifactRef::new(
        artifact_id,
        task_id,
        ProviderArtifactKind::Evidence,
        /*revision*/ 1,
        ProviderArtifactRetention::Task,
        /*created_at*/ 40,
    )
    .expect("artifact")
}

fn artifact_json(artifact_id: &str, task_id: &str) -> Value {
    serde_json::json!({
        "artifactId": artifact_id,
        "taskId": task_id,
        "kind": "evidence",
        "revision": 1,
        "retention": "task",
        "createdAt": 40,
    })
}

fn digest(value: impl AsRef<[u8]>) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_ref()))
}
