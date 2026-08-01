#[path = "cloud_agent_vertical_support.rs"]
mod support;

use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::to_response;
use crewon_app_server_protocol::ClientInfo;
use crewon_app_server_protocol::InitializeCapabilities;
use crewon_app_server_protocol::InitializeParams;
use crewon_app_server_protocol::JSONRPCMessage;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::ProviderConnectParams;
use crewon_app_server_protocol::ProviderConnectResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindResponse;
use crewon_app_server_protocol::ResourceBindingMode;
use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceListResponse;
use crewon_app_server_protocol::ResourceType;
use crewon_app_server_protocol::ThreadExecutionContextBindingRef;
use crewon_app_server_protocol::ThreadExecutionContextCreateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateResponse;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::ThreadReadParams;
use crewon_app_server_protocol::ThreadReadResponse;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::TurnInterruptParams;
use crewon_app_server_protocol::TurnInterruptResponse;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::TurnStartResponse;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::UserInput;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use pretty_assertions::assert_eq;
use serde_json::Value;
use tempfile::TempDir;
use tokio::time::sleep;
use tokio::time::timeout;

use super::connection_handling_websocket::DEFAULT_READ_TIMEOUT;
use super::connection_handling_websocket::WsClient;
use super::connection_handling_websocket::connect_websocket_with_bearer;
use super::connection_handling_websocket::create_config_toml;
use super::connection_handling_websocket::read_jsonrpc_message;
use super::connection_handling_websocket::send_request;
use super::connection_handling_websocket::spawn_websocket_server_with_env_and_args;
use support::AGENT_ID;
use support::AGENT_REVISION;
use support::HermeticCloudServices;
use support::OUTPUT_TEXT;
use support::PROVIDER_ID;

const CLIENT_MESSAGE_ID: &str = "client-w3-01-vertical-001";
const PROMPT: &str = "Return the hermetic Cloud Agent result.";

