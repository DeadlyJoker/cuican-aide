use anyhow::Result;
use app_test_support::ChatGptAuthFixture;
use app_test_support::PathBufExt;
use app_test_support::TestAppServer;
use app_test_support::create_mock_responses_server_repeating_assistant;
use app_test_support::to_response;
use app_test_support::write_chatgpt_auth;
use crewon_app_server_protocol::AgentSaveResponse;
use crewon_app_server_protocol::AskForApproval;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCMessage;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::McpServerStartupState;
use crewon_app_server_protocol::McpServerStatusUpdatedNotification;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::SandboxMode;
use crewon_app_server_protocol::SceneExecutionStrategy;
use crewon_app_server_protocol::SceneExecutionTargetKind;
use crewon_app_server_protocol::SceneExecutionTargetSelection;
use crewon_app_server_protocol::SceneId;
use crewon_app_server_protocol::SceneInteractionMode;
use crewon_app_server_protocol::ServerNotification;
use crewon_app_server_protocol::ThreadForkParams;
use crewon_app_server_protocol::ThreadForkResponse;
use crewon_app_server_protocol::ThreadResumeParams;
use crewon_app_server_protocol::ThreadResumeResponse;
use crewon_app_server_protocol::ThreadSceneSelectionParams;
use crewon_app_server_protocol::ThreadSource;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::ThreadStartedNotification;
use crewon_app_server_protocol::ThreadStatus;
use crewon_app_server_protocol::ThreadStatusChangedNotification;
use crewon_app_server_protocol::TurnEnvironmentParams;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::UserInput;
use crewon_config::loader::project_trust_key;
use crewon_config::types::AuthCredentialsStoreMode;
use crewon_core::config::set_project_trust_level;
use crewon_exec_server::LOCAL_FS;
use crewon_git_utils::resolve_root_git_project_for_trust;
use crewon_login::REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR;
use crewon_protocol::config_types::SERVICE_TIER_DEFAULT_REQUEST_VALUE;
use crewon_protocol::config_types::TrustLevel;
use crewon_protocol::openai_models::ReasoningEffort;
use crewon_protocol::protocol::MultiAgentVersion;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::time::timeout;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::analytics::assert_basic_thread_initialized_event;
use super::analytics::mount_analytics_capture;
use super::analytics::thread_initialized_event;
use super::analytics::wait_for_analytics_payload;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const INVALID_REQUEST_ERROR_CODE: i64 = -32600;

