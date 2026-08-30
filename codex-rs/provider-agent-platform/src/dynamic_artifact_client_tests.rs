use std::sync::Mutex;

use crewon_resource_federation::ContentDigest;
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
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;
use crate::AgentPlatformProviderConnector;
use crate::DelegationToken;
use crate::ProviderAuthorizationHeaders;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::ProviderDynamicArtifactRef;
use crate::ProviderDynamicAuthorizationBinding;
use crate::ServiceBearerToken;

const DYNAMIC_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_dynamic_execution.v3.json");

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
            ServiceBearerToken::new("service-artifact-secret").expect("service token"),
            DelegationToken::new("delegation-artifact-secret").expect("delegation token"),
        )
    }
}

#[tokio::test]
async fn dynamic_artifact_client_reads_exact_verified_bytes() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture["descriptor"].clone()))
        .mount(&server)
        .await;
    let body = br#"{"large":"result"}"#;
    let digest = format!("sha256:{:x}", Sha256::digest(body));
    let mut artifact_command = fixture["artifactReadCommands"][0].clone();
    artifact_command["contentDigest"] = Value::String(digest.clone());
    Mock::given(method("POST"))
        .and(path("/provider/v3/dynamicArtifacts:read"))
        .and(body_partial_json(artifact_command))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .insert_header("x-crewon-artifact-id", "provider-artifact-001")
                .insert_header("x-crewon-artifact-revision", "1")
                .insert_header("x-crewon-artifact-sensitivity", "workspaceSensitive")
                .insert_header("x-crewon-content-digest", digest.as_str())
                .set_body_bytes(body),
        )
        .expect(1)
        .mount(&server)
        .await;
    let client = AgentPlatformProviderConnector::development_loopback(&format!(
        "{}/provider/v3/",
        server.uri()
    ))
    .await
    .expect("connector")
    .connect(RecordingAuthorizer::default())
    .await
    .expect("client");
    let request = ProviderDynamicArtifactReadRequest::new(
        binding(),
        "command-artifact-read-001",
        ProviderDynamicArtifactRef::new(
            "provider-artifact-001".to_string(),
            1,
            ContentDigest::new(digest).expect("content digest"),
        )
        .expect("artifact ref"),
    )
    .expect("artifact read request");

    let content = client
        .read_dynamic_artifact(request)
        .await
        .expect("artifact content");

    assert_eq!(content.bytes(), body);
    assert_eq!(content.media_type(), "application/json");
    assert!(content.workspace_sensitive());
    assert_eq!(
        client
            .authorizer
            .requests
            .lock()
            .expect("requests lock")
            .len(),
        2
    );
}

#[test]
fn dynamic_artifact_content_rejects_non_utf8_text() {
    assert_eq!(
        ProviderDynamicArtifactContent::new(vec![0xff, 0xfe], "application/json".to_string(), true,),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

fn binding() -> ProviderDynamicAuthorizationBinding {
    ProviderDynamicAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind: ResourceKind::McpTool,
            resource_id: ResourceId::new("tool-demo").expect("resource id"),
            revision: ResourceRevision::new("tool-version:3").expect("revision"),
        },
        "tool-call-001",
        format!("sha256:{}", "f".repeat(64)),
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("authorization binding")
}
