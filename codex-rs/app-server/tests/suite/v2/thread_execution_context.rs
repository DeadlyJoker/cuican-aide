use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadExecutionContextCreateParams;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn thread_execution_context_rejects_ephemeral_and_unverified_first_claims() -> Result<()> {
    let codex_home = tempfile::TempDir::new()?;
    let mut app = TestAppServer::new(codex_home.path()).await?;
    app.initialize().await?;
    let request_id = app
        .send_workspace_list_request(WorkspaceListParams {
            cursor: None,
            limit: Some(20),
        })
        .await?;
    let response: JSONRPCResponse = app
        .read_stream_until_response_message(RequestId::Integer(request_id))
        .await?;
    let workspaces: WorkspaceListResponse = to_response(response)?;
    let workspace_key = workspaces
        .data
        .first()
        .expect("server workspace")
        .workspace_key
        .clone();

    let ephemeral_id = app
        .send_thread_start_request(ThreadStartParams {
            execution_context: Some(ThreadExecutionContextCreateParams {
                workspace_key: workspace_key.clone(),
            }),
            ephemeral: Some(true),
            ..Default::default()
        })
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(ephemeral_id))
        .await?;
    assert_eq!(
        error.message,
        "Thread execution context requires a persistent thread"
    );

    let unverified_id = app
        .send_thread_start_request(ThreadStartParams {
            execution_context: Some(ThreadExecutionContextCreateParams { workspace_key }),
            ..Default::default()
        })
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(unverified_id))
        .await?;
    assert_eq!(
        error.message,
        "Thread execution context request is not authorized"
    );
    Ok(())
}