#[tokio::test]
async fn thread_start_scene_defaults_to_crewon_single_and_persists_runtime() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            scene: Some(ThreadSceneSelectionParams {
                scene_id: SceneId::Office,
                mode: None,
                deliverable: None,
                execution_target: None,
            }),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse {
        thread,
        scene_runtime,
        ..
    } = to_response::<ThreadStartResponse>(response)?;
    let scene_runtime = scene_runtime.expect("scene runtime should be resolved");
    assert_eq!(scene_runtime.contract.scene, SceneId::Office);
    assert_eq!(scene_runtime.contract.mode, SceneInteractionMode::Auto);
    assert_eq!(
        scene_runtime.execution_target_kind,
        SceneExecutionTargetKind::Crewon
    );
    assert_eq!(
        scene_runtime.execution_strategy,
        SceneExecutionStrategy::Single
    );

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id,
            input: vec![UserInput::Text {
                text: "prepare my day".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;

    let rollout_path = thread
        .path
        .expect("persistent thread should have a rollout path");
    let session_meta = crewon_rollout::read_session_meta_line(&rollout_path).await?;
    assert_eq!(
        session_meta.meta.multi_agent_version,
        Some(MultiAgentVersion::Disabled)
    );
    let persisted_scene = session_meta
        .scene_runtime
        .expect("rollout should persist scene runtime");
    assert_eq!(
        persisted_scene.contract.scene,
        crewon_protocol::scene::SceneId::Office
    );
    assert_eq!(
        persisted_scene.execution_target_token,
        scene_runtime.execution_target_token
    );

    let requests = server
        .received_requests()
        .await
        .expect("mock server should capture requests");
    let request_body = requests[0].body_json::<Value>()?;
    let request_text = request_body.to_string();
    assert!(request_text.contains("<crewon_scene_context>"));
    assert!(request_text.contains("Office scene:"));
    assert!(request_text.contains("Auto mode: infer the requested behavior"));
    assert!(!request_text.contains(&scene_runtime.execution_target_token));
    let tools = request_body["tools"]
        .as_array()
        .expect("request tools should be an array");
    let tool_names = tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(tool_names.contains(&"spawn_agent"), false);
    assert_eq!(tool_names.contains(&"send_message"), false);
    assert_eq!(tool_names.contains(&"list_agents"), false);
    Ok(())
}

#[tokio::test]
async fn thread_start_defined_team_enables_v2_team_runtime() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let cwd = codex_home.path().to_string_lossy().into_owned();
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let office_request_id = mcp
        .send_raw_request(
            "office/save",
            Some(json!({
                "cwd": cwd,
                "config": {
                    "title": "Launch Team",
                    "subtitle": "Ship the launch",
                    "workspace": {
                        "goal": "Launch safely",
                        "members": [{
                            "name": "Builder",
                            "role": "Implementation",
                            "agentId": "agent-builder"
                        }],
                        "messages": [],
                        "tasks": [],
                        "activity": { "approvals": [], "artifacts": [] }
                    }
                }
            })),
        )
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(office_request_id)),
    )
    .await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(cwd),
            scene: Some(ThreadSceneSelectionParams {
                scene_id: SceneId::Office,
                mode: None,
                deliverable: None,
                execution_target: Some(SceneExecutionTargetSelection::Team {
                    id: "Launch Team".to_string(),
                }),
            }),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse {
        thread,
        scene_runtime,
        ..
    } = to_response::<ThreadStartResponse>(response)?;
    let scene_runtime = scene_runtime.expect("team scene should resolve");
    assert_eq!(
        scene_runtime.execution_target_kind,
        SceneExecutionTargetKind::Team
    );
    assert_eq!(
        scene_runtime.execution_strategy,
        SceneExecutionStrategy::Team
    );

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id,
            input: vec![UserInput::Text {
                text: "prepare the launch".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;

    let rollout_path = thread
        .path
        .expect("persistent thread should have a rollout path");
    let session_meta = crewon_rollout::read_session_meta_line(&rollout_path).await?;
    assert_eq!(
        session_meta.meta.multi_agent_version,
        Some(MultiAgentVersion::V2)
    );
    let requests = server
        .received_requests()
        .await
        .expect("mock server should capture requests");
    let request_body = requests[0].body_json::<Value>()?;
    let request_text = request_body.to_string();
    assert!(request_text.contains("<crewon_execution_target_context>"));
    assert!(request_text.contains("Launch Team"));
    assert!(request_text.contains("Builder"));
    let tool_names = request_body["tools"]
        .as_array()
        .expect("request tools should be an array")
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert_eq!(tool_names.contains(&"spawn_agent"), true);
    assert_eq!(tool_names.contains(&"send_message"), true);
    Ok(())
}

#[tokio::test]
async fn thread_start_defined_agent_resolves_to_single_runtime() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let cwd = codex_home.path().to_string_lossy().into_owned();
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let agent_request_id = mcp
        .send_raw_request(
            "agent/save",
            Some(json!({
                "cwd": cwd,
                "config": {
                    "agentId": "agent-writer",
                    "name": "Writer",
                    "role": "Draft documents",
                    "model": "gpt-5.6-sol",
                    "systemPrompt": "Write concise source-grounded drafts.",
                    "skills": [{
                        "id": "document-drafting",
                        "name": "Document drafting",
                        "enabled": true
                    }],
                    "mcp": []
                }
            })),
        )
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(agent_request_id)),
    )
    .await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(cwd),
            scene: Some(ThreadSceneSelectionParams {
                scene_id: SceneId::Office,
                mode: None,
                deliverable: None,
                execution_target: Some(SceneExecutionTargetSelection::Agent {
                    id: "agent-writer".to_string(),
                }),
            }),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse {
        model,
        scene_runtime,
        thread,
        ..
    } = to_response::<ThreadStartResponse>(response)?;
    let scene_runtime = scene_runtime.expect("agent scene should resolve");
    assert_eq!(model, "gpt-5.6-sol");
    assert_eq!(
        scene_runtime.execution_target_kind,
        SceneExecutionTargetKind::Agent
    );
    assert_eq!(
        scene_runtime.execution_strategy,
        SceneExecutionStrategy::Single
    );
    assert_eq!(
        scene_runtime
            .execution_target_token
            .contains("agent-writer"),
        false
    );

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id,
            input: vec![UserInput::Text {
                text: "draft the update".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let requests = server
        .received_requests()
        .await
        .expect("mock server should capture requests");
    let request_text = requests[0].body_json::<Value>()?.to_string();
    assert!(request_text.contains("<crewon_execution_target_context>"));
    assert!(request_text.contains("Write concise source-grounded drafts."));
    assert!(request_text.contains("Document drafting"));
    Ok(())
}

#[tokio::test]
async fn cold_resume_restores_scene_identity_and_single_tool_policy() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let start_request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            scene: Some(ThreadSceneSelectionParams {
                scene_id: SceneId::Code,
                mode: Some(SceneInteractionMode::Review),
                deliverable: None,
                execution_target: None,
            }),
            ..Default::default()
        })
        .await?;
    let start_response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(start_request_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(start_response)?;
    let thread_id = thread.id;

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread_id.clone(),
            input: vec![UserInput::Text {
                text: "review this workspace".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;

    let fork_request_id = mcp
        .send_thread_fork_request(ThreadForkParams {
            thread_id: thread_id.clone(),
            ..Default::default()
        })
        .await?;
    let fork_response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(fork_request_id)),
    )
    .await??;
    let ThreadForkResponse {
        scene_runtime: fork_scene_runtime,
        ..
    } = to_response::<ThreadForkResponse>(fork_response)?;
    let fork_scene_runtime = fork_scene_runtime.expect("fork should inherit scene runtime");
    assert_eq!(fork_scene_runtime.contract.scene, SceneId::Code);
    assert_eq!(
        fork_scene_runtime.contract.mode,
        SceneInteractionMode::Review
    );
    assert_eq!(
        fork_scene_runtime.execution_strategy,
        SceneExecutionStrategy::Single
    );
    drop(mcp);

    let mut resumed_mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, resumed_mcp.initialize()).await??;
    let resume_request_id = resumed_mcp
        .send_thread_resume_request(ThreadResumeParams {
            thread_id: thread_id.clone(),
            ..Default::default()
        })
        .await?;
    let resume_response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        resumed_mcp.read_stream_until_response_message(RequestId::Integer(resume_request_id)),
    )
    .await??;
    let ThreadResumeResponse { scene_runtime, .. } =
        to_response::<ThreadResumeResponse>(resume_response)?;
    let scene_runtime = scene_runtime.expect("resume should restore scene runtime");
    assert_eq!(scene_runtime.contract.scene, SceneId::Code);
    assert_eq!(scene_runtime.contract.mode, SceneInteractionMode::Review);
    assert_eq!(
        scene_runtime.execution_strategy,
        SceneExecutionStrategy::Single
    );

    let resumed_turn_request_id = resumed_mcp
        .send_turn_start_request(TurnStartParams {
            thread_id,
            input: vec![UserInput::Text {
                text: "continue".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        resumed_mcp.read_stream_until_response_message(RequestId::Integer(resumed_turn_request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        resumed_mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let requests = server
        .received_requests()
        .await
        .expect("mock server should capture requests");
    let resumed_request_body = requests
        .last()
        .expect("resumed turn should reach the model")
        .body_json::<Value>()?;
    let resumed_has_spawn_agent = resumed_request_body["tools"]
        .as_array()
        .expect("request tools should be an array")
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .any(|name| name == "spawn_agent");
    assert_eq!(resumed_has_spawn_agent, false);
    Ok(())
}

#[tokio::test]
async fn code_plan_scene_enters_plan_collaboration_mode() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let start_request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            scene: Some(ThreadSceneSelectionParams {
                scene_id: SceneId::Code,
                mode: Some(SceneInteractionMode::Plan),
                deliverable: None,
                execution_target: None,
            }),
            ..Default::default()
        })
        .await?;
    let start_response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(start_request_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(start_response)?;
    let rollout_path = thread
        .path
        .clone()
        .expect("persistent thread should have a rollout path");

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id,
            input: vec![UserInput::Text {
                text: "plan the implementation".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;

    let requests = server
        .received_requests()
        .await
        .expect("mock server should capture requests");
    let request_text = requests[0].body_json::<Value>()?.to_string();
    assert!(request_text.contains("Plan mode: produce a scoped implementation plan"));
    let rollout = tokio::fs::read_to_string(rollout_path).await?;
    assert!(rollout.contains("\"collaboration_mode_kind\":\"plan\""));
    Ok(())
}

#[tokio::test]
async fn cold_resume_rejects_a_deleted_agent_execution_target() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let cwd = codex_home.path().to_string_lossy().into_owned();
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let save_request_id = mcp
        .send_raw_request(
            "agent/save",
            Some(json!({
                "cwd": cwd,
                "config": {
                    "agentId": "agent-temporary",
                    "name": "Temporary",
                    "role": "Temporary target"
                }
            })),
        )
        .await?;
    let save_response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(save_request_id)),
    )
    .await??;
    let AgentSaveResponse { file_path, .. } = to_response::<AgentSaveResponse>(save_response)?;

    let start_request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(cwd),
            scene: Some(ThreadSceneSelectionParams {
                scene_id: SceneId::Office,
                mode: None,
                deliverable: None,
                execution_target: Some(SceneExecutionTargetSelection::Agent {
                    id: "agent-temporary".to_string(),
                }),
            }),
            ..Default::default()
        })
        .await?;
    let start_response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(start_request_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(start_response)?;
    let thread_id = thread.id;

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread_id.clone(),
            input: vec![UserInput::Text {
                text: "materialize the thread".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    drop(mcp);
    tokio::fs::remove_file(file_path).await?;

    let mut resumed_mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, resumed_mcp.initialize()).await??;
    let resume_request_id = resumed_mcp
        .send_thread_resume_request(ThreadResumeParams {
            thread_id,
            ..Default::default()
        })
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        resumed_mcp.read_stream_until_error_message(RequestId::Integer(resume_request_id)),
    )
    .await??;
    assert_eq!(error.error.code, INVALID_REQUEST_ERROR_CODE);
    assert_eq!(
        error.error.message,
        "persisted Agent execution target is unavailable"
    );
    Ok(())
}

#[tokio::test]
async fn thread_start_creates_thread_and_emits_started() -> Result<()> {
    // Provide a mock server and config so model wiring is valid.
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    // Start server and initialize.
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    // Start a v2 thread with an explicit model override.
    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            model: Some("gpt-5.2".to_string()),
            thread_source: Some(ThreadSource::User),
            ..Default::default()
        })
        .await?;

    // Expect a proper JSON-RPC response with a thread id.
    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let resp_result = resp.result.clone();
    let ThreadStartResponse {
        thread,
        model_provider,
        ..
    } = to_response::<ThreadStartResponse>(resp)?;
    assert!(
        !thread.session_id.is_empty(),
        "session id should not be empty"
    );
    assert!(!thread.id.is_empty(), "thread id should not be empty");
    assert!(
        thread.preview.is_empty(),
        "new threads should start with an empty preview"
    );
    assert_eq!(model_provider, "mock_provider");
    assert!(
        thread.created_at > 0,
        "created_at should be a positive UNIX timestamp"
    );
    assert!(
        !thread.ephemeral,
        "new persistent threads should not be ephemeral"
    );
    assert_eq!(thread.status, ThreadStatus::Idle);
    assert_eq!(thread.thread_source, Some(ThreadSource::User));
    let thread_path = thread.path.clone().expect("thread path should be present");
    assert!(thread_path.is_absolute(), "thread path should be absolute");
    assert!(
        !thread_path.exists(),
        "fresh thread rollout should not be materialized until first user message"
    );

    // Wire contract: thread title field is `name`, serialized as null when unset.
    let thread_json = resp_result
        .get("thread")
        .and_then(Value::as_object)
        .expect("thread/start result.thread must be an object");
    assert_eq!(
        thread_json.get("sessionId").and_then(Value::as_str),
        Some(thread.session_id.as_str()),
        "new threads should serialize `sessionId` on the thread object"
    );
    assert_eq!(
        thread_json.get("name"),
        Some(&Value::Null),
        "new threads should serialize `name: null`"
    );
    assert_eq!(
        resp_result.get("sessionId"),
        None,
        "thread/start should not serialize a top-level `sessionId`"
    );
    assert_eq!(
        thread_json.get("ephemeral").and_then(Value::as_bool),
        Some(false),
        "new persistent threads should serialize `ephemeral: false`"
    );
    assert_eq!(
        thread_json.get("threadSource").and_then(Value::as_str),
        Some("user"),
        "new threads should serialize the caller-supplied thread origin"
    );
    assert_eq!(thread.name, None);

    // A corresponding thread/started notification should arrive.
    let deadline = tokio::time::Instant::now() + DEFAULT_READ_TIMEOUT;
    let notif = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let message = timeout(remaining, mcp.read_next_message()).await??;
        let JSONRPCMessage::Notification(notif) = message else {
            continue;
        };
        if notif.method == "thread/status/changed" {
            let status_changed: ThreadStatusChangedNotification =
                serde_json::from_value(notif.params.expect("params must be present"))?;
            if status_changed.thread_id == thread.id {
                anyhow::bail!(
                    "thread/start should introduce the thread without a preceding thread/status/changed"
                );
            }
            continue;
        }
        if notif.method == "thread/started" {
            break notif;
        }
    };
    let started_params = notif.params.clone().expect("params must be present");
    let started_thread_json = started_params
        .get("thread")
        .and_then(Value::as_object)
        .expect("thread/started params.thread must be an object");
    assert_eq!(
        started_thread_json.get("name"),
        Some(&Value::Null),
        "thread/started should serialize `name: null` for new threads"
    );
    assert_eq!(
        started_thread_json
            .get("ephemeral")
            .and_then(Value::as_bool),
        Some(false),
        "thread/started should serialize `ephemeral: false` for new persistent threads"
    );
    assert_eq!(
        started_thread_json
            .get("threadSource")
            .and_then(Value::as_str),
        Some("user"),
        "thread/started should preserve the caller-supplied thread origin"
    );
    let started: ThreadStartedNotification =
        serde_json::from_value(notif.params.expect("params must be present"))?;
    assert_eq!(started.thread, thread);

    Ok(())
}

