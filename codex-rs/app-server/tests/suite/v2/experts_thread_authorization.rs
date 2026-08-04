use super::connection_handling_websocket::WsClient;
use super::connection_handling_websocket::connect_websocket;
use super::connection_handling_websocket::connect_websocket_with_bearer;
use super::connection_handling_websocket::create_config_toml;
use super::connection_handling_websocket::read_error_for_id;
use super::connection_handling_websocket::read_jsonrpc_message;
use super::connection_handling_websocket::read_notification_for_method;
use super::connection_handling_websocket::read_response_for_id;
use super::connection_handling_websocket::send_request;
use super::connection_handling_websocket::signed_bearer_token;
use super::connection_handling_websocket::spawn_websocket_server_with_args;
use super::connection_handling_websocket::spawn_websocket_server_with_env_and_args;
use anyhow::Context;
use anyhow::Result;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::to_response;
use crewon_app_server_protocol::ClientInfo;
use crewon_app_server_protocol::ExpertTeamCreateResponse;
use crewon_app_server_protocol::InitializeCapabilities;
use crewon_app_server_protocol::InitializeParams;
use crewon_app_server_protocol::JSONRPCMessage;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::SceneExecutionStrategy;
use crewon_app_server_protocol::SceneExecutionTargetKind;
use crewon_app_server_protocol::SceneExecutionTargetSelection;
use crewon_app_server_protocol::SceneId;
use crewon_app_server_protocol::ThreadExecutionContextCreateParams;
use crewon_app_server_protocol::ThreadResumeParams;
use crewon_app_server_protocol::ThreadSceneSelectionParams;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use crewon_protocol::models::ContentItem;
use crewon_protocol::models::ResponseItem;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tempfile::TempDir;
use time::OffsetDateTime;

const SHARED_SECRET: &str = "0123456789abcdef0123456789abcdef";
const SINGLE_TENANT_WEBSOCKET_ENV: &str = "CREWON_EXPERT_TEAM_SINGLE_TENANT_WEBSOCKET_ENABLED";

#[tokio::test]
async fn experts_single_tenant_websocket_mode_is_explicit_and_functional() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let (mut process, bind_addr) = spawn_websocket_server_with_env_and_args(
        codex_home.path(),
        "ws://127.0.0.1:0",
        &[(SINGLE_TENANT_WEBSOCKET_ENV, Some("true"))],
        &[],
    )
    .await?;
    let mut client = tokio::time::timeout(Duration::from_secs(10), connect_websocket(bind_addr))
        .await
        .context("timed out connecting single-tenant Experts websocket")??;
    tokio::time::timeout(Duration::from_secs(10), initialize(&mut client, /*id*/ 1))
        .await
        .context("timed out initializing single-tenant Experts websocket")??;
    let workspace_key = tokio::time::timeout(
        Duration::from_secs(10),
        read_workspace_key(&mut client, /*id*/ 2),
    )
    .await
    .context("timed out listing the single-tenant Experts workspace")??;
    let created = tokio::time::timeout(
        Duration::from_secs(10),
        create_expert_team(&mut client, /*id*/ 3, &workspace_key),
    )
    .await
    .context("timed out creating the single-tenant Expert Team")??;
    let cwd = workspace_root_for_record(&created.record.file_path)?;

    let mut thread_start =
        experts_thread_start_params(&cwd, &workspace_key, &created.record.config.experts_id);
    thread_start.execution_context = None;
    send_request(
        &mut client,
        "thread/start",
        /*id*/ 4,
        Some(serde_json::to_value(thread_start)?),
    )
    .await?;
    let started: ThreadStartResponse = to_response(
        tokio::time::timeout(
            Duration::from_secs(10),
            read_response_for_id(&mut client, /*id*/ 4),
        )
        .await
        .context("timed out starting the single-tenant Experts thread")??,
    )?;
    let scene = started.scene_runtime.expect("Experts scene runtime");
    assert_eq!(
        (scene.execution_target_kind, scene.execution_strategy),
        (
            SceneExecutionTargetKind::Experts,
            SceneExecutionStrategy::Team,
        )
    );

    std::fs::remove_file(&created.record.file_path)?;
    client.close(None).await?;
    process
        .kill()
        .await
        .context("failed to stop single-tenant Experts app-server process")?;
    Ok(())
}

