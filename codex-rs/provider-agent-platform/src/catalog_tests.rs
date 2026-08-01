use std::net::IpAddr;
use std::sync::Mutex;

use crewon_provider_transport::EndpointResolver;
use crewon_provider_transport::ProviderEndpointPolicy;
use crewon_provider_transport::ProviderEndpointPolicyError;
use crewon_resource_federation::CatalogProvider;
use crewon_resource_federation::PageLimit;
use crewon_resource_federation::ResourceListQuery;
use pretty_assertions::assert_eq;
use serde_json::Value;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;
use crate::DelegationToken;
use crate::ProviderAuthorizationHeaders;
use crate::ServiceBearerToken;

const DISCOVERY_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_discovery.v1.json");
const DYNAMIC_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_dynamic_execution.v3.json");

struct FixedResolver(IpAddr);

impl EndpointResolver for FixedResolver {
    async fn resolve(
        &self,
        _host: String,
        _port: u16,
    ) -> Result<Vec<IpAddr>, ProviderEndpointPolicyError> {
        Ok(vec![self.0])
    }
}

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
            ServiceBearerToken::new("service-test-token").expect("service token"),
            DelegationToken::new("delegation-test-token").expect("delegation token"),
        )
    }
}

#[tokio::test]
async fn catalog_connects_with_strict_descriptor_and_reads_exact_resources() {
    let fixture: Value = serde_json::from_str(DISCOVERY_FIXTURE).expect("fixture");
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture["descriptor"].clone()))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:list"))
        .and(body_partial_json(serde_json::json!({
            "type": "listResources",
            "resourceType": "agent",
            "afterCursor": null,
            "limit": 20
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture["page"].clone()))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:read"))
        .and(body_partial_json(serde_json::json!({
            "type": "readResource",
            "resource": fixture["manifest"]["resource"].clone()
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture["manifest"].clone()))
        .mount(&server)
        .await;

    let raw_endpoint = format!("{}/provider/v3/", server.uri());
    let connector = AgentPlatformProviderConnector::development_loopback(&raw_endpoint)
        .await
        .expect("Provider connector");
    assert_eq!(
        format!("{connector:?}"),
        "AgentPlatformProviderConnector([REDACTED])"
    );
    let provider = connector
        .connect(RecordingAuthorizer::default())
        .await
        .expect("connected catalog");
    let query = ResourceListQuery::new(
        provider.descriptor().provider().clone(),
        PageLimit::new(20).expect("page limit"),
    );
    let page = provider.list_resources(query).await.expect("resource page");
    assert_eq!(
        page.resources().len(),
        fixture["page"]["data"]
            .as_array()
            .expect("fixture page data")
            .len()
    );
    let resource = page.resources()[0].clone();
    let manifest = provider
        .read_manifest(resource.clone())
        .await
        .expect("manifest");

    assert_eq!(manifest.resource, resource);
    assert_eq!(
        page.next_cursor().expect("cursor").as_str(),
        "agent-version-row:71"
    );
    assert_eq!(
        provider
            .authorizer
            .requests
            .lock()
            .expect("requests lock")
            .as_slice(),
        &[
            ProviderAuthorizationRequest::Discovery(
                DiscoveryAuthorizationOperation::ReadDescriptor
            ),
            ProviderAuthorizationRequest::Discovery(DiscoveryAuthorizationOperation::ListResources),
            ProviderAuthorizationRequest::Discovery(DiscoveryAuthorizationOperation::ReadResource),
        ]
    );
    let requests = server.received_requests().await.expect("received requests");
    assert_eq!(requests.len(), 3);
    for request in requests {
        assert_eq!(
            request.headers["authorization"]
                .to_str()
                .expect("authorization"),
            "Bearer service-test-token"
        );
        assert_eq!(
            request.headers["x-crewon-delegation"]
                .to_str()
                .expect("delegation"),
            "delegation-test-token"
        );
        let body = String::from_utf8(request.body).expect("UTF-8 JSON body");
        assert!(!body.contains("service-test-token"));
        assert!(!body.contains("delegation-test-token"));
        assert!(!body.contains("workspaceRoot"));
        assert!(!body.contains("credential"));
    }
}

#[tokio::test]
async fn catalog_discovers_and_reads_exact_dynamic_resource_manifests() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");
    let resource = fixture["manifests"][0]["resource"].clone();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture["descriptor"].clone()))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/resources:list"))
        .and(body_partial_json(serde_json::json!({
            "type": "listResources",
            "resourceType": "mcpTool",
            "afterCursor": null,
            "limit": 20
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{
                "resource": resource,
                "manifestSchemaVersion": "1.0.0",
                "contentDigest": fixture["manifests"][0]["contentDigest"]
            }],
            "nextCursor": null
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/dynamicResources:read"))
        .and(body_partial_json(serde_json::json!({
            "type": "readDynamicResource",
            "resource": fixture["manifests"][0]["resource"]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(fixture["manifests"][0].clone()))
        .mount(&server)
        .await;

    let connector = AgentPlatformProviderConnector::development_loopback(&format!(
        "{}/provider/v3/",
        server.uri()
    ))
    .await
    .expect("Provider connector");
    let provider = connector
        .connect(RecordingAuthorizer::default())
        .await
        .expect("connected catalog");
    let page = provider
        .list_resources(
            ResourceListQuery::new(
                provider.descriptor().provider().clone(),
                PageLimit::new(20).expect("page limit"),
            )
            .for_kind(crewon_resource_federation::ResourceKind::McpTool),
        )
        .await
        .expect("tool page");
    let manifest = provider
        .read_dynamic_manifest(page.resources()[0].clone())
        .await
        .expect("dynamic manifest");

    assert_eq!(manifest.operation(), crate::ProviderDynamicOperation::Call);
    assert_eq!(
        manifest.side_effect(),
        crate::ProviderDynamicSideEffect::ExternalWrite
    );
    assert_eq!(
        provider
            .authorizer
            .requests
            .lock()
            .expect("requests lock")
            .as_slice(),
        &[
            ProviderAuthorizationRequest::Discovery(
                DiscoveryAuthorizationOperation::ReadDescriptor
            ),
            ProviderAuthorizationRequest::Discovery(DiscoveryAuthorizationOperation::ListResources),
            ProviderAuthorizationRequest::Discovery(
                DiscoveryAuthorizationOperation::ReadDynamicResource
            ),
        ]
    );
}

#[tokio::test]
async fn catalog_fails_closed_for_unknown_descriptor_capability() {
    let fixture: Value = serde_json::from_str(DISCOVERY_FIXTURE).expect("fixture");
    let mut descriptor = fixture["descriptor"].clone();
    descriptor["capabilities"]
        .as_array_mut()
        .expect("capabilities")
        .push(Value::String("oneShotFallback".to_string()));
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(descriptor))
        .mount(&server)
        .await;

    let policy = ProviderEndpointPolicy::development_loopback();
    let raw_endpoint = format!("{}/provider/v3/", server.uri());
    let host = server.address().ip();
    let endpoint = policy
        .validate(&raw_endpoint, &FixedResolver(host))
        .await
        .expect("endpoint");
    let result =
        AgentPlatformProviderClient::connect(policy, endpoint, RecordingAuthorizer::default())
            .await;

    assert!(matches!(
        result,
        Err(AgentPlatformProviderError::InvalidResponse)
    ));
}

#[tokio::test]
async fn catalog_surfaces_bounded_rate_limit_without_retrying() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/descriptor:read"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "30")
                .set_body_json(serde_json::json!({
                    "code": "providerUnavailable",
                    "retryable": true,
                    "providerRunId": null,
                    "traceId": "trace-rate-limit"
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let policy = ProviderEndpointPolicy::development_loopback();
    let raw_endpoint = format!("{}/provider/v3/", server.uri());
    let endpoint = policy
        .validate(&raw_endpoint, &FixedResolver(server.address().ip()))
        .await
        .expect("endpoint");
    let result =
        AgentPlatformProviderClient::connect(policy, endpoint, RecordingAuthorizer::default())
            .await;

    assert!(matches!(
        result,
        Err(AgentPlatformProviderError::RateLimited {
            retry_after_seconds: Some(30)
        })
    ));
    assert_eq!(
        server
            .received_requests()
            .await
            .expect("received requests")
            .len(),
        1
    );
}
