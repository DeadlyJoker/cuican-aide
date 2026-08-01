use super::connection_handling_websocket::WsClient;
use super::connection_handling_websocket::connect_websocket_with_bearer;
use super::connection_handling_websocket::create_config_toml;
use super::connection_handling_websocket::read_error_for_id;
use super::connection_handling_websocket::read_response_for_id;
use super::connection_handling_websocket::send_initialize_request;
use super::connection_handling_websocket::send_request;
use super::connection_handling_websocket::signed_bearer_token;
use super::connection_handling_websocket::spawn_websocket_server_with_args;
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::to_response;
use crewon_app_server_protocol::ClientInfo;
use crewon_app_server_protocol::IdentityReadResponse;
use crewon_app_server_protocol::InitializeCapabilities;
use crewon_app_server_protocol::InitializeParams;
use crewon_app_server_protocol::ThreadExecutionContextCreateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateResponse;
use crewon_app_server_protocol::ThreadResumeParams;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use crewon_protocol::ThreadId;
use futures::SinkExt;
use futures::StreamExt;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WebSocketMessage;

#[tokio::test]
async fn authenticated_thread_execution_context_is_owner_scoped_and_state_durable() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    let shared_secret = "0123456789abcdef0123456789abcdef";
    std::fs::write(&shared_secret_file, format!("{shared_secret}\n"))?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let auth_args = signed_bearer_auth_args(&shared_secret_file);
    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let owner_token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": now + 180,
            "iat": now,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": "user:42",
            "tenantId": "tenant-7",
            "spaceId": "space-9",
            "jti": "thread-context-owner",
        }),
    )?;
    let mut owner = connect_websocket_with_bearer(bind_addr, Some(owner_token.as_str())).await?;
    send_experimental_initialize_request(&mut owner, /*id*/ 1).await?;
    read_response_for_id(&mut owner, /*id*/ 1).await?;
    let workspaces = read_workspaces(&mut owner, /*id*/ 2).await?;
    let workspace_key = workspaces
        .data
        .first()
        .expect("server workspace")
        .workspace_key
        .clone();

    send_request(
        &mut owner,
        "thread/start",
        /*id*/ 3,
        Some(serde_json::to_value(ThreadStartParams {
            execution_context: Some(ThreadExecutionContextCreateParams {
                workspace_key: workspace_key.clone(),
            }),
            ..Default::default()
        })?),
    )
    .await?;
    let started: ThreadStartResponse =
        to_response(read_response_for_id(&mut owner, /*id*/ 3).await?)?;
    let thread_id = started.thread.id.clone();
    let created = started.execution_context.expect("Thread execution context");
    assert_eq!(created.thread_id, thread_id);
    assert_eq!(created.workspace.workspace_key, workspace_key);
    assert_eq!(created.workspace.scope_id, thread_id);
    assert_eq!(created.revision, 1);

    send_request(
        &mut owner,
        "threadExecutionContext/update",
        /*id*/ 4,
        Some(serde_json::to_value(ThreadExecutionContextUpdateParams {
            thread_id: thread_id.clone(),
            workspace_binding_id: created.workspace.binding_id.clone(),
            resource_binding_ids: Vec::new(),
            execution_binding_id: None,
            expected_revision: created.revision,
        })?),
    )
    .await?;
    let unchanged: ThreadExecutionContextUpdateResponse =
        to_response(read_response_for_id(&mut owner, /*id*/ 4).await?)?;
    assert_eq!(unchanged.execution_context, created);

    let other_token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": now + 180,
            "iat": now,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": "user:42",
            "tenantId": "tenant-7",
            "spaceId": "space-other",
            "jti": "thread-context-other",
        }),
    )?;
    let mut other = connect_websocket_with_bearer(bind_addr, Some(other_token.as_str())).await?;
    send_experimental_initialize_request(&mut other, /*id*/ 10).await?;
    read_response_for_id(&mut other, /*id*/ 10).await?;
    send_request(
        &mut other,
        "thread/resume",
        /*id*/ 11,
        Some(serde_json::to_value(ThreadResumeParams {
            thread_id: thread_id.clone(),
            ..Default::default()
        })?),
    )
    .await?;
    let cross_owner = read_error_for_id(&mut other, /*id*/ 11).await?;
    assert_eq!(
        cross_owner.error.message,
        "Thread execution context request is not authorized"
    );
    send_request(
        &mut other,
        "thread/inject_items",
        /*id*/ 12,
        Some(json!({
            "threadId": thread_id.clone(),
            "items": [],
        })),
    )
    .await?;
    let cross_owner_inject = read_error_for_id(&mut other, /*id*/ 12).await?;
    assert_eq!(
        cross_owner_inject.error.message,
        "Thread execution context request is not authorized"
    );
    send_request(
        &mut other,
        "turn/steer",
        /*id*/ 13,
        Some(json!({
            "threadId": thread_id.clone(),
            "input": [],
            "expectedTurnId": "turn-other",
        })),
    )
    .await?;
    let cross_owner_steer = read_error_for_id(&mut other, /*id*/ 13).await?;
    assert_eq!(
        cross_owner_steer.error.message,
        "Thread execution context request is not authorized"
    );
    other.close(None).await?;
    owner.close(None).await?;
    process
        .kill()
        .await
        .context("failed to stop thread context app-server process")?;

    let state = crewon_state::StateRuntime::init(
        codex_home.path().to_path_buf(),
        "thread-context-test".to_string(),
    )
    .await?;
    assert!(
        state
            .get_thread_execution_context_record(&thread_id)
            .await?
            .is_some()
    );
    let parsed_thread_id = ThreadId::from_string(&thread_id)?;
    state.delete_threads_strict(&[parsed_thread_id]).await?;
    assert_eq!(
        state
            .get_thread_execution_context_record(&thread_id)
            .await?,
        None
    );
    state.close().await;
    Ok(())
}