#[tokio::test]
async fn experts_thread_start_enforces_owner_and_workspace_authority() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    std::fs::write(&shared_secret_file, format!("{SHARED_SECRET}\n"))?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let auth_args = signed_bearer_auth_args(&shared_secret_file);
    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let owner_token = principal_token(now, "user:experts-owner", "space-experts", "owner-token")?;
    let mut owner = connect_websocket_with_bearer(bind_addr, Some(owner_token.as_str())).await?;
    initialize(&mut owner, /*id*/ 1).await?;
    let workspace_key = read_workspace_key(&mut owner, /*id*/ 2).await?;
    let created = create_expert_team(&mut owner, /*id*/ 3, &workspace_key).await?;
    let cwd = workspace_root_for_record(&created.record.file_path)?;
    let experts_id = created.record.config.experts_id.clone();

    send_request(
        &mut owner,
        "thread/start",
        /*id*/ 4,
        Some(serde_json::to_value(experts_thread_start_params(
            &cwd,
            &workspace_key,
            &experts_id,
        ))?),
    )
    .await?;
    let started: ThreadStartResponse =
        to_response(read_response_for_id(&mut owner, /*id*/ 4).await?)?;
    let scene = started.scene_runtime.expect("Experts scene runtime");
    assert_eq!(
        scene.execution_target_kind,
        SceneExecutionTargetKind::Experts
    );
    assert_eq!(scene.execution_strategy, SceneExecutionStrategy::Team);
    assert_eq!(
        started
            .execution_context
            .as_ref()
            .expect("Experts execution context")
            .workspace
            .workspace_key,
        workspace_key
    );

    let other_token = principal_token(now, "user:experts-other", "space-experts", "other-token")?;
    let mut other = connect_websocket_with_bearer(bind_addr, Some(other_token.as_str())).await?;
    initialize(&mut other, /*id*/ 10).await?;
    let other_workspace_key = read_workspace_key(&mut other, /*id*/ 11).await?;
    send_request(
        &mut other,
        "thread/start",
        /*id*/ 12,
        Some(serde_json::to_value(experts_thread_start_params(
            &cwd,
            &other_workspace_key,
            &experts_id,
        ))?),
    )
    .await?;
    let cross_owner = read_error_for_id(&mut other, /*id*/ 12).await?;
    assert_eq!(
        cross_owner.error.message,
        "Expert Team execution target is not authorized"
    );

    let mismatched_cwd = TempDir::new()?;
    let copied_record_directory = mismatched_cwd.path().join(".crewon/experts");
    std::fs::create_dir_all(&copied_record_directory)?;
    let record_name = Path::new(&created.record.file_path)
        .file_name()
        .context("Expert Team record must have a file name")?;
    std::fs::copy(
        &created.record.file_path,
        copied_record_directory.join(record_name),
    )?;
    send_request(
        &mut owner,
        "thread/start",
        /*id*/ 5,
        Some(serde_json::to_value(experts_thread_start_params(
            mismatched_cwd.path().to_string_lossy().as_ref(),
            &workspace_key,
            &experts_id,
        ))?),
    )
    .await?;
    let mismatched_workspace = read_error_for_id(&mut owner, /*id*/ 5).await?;
    assert_eq!(
        mismatched_workspace.error.message,
        "Expert Team cwd does not match the authorized workspace"
    );

    let mut ui_thread_start = experts_thread_start_params(&cwd, &workspace_key, &experts_id);
    ui_thread_start.execution_context = None;
    send_request(
        &mut owner,
        "thread/start",
        /*id*/ 6,
        Some(serde_json::to_value(ui_thread_start)?),
    )
    .await?;
    let ui_started: ThreadStartResponse =
        to_response(read_response_for_id(&mut owner, /*id*/ 6).await?)?;
    assert_eq!(ui_started.execution_context, None);
    let ui_scene = ui_started.scene_runtime.expect("Experts UI scene runtime");
    assert_eq!(
        (ui_scene.execution_target_kind, ui_scene.execution_strategy),
        (
            SceneExecutionTargetKind::Experts,
            SceneExecutionStrategy::Team
        )
    );

    std::fs::remove_file(&created.record.file_path)?;
    other.close(None).await?;
    owner.close(None).await?;
    process
        .kill()
        .await
        .context("failed to stop Experts authorization app-server process")?;
    Ok(())
}

