use crewon_client::TransportError;
use crewon_model_provider_info::ModelProviderInfo;
use crewon_model_provider_info::WireApi;
use http::StatusCode;
use pretty_assertions::assert_eq;
use serde_json::json;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::ProbeStatus;
use super::classify_transport_error;
use super::probe_model_provider;

fn provider_with_base_url(base_url: String) -> ModelProviderInfo {
    ModelProviderInfo {
        name: "Probe Target".to_string(),
        base_url: Some(base_url),
        wire_api: WireApi::Responses,
        ..ModelProviderInfo::default()
    }
}

#[tokio::test]
async fn reports_ok_and_model_count_when_provider_serves_a_catalog() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "models": [minimal_model("provider-model-a"), minimal_model("provider-model-b")],
        })))
        .mount(&server)
        .await;

    let provider = provider_with_base_url(format!("{}/v1", server.uri()));
    let outcome = probe_model_provider(&provider, /*auth*/ None).await;

    assert_eq!(outcome.status, ProbeStatus::Ok);
    assert_eq!(outcome.http_status, Some(200));
    assert_eq!(outcome.model_count, Some(2));
    assert_eq!(outcome.endpoint, format!("{}/v1/models", server.uri()));
    assert_eq!(outcome.message, None);
}

/*
 * Third-party gateways answer `/models` in OpenAI's shape, with a `data` array
 * whose entries carry none of the fields Crewon's own catalog defines. Rejecting
 * that body would report every such provider as broken, which is exactly the
 * case this page exists to configure.
 */
#[tokio::test]
async fn accepts_an_openai_compatible_catalog() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "object": "list",
            "data": [
                { "id": "gpt-4o", "object": "model", "owned_by": "gateway" },
                { "id": "qwen-max", "object": "model", "owned_by": "gateway" },
                { "id": "glm-4.6", "object": "model", "owned_by": "gateway" },
            ],
        })))
        .mount(&server)
        .await;

    let provider = provider_with_base_url(format!("{}/v1", server.uri()));
    let outcome = probe_model_provider(&provider, /*auth*/ None).await;

    assert_eq!(outcome.status, ProbeStatus::Ok);
    assert_eq!(outcome.model_count, Some(3));
    assert_eq!(outcome.message, None);
}

#[tokio::test]
async fn attaches_the_configured_bearer_token_and_reports_it_as_authenticated() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("authorization", "Bearer configured-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "models": [] })))
        .mount(&server)
        .await;

    let mut provider = provider_with_base_url(format!("{}/v1", server.uri()));
    provider.experimental_bearer_token = Some("configured-secret".to_string());
    let outcome = probe_model_provider(&provider, /*auth*/ None).await;

    assert_eq!(outcome.status, ProbeStatus::Ok);
    assert!(outcome.authenticated);
}

#[tokio::test]
async fn separates_a_rejected_credential_from_a_wrong_address() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(401).set_body_string("{\"error\":\"invalid api key\"}"))
        .mount(&server)
        .await;

    let provider = provider_with_base_url(format!("{}/v1", server.uri()));
    let outcome = probe_model_provider(&provider, /*auth*/ None).await;

    assert_eq!(outcome.status, ProbeStatus::Unauthorized);
    assert_eq!(outcome.http_status, Some(401));
    assert_eq!(
        outcome.message,
        Some("{\"error\":\"invalid api key\"}".to_string())
    );
}

#[tokio::test]
async fn reports_http_error_for_a_non_auth_failure_status() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(404).set_body_string("no such route"))
        .mount(&server)
        .await;

    let provider = provider_with_base_url(format!("{}/v1", server.uri()));
    let outcome = probe_model_provider(&provider, /*auth*/ None).await;

    assert_eq!(outcome.status, ProbeStatus::HttpError);
    assert_eq!(outcome.http_status, Some(404));
}

#[tokio::test]
async fn reports_invalid_response_when_the_body_is_not_a_model_catalog() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>login</html>"))
        .mount(&server)
        .await;

    let provider = provider_with_base_url(format!("{}/v1", server.uri()));
    let outcome = probe_model_provider(&provider, /*auth*/ None).await;

    assert_eq!(outcome.status, ProbeStatus::InvalidResponse);
    assert_eq!(outcome.http_status, Some(200));
    assert!(outcome.model_count.is_none());
}

/*
 * A provider that cannot be reached must be reported as such, because that is
 * exactly the case `model/list` hides behind its bundled-catalog fallback.
 *
 * Classification is asserted directly rather than by dialling a dead port: a
 * developer machine with a system HTTP proxy has the proxy answer the refused
 * connection with an error status, which would make this assert on the local
 * network configuration instead of on the mapping.
 */
#[test]
fn classifies_network_and_timeout_failures_as_unreachable() {
    let network =
        classify_transport_error(&TransportError::Network("connection refused".to_string()));
    assert_eq!(network.status, ProbeStatus::Unreachable);
    assert_eq!(network.http_status, None);

    let timed_out = classify_transport_error(&TransportError::Timeout);
    assert_eq!(timed_out.status, ProbeStatus::Unreachable);
    assert_eq!(timed_out.http_status, None);
}

#[test]
fn classifies_auth_statuses_apart_from_other_http_failures() {
    let forbidden = classify_transport_error(&TransportError::Http {
        status: StatusCode::FORBIDDEN,
        url: None,
        headers: None,
        body: Some("forbidden".to_string()),
    });
    assert_eq!(forbidden.status, ProbeStatus::Unauthorized);
    assert_eq!(forbidden.http_status, Some(403));

    let server_error = classify_transport_error(&TransportError::Http {
        status: StatusCode::BAD_GATEWAY,
        url: None,
        headers: None,
        body: None,
    });
    assert_eq!(server_error.status, ProbeStatus::HttpError);
    assert_eq!(server_error.http_status, Some(502));
    assert_eq!(
        server_error.message,
        "provider returned an error with no body".to_string()
    );
}

#[tokio::test]
async fn reports_unauthorized_when_an_env_key_is_not_set() {
    let provider = ModelProviderInfo {
        name: "Env Key Provider".to_string(),
        base_url: Some("https://provider.invalid/v1".to_string()),
        env_key: Some("CREWON_PROBE_TEST_KEY_DEFINITELY_UNSET".to_string()),
        wire_api: WireApi::Responses,
        ..ModelProviderInfo::default()
    };
    let outcome = probe_model_provider(&provider, /*auth*/ None).await;

    assert_eq!(outcome.status, ProbeStatus::Unauthorized);
    assert!(!outcome.authenticated);
    assert_eq!(
        outcome.endpoint,
        "https://provider.invalid/v1/models".to_string()
    );
}

/// A catalog entry as Crewon's own `/models` serves it.
///
/// Only the envelope matters to the probe, so entries stay minimal rather than
/// mirroring every `ModelInfo` field.
fn minimal_model(slug: &str) -> serde_json::Value {
    json!({ "slug": slug, "display_name": slug })
}
