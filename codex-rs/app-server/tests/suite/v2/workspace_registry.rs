use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::WorkspaceAccessMode;
use crewon_app_server_protocol::WorkspaceBindParams;
use crewon_app_server_protocol::WorkspaceBindResponse;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use crewon_app_server_protocol::WorkspaceScope;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

async fn list_workspaces(app: &mut TestAppServer) -> Result<WorkspaceListResponse> {
    let request_id = app
        .send_workspace_list_request(WorkspaceListParams {
            cursor: None,
            limit: Some(20),
        })
        .await?;
    let response: JSONRPCResponse = app
        .read_stream_until_response_message(RequestId::Integer(request_id))
        .await?;
    to_response(response)
}

async fn bind_workspace(
    app: &mut TestAppServer,
    params: WorkspaceBindParams,
) -> Result<WorkspaceBindResponse> {
    let request_id = app
        .send_workspace_bind_request(Some(serde_json::to_value(params)?))
        .await?;
    let response: JSONRPCResponse = app
        .read_stream_until_response_message(RequestId::Integer(request_id))
        .await?;
    to_response(response)
}

#[tokio::test]
async fn workspace_registry_separates_single_and_office_bindings_without_exposing_paths()
-> Result<()> {
    let home = TempDir::new()?;
    let mut app = TestAppServer::new(home.path()).await?;
    app.initialize().await?;

    let listed = list_workspaces(&mut app).await?;
    assert_eq!(
        listed.access_mode,
        WorkspaceAccessMode::LocalProcessServerRoots
    );
    assert_eq!(listed.next_cursor, None);
    let workspace = listed.data.first().expect("server cwd workspace");
    assert!(!workspace.workspace_key.is_empty());
    assert!(!workspace.display_name.is_empty());
    assert!(!workspace.node_id.is_empty());
    assert_eq!(workspace.environment_id, "local");

    let single = bind_workspace(
        &mut app,
        WorkspaceBindParams {
            workspace_key: workspace.workspace_key.clone(),
            scope: WorkspaceScope::Conversation,
            scope_id: "single-thread".to_string(),
        },
    )
    .await?;
    let repeated_single = bind_workspace(
        &mut app,
        WorkspaceBindParams {
            workspace_key: workspace.workspace_key.clone(),
            scope: WorkspaceScope::Conversation,
            scope_id: "single-thread".to_string(),
        },
    )
    .await?;
    let office = bind_workspace(
        &mut app,
        WorkspaceBindParams {
            workspace_key: workspace.workspace_key.clone(),
            scope: WorkspaceScope::Office,
            scope_id: "office-record".to_string(),
        },
    )
    .await?;

    assert_eq!(repeated_single, single);
    assert_eq!(
        single.workspace.workspace_key,
        office.workspace.workspace_key
    );
    assert_ne!(single.workspace.binding_id, office.workspace.binding_id);
    assert_eq!(single.workspace.scope, WorkspaceScope::Conversation);
    assert_eq!(office.workspace.scope, WorkspaceScope::Office);
    assert_eq!(single.workspace.node_id, office.workspace.node_id);
    assert_eq!(
        single.workspace.environment_id,
        office.workspace.environment_id
    );

    Ok(())
}

#[tokio::test]
async fn workspace_registry_rejects_client_paths_and_does_not_restore_session_keys() -> Result<()> {
    let home = TempDir::new()?;
    let mut first = TestAppServer::new(home.path()).await?;
    first.initialize().await?;
    let listed = list_workspaces(&mut first).await?;
    let workspace_key = listed
        .data
        .first()
        .expect("server cwd workspace")
        .workspace_key
        .clone();

    for forged_params in [
        json!({
            "workspaceKey": workspace_key.clone(),
            "scope": "conversation",
            "scopeId": "single-thread",
            "rootPath": home.path(),
        }),
        json!({
            "workspaceKey": workspace_key.clone(),
            "scope": "conversation",
            "scopeId": "single-thread",
            "relativePath": "../escape",
        }),
    ] {
        let request_id = first
            .send_workspace_bind_request(Some(forged_params))
            .await?;
        let JSONRPCError { error, .. } = first
            .read_stream_until_error_message(RequestId::Integer(request_id))
            .await?;
        assert_eq!(error.code, -32600);
        assert!(error.message.contains("unknown field"));
        assert_eq!(error.data, None);
    }

    drop(first);
    let mut restarted = TestAppServer::new(home.path()).await?;
    restarted.initialize().await?;
    let request_id = restarted
        .send_workspace_bind_request(Some(json!({
            "workspaceKey": workspace_key,
            "scope": "conversation",
            "scopeId": "single-thread",
        })))
        .await?;
    let JSONRPCError { error, .. } = restarted
        .read_stream_until_error_message(RequestId::Integer(request_id))
        .await?;
    assert_eq!(error.code, -32602);
    assert_eq!(
        error.message,
        "workspaceKey is not registered for this session"
    );
    assert_eq!(error.data, None);

    Ok(())
}