#[tokio::test]
async fn cloud_agent_vertical_recovers_standard_result_across_disconnect_and_restarts() -> Result<()>
{
    let now = unix_now()?;
    let services = HermeticCloudServices::start(now).await?;
    let codex_home = TempDir::new()?;
    services.seed_authority(codex_home.path()).await?;
    let responses = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    create_config_toml(codex_home.path(), &responses.uri(), "never")?;
    let environment = services.environment();
    let env_overrides = environment
        .iter()
        .map(|(name, value)| (name.as_str(), Some(value.as_str())))
        .collect::<Vec<_>>();
    let token = services.principal_session_token()?;

    let (mut process, bind_addr) = spawn_websocket_server_with_env_and_args(
        codex_home.path(),
        "ws://127.0.0.1:0",
        &env_overrides,
        &[],
    )
    .await?;
    let mut websocket = connect_websocket_with_bearer(bind_addr, Some(token.as_str())).await?;
    initialize(&mut websocket, /*id*/ 1).await?;

    let workspaces = list_workspaces(&mut websocket, /*id*/ 2).await?;
    let workspace_key = workspaces
        .data
        .first()
        .context("server-owned Workspace")?
        .workspace_key
        .clone();
    let provider = connect_provider(&mut websocket, /*id*/ 3).await?;
    let resource = list_agent_resource(
        &mut websocket,
        /*id*/ 4,
        &provider.provider.connection_id,
    )
    .await?;
    let started_thread = start_thread(&mut websocket, /*id*/ 5, workspace_key).await?;
    let thread_id = started_thread.thread.id.clone();
    let context = started_thread
        .execution_context
        .context("Thread execution context")?;
    let bound = bind_agent(
        &mut websocket,
        /*id*/ 6,
        provider.provider.connection_id,
        context.workspace.binding_id.clone(),
        resource,
    )
    .await?;
    let updated = update_execution_binding(
        &mut websocket,
        /*id*/ 7,
        &thread_id,
        context.workspace.binding_id,
        bound.binding.binding.binding_id.clone(),
        context.revision,
    )
    .await?;
    assert_eq!(
        updated.execution_context.execution_binding,
        Some(ThreadExecutionContextBindingRef {
            binding_id: bound.binding.binding.binding_id.clone(),
            revision: bound.binding.revision,
        })
    );

    let first = start_cloud_turn(&mut websocket, /*id*/ 8, &thread_id).await?;
    assert_eq!(first.turn.status, TurnStatus::InProgress);
    let duplicate = start_cloud_turn(&mut websocket, /*id*/ 9, &thread_id).await?;
    assert_eq!(duplicate.turn.id, first.turn.id);
    assert_eq!(duplicate.turn.status, first.turn.status);
    assert_eq!(duplicate.turn.items_view, TurnItemsView::Full);
    assert_eq!(
        duplicate.turn.items,
        vec![ThreadItem::UserMessage {
            id: format!("{}:user", first.turn.id),
            client_id: Some(CLIENT_MESSAGE_ID.to_string()),
            content: vec![text_input(PROMPT)],
        }]
    );
    services.wait_for_progress().await?;

    websocket
        .close(None)
        .await
        .context("close first WebSocket")?;
    drop(websocket);
    process
        .kill()
        .await
        .context("stop first hermetic app-server")?;

    services.restart_provider_before_completion();
    let restart_url = format!("ws://{bind_addr}");
    let (mut restarted_process, restarted_bind_addr) = spawn_websocket_server_with_env_and_args(
        codex_home.path(),
        &restart_url,
        &env_overrides,
        &[],
    )
    .await?;
    let mut reconnected =
        connect_websocket_with_bearer(restarted_bind_addr, Some(token.as_str())).await?;
    initialize(&mut reconnected, /*id*/ 10).await?;
    services.wait_for_restart_recovery().await?;

    let thread = wait_for_completed_thread(&mut reconnected, /*first_id*/ 11, &thread_id).await?;
    assert_eq!(thread.turns.len(), 1);
    let completed = &thread.turns[0];
    assert_eq!(completed.id, first.turn.id);
    assert_eq!(completed.status, TurnStatus::Completed);
    assert_eq!(completed.error, None);
    assert_eq!(
        completed.items,
        vec![
            ThreadItem::UserMessage {
                id: format!("{}:user", completed.id),
                client_id: Some(CLIENT_MESSAGE_ID.to_string()),
                content: vec![text_input(PROMPT)],
            },
            ThreadItem::AgentMessage {
                id: format!("{}:assistant", completed.id),
                text: OUTPUT_TEXT.to_string(),
                phase: None,
                memory_citation: None,
            },
        ]
    );
    assert_eq!(thread.preview, OUTPUT_TEXT);

    let requests = services.received_requests().await?;
    assert_eq!(request_count(&requests, "/provider/v3/runs:start"), 1);
    assert!(request_count(&requests, "/provider/v3/runs:listEvents") >= 2);
    assert_eq!(request_count(&requests, "/provider/v3/artifacts:read"), 1);
    assert!(
        requests
            .iter()
            .filter(|request| request.url.path() == "/provider/v3/runs:listEvents")
            .all(|request| request_json(request)["providerRunId"] == "provider-run-w3-01")
    );
    let request_bodies = requests
        .iter()
        .map(|request| String::from_utf8_lossy(&request.body))
        .collect::<String>();
    assert!(!request_bodies.contains(token.as_str()));
    assert!(!request_bodies.contains("PRIVATE KEY"));

    reconnected
        .close(None)
        .await
        .context("close restarted WebSocket")?;
    restarted_process
        .kill()
        .await
        .context("stop restarted hermetic app-server")?;
    Ok(())
}

