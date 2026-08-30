use std::net::IpAddr;

use crewon_provider_transport::EndpointResolver;
use crewon_provider_transport::ProviderEndpointPolicy;
use crewon_provider_transport::ProviderEndpointPolicyError;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;
use crate::DelegationToken;
use crate::ProviderAuthorizationHeaders;
use crate::ServiceBearerToken;
use crate::run_wire::StartResponseWire;

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

async fn client(server: &MockServer) -> AgentPlatformHttpClient {
    let policy = ProviderEndpointPolicy::development_loopback();
    let endpoint = policy
        .validate(
            &format!("{}/provider/v3/", server.uri()),
            &FixedResolver(server.address().ip()),
        )
        .await
        .expect("endpoint");
    AgentPlatformHttpClient::new(policy.pinned_client(endpoint).expect("pinned client"))
}

fn authorization() -> ProviderAuthorizationHeaders {
    ProviderAuthorizationHeaders::new(
        ServiceBearerToken::new("service-boundary-token").expect("service token"),
        DelegationToken::new("delegation-boundary-token").expect("delegation token"),
    )
    .expect("authorization")
}

#[tokio::test]
async fn json_boundary_rejects_malformed_success_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:start"))
        .respond_with(ResponseTemplate::new(200).set_body_raw("{", "application/json"))
        .mount(&server)
        .await;

    let result = client(&server)
        .await
        .post_json::<_, StartResponseWire>(
            "./runs:start",
            authorization(),
            &serde_json::json!({"type": "start"}),
        )
        .await;

    assert_eq!(result, Err(AgentPlatformProviderError::InvalidResponse));
}

#[tokio::test]
async fn json_boundary_rejects_duplicate_top_level_response_fields() {
    let server = MockServer::start().await;
    let body = r#"{
        "providerRunId":"provider-run-one",
        "providerRunId":"provider-run-two",
        "attemptId":"attempt-one",
        "created":true
    }"#;
    Mock::given(method("POST"))
        .and(path("/provider/v3/runs:start"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/json"))
        .mount(&server)
        .await;

    let result = client(&server)
        .await
        .post_json::<_, StartResponseWire>(
            "./runs:start",
            authorization(),
            &serde_json::json!({"type": "start"}),
        )
        .await;

    assert_eq!(result, Err(AgentPlatformProviderError::InvalidResponse));
}
