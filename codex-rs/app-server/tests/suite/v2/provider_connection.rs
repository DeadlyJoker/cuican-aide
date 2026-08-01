use anyhow::Result;
use app_test_support::TestAppServer;
use crewon_app_server_protocol::ClientInfo;
use crewon_app_server_protocol::InitializeCapabilities;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::ProviderConnectParams;
use crewon_app_server_protocol::ProviderReadParams;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::experimental_required_message;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

const PROVIDER_ENABLED_ENV: &str = "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED";

#[tokio::test]
async fn provider_rpc_is_registered_and_fails_closed_without_runtime() -> Result<()> {
    let home = TempDir::new()?;
    let mut app =
        TestAppServer::new_with_env(home.path(), &[(PROVIDER_ENABLED_ENV, Some("false"))]).await?;
    app.initialize().await?;

    let connect_id = app
        .send_provider_connect_request(ProviderConnectParams {
            provider_id: "agent-platform".to_string(),
        })
        .await?;
    let read_id = app
        .send_provider_read_request(ProviderReadParams {
            connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        })
        .await?;

    for request_id in [connect_id, read_id] {
        let JSONRPCError { error, .. } = app
            .read_stream_until_error_message(RequestId::Integer(request_id))
            .await?;
        assert_eq!(error.code, -32603);
        assert_eq!(error.message, "Provider connection runtime is unavailable");
    }
    Ok(())
}

#[tokio::test]
async fn provider_rpc_rejects_client_authority_fields_before_dispatch() -> Result<()> {
    let home = TempDir::new()?;
    let mut app =
        TestAppServer::new_with_env(home.path(), &[(PROVIDER_ENABLED_ENV, Some("false"))]).await?;
    app.initialize().await?;

    let forged_id = app
        .send_raw_request(
            "provider/connect",
            Some(json!({
                "providerId": "agent-platform",
                "credentialId": "forged-grant",
                "owner": "forged-owner",
                "endpoint": "https://attacker.invalid"
            })),
        )
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(forged_id))
        .await?;
    assert_eq!(error.code, -32600);
    assert!(error.message.contains("unknown field"));
    assert!(!error.message.contains("forged-grant"));
    assert!(!error.message.contains("forged-owner"));
    assert!(!error.message.contains("attacker.invalid"));

    let valid_id = app
        .send_provider_connect_request(ProviderConnectParams {
            provider_id: "agent-platform".to_string(),
        })
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(valid_id))
        .await?;
    assert_eq!(error.code, -32603);
    Ok(())
}

#[tokio::test]
async fn provider_rpc_requires_experimental_api_capability() -> Result<()> {
    let home = TempDir::new()?;
    let mut app =
        TestAppServer::new_with_env(home.path(), &[(PROVIDER_ENABLED_ENV, Some("false"))]).await?;
    app.initialize_with_capabilities(
        ClientInfo {
            name: "provider-stable-client".to_string(),
            title: None,
            version: "1.0.0".to_string(),
        },
        Some(InitializeCapabilities {
            experimental_api: false,
            ..Default::default()
        }),
    )
    .await?;

    let request_id = app
        .send_provider_connect_request(ProviderConnectParams {
            provider_id: "agent-platform".to_string(),
        })
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(request_id))
        .await?;
    assert_eq!(error.code, -32600);
    assert_eq!(
        error.message,
        experimental_required_message("provider/connect")
    );
    Ok(())
}