#[tokio::test]
async fn thread_start_accepts_absolute_runtime_workspace_roots() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let cwd_tmp = TempDir::new()?;
    let cwd = cwd_tmp.path().to_path_buf();
    let extra_root = cwd.join("extra-root");
    std::fs::create_dir_all(&extra_root)?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(cwd.to_string_lossy().to_string()),
            runtime_workspace_roots: Some(vec![extra_root.abs()]),
            ..Default::default()
        })
        .await?;

    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let ThreadStartResponse {
        cwd: response_cwd,
        runtime_workspace_roots,
        ..
    } = to_response::<ThreadStartResponse>(resp)?;

    assert_eq!(response_cwd, cwd.abs());
    assert_eq!(runtime_workspace_roots, vec![extra_root.abs()]);

    Ok(())
}

#[tokio::test]
async fn thread_start_excludes_profile_workspace_roots_from_runtime_workspace_roots() -> Result<()>
{
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    let cwd = TempDir::new()?;
    let profile_root = TempDir::new()?;
    create_config_toml_with_profile_workspace_root(
        codex_home.path(),
        &server.uri(),
        profile_root.path(),
    )?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(cwd.path().to_string_lossy().to_string()),
            ..Default::default()
        })
        .await?;

    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let ThreadStartResponse {
        runtime_workspace_roots,
        ..
    } = to_response::<ThreadStartResponse>(resp)?;

    assert_eq!(
        runtime_workspace_roots,
        vec![cwd.path().to_path_buf().abs()]
    );

    Ok(())
}