#[tokio::test]
async fn experts_thread_resume_revalidates_deleted_definition() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(Vec::new()).await;
    let codex_home = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    std::fs::write(&shared_secret_file, format!("{SHARED_SECRET}\n"))?;
    create_config_toml(codex_home.path(), &server.uri(), "never")?;
    let auth_args = signed_bearer_auth_args(&shared_secret_file);
    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let token = principal_token(now, "user:experts-owner", "space-experts", "resume-token")?;
    let mut owner = connect_websocket_with_bearer(bind_addr, Some(token.as_str())).await?;
    initialize(&mut owner, /*id*/ 1).await?;
    let workspace_key = read_workspace_key(&mut owner, /*id*/ 2).await?;
    let created = create_expert_team(&mut owner, /*id*/ 3, &workspace_key).await?;
    let cwd = workspace_root_for_record(&created.record.file_path)?;

    send_request(
        &mut owner,
        "thread/start",
        /*id*/ 4,
        Some(serde_json::to_value(experts_thread_start_params(
            &cwd,
            &workspace_key,
            &created.record.config.experts_id,
        ))?),
    )
    .await?;
    let started: ThreadStartResponse =
        to_response(read_response_for_id(&mut owner, /*id*/ 4).await?)?;
    read_notification_for_method(&mut owner, "thread/started").await?;
    send_request(
        &mut owner,
        "thread/inject_items",
        /*id*/ 5,
        Some(json!({
            "threadId": started.thread.id.clone(),
            "items": [serde_json::to_value(ResponseItem::Message {
                id: None,
                role: "assistant".to_string(),
                content: vec![ContentItem::OutputText {
                    text: "Materialize the Experts thread".to_string(),
                }],
                phase: None,
            })?]
        })),
    )
    .await?;
    loop {
        match read_jsonrpc_message(&mut owner).await? {
            JSONRPCMessage::Response(response) if response.id == RequestId::Integer(5) => break,
            JSONRPCMessage::Error(error) if error.id == RequestId::Integer(5) => {
                anyhow::bail!("thread/inject_items failed: {}", error.error.message);
            }
            _ => {}
        }
    }
    std::fs::remove_file(&created.record.file_path)?;
    let thread_id = started.thread.id.clone();
    owner.close(None).await?;
    process
        .kill()
        .await
        .context("failed to stop first Experts resume app-server process")?;

    let (mut restarted_process, restarted_bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let mut restarted_owner =
        connect_websocket_with_bearer(restarted_bind_addr, Some(token.as_str())).await?;
    initialize(&mut restarted_owner, /*id*/ 10).await?;

    send_request(
        &mut restarted_owner,
        "thread/resume",
        /*id*/ 11,
        Some(serde_json::to_value(ThreadResumeParams {
            thread_id,
            ..Default::default()
        })?),
    )
    .await?;
    let unavailable = read_error_for_id(&mut restarted_owner, /*id*/ 11).await?;
    assert_eq!(
        unavailable.error.message,
        "persisted Experts execution target is unavailable"
    );

    restarted_owner.close(None).await?;
    restarted_process
        .kill()
        .await
        .context("failed to stop restarted Experts resume app-server process")?;
    Ok(())
}

fn signed_bearer_auth_args(shared_secret_file: &Path) -> Vec<String> {
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

fn workspace_root_for_record(file_path: &str) -> Result<String> {
    let root = Path::new(file_path)
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .context("Expert Team record must live below <workspace>/.crewon/experts")?;
    Ok(std::fs::canonicalize(root)?.to_string_lossy().into_owned())
}

fn principal_token(now: i64, subject: &str, space_id: &str, token_id: &str) -> Result<String> {
    signed_bearer_token(
        SHARED_SECRET.as_bytes(),
        json!({
            "exp": now + 180,
            "iat": now,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": subject,
            "tenantId": "tenant-experts",
            "spaceId": space_id,
            "jti": token_id,
        }),
    )
}

async fn initialize(stream: &mut WsClient, id: i64) -> Result<()> {
    send_request(
        stream,
        "initialize",
        id,
        Some(serde_json::to_value(InitializeParams {
            client_info: ClientInfo {
                name: "experts_authorization_client".to_string(),
                title: Some("Experts Authorization Test Client".to_string()),
                version: "0.1.0".to_string(),
            },
            capabilities: Some(InitializeCapabilities {
                experimental_api: true,
                ..Default::default()
            }),
        })?),
    )
    .await?;
    read_response_for_id(stream, id).await?;
    Ok(())
}

async fn read_workspace_key(stream: &mut WsClient, id: i64) -> Result<String> {
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
    let workspaces: WorkspaceListResponse = to_response(read_response_for_id(stream, id).await?)?;
    Ok(workspaces
        .data
        .first()
        .context("server workspace was not registered")?
        .workspace_key
        .clone())
}

async fn create_expert_team(
    stream: &mut WsClient,
    id: i64,
    workspace_key: &str,
) -> Result<ExpertTeamCreateResponse> {
    send_request(
        stream,
        "expertTeam/create",
        id,
        Some(json!({
            "workspaceKey": workspace_key,
            "title": "Delivery Experts",
            "goal": "Review and synthesize the delivery plan",
            "leader": {
                "name": "Lead",
                "role": "Coordinate and synthesize",
                "agentType": "worker",
                "instructions": null
            },
            "experts": [
                {
                    "name": "Researcher",
                    "role": "Gather evidence",
                    "agentType": "explorer",
                    "instructions": null
                },
                {
                    "name": "Reviewer",
                    "role": "Challenge the proposal",
                    "agentType": "worker",
                    "instructions": "Return concrete risks"
                }
            ]
        })),
    )
    .await?;
    to_response(read_response_for_id(stream, id).await?)
}

fn experts_thread_start_params(
    cwd: &str,
    workspace_key: &str,
    experts_id: &str,
) -> ThreadStartParams {
    ThreadStartParams {
        cwd: Some(cwd.to_string()),
        execution_context: Some(ThreadExecutionContextCreateParams {
            workspace_key: workspace_key.to_string(),
        }),
        scene: Some(ThreadSceneSelectionParams {
            scene_id: SceneId::Office,
            mode: None,
            deliverable: None,
            execution_target: Some(SceneExecutionTargetSelection::Experts {
                id: experts_id.to_string(),
            }),
        }),
        ..Default::default()
    }
}