#[tokio::test]
async fn websocket_transport_projects_verified_principal_across_reconnects() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    let shared_secret = "0123456789abcdef0123456789abcdef";
    std::fs::write(&shared_secret_file, format!("{shared_secret}\n"))?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let auth_args = signed_bearer_auth_args(&shared_secret_file);
    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": now + 60,
            "iat": now,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": "user:42",
            "tenantId": "tenant-7",
            "spaceId": "space-9",
            "jti": "reconnect-token",
        }),
    )?;

    let mut first = connect_websocket_with_bearer(bind_addr, Some(token.as_str())).await?;
    send_experimental_initialize_request(&mut first, /*id*/ 1).await?;
    read_response_for_id(&mut first, /*id*/ 1).await?;
    let first_identity = read_identity(&mut first, /*id*/ 2).await?;
    let first_workspaces = read_workspaces(&mut first, /*id*/ 3).await?;
    first.close(None).await?;
    drop(first);
    process
        .kill()
        .await
        .context("failed to stop first websocket app-server process")?;

    let restart_bind = format!("ws://{bind_addr}");
    let (mut restarted_process, restarted_bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), &restart_bind, &auth_args).await?;
    let mut second =
        connect_websocket_with_bearer(restarted_bind_addr, Some(token.as_str())).await?;
    send_experimental_initialize_request(&mut second, /*id*/ 4).await?;
    read_response_for_id(&mut second, /*id*/ 4).await?;
    let second_identity = read_identity(&mut second, /*id*/ 5).await?;
    let second_workspaces = read_workspaces(&mut second, /*id*/ 6).await?;

    assert_eq!(
        first_identity.identity.actor_id,
        second_identity.identity.actor_id
    );
    assert_eq!(
        first_identity.identity.tenant_id.as_deref(),
        Some("tenant-7")
    );
    assert_eq!(first_identity.identity.space_id.as_deref(), Some("space-9"));
    assert_ne!(
        first_identity.identity.session_id,
        second_identity.identity.session_id
    );
    assert_ne!(
        first_identity.identity.trace_id,
        second_identity.identity.trace_id
    );
    assert_ne!(first_identity.audit_subject, second_identity.audit_subject);
    assert_eq!(first_workspaces.data, second_workspaces.data);
    assert_eq!(first_workspaces.next_cursor, second_workspaces.next_cursor);
    assert_eq!(first_workspaces.access_mode, second_workspaces.access_mode);
    assert!(
        !serde_json::to_string(&first_workspaces)?
            .contains(codex_home.path().to_string_lossy().as_ref())
    );

    restarted_process
        .kill()
        .await
        .context("failed to stop restarted websocket app-server process")?;
    Ok(())
}