#[tokio::test]
async fn thread_start_rejects_unknown_environment_as_invalid_request() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            environments: Some(vec![TurnEnvironmentParams {
                environment_id: "missing".to_string(),
                cwd: codex_home.path().to_path_buf().try_into()?,
            }]),
            ..Default::default()
        })
        .await?;

    let error: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;

    assert_eq!(error.id, RequestId::Integer(request_id));
    assert_eq!(error.error.code, INVALID_REQUEST_ERROR_CODE);
    assert_eq!(error.error.message, "unknown turn environment id `missing`");

    Ok(())
}

#[tokio::test]
async fn thread_start_response_includes_loaded_instruction_sources() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let global_agents_path = codex_home.path().join("AGENTS.md");
    std::fs::write(&global_agents_path, "global instructions")?;
    let workspace = TempDir::new()?;
    let project_agents_path = workspace.path().join("AGENTS.md");
    std::fs::write(&project_agents_path, "project instructions")?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse {
        instruction_sources,
        ..
    } = to_response::<ThreadStartResponse>(response)?;

    let instruction_sources = instruction_sources
        .into_iter()
        .map(normalize_path_for_comparison)
        .collect::<Vec<_>>();
    let expected_instruction_sources = vec![
        std::fs::canonicalize(global_agents_path)?,
        project_agents_path,
    ]
    .into_iter()
    .map(normalize_path_for_comparison)
    .collect::<Vec<_>>();

    assert_eq!(instruction_sources, expected_instruction_sources);

    Ok(())
}

