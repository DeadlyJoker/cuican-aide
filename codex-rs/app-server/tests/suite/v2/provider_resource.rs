use anyhow::Context;
use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::ClientInfo;
use crewon_app_server_protocol::InitializeCapabilities;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindingMode;
use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceReadParams;
use crewon_app_server_protocol::ResourceRef;
use crewon_app_server_protocol::ResourceType;
use crewon_app_server_protocol::ResourceUnbindParams;
use crewon_app_server_protocol::WorkspaceBindParams;
use crewon_app_server_protocol::WorkspaceBindResponse;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_app_server_protocol::experimental_required_message;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

const PROVIDER_ENABLED_ENV: &str = "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED";
const CONNECTION_ID: &str = "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101";

#[tokio::test]
async fn resource_rpc_is_registered_and_fails_closed_without_runtime() -> Result<()> {
    let home = TempDir::new()?;
    let mut app =
        TestAppServer::new_with_env(home.path(), &[(PROVIDER_ENABLED_ENV, Some("false"))]).await?;
    app.initialize().await?;

    let workspace = bind_workspace(&mut app).await?;

    let list_id = app
        .send_resource_list_request(ResourceListParams {
            connection_id: CONNECTION_ID.to_string(),
            cursor: None,
            limit: None,
            resource_type: Some(ResourceType::Agent),
        })
        .await?;
    let read_id = app
        .send_resource_read_request(ResourceReadParams {
            connection_id: CONNECTION_ID.to_string(),
            resource: resource_ref(),
        })
        .await?;
    let bind_id = app
        .send_resource_bind_request(ResourceBindParams {
            connection_id: CONNECTION_ID.to_string(),
            workspace_binding_id: workspace.workspace.binding_id,
            resource: resource_ref(),
            mode: ResourceBindingMode::ProviderManaged,
        })
        .await?;

    for request_id in [list_id, read_id, bind_id] {
        let JSONRPCError { error, .. } = app
            .read_stream_until_error_message(RequestId::Integer(request_id))
            .await?;
        assert_eq!(error.code, -32603);
        assert_eq!(error.message, "Provider resource runtime is unavailable");
    }
    let unbind_id = app
        .send_resource_unbind_request(ResourceUnbindParams {
            binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301".to_string(),
        })
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(unbind_id))
        .await?;
    assert_eq!(error.code, -32600);
    assert_eq!(error.message, "Provider resource request is not authorized");
    Ok(())
}

#[tokio::test]
async fn resource_rpc_rejects_client_authority_fields_before_dispatch() -> Result<()> {
    let home = TempDir::new()?;
    let mut app =
        TestAppServer::new_with_env(home.path(), &[(PROVIDER_ENABLED_ENV, Some("false"))]).await?;
    app.initialize().await?;

    let request_id = app
        .send_raw_request(
            "resource/list",
            Some(json!({
                "connectionId": CONNECTION_ID,
                "credentialId": "forged-grant",
                "endpoint": "https://attacker.invalid",
                "workspaceRoot": "/private/forged"
            })),
        )
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(request_id))
        .await?;
    assert_eq!(error.code, -32600);
    assert!(error.message.contains("unknown field"));
    assert!(!error.message.contains("forged-grant"));
    assert!(!error.message.contains("attacker.invalid"));
    assert!(!error.message.contains("/private/forged"));

    let request_id = app
        .send_raw_request(
            "resource/bind",
            Some(json!({
                "connectionId": CONNECTION_ID,
                "workspaceBindingId": "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201",
                "resource": resource_ref(),
                "mode": "providerManaged",
                "endpoint": "https://attacker.invalid"
            })),
        )
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(request_id))
        .await?;
    assert_eq!(error.code, -32600);
    assert!(error.message.contains("unknown field"));
    assert!(!error.message.contains("attacker.invalid"));
    Ok(())
}

#[tokio::test]
async fn resource_rpc_requires_experimental_api_capability() -> Result<()> {
    let home = TempDir::new()?;
    let mut app =
        TestAppServer::new_with_env(home.path(), &[(PROVIDER_ENABLED_ENV, Some("false"))]).await?;
    app.initialize_with_capabilities(
        ClientInfo {
            name: "resource-stable-client".to_string(),
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
        .send_resource_list_request(ResourceListParams {
            connection_id: CONNECTION_ID.to_string(),
            cursor: None,
            limit: None,
            resource_type: None,
        })
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(request_id))
        .await?;
    assert_eq!(error.code, -32600);
    assert_eq!(
        error.message,
        experimental_required_message("resource/list")
    );

    for (request_id, method) in [
        (
            app.send_resource_bind_request(ResourceBindParams {
                connection_id: CONNECTION_ID.to_string(),
                workspace_binding_id: "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
                resource: resource_ref(),
                mode: ResourceBindingMode::ProviderManaged,
            })
            .await?,
            "resource/bind",
        ),
        (
            app.send_resource_unbind_request(ResourceUnbindParams {
                binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301".to_string(),
            })
            .await?,
            "resource/unbind",
        ),
    ] {
        let JSONRPCError { error, .. } = app
            .read_stream_until_error_message(RequestId::Integer(request_id))
            .await?;
        assert_eq!(error.code, -32600);
        assert_eq!(error.message, experimental_required_message(method));
    }
    Ok(())
}

async fn bind_workspace(app: &mut TestAppServer) -> Result<WorkspaceBindResponse> {
    let list_id = app
        .send_workspace_list_request(WorkspaceListParams {
            cursor: None,
            limit: Some(20),
        })
        .await?;
    let listed: WorkspaceListResponse = to_response(
        app.read_stream_until_response_message(RequestId::Integer(list_id))
            .await?,
    )?;
    let workspace = listed.data.first().context("server workspace")?;
    let bind_id = app
        .send_workspace_bind_request(Some(serde_json::to_value(WorkspaceBindParams {
            workspace_key: workspace.workspace_key.clone(),
            scope: WorkspaceScope::Office,
            scope_id: "office-provider-resource".to_string(),
        })?))
        .await?;
    let response: JSONRPCResponse = app
        .read_stream_until_response_message(RequestId::Integer(bind_id))
        .await?;
    to_response(response)
}

fn resource_ref() -> ResourceRef {
    ResourceRef {
        provider_id: "agent-platform".to_string(),
        resource_id: "agent-demo".to_string(),
        revision: "agent-version:7".to_string(),
        resource_type: ResourceType::Agent,
    }
}