#[tokio::test]
async fn websocket_transport_disconnects_when_verified_principal_expires() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    let shared_secret = "0123456789abcdef0123456789abcdef";
    std::fs::write(&shared_secret_file, format!("{shared_secret}\n"))?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let auth_args = signed_bearer_auth_args(&shared_secret_file);
    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let token = signed_bearer_token(
        shared_secret.as_bytes(),
        json!({
            "exp": now + 3,
            "iat": now,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": "user:42",
            "tenantId": "tenant-7",
            "spaceId": "space-9",
            "jti": "expiring-token",
        }),
    )?;

    let mut websocket = connect_websocket_with_bearer(bind_addr, Some(token.as_str())).await?;
    send_initialize_request(&mut websocket, /*id*/ 1, "expiring_principal_client").await?;
    read_response_for_id(&mut websocket, /*id*/ 1).await?;
    expect_websocket_disconnect(&mut websocket, Duration::from_secs(/*secs*/ 6)).await?;

    process
        .kill()
        .await
        .context("failed to stop websocket app-server process")?;
    Ok(())
}

fn signed_bearer_auth_args(shared_secret_file: &std::path::Path) -> Vec<String> {
    vec![
        "--ws-auth".to_string(),
        "signed-bearer-token".to_string(),
        "--ws-shared-secret-file".to_string(),
        shared_secret_file.display().to_string(),
        "--ws-issuer".to_string(),
        "crewon-enroller".to_string(),
        "--ws-audience".to_string(),
        "crewon-app-server".to_string(),
    ]
}

async fn send_experimental_initialize_request(stream: &mut WsClient, id: i64) -> Result<()> {
    send_request(
        stream,
        "initialize",
        id,
        Some(serde_json::to_value(InitializeParams {
            client_info: ClientInfo {
                name: "principal_client".to_string(),
                title: Some("WebSocket Principal Test Client".to_string()),
                version: "0.1.0".to_string(),
            },
            capabilities: Some(InitializeCapabilities {
                experimental_api: true,
                ..Default::default()
            }),
        })?),
    )
    .await
}

async fn read_identity(stream: &mut WsClient, id: i64) -> Result<IdentityReadResponse> {
    send_request(stream, "identity/read", id, /*params*/ None).await?;
    to_response(read_response_for_id(stream, id).await?)
}

async fn read_workspaces(stream: &mut WsClient, id: i64) -> Result<WorkspaceListResponse> {
    send_request(
        stream,
        "workspace/list",
        id,
        Some(serde_json::to_value(WorkspaceListParams {
            cursor: None,
            limit: None,
        })?),
    )
    .await?;
    to_response(read_response_for_id(stream, id).await?)
}

async fn expect_websocket_disconnect(stream: &mut WsClient, wait_for: Duration) -> Result<()> {
    timeout(wait_for, async {
        loop {
            match stream.next().await {
                None | Some(Ok(WebSocketMessage::Close(_))) | Some(Err(_)) => return Ok(()),
                Some(Ok(WebSocketMessage::Ping(payload))) => {
                    stream.send(WebSocketMessage::Pong(payload)).await?;
                }
                Some(Ok(WebSocketMessage::Text(_)))
                | Some(Ok(WebSocketMessage::Pong(_)))
                | Some(Ok(WebSocketMessage::Frame(_))) => {}
                Some(Ok(frame)) => bail!("unexpected frame before expiry disconnect: {frame:?}"),
            }
        }
    })
    .await
    .context("timed out waiting for principal expiry disconnect")?
}