#[tokio::test]
async fn thread_start_response_excludes_empty_project_instruction_source() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    let global_agents_path = codex_home.path().join("AGENTS.md");
    std::fs::write(&global_agents_path, "global instructions")?;
    let workspace = TempDir::new()?;
    let project_agents_path = workspace.path().join("AGENTS.md");
    std::fs::write(project_agents_path, "")?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse {
        instruction_sources,
        ..
    } = to_response::<ThreadStartResponse>(response)?;

    let instruction_sources = instruction_sources
        .into_iter()
        .map(normalize_path_for_comparison)
        .collect::<Vec<_>>();
    let expected_instruction_sources = vec![normalize_path_for_comparison(std::fs::canonicalize(
        global_agents_path,
    )?)];

    assert_eq!(instruction_sources, expected_instruction_sources);

    Ok(())
}

#[tokio::test]
async fn thread_start_without_selected_environment_excludes_instruction_sources() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;
    std::fs::write(codex_home.path().join("AGENTS.md"), "global instructions")?;
    let workspace = TempDir::new()?;
    std::fs::write(workspace.path().join("AGENTS.md"), "project instructions")?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            environments: Some(Vec::new()),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse {
        instruction_sources,
        ..
    } = to_response::<ThreadStartResponse>(response)?;

    assert!(instruction_sources.is_empty());

    Ok(())
}

#[cfg(windows)]
fn normalize_path_for_comparison(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let path = path.display().to_string();
    PathBuf::from(path.strip_prefix(r"\\?\").unwrap_or(&path))
}

#[cfg(not(windows))]
fn normalize_path_for_comparison(path: impl AsRef<Path>) -> PathBuf {
    path.as_ref().to_path_buf()
}

#[tokio::test]
async fn thread_start_tracks_thread_initialized_analytics() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_with_chatgpt_base_url(codex_home.path(), &server.uri(), &server.uri())?;
    mount_analytics_capture(&server, codex_home.path()).await?;

    let mut mcp = TestAppServer::new_without_managed_config(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            thread_source: Some(ThreadSource::User),
            ..Default::default()
        })
        .await?;
    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(resp)?;

    let payload = wait_for_analytics_payload(&server, DEFAULT_READ_TIMEOUT).await?;
    assert_eq!(payload["events"].as_array().expect("events array").len(), 1);
    let event = thread_initialized_event(&payload)?;
    assert_basic_thread_initialized_event(
        event,
        &thread.id,
        &thread.session_id,
        "mock-model",
        "new",
        "user",
    );
    Ok(())
}

