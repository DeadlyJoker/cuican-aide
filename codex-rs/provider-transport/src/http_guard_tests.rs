//! Pinned HTTP guard behavior matrix preserved from the app-server implementation.

use std::net::IpAddr;
use std::net::SocketAddr;
use std::time::Duration;

use pretty_assertions::assert_eq;
use reqwest::Method;
use reqwest::Url;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::*;
use crate::endpoint_policy::EndpointResolver;
use crate::endpoint_policy::ProviderEndpointEnvironment;
use crate::endpoint_policy::ProviderEndpointLimits;
use crate::endpoint_policy::ProviderEndpointPolicy;
use crate::endpoint_policy::ProviderEndpointPolicyError;
use crate::endpoint_policy::ValidatedProviderEndpoint;

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

fn test_policy(max_response_bytes: usize, request_timeout: Duration) -> ProviderEndpointPolicy {
    ProviderEndpointPolicy {
        environment: ProviderEndpointEnvironment::DevelopmentLoopback,
        limits: ProviderEndpointLimits {
            max_redirects: 2,
            max_response_bytes,
            connect_timeout: Duration::from_millis(100),
            request_timeout,
        },
    }
}

#[tokio::test]
async fn pinned_client_enforces_response_cap_and_timeout_with_http_mock() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/large"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'x'; 65]))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/slow"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("ok")
                .set_delay(Duration::from_millis(150)),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&server.uri()).expect("mock URL");
    let address = url.host_str().expect("mock host").parse().expect("mock IP");
    let resolver = FixedResolver(address);
    let policy = test_policy(/*max_response_bytes*/ 64, Duration::from_millis(50));

    let large_endpoint = policy
        .validate(&format!("{}/large", server.uri()), &resolver)
        .await
        .expect("large endpoint");
    let large_client = policy.pinned_client(large_endpoint).expect("pinned client");
    let large_response = large_client
        .request(Method::GET, "")
        .expect("request")
        .send()
        .await
        .expect("response headers");
    assert_eq!(
        large_client.read_bounded_body(large_response).await,
        Err(ProviderEndpointPolicyError::ResponseTooLarge)
    );

    let slow_endpoint = policy
        .validate(&format!("{}/slow", server.uri()), &resolver)
        .await
        .expect("slow endpoint");
    let slow_client = policy.pinned_client(slow_endpoint).expect("pinned client");
    let error = slow_client
        .request(Method::GET, "")
        .expect("request")
        .send()
        .await
        .expect_err("request must time out");
    assert!(error.is_timeout());
    assert_eq!(
        classify_request_error(error),
        ProviderEndpointPolicyError::RequestTimeout
    );
}

#[test]
fn pinned_client_rejects_cross_origin_paths_and_query_injection() {
    let policy = test_policy(/*max_response_bytes*/ 64, Duration::from_secs(1));
    let endpoint = ValidatedProviderEndpoint {
        url: Url::parse("http://127.0.0.1:8080/api/").expect("valid URL"),
        socket_addrs: vec![SocketAddr::new(
            "127.0.0.1".parse().expect("loopback IP"),
            8080,
        )],
    };
    let client = policy.pinned_client(endpoint).expect("pinned client");

    assert!(client.request(Method::GET, "tasks").is_ok());
    assert!(matches!(
        client.request(Method::GET, "https://other.example/tasks"),
        Err(ProviderEndpointPolicyError::CrossOriginRequest)
    ));
    assert!(matches!(
        client.request(Method::GET, "tasks?token=value"),
        Err(ProviderEndpointPolicyError::QueryNotAllowed)
    ));
}