#[tokio::test]
async fn cloud_agent_vertical_cancels_once_through_standard_turn_interrupt() -> Result<()> {
    let now = unix_now()?;
    let services = HermeticCloudServices::start(now).await?;
    let codex_home = TempDir::new()?;
    services.seed_authority(codex_home.path()).await?;
    let responses = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    create_config_toml(codex_home.path(), &responses.uri(), "never")?;
    let environment = services.environment();
    let env_overrides = environment
        .iter()
        .map(|(name, value)| (name.as_str(), Some(value.as_str())))
        .collect::<Vec<_>>();
    let token = services.principal_session_token()?;
    let (mut process, bind_addr) = spawn_websocket_server_with_env_and_args(
        codex_home.path(),
        "ws://127.0.0.1:0",
        &env_overrides,
        &[],
    )
    .await?;
    let mut websocket = connect_websocket_with_bearer(bind_addr, Some(token.as_str())).await?;
    initialize(&mut websocket, /*id*/ 1).await?;

    let workspace_key = list_workspaces(&mut websocket, /*id*/ 2)
        .await?
        .data
        .into_iter()
        .next()
        .context("server-owned Workspace")?
        .workspace_key;
    let provider = connect_provider(&mut websocket, /*id*/ 3).await?;
    let resource = list_agent_resource(
        &mut websocket,
        /*id*/ 4,
        &provider.provider.connection_id,
    )
    .await?;
    let started_thread = start_thread(&mut websocket, /*id*/ 5, workspace_key).await?;
    let thread_id = started_thread.thread.id;
    let context = started_thread
        .execution_context
        .context("Thread execution context")?;
    let bound = bind_agent(
        &mut websocket,
        /*id*/ 6,
        provider.provider.connection_id,
        context.workspace.binding_id.clone(),
        resource,
    )
    .await?;
    update_execution_binding(
        &mut websocket,
        /*id*/ 7,
        &thread_id,
        context.workspace.binding_id,
        bound.binding.binding.binding_id,
        context.revision,
    )
    .await?;
    let started = start_cloud_turn(&mut websocket, /*id*/ 8, &thread_id).await?;
    services.wait_for_progress().await?;

    interrupt_cloud_turn(&mut websocket, /*id*/ 9, &thread_id, &started.turn.id).await?;
    interrupt_cloud_turn(&mut websocket, /*id*/ 10, &thread_id, &started.turn.id).await?;
    services.wait_for_cancel_request().await?;
    let thread = wait_for_thread_status(
        &mut websocket,
        /*first_id*/ 11,
        &thread_id,
        TurnStatus::Interrupted,
    )
    .await?;
    assert_eq!(thread.turns.len(), 1);
    assert_eq!(thread.turns[0].id, started.turn.id);
    assert_eq!(thread.turns[0].status, TurnStatus::Interrupted);
    assert!(thread.turns[0].error.is_none());

    let requests = services.received_requests().await?;
    assert_eq!(request_count(&requests, "/provider/v3/runs:start"), 1);
    assert_eq!(request_count(&requests, "/provider/v3/runs:cancel"), 1);
    assert_eq!(request_count(&requests, "/provider/v3/artifacts:read"), 0);

    websocket.close(None).await.context("close WebSocket")?;
    process.kill().await.context("stop hermetic app-server")?;
    Ok(())
}

async fn initialize(websocket: &mut WsClient, id: i64) -> Result<()> {
    send_request(
        websocket,
        "initialize",
        id,
        Some(serde_json::to_value(InitializeParams {
            client_info: ClientInfo {
                name: "w3-01-hermetic-client".to_string(),
                title: Some("W3-01 Hermetic Client".to_string()),
                version: "1.0.0".to_string(),
            },
            capabilities: Some(InitializeCapabilities {
                experimental_api: true,
                ..Default::default()
            }),
        })?),
    )
    .await?;
    read_response_for_id(websocket, id).await?;
    Ok(())
}

async fn list_workspaces(websocket: &mut WsClient, id: i64) -> Result<WorkspaceListResponse> {
    send_request(
        websocket,
        "workspace/list",
        id,
        Some(serde_json::to_value(WorkspaceListParams {
            cursor: None,
            limit: Some(20),
        })?),
    )
    .await?;
    to_response(read_response_for_id(websocket, id).await?)
}

async fn connect_provider(websocket: &mut WsClient, id: i64) -> Result<ProviderConnectResponse> {
    send_request(
        websocket,
        "provider/connect",
        id,
        Some(serde_json::to_value(ProviderConnectParams {
            provider_id: PROVIDER_ID.to_string(),
        })?),
    )
    .await?;
    to_response(read_response_for_id(websocket, id).await?)
}

async fn list_agent_resource(
    websocket: &mut WsClient,
    id: i64,
    connection_id: &str,
) -> Result<crewon_app_server_protocol::ResourceRef> {
    send_request(
        websocket,
        "resource/list",
        id,
        Some(serde_json::to_value(ResourceListParams {
            connection_id: connection_id.to_string(),
            cursor: None,
            limit: Some(20),
            resource_type: Some(ResourceType::Agent),
        })?),
    )
    .await?;
    let response: ResourceListResponse = to_response(read_response_for_id(websocket, id).await?)?;
    let resource = response.data.into_iter().next().context("Provider Agent")?;
    assert_eq!(resource.resource_id, AGENT_ID);
    assert_eq!(resource.revision, AGENT_REVISION);
    Ok(resource)
}

async fn start_thread(
    websocket: &mut WsClient,
    id: i64,
    workspace_key: String,
) -> Result<ThreadStartResponse> {
    send_request(
        websocket,
        "thread/start",
        id,
        Some(serde_json::to_value(ThreadStartParams {
            execution_context: Some(ThreadExecutionContextCreateParams { workspace_key }),
            ..Default::default()
        })?),
    )
    .await?;
    to_response(read_response_for_id(websocket, id).await?)
}

