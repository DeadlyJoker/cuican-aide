use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::ModelProviderProbeParams;
use crewon_app_server_protocol::ModelProviderProbeResponse;
use crewon_app_server_protocol::ModelProviderProbeStatus;
use crewon_app_server_protocol::RequestId;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::time::timeout;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

async fn probe(
    codex_home: &TempDir,
    params: ModelProviderProbeParams,
) -> Result<ModelProviderProbeResponse> {
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp.send_model_provider_probe_request(params).await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

fn write_provider_config(codex_home: &TempDir, base_url: &str) -> Result<()> {
    std::fs::write(
        codex_home.path().join("config.toml"),
        format!(
            r#"model_provider = "probe-target"

[model_providers.probe-target]
name = "Probe Target"
base_url = "{base_url}"
wire_api = "responses"
experimental_bearer_token = "configured-secret"
"#
        ),
    )?;
    Ok(())
}

/// The selected provider is probed when no id is supplied, and the configured
/// credential is the one actually sent.
#[tokio::test]
async fn probes_the_selected_provider_with_its_configured_credential() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("authorization", "Bearer configured-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "models": [] })))
        .mount(&server)
        .await;

    let codex_home = TempDir::new()?;
    write_provider_config(&codex_home, &format!("{}/v1", server.uri()))?;

    let received = probe(&codex_home, ModelProviderProbeParams { provider_id: None }).await?;

    assert_eq!(received.provider_id, "probe-target");
    assert_eq!(received.status, ModelProviderProbeStatus::Ok);
    assert_eq!(received.http_status, Some(200));
    assert_eq!(received.model_count, Some(0));
    assert_eq!(received.authenticated, true);
    assert_eq!(received.message, None);
    assert_eq!(received.endpoint, format!("{}/v1/models", server.uri()));
    Ok(())
}

/// A rejected credential must be reported as such rather than as a generic
/// failure, so a user can tell it apart from a wrong address.
#[tokio::test]
async fn reports_a_rejected_credential_as_unauthorized() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(401).set_body_string("invalid api key"))
        .mount(&server)
        .await;

    let codex_home = TempDir::new()?;
    write_provider_config(&codex_home, &format!("{}/v1", server.uri()))?;

    let received = probe(
        &codex_home,
        ModelProviderProbeParams {
            provider_id: Some("probe-target".to_string()),
        },
    )
    .await?;

    assert_eq!(received.status, ModelProviderProbeStatus::Unauthorized);
    assert_eq!(received.http_status, Some(401));
    assert_eq!(received.message, Some("invalid api key".to_string()));
    Ok(())
}

/// Third-party gateways answer `/models` in OpenAI's shape, with a `data`
/// array. Rejecting that body would report every such provider as broken, which
/// is the exact case a custom provider entry exists to configure.
#[tokio::test]
async fn accepts_an_openai_compatible_catalog() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "object": "list",
            "data": [
                { "id": "qwen-max", "object": "model" },
                { "id": "glm-4.6", "object": "model" },
            ],
        })))
        .mount(&server)
        .await;

    let codex_home = TempDir::new()?;
    write_provider_config(&codex_home, &format!("{}/v1", server.uri()))?;

    let received = probe(&codex_home, ModelProviderProbeParams { provider_id: None }).await?;

    assert_eq!(received.status, ModelProviderProbeStatus::Ok);
    assert_eq!(received.model_count, Some(2));
    assert_eq!(received.message, None);
    Ok(())
}

/// A provider that answers with something other than a model catalog is a
/// misconfigured endpoint, not an auth problem.
#[tokio::test]
async fn reports_a_non_catalog_body_as_invalid_response() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html>sign in</html>"))
        .mount(&server)
        .await;

    let codex_home = TempDir::new()?;
    write_provider_config(&codex_home, &format!("{}/v1", server.uri()))?;

    let received = probe(&codex_home, ModelProviderProbeParams { provider_id: None }).await?;

    assert_eq!(received.status, ModelProviderProbeStatus::InvalidResponse);
    assert_eq!(received.http_status, Some(200));
    assert_eq!(received.model_count, None);
    Ok(())
}

#[tokio::test]
async fn rejects_an_unknown_provider_id() -> Result<()> {
    let codex_home = TempDir::new()?;
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_model_provider_probe_request(ModelProviderProbeParams {
            provider_id: Some("not-configured".to_string()),
        })
        .await?;
    let error = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;

    assert!(
        error.error.message.contains("not-configured"),
        "{}",
        error.error.message
    );
    Ok(())
}