#[tokio::test]
async fn thread_start_respects_project_config_from_cwd() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let workspace = TempDir::new()?;
    let project_config_dir = workspace.path().join(".codex");
    std::fs::create_dir_all(&project_config_dir)?;
    std::fs::write(
        project_config_dir.join("config.toml"),
        r#"
model_reasoning_effort = "high"
"#,
    )?;
    set_project_trust_level(codex_home.path(), workspace.path(), TrustLevel::Trusted)?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().to_string_lossy().into_owned()),
            ..Default::default()
        })
        .await?;

    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let ThreadStartResponse {
        reasoning_effort, ..
    } = to_response::<ThreadStartResponse>(resp)?;

    assert_eq!(reasoning_effort, Some(ReasoningEffort::High));
    Ok(())
}

#[tokio::test]
async fn thread_start_drops_unsupported_service_tier_id() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let service_tier_id = "experimental-tier-id".to_string();
    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            service_tier: Some(Some(service_tier_id.clone())),
            ..Default::default()
        })
        .await?;

    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let ThreadStartResponse { service_tier, .. } = to_response::<ThreadStartResponse>(resp)?;

    // Unsupported catalog ids are dropped at session config time instead of echoed back.
    assert_eq!(service_tier, None);
    Ok(())
}

#[tokio::test]
async fn thread_start_accepts_default_service_tier() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            service_tier: Some(Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string())),
            ..Default::default()
        })
        .await?;

    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let ThreadStartResponse { service_tier, .. } = to_response::<ThreadStartResponse>(resp)?;

    assert_eq!(
        service_tier,
        Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string())
    );
    Ok(())
}

#[tokio::test]
async fn thread_start_accepts_metrics_service_name() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            service_name: Some("my_app_server_client".to_string()),
            ..Default::default()
        })
        .await?;

    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(resp)?;
    assert!(!thread.id.is_empty(), "thread id should not be empty");

    Ok(())
}

#[tokio::test]
async fn thread_start_ephemeral_remains_pathless() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams {
            model: Some("gpt-5.2".to_string()),
            ephemeral: Some(true),
            ..Default::default()
        })
        .await?;

    let resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
    )
    .await??;
    let resp_result = resp.result.clone();
    let ThreadStartResponse { thread, .. } = to_response::<ThreadStartResponse>(resp)?;
    assert!(
        thread.ephemeral,
        "ephemeral threads should be marked explicitly"
    );
    assert_eq!(
        thread.path, None,
        "ephemeral threads should not expose a path"
    );
    let thread_json = resp_result
        .get("thread")
        .and_then(Value::as_object)
        .expect("thread/start result.thread must be an object");
    assert_eq!(
        thread_json.get("ephemeral").and_then(Value::as_bool),
        Some(true),
        "ephemeral threads should serialize `ephemeral: true`"
    );

    Ok(())
}

#[tokio::test]
async fn thread_start_fails_when_required_mcp_server_fails_to_initialize() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_with_required_broken_mcp(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams::default())
        .await?;

    let err: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(req_id)),
    )
    .await??;

    assert!(
        err.error
            .message
            .contains("required MCP servers failed to initialize"),
        "unexpected error message: {}",
        err.error.message
    );
    assert!(
        err.error.message.contains("required_broken"),
        "unexpected error message: {}",
        err.error.message
    );

    Ok(())
}

#[tokio::test]
async fn thread_start_emits_mcp_server_status_updated_notifications() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_with_optional_broken_mcp(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams::default())
        .await?;

    let start_response: ThreadStartResponse = to_response(
        timeout(
            DEFAULT_READ_TIMEOUT,
            mcp.read_stream_until_response_message(RequestId::Integer(req_id)),
        )
        .await??,
    )?;

    let starting = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_matching_notification(
            "mcpServer/startupStatus/updated starting",
            |notification| {
                notification.method == "mcpServer/startupStatus/updated"
                    && notification
                        .params
                        .as_ref()
                        .and_then(|params| params.get("name"))
                        .and_then(Value::as_str)
                        == Some("optional_broken")
                    && notification
                        .params
                        .as_ref()
                        .and_then(|params| params.get("status"))
                        .and_then(Value::as_str)
                        == Some("starting")
            },
        ),
    )
    .await??;
    let starting: ServerNotification = starting.try_into()?;
    let ServerNotification::McpServerStatusUpdated(starting) = starting else {
        anyhow::bail!("unexpected notification variant");
    };
    assert_eq!(
        starting,
        McpServerStatusUpdatedNotification {
            thread_id: Some(start_response.thread.id.clone()),
            name: "optional_broken".to_string(),
            status: McpServerStartupState::Starting,
            error: None,
        }
    );

    let failed = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_matching_notification(
            "mcpServer/startupStatus/updated failed",
            |notification| {
                notification.method == "mcpServer/startupStatus/updated"
                    && notification
                        .params
                        .as_ref()
                        .and_then(|params| params.get("name"))
                        .and_then(Value::as_str)
                        == Some("optional_broken")
                    && notification
                        .params
                        .as_ref()
                        .and_then(|params| params.get("status"))
                        .and_then(Value::as_str)
                        == Some("failed")
            },
        ),
    )
    .await??;
    let failed: ServerNotification = failed.try_into()?;
    let ServerNotification::McpServerStatusUpdated(failed) = failed else {
        anyhow::bail!("unexpected notification variant");
    };
    assert_eq!(failed.thread_id, Some(start_response.thread.id));
    assert_eq!(failed.name, "optional_broken");
    assert_eq!(failed.status, McpServerStartupState::Failed);
    assert!(
        failed
            .error
            .as_deref()
            .is_some_and(|error| error.contains("MCP client for `optional_broken` failed to start")),
        "unexpected MCP startup error: {:?}",
        failed.error
    );

    Ok(())
}

