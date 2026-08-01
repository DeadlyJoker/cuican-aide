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
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;
use crate::AgentPlatformProviderConnector;
use crate::DelegationToken;
use crate::DynamicAuthorizationOperation;
use crate::ProviderAuthorizationHeaders;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
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
            ServiceBearerToken::new("service-dynamic-secret").expect("service token"),
            DelegationToken::new("delegation-dynamic-secret").expect("delegation token"),
        )
    }
}

#[tokio::test]
async fn dynamic_client_executes_once_with_exact_authority_and_identity() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture["descriptor"].clone()))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/dynamicActions:execute"))
        .and(body_partial_json(fixture["executeCommands"][0].clone()))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(fixture["executeResponses"][0].clone()),
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
    let request = request();
    let expected_binding = request.authorization().clone();
    let outcome = client
        .execute_dynamic(request)
        .await
        .expect("dynamic outcome");

    assert!(matches!(
        outcome,
        ProviderDynamicExecutionOutcome::Succeeded(_)
    ));
    assert_eq!(
        client
            .authorizer
            .requests
            .lock()
            .expect("requests lock")
            .as_slice(),
        &[
            ProviderAuthorizationRequest::Discovery(
                crate::DiscoveryAuthorizationOperation::ReadDescriptor
            ),
            ProviderAuthorizationRequest::Dynamic {
                operation: DynamicAuthorizationOperation::Call,
                binding: expected_binding,
            },
        ]
    );
    let requests = server.received_requests().await.expect("received requests");
    let execute = requests
        .iter()
        .find(|request| request.url.path().ends_with("dynamicActions:execute"))
        .expect("execute request");
    let body = String::from_utf8(execute.body.clone()).expect("UTF-8 body");
    assert!(!body.contains("service-dynamic-secret"));
    assert!(!body.contains("delegation-dynamic-secret"));
    assert!(!body.contains("credential-demo"));
}

fn request() -> ProviderDynamicExecutionRequest {
    ProviderDynamicExecutionRequest::new(
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
        .expect("authorization binding"),
        "command-tool-call-001",
        serde_json::json!({"title": "Ship the bounded result"}),
    )
    .expect("execution request")
}