async fn bind_agent(
    websocket: &mut WsClient,
    id: i64,
    connection_id: String,
    workspace_binding_id: String,
    resource: crewon_app_server_protocol::ResourceRef,
) -> Result<ResourceBindResponse> {
    send_request(
        websocket,
        "resource/bind",
        id,
        Some(serde_json::to_value(ResourceBindParams {
            connection_id,
            workspace_binding_id,
            resource,
            mode: ResourceBindingMode::ProviderManaged,
        })?),
    )
    .await?;
    to_response(read_response_for_id(websocket, id).await?)
}

async fn update_execution_binding(
    websocket: &mut WsClient,
    id: i64,
    thread_id: &str,
    workspace_binding_id: String,
    binding_id: String,
    expected_revision: u64,
) -> Result<ThreadExecutionContextUpdateResponse> {
    send_request(
        websocket,
        "threadExecutionContext/update",
        id,
        Some(serde_json::to_value(ThreadExecutionContextUpdateParams {
            thread_id: thread_id.to_string(),
            workspace_binding_id,
            resource_binding_ids: vec![binding_id.clone()],
            execution_binding_id: Some(binding_id),
            expected_revision,
        })?),
    )
    .await?;
    to_response(read_response_for_id(websocket, id).await?)
}

async fn start_cloud_turn(
    websocket: &mut WsClient,
    id: i64,
    thread_id: &str,
) -> Result<TurnStartResponse> {
    send_request(
        websocket,
        "turn/start",
        id,
        Some(serde_json::to_value(TurnStartParams {
            thread_id: thread_id.to_string(),
            client_user_message_id: Some(CLIENT_MESSAGE_ID.to_string()),
            input: vec![text_input(PROMPT)],
            ..Default::default()
        })?),
    )
    .await?;
    to_response(read_response_for_id(websocket, id).await?)
}

async fn interrupt_cloud_turn(
    websocket: &mut WsClient,
    id: i64,
    thread_id: &str,
    turn_id: &str,
) -> Result<TurnInterruptResponse> {
    send_request(
        websocket,
        "turn/interrupt",
        id,
        Some(serde_json::to_value(TurnInterruptParams {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
        })?),
    )
    .await?;
    to_response(read_response_for_id(websocket, id).await?)
}

async fn wait_for_completed_thread(
    websocket: &mut WsClient,
    first_id: i64,
    thread_id: &str,
) -> Result<crewon_app_server_protocol::Thread> {
    wait_for_thread_status(websocket, first_id, thread_id, TurnStatus::Completed).await
}

async fn wait_for_thread_status(
    websocket: &mut WsClient,
    first_id: i64,
    thread_id: &str,
    status: TurnStatus,
) -> Result<crewon_app_server_protocol::Thread> {
    timeout(DEFAULT_READ_TIMEOUT, async {
        let mut id = first_id;
        loop {
            send_request(
                websocket,
                "thread/read",
                id,
                Some(serde_json::to_value(ThreadReadParams {
                    thread_id: thread_id.to_string(),
                    include_turns: true,
                })?),
            )
            .await?;
            let response: ThreadReadResponse =
                to_response(read_response_for_id(websocket, id).await?)?;
            if response
                .thread
                .turns
                .iter()
                .any(|turn| turn.status == status)
            {
                return Ok::<_, anyhow::Error>(response.thread);
            }
            id += 1;
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .with_context(|| format!("timed out waiting for Cloud Agent Turn status {status:?}"))?
}

fn text_input(text: &str) -> UserInput {
    UserInput::Text {
        text: text.to_string(),
        text_elements: Vec::new(),
    }
}

fn request_count(requests: &[wiremock::Request], path: &str) -> usize {
    requests
        .iter()
        .filter(|request| request.url.path() == path)
        .count()
}

fn request_json(request: &wiremock::Request) -> Value {
    serde_json::from_slice(&request.body)
        .unwrap_or_else(|error| panic!("fake Provider request JSON: {error}"))
}

async fn read_response_for_id(websocket: &mut WsClient, id: i64) -> Result<JSONRPCResponse> {
    let request_id = RequestId::Integer(id);
    loop {
        match read_jsonrpc_message(websocket).await? {
            JSONRPCMessage::Response(response) if response.id == request_id => return Ok(response),
            JSONRPCMessage::Error(error) if error.id == request_id => {
                bail!(
                    "JSON-RPC request {id} failed with {}: {}",
                    error.error.code,
                    error.error.message
                )
            }
            _ => {}
        }
    }
}

fn unix_now() -> Result<i64> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system time before Unix epoch")?
            .as_secs(),
    )
    .context("Unix time overflow")
}