#[tokio::test]
async fn thread_start_surfaces_cloud_config_bundle_load_errors() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/backend-api/wham/config/bundle"))
        .respond_with(
            ResponseTemplate::new(401)
                .insert_header("content-type", "text/html")
                .set_body_string("<html>nope</html>"),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/oauth/token"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "error": { "code": "refresh_token_invalidated" }
        })))
        .mount(&server)
        .await;

    let codex_home = TempDir::new()?;
    let model_server = create_mock_responses_server_repeating_assistant("Done").await;
    let chatgpt_base_url = format!("{}/backend-api", server.uri());
    create_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &model_server.uri(),
        &chatgpt_base_url,
    )?;
    write_chatgpt_auth(
        codex_home.path(),
        ChatGptAuthFixture::new("chatgpt-token")
            .refresh_token("stale-refresh-token")
            .plan_type("business")
            .chatgpt_user_id("user-123")
            .chatgpt_account_id("account-123")
            .account_id("account-123"),
        AuthCredentialsStoreMode::File,
    )?;

    let refresh_token_url = format!("{}/oauth/token", server.uri());
    let mut mcp = TestAppServer::new_with_env(
        codex_home.path(),
        &[
            ("OPENAI_API_KEY", None),
            (
                REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR,
                Some(refresh_token_url.as_str()),
            ),
        ],
    )
    .await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let req_id = mcp
        .send_thread_start_request(ThreadStartParams::default())
        .await?;

    let err: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(req_id)),
    )
    .await??;

    assert!(
        err.error.message.contains("failed to load configuration"),
        "unexpected error message: {}",
        err.error.message
    );
    assert_eq!(
        err.error.data,
        Some(json!({
            "reason": "cloudConfigBundle",
            "errorCode": "Auth",
            "action": "relogin",
            "statusCode": 401,
            "detail": "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
        }))
    );

    Ok(())
}

#[tokio::test]
async fn thread_start_with_elevated_sandbox_trusts_project_and_followup_loads_project_config()
-> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let workspace = TempDir::new()?;
    let project_config_dir = workspace.path().join(".codex");
    std::fs::create_dir_all(&project_config_dir)?;
    std::fs::write(
        project_config_dir.join("config.toml"),
        r#"
model_reasoning_effort = "high"
"#,
    )?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let first_request = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            sandbox: Some(SandboxMode::WorkspaceWrite),
            ..Default::default()
        })
        .await?;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(first_request)),
    )
    .await??;

    let second_request = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            ..Default::default()
        })
        .await?;
    let second_response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(second_request)),
    )
    .await??;
    let ThreadStartResponse {
        approval_policy,
        reasoning_effort,
        ..
    } = to_response::<ThreadStartResponse>(second_response)?;

    assert_eq!(approval_policy, AskForApproval::OnRequest);
    assert_eq!(reasoning_effort, Some(ReasoningEffort::High));

    let config_toml = std::fs::read_to_string(codex_home.path().join("config.toml"))?;
    let workspace_abs = workspace.path().to_path_buf().abs();
    let trusted_root = resolve_root_git_project_for_trust(LOCAL_FS.as_ref(), &workspace_abs)
        .await
        .unwrap_or(workspace_abs);
    let trusted_root_key = project_trust_key(trusted_root.as_path());
    assert!(config_toml.contains(&trusted_root_key));
    assert!(config_toml.contains("trust_level = \"trusted\""));

    Ok(())
}

#[tokio::test]
async fn thread_start_with_nested_git_cwd_trusts_repo_root() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let repo_root = TempDir::new()?;
    std::fs::create_dir(repo_root.path().join(".git"))?;
    let nested = repo_root.path().join("nested/project");
    std::fs::create_dir_all(&nested)?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(nested.display().to_string()),
            sandbox: Some(SandboxMode::WorkspaceWrite),
            ..Default::default()
        })
        .await?;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;

    let config_toml = std::fs::read_to_string(codex_home.path().join("config.toml"))?;
    let nested_abs = nested.abs();
    let trusted_root = resolve_root_git_project_for_trust(LOCAL_FS.as_ref(), &nested_abs)
        .await
        .expect("git root should resolve");
    let trusted_root_key = project_trust_key(trusted_root.as_path());
    let nested_key = project_trust_key(&nested);
    assert!(config_toml.contains(&trusted_root_key));
    assert!(!config_toml.contains(&nested_key));

    Ok(())
}

#[tokio::test]
async fn thread_start_with_read_only_sandbox_does_not_persist_project_trust() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let workspace = TempDir::new()?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            ..Default::default()
        })
        .await?;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;

    let config_toml = std::fs::read_to_string(codex_home.path().join("config.toml"))?;
    assert!(!config_toml.contains("trust_level = \"trusted\""));
    assert!(!config_toml.contains(&workspace.path().display().to_string()));

    Ok(())
}

#[tokio::test]
async fn thread_start_preserves_untrusted_project_trust() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let workspace = TempDir::new()?;
    let config_path = codex_home.path().join("config.toml");
    let workspace_key = workspace.path().display().to_string();
    let mut config_toml =
        std::fs::read_to_string(&config_path)?.parse::<toml_edit::DocumentMut>()?;
    config_toml["projects"][workspace_key.as_str()]["trust_level"] = toml_edit::value("untrusted");
    std::fs::write(&config_path, config_toml.to_string())?;
    let config_before = std::fs::read_to_string(&config_path)?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            sandbox: Some(SandboxMode::WorkspaceWrite),
            ..Default::default()
        })
        .await?;
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;

    let config_after = std::fs::read_to_string(&config_path)?;
    assert_eq!(config_after, config_before);

    Ok(())
}

#[tokio::test]
async fn thread_start_skips_trust_write_when_project_is_already_trusted() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;

    let codex_home = TempDir::new()?;
    create_config_toml_without_approval_policy(codex_home.path(), &server.uri())?;

    let workspace = TempDir::new()?;
    let project_config_dir = workspace.path().join(".codex");
    std::fs::create_dir_all(&project_config_dir)?;
    std::fs::write(
        project_config_dir.join("config.toml"),
        r#"
model_reasoning_effort = "high"
"#,
    )?;
    set_project_trust_level(codex_home.path(), workspace.path(), TrustLevel::Trusted)?;
    let config_before = std::fs::read_to_string(codex_home.path().join("config.toml"))?;

    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().display().to_string()),
            sandbox: Some(SandboxMode::WorkspaceWrite),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let ThreadStartResponse {
        approval_policy,
        reasoning_effort,
        ..
    } = to_response::<ThreadStartResponse>(response)?;

    assert_eq!(approval_policy, AskForApproval::OnRequest);
    assert_eq!(reasoning_effort, Some(ReasoningEffort::High));

    let config_after = std::fs::read_to_string(codex_home.path().join("config.toml"))?;
    assert_eq!(config_after, config_before);

    Ok(())
}

fn create_config_toml_without_approval_policy(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()> {
    create_config_toml_with_optional_approval_policy(
        codex_home, server_uri, /*approval_policy*/ None,
    )
}

fn create_config_toml_with_optional_approval_policy(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: Option<&str>,
) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    let approval_policy = approval_policy
        .map(|policy| format!("approval_policy = \"{policy}\"\n"))
        .unwrap_or_default();
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
{approval_policy}sandbox_mode = "read-only"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#
        ),
    )
}

fn create_config_toml_with_profile_workspace_root(
    codex_home: &Path,
    server_uri: &str,
    profile_root: &Path,
) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    let profile_root_key = profile_root
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
default_permissions = "dev"
model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[permissions.dev.workspace_roots]
"{profile_root_key}" = true

[permissions.dev.filesystem.":workspace_roots"]
"." = "write"
"#,
        ),
    )
}

fn create_config_toml_with_chatgpt_base_url(
    codex_home: &Path,
    server_uri: &str,
    chatgpt_base_url: &str,
) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"
chatgpt_base_url = "{chatgpt_base_url}"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#
        ),
    )
}

fn create_config_toml_with_required_broken_mcp(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[mcp_servers.required_broken]
{required_broken_transport}
required = true
"#,
            required_broken_transport = broken_mcp_transport_toml()
        ),
    )
}

fn create_config_toml_with_optional_broken_mcp(
    codex_home: &Path,
    server_uri: &str,
) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[mcp_servers.optional_broken]
{optional_broken_transport}
"#,
            optional_broken_transport = broken_mcp_transport_toml()
        ),
    )
}

#[cfg(target_os = "windows")]
fn broken_mcp_transport_toml() -> &'static str {
    r#"command = "cmd"
args = ["/C", "exit 1"]"#
}

#[cfg(not(target_os = "windows"))]
fn broken_mcp_transport_toml() -> &'static str {
    r#"command = "/bin/sh"
args = ["-c", "exit 1"]"#
}
