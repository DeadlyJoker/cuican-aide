use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crewon_app_server_protocol::AgentPlatformAgentInfoResponse;
use crewon_app_server_protocol::AgentPlatformAgentParams;
use crewon_app_server_protocol::AgentPlatformAuthParams;
use crewon_app_server_protocol::AgentPlatformChatCompletedNotification;
use crewon_app_server_protocol::AgentPlatformChatDeltaNotification;
use crewon_app_server_protocol::AgentPlatformChatFailedNotification;
use crewon_app_server_protocol::AgentPlatformChatParams;
use crewon_app_server_protocol::AgentPlatformChatResponse;
use crewon_app_server_protocol::AgentPlatformHistoryMessage;
use crewon_app_server_protocol::AgentPlatformResourceEvent;
use crewon_app_server_protocol::AgentPlatformResourceEventNotification;
use crewon_app_server_protocol::AgentPlatformResourceStatus;
use crewon_app_server_protocol::AgentPlatformResourceType;
use crewon_app_server_protocol::AgentPlatformRunCancelParams;
use crewon_app_server_protocol::AgentPlatformSessionParams;
use crewon_app_server_protocol::AgentPlatformTokenUsage;
use crewon_app_server_protocol::AgentPlatformUser;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ServerNotification;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use tempfile::TempDir;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::AdmissionController;
use super::AgentPlatformRequestProcessor;
use super::Inner;
use super::MAX_ACCESS_TOKEN_BYTES;
use super::MAX_AGENT_ID_BYTES;
use super::MAX_CONTEXT_TOKENS;
use super::MAX_HISTORY_MESSAGES;
use super::MAX_REMOTE_JSON_BYTES;
use super::MAX_SESSION_FILES;
use super::MAX_THREAD_ID_BYTES;
use super::RemoteAgentInfo;
use super::RemoteChatResponse;
use super::RunRecord;
use super::RunState;
use super::take_sse_frame;
use super::trim_history;
use super::validate_chat_params;
use crate::error_code::INTERNAL_ERROR_CODE;
use crate::error_code::INVALID_PARAMS_ERROR_CODE;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingEnvelope;
use crate::outgoing_message::OutgoingMessage;
use crate::outgoing_message::OutgoingMessageSender;

const ACCESS_TOKEN: &str = "owner-token";
const API_KEY: &str = "space-api-key";
const AGENT_ID: &str = "agent-7";
const THREAD_ID: &str = "thread-1";
const USER_ID: i64 = 42;
const CONNECTION: ConnectionId = ConnectionId(7);

#[derive(Clone, Copy)]
struct TestTimeouts {
    preflight: Duration,
    request: Duration,
    stream_idle: Duration,
    stream_total: Duration,
}

impl Default for TestTimeouts {
    fn default() -> Self {
        Self {
            preflight: Duration::from_secs(2),
            request: Duration::from_secs(2),
            stream_idle: Duration::from_secs(2),
            stream_total: Duration::from_secs(5),
        }
    }
}

struct TestProcessor {
    processor: AgentPlatformRequestProcessor,
    notifications: mpsc::Receiver<OutgoingEnvelope>,
}

fn test_processor(
    server: &MockServer,
    history_root: &Path,
    timeouts: TestTimeouts,
) -> TestProcessor {
    test_processor_for_base_url(server.uri(), history_root, timeouts)
}

fn test_processor_for_base_url(
    base_url: String,
    history_root: &Path,
    timeouts: TestTimeouts,
) -> TestProcessor {
    std::fs::create_dir_all(history_root).expect("history directory should be created");
    let (sender, notifications) = mpsc::channel(/*buffer*/ 64);
    let outgoing = Arc::new(OutgoingMessageSender::new(
        sender,
        crewon_analytics::AnalyticsEventsClient::disabled(),
    ));
    let client = reqwest::Client::builder()
        .connect_timeout(timeouts.request)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("test HTTP client should build");
    let processor = AgentPlatformRequestProcessor {
        inner: Arc::new(Inner {
            admission: AdmissionController::new(),
            base_url: Some(base_url),
            allow_insecure_http: false,
            api_key: Some(API_KEY.to_string()),
            client,
            history_root: history_root.to_path_buf(),
            history_write_lock: Mutex::new(()),
            outgoing,
            preflight_timeout: timeouts.preflight,
            request_timeout: timeouts.request,
            runs: Mutex::new(HashMap::new()),
            session_locks: Mutex::new(HashMap::new()),
            stream_idle_timeout: timeouts.stream_idle,
            stream_total_timeout: timeouts.stream_total,
        }),
    };
    TestProcessor {
        processor,
        notifications,
    }
}

fn chat_params(
    access_token: &str,
    thread_id: &str,
    agent_id: &str,
    message: &str,
) -> AgentPlatformChatParams {
    AgentPlatformChatParams {
        access_token: access_token.to_string(),
        thread_id: thread_id.to_string(),
        agent_id: agent_id.to_string(),
        message: message.to_string(),
    }
}

fn session_params(
    access_token: &str,
    thread_id: &str,
    agent_id: &str,
) -> AgentPlatformSessionParams {
    AgentPlatformSessionParams {
        access_token: access_token.to_string(),
        thread_id: thread_id.to_string(),
        agent_id: agent_id.to_string(),
    }
}

async fn mount_user(server: &MockServer, access_token: &str, user_id: i64) {
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/me"))
        .and(header("authorization", format!("Bearer {access_token}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": user_id,
            "username": format!("user-{user_id}"),
        })))
        .mount(server)
        .await;
}

async fn mount_agent_status(
    server: &MockServer,
    access_token: &str,
    agent_id: &str,
    api_enabled: i64,
) {
    mount_agent_status_alias(server, access_token, agent_id, agent_id, api_enabled).await;
}

async fn mount_agent_status_alias(
    server: &MockServer,
    access_token: &str,
    requested_agent_id: &str,
    canonical_agent_id: &str,
    api_enabled: i64,
) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/agents/{requested_agent_id}/api-status"
        )))
        .and(header("authorization", format!("Bearer {access_token}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 7,
            "uid": canonical_agent_id,
            "api_enabled": api_enabled,
        })))
        .mount(server)
        .await;
}

fn chat_response(agent_id: &str, answer: &str, duration_ms: u64) -> Value {
    json!({
        "agent_id": agent_id,
        "message": answer,
        "thoughts": [],
        "skills_used": [],
        "tokens": {
            "prompt_tokens": 3,
            "completion_tokens": 2,
            "total_tokens": 5,
        },
        "duration_ms": duration_ms,
    })
}

fn sse_response(body: impl Into<String>) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(body)
}

async fn next_notification(
    notifications: &mut mpsc::Receiver<OutgoingEnvelope>,
    connection_id: ConnectionId,
) -> ServerNotification {
    let envelope = tokio::time::timeout(Duration::from_secs(2), notifications.recv())
        .await
        .expect("notification should arrive before the test timeout")
        .expect("notification channel should remain open");
    match envelope {
        OutgoingEnvelope::ToConnection {
            connection_id: actual_connection_id,
            message: OutgoingMessage::AppServerNotification(notification),
            ..
        } => {
            assert_eq!(actual_connection_id, connection_id);
            notification
        }
        other => panic!("unexpected outgoing message: {other:?}"),
    }
}

fn message(role: &str, content: impl Into<String>) -> AgentPlatformHistoryMessage {
    AgentPlatformHistoryMessage {
        role: role.to_string(),
        content: content.into(),
    }
}

#[test]
fn public_http_requires_an_explicit_insecure_transport_opt_in() {
    let temp = TempDir::new().expect("temporary history root should be created");
    let mut test = test_processor_for_base_url(
        "http://example.com/api".to_string(),
        temp.path(),
        TestTimeouts::default(),
    );

    let error = test
        .processor
        .base_url()
        .expect_err("public HTTP should be rejected by default");
    assert!(error.message.contains("must use HTTPS"));

    Arc::get_mut(&mut test.processor.inner)
        .expect("test processor should have unique ownership")
        .allow_insecure_http = true;
    assert_eq!(
        test.processor
            .base_url()
            .expect("explicit opt-in should permit public HTTP"),
        "http://example.com/api"
    );
}

#[test]
fn history_keeps_only_the_latest_ten_completed_rounds() {
    let history = (0..12)
        .flat_map(|index| {
            [
                message("user", format!("question-{index}")),
                message("assistant", format!("answer-{index}")),
            ]
        })
        .collect();

    let trimmed = trim_history(history, "current");

    assert_eq!(trimmed.len(), MAX_HISTORY_MESSAGES);
    assert_eq!(trimmed.first(), Some(&message("user", "question-2")));
    assert_eq!(trimmed.last(), Some(&message("assistant", "answer-11")));
}

#[test]
fn history_drops_oldest_messages_to_fit_the_context_limit() {
    let chunk_chars =
        crewon_utils_output_truncation::approx_bytes_for_tokens(MAX_CONTEXT_TOKENS / 3)
            / "问".len();
    let oldest_user = "旧".repeat(chunk_chars);
    let oldest_assistant = "答".repeat(chunk_chars);
    let latest_user = "新".repeat(chunk_chars);
    let latest_assistant = "复".repeat(chunk_chars);
    let current = "问".repeat(chunk_chars);
    let history = vec![
        message("user", oldest_user),
        message("assistant", oldest_assistant),
        message("user", latest_user.clone()),
        message("assistant", latest_assistant.clone()),
    ];

    let trimmed = trim_history(history, &current);

    assert_eq!(
        trimmed,
        vec![
            message("user", latest_user),
            message("assistant", latest_assistant),
        ]
    );
}

#[tokio::test]
async fn admission_enforces_per_connection_and_global_active_request_limits() {
    let admission = AdmissionController::new();
    let cancellation = CancellationToken::new();
    let expected_error = JSONRPCErrorError {
        code: 429,
        message: "Agent Platform active request limit reached".to_string(),
        data: None,
    };

    let mut connection_permits = Vec::new();
    for _ in 0..8 {
        connection_permits.push(
            admission
                .acquire(CONNECTION, &cancellation)
                .await
                .expect("the first eight requests on one connection should be admitted"),
        );
    }
    let Err(connection_error) = admission.acquire(CONNECTION, &cancellation).await else {
        panic!("the ninth request on one connection should be rejected");
    };
    assert_eq!(connection_error, expected_error);
    drop(connection_permits.pop());
    let replacement = admission
        .acquire(CONNECTION, &cancellation)
        .await
        .expect("releasing a connection permit should restore capacity");
    drop(replacement);
    drop(connection_permits);

    let mut global_permits = Vec::new();
    for connection_offset in 0..8 {
        for _ in 0..8 {
            global_permits.push(
                admission
                    .acquire(ConnectionId(100 + connection_offset), &cancellation)
                    .await
                    .expect("the first 64 requests should be globally admitted"),
            );
        }
    }
    let Err(global_error) = admission.acquire(ConnectionId(999), &cancellation).await else {
        panic!("the 65th active request should be rejected");
    };
    assert_eq!(global_error, expected_error);
    drop(global_permits.pop());
    admission
        .acquire(ConnectionId(999), &cancellation)
        .await
        .expect("releasing a global permit should restore capacity");
}

#[test]
fn remote_snake_case_payloads_convert_to_v2_responses() {
    let info = serde_json::from_value::<RemoteAgentInfo>(serde_json::json!({
        "id": 7,
        "uid": "agent-7",
        "name": "Test Agent",
        "description": "description",
        "max_concurrency": 5,
        "active_connections": 1
    }))
    .expect("remote Agent info should deserialize");
    let chat = serde_json::from_value::<RemoteChatResponse>(serde_json::json!({
        "agent_id": "agent-7",
        "message": "answer",
        "thoughts": [{"step": 1}],
        "skills_used": ["skill-12"],
        "tokens": {
            "prompt_tokens": 3,
            "completion_tokens": 2,
            "total_tokens": 5
        },
        "duration_ms": 42
    }))
    .expect("remote chat response should deserialize");

    assert_eq!(
        crewon_app_server_protocol::AgentPlatformAgentInfoResponse::from(info),
        crewon_app_server_protocol::AgentPlatformAgentInfoResponse {
            id: 7,
            uid: Some("agent-7".to_string()),
            name: "Test Agent".to_string(),
            description: Some("description".to_string()),
            max_concurrency: 5,
            active_connections: 1,
        }
    );
    assert_eq!(
        crewon_app_server_protocol::AgentPlatformChatResponse::from(chat),
        crewon_app_server_protocol::AgentPlatformChatResponse {
            agent_id: "agent-7".to_string(),
            message: "answer".to_string(),
            thoughts: vec![serde_json::json!({"step": 1})],
            skills_used: vec![serde_json::json!("skill-12")],
            resource_events: Vec::new(),
            tokens: crewon_app_server_protocol::AgentPlatformTokenUsage {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
            },
            duration_ms: 42,
        }
    );
}

#[test]
fn sse_frames_preserve_utf8_split_across_network_chunks() {
    let frame = "data: {\"event\":\"message\",\"chunk\":\"你好\"}\n\n".as_bytes();
    let split = frame
        .windows(3)
        .position(|window| window == "你".as_bytes())
        .expect("Chinese content should exist")
        + 1;
    let mut buffer = frame[..split].to_vec();

    let max_frame_bytes =
        crewon_utils_output_truncation::approx_bytes_for_tokens(MAX_CONTEXT_TOKENS);
    assert_eq!(
        take_sse_frame(&mut buffer, max_frame_bytes).expect("partial frame"),
        None
    );
    buffer.extend_from_slice(&frame[split..]);
    assert_eq!(
        take_sse_frame(&mut buffer, max_frame_bytes).expect("complete frame"),
        Some("data: {\"event\":\"message\",\"chunk\":\"你好\"}".to_string())
    );
    assert_eq!(buffer, Vec::<u8>::new());
}

#[test]
fn current_message_has_a_local_hard_limit() {
    assert_eq!(
        validate_chat_params(&chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question")),
        Ok(())
    );
    assert!(
        validate_chat_params(&chat_params(
            ACCESS_TOKEN,
            THREAD_ID,
            AGENT_ID,
            &"x".repeat(super::MAX_MESSAGE_CHARS + 1),
        ))
        .is_err()
    );
}

#[tokio::test]
async fn unsafe_or_oversized_rpc_identity_is_rejected_before_remote_access() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let test = test_processor(&server, temp.path(), TestTimeouts::default());
    let cases = [
        (
            chat_params(ACCESS_TOKEN, THREAD_ID, "../agent?admin=1", "question"),
            JSONRPCErrorError {
                code: INVALID_PARAMS_ERROR_CODE,
                message: "Agent Platform agentId must be a safe URL path segment".to_string(),
                data: None,
            },
        ),
        (
            chat_params(
                ACCESS_TOKEN,
                THREAD_ID,
                &"a".repeat(MAX_AGENT_ID_BYTES + 1),
                "question",
            ),
            JSONRPCErrorError {
                code: INVALID_PARAMS_ERROR_CODE,
                message: "Agent Platform agentId must be a safe URL path segment".to_string(),
                data: None,
            },
        ),
        (
            chat_params(
                ACCESS_TOKEN,
                &"t".repeat(MAX_THREAD_ID_BYTES + 1),
                AGENT_ID,
                "question",
            ),
            JSONRPCErrorError {
                code: INVALID_PARAMS_ERROR_CODE,
                message: format!(
                    "Agent Platform threadId must contain 1 to {MAX_THREAD_ID_BYTES} bytes"
                ),
                data: None,
            },
        ),
        (
            chat_params(
                &"t".repeat(MAX_ACCESS_TOKEN_BYTES + 1),
                THREAD_ID,
                AGENT_ID,
                "question",
            ),
            JSONRPCErrorError {
                code: 401,
                message: "missing or invalid Agent Platform access token".to_string(),
                data: None,
            },
        ),
    ];

    for (params, expected) in cases {
        assert_eq!(
            test.processor
                .chat(CONNECTION, params, CancellationToken::new())
                .await
                .expect_err("invalid identity should be rejected"),
            expected
        );
    }
    let requests = server
        .received_requests()
        .await
        .expect("mock server request journal should be readable");
    assert_eq!(requests.len(), 0);
}

#[tokio::test]
async fn remote_redirects_are_rejected_without_following_the_location() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let test = test_processor(&server, temp.path(), TestTimeouts::default());
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/me"))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", "/redirected-auth-target"),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/redirected-auth-target"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": USER_ID,
            "username": "redirected-user",
        })))
        .expect(0)
        .mount(&server)
        .await;

    let error = test
        .processor
        .authenticate(AgentPlatformAuthParams {
            access_token: ACCESS_TOKEN.to_string(),
        })
        .await
        .expect_err("Agent Platform redirects must not be followed");
    assert_eq!(
        error,
        JSONRPCErrorError {
            code: 302,
            message: "Agent Platform request failed with HTTP 302 Found".to_string(),
            data: None,
        }
    );
    server.verify().await;
}

#[tokio::test]
async fn cancellation_during_access_check_prevents_stream_run_registration() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let test = test_processor(&server, temp.path(), TestTimeouts::default());
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    let cancellation = CancellationToken::new();
    let cancel_on_status = cancellation.clone();
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/agents/{AGENT_ID}/api-status")))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(move |_: &wiremock::Request| {
            cancel_on_status.cancel();
            ResponseTemplate::new(200).set_body_json(json!({
                "id": 7,
                "uid": AGENT_ID,
                "api_enabled": 1,
            }))
        })
        .expect(1)
        .mount(&server)
        .await;

    let error = test
        .processor
        .chat_start(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            cancellation,
        )
        .await
        .expect_err("connection cancellation should prevent run registration");
    assert_eq!(
        error,
        JSONRPCErrorError {
            code: INTERNAL_ERROR_CODE,
            message: "Agent Platform connection closed".to_string(),
            data: None,
        }
    );
    assert!(test.processor.inner.runs.lock().await.is_empty());
    let requests = server
        .received_requests()
        .await
        .expect("mock server request journal should be readable");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.url.path())
            .collect::<Vec<_>>(),
        vec![
            "/api/v1/auth/me",
            &format!("/api/v1/agents/{AGENT_ID}/api-status"),
        ]
    );
    server.verify().await;
}

#[tokio::test]
async fn agent_info_requires_owner_bearer_and_space_api_key_and_rejects_disabled_agent() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let test = test_processor(&server, temp.path(), TestTimeouts::default());

    Mock::given(method("GET"))
        .and(path(format!("/api/v1/agents/{AGENT_ID}/api-status")))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 7,
            "uid": AGENT_ID,
            "api_enabled": 1,
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/info")))
        .and(header("x-api-key", API_KEY))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 7,
            "uid": AGENT_ID,
            "name": "Owned Agent",
            "description": "description",
            "max_concurrency": 3,
            "active_connections": 1,
        })))
        .expect(1)
        .mount(&server)
        .await;
    mount_agent_status(
        &server,
        ACCESS_TOKEN,
        "agent-disabled",
        /*api_enabled*/ 0,
    )
    .await;

    let info = test
        .processor
        .agent_info(AgentPlatformAgentParams {
            access_token: ACCESS_TOKEN.to_string(),
            agent_id: AGENT_ID.to_string(),
        })
        .await
        .expect("enabled owned Agent should be readable");
    assert_eq!(
        info,
        AgentPlatformAgentInfoResponse {
            id: 7,
            uid: Some(AGENT_ID.to_string()),
            name: "Owned Agent".to_string(),
            description: Some("description".to_string()),
            max_concurrency: 3,
            active_connections: 1,
        }
    );

    let error = test
        .processor
        .agent_info(AgentPlatformAgentParams {
            access_token: ACCESS_TOKEN.to_string(),
            agent_id: "agent-disabled".to_string(),
        })
        .await
        .expect_err("disabled Agent should be rejected before Open API access");
    assert_eq!(error.code, 403);
    assert_eq!(error.message, "Agent Open API is not enabled");
    server.verify().await;
}

#[tokio::test]
async fn agent_info_rejects_a_json_response_larger_than_one_megabyte() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let test = test_processor(&server, temp.path(), TestTimeouts::default());
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/info")))
        .and(header("x-api-key", API_KEY))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "padding": "x".repeat(MAX_REMOTE_JSON_BYTES),
        })))
        .expect(1)
        .mount(&server)
        .await;

    let error = test
        .processor
        .agent_info(AgentPlatformAgentParams {
            access_token: ACCESS_TOKEN.to_string(),
            agent_id: AGENT_ID.to_string(),
        })
        .await
        .expect_err("oversized Agent info response should be rejected");
    assert_eq!(
        error,
        JSONRPCErrorError {
            code: INTERNAL_ERROR_CODE,
            message: "Agent Platform response body was too large".to_string(),
            data: None,
        }
    );
    server.verify().await;
}

#[tokio::test]
async fn crlf_multiline_stream_frames_send_deltas_then_complete_and_persist_the_round() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let mut test = test_processor(&server, temp.path(), TestTimeouts::default());
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    let stream = concat!(
        "data: {\"event\":\"message\",\r\n",
        "data: \"chunk\":\"hello \"}\r\n\r\n",
        "data: {\"event\":\"message\",\r\n",
        "data: \"chunk\":\"world\"}\r\n\r\n",
        "data: {\"event\":\"resource_event\",\"type\":\"mcp\",\"status\":\"succeeded\",",
        "\"name\":\"echo\",\"input_summary\":{\"message\":\"hello\"},",
        "\"output_summary\":\"hello\",\"error\":null}\r\n\r\n",
        "data: {\"event\":\"done\",\"agent_thoughts\":[{\"step\":1}],\r\n",
        "data: \"skills_used\":[\"skill-12\"],\"resource_events\":[{\"type\":\"mcp\",\r\n",
        "data: \"status\":\"succeeded\",\"name\":\"echo\",\"input_summary\":{\"message\":\"hello\"},\r\n",
        "data: \"output_summary\":\"hello\",\"error\":null}],\"token_usage\":{\"prompt_tokens\":3,\r\n",
        "data: \"completion_tokens\":2,\"total_tokens\":5}}\r\n\r\n",
    );
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat/stream")))
        .and(header("x-api-key", API_KEY))
        .and(body_json(json!({
            "message": "question",
            "history": [],
        })))
        .respond_with(sse_response(stream))
        .expect(1)
        .mount(&server)
        .await;

    let started = test
        .processor
        .chat_start(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            CancellationToken::new(),
        )
        .await
        .expect("stream should start");
    for expected_delta in ["hello ", "world"] {
        let ServerNotification::AgentPlatformChatDelta(delta) =
            next_notification(&mut test.notifications, CONNECTION).await
        else {
            panic!("expected Agent Platform delta notification");
        };
        assert_eq!(
            delta,
            AgentPlatformChatDeltaNotification {
                run_id: started.run_id.clone(),
                thread_id: THREAD_ID.to_string(),
                agent_id: AGENT_ID.to_string(),
                delta: expected_delta.to_string(),
            }
        );
    }
    let resource_notification = next_notification(&mut test.notifications, CONNECTION).await;
    let ServerNotification::AgentPlatformResourceEvent(resource) = resource_notification else {
        panic!("expected Agent Platform resource notification, got {resource_notification:?}");
    };
    let expected_resource_event = AgentPlatformResourceEvent {
        r#type: AgentPlatformResourceType::Mcp,
        status: AgentPlatformResourceStatus::Succeeded,
        name: "echo".to_string(),
        input_summary: json!({"message": "hello"}),
        output_summary: json!("hello"),
        error: None,
    };
    assert_eq!(
        resource,
        AgentPlatformResourceEventNotification {
            run_id: started.run_id.clone(),
            thread_id: THREAD_ID.to_string(),
            agent_id: AGENT_ID.to_string(),
            event: expected_resource_event.clone(),
        }
    );
    let ServerNotification::AgentPlatformChatCompleted(completed) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected Agent Platform completed notification");
    };
    assert_eq!(
        completed,
        AgentPlatformChatCompletedNotification {
            run_id: started.run_id,
            thread_id: THREAD_ID.to_string(),
            agent_id: AGENT_ID.to_string(),
            message: "hello world".to_string(),
            thoughts: vec![json!({"step": 1})],
            skills_used: vec![json!("skill-12")],
            resource_events: vec![expected_resource_event],
            tokens: AgentPlatformTokenUsage {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
            },
            duration_ms: completed.duration_ms,
        }
    );

    let session = test
        .processor
        .session_read(session_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID))
        .await
        .expect("completed stream should be persisted");
    assert_eq!(
        session.messages,
        vec![
            message("user", "question"),
            message("assistant", "hello world")
        ]
    );
    server.verify().await;
}

#[tokio::test]
async fn numeric_agent_alias_uses_the_canonical_uid_for_open_api_and_session_storage() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let test = test_processor(&server, temp.path(), TestTimeouts::default());
    let numeric_alias = "7";
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status_alias(
        &server,
        ACCESS_TOKEN,
        numeric_alias,
        AGENT_ID,
        /*api_enabled*/ 1,
    )
    .await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat")))
        .and(header("x-api-key", API_KEY))
        .and(body_json(json!({
            "message": "canonical question",
            "history": [],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_response(
            AGENT_ID,
            "canonical answer",
            /*duration_ms*/ 17,
        )))
        .expect(1)
        .mount(&server)
        .await;

    let response = test
        .processor
        .chat(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, numeric_alias, "canonical question"),
            CancellationToken::new(),
        )
        .await
        .expect("numeric alias should resolve before Open API access");
    assert_eq!(
        response,
        AgentPlatformChatResponse {
            agent_id: AGENT_ID.to_string(),
            message: "canonical answer".to_string(),
            thoughts: Vec::new(),
            skills_used: Vec::new(),
            resource_events: Vec::new(),
            tokens: AgentPlatformTokenUsage {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
            },
            duration_ms: 17,
        }
    );
    let session = test
        .processor
        .session_read(session_params(ACCESS_TOKEN, THREAD_ID, numeric_alias))
        .await
        .expect("numeric alias should restore the canonical session");
    assert_eq!(
        session.messages,
        vec![
            message("user", "canonical question"),
            message("assistant", "canonical answer"),
        ]
    );
    assert!(
        test.processor
            .session_path(USER_ID, THREAD_ID, AGENT_ID)
            .exists()
    );
    assert!(
        !test
            .processor
            .session_path(USER_ID, THREAD_ID, numeric_alias)
            .exists()
    );
    let requests = server
        .received_requests()
        .await
        .expect("mock server request journal should be readable");
    assert_eq!(
        requests
            .iter()
            .map(|request| request.url.path().to_string())
            .collect::<Vec<_>>(),
        vec![
            "/api/v1/auth/me".to_string(),
            "/api/v1/agents/7/api-status".to_string(),
            format!("/api/v1/open/agent/{AGENT_ID}/chat"),
            "/api/v1/auth/me".to_string(),
            "/api/v1/agents/7/api-status".to_string(),
        ]
    );
    server.verify().await;
}

#[tokio::test]
async fn same_session_rejects_concurrency_and_cancel_is_connection_scoped_without_history() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let mut test = test_processor(&server, temp.path(), TestTimeouts::default());
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat/stream")))
        .and(header("x-api-key", API_KEY))
        .respond_with(
            sse_response("data: {\"event\":\"done\"}\n\n").set_delay(Duration::from_secs(5)),
        )
        .mount(&server)
        .await;

    let started = test
        .processor
        .chat_start(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "first"),
            CancellationToken::new(),
        )
        .await
        .expect("first stream should start");
    let conflict = test
        .processor
        .chat_start(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "second"),
            CancellationToken::new(),
        )
        .await
        .expect_err("same session should reject a concurrent run");
    assert_eq!(conflict.code, 409);

    let wrong_connection = test
        .processor
        .run_cancel(
            ConnectionId(8),
            AgentPlatformRunCancelParams {
                run_id: started.run_id.clone(),
            },
        )
        .await;
    assert_eq!(wrong_connection.cancelled, false);
    let owned_connection = test
        .processor
        .run_cancel(
            CONNECTION,
            AgentPlatformRunCancelParams {
                run_id: started.run_id.clone(),
            },
        )
        .await;
    assert_eq!(owned_connection.cancelled, true);

    let ServerNotification::AgentPlatformChatFailed(failed) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected Agent Platform failed notification");
    };
    assert_eq!(
        failed,
        AgentPlatformChatFailedNotification {
            run_id: started.run_id,
            thread_id: THREAD_ID.to_string(),
            agent_id: AGENT_ID.to_string(),
            error: "Agent Platform run cancelled".to_string(),
            code: INTERNAL_ERROR_CODE,
            cancelled: true,
        }
    );
    let session = test
        .processor
        .load_session(USER_ID, THREAD_ID, AGENT_ID)
        .await
        .expect("cancelled run should leave a readable session");
    assert_eq!(session.messages, Vec::<AgentPlatformHistoryMessage>::new());
}

#[tokio::test]
async fn cancel_is_rejected_after_run_enters_finalization() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let mut test = test_processor(&server, temp.path(), TestTimeouts::default());
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    let stream = concat!(
        "data: {\"event\":\"message\",\"chunk\":\"answer\"}\n\n",
        "data: {\"event\":\"done\",\"agent_thoughts\":[],\"skills_used\":[],",
        "\"token_usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
    );
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat/stream")))
        .and(header("x-api-key", API_KEY))
        .respond_with(sse_response(stream))
        .expect(1)
        .mount(&server)
        .await;
    let processor = test.processor.clone();
    let (history_lock_held_tx, history_lock_held_rx) = std::sync::mpsc::channel();
    let (release_history_lock_tx, release_history_lock_rx) = std::sync::mpsc::channel();
    let history_lock_thread = std::thread::spawn(move || {
        let _history_write_guard = processor.inner.history_write_lock.blocking_lock();
        history_lock_held_tx
            .send(())
            .expect("history write lock signal should be sent");
        release_history_lock_rx
            .recv()
            .expect("history write lock release should be received");
    });
    history_lock_held_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("history write lock should be held before the stream starts");
    let started = test
        .processor
        .chat_start(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            CancellationToken::new(),
        )
        .await
        .expect("stream should start");
    let ServerNotification::AgentPlatformChatDelta(delta) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected Agent Platform delta notification");
    };
    assert_eq!(delta.delta, "answer");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = test
                .processor
                .inner
                .runs
                .lock()
                .await
                .get(&started.run_id)
                .map(|record| record.state);
            if state == Some(RunState::Finalizing) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("run should enter finalization before history is written");
    let response = test
        .processor
        .run_cancel(
            CONNECTION,
            AgentPlatformRunCancelParams {
                run_id: started.run_id.clone(),
            },
        )
        .await;
    assert_eq!(response.cancelled, false);
    release_history_lock_tx
        .send(())
        .expect("history write lock should be released");
    history_lock_thread
        .join()
        .expect("history write lock thread should complete");

    let ServerNotification::AgentPlatformChatCompleted(completed) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected Agent Platform completed notification");
    };
    assert_eq!(completed.run_id, started.run_id);
    let session = test
        .processor
        .load_session(USER_ID, THREAD_ID, AGENT_ID)
        .await
        .expect("finalized run should persist its completed round");
    assert_eq!(
        session.messages,
        vec![message("user", "question"), message("assistant", "answer")]
    );
    server.verify().await;
}

#[tokio::test]
async fn remote_success_is_returned_when_local_history_limit_prevents_persistence() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let history_root = temp.path().join("sessions");
    let test = test_processor(&server, &history_root, TestTimeouts::default());
    for index in 0..MAX_SESSION_FILES {
        std::fs::write(history_root.join(format!("filler-{index}.json")), "{}")
            .expect("history limit fixture should be created");
    }
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat")))
        .and(header("x-api-key", API_KEY))
        .and(body_json(json!({
            "message": "question",
            "history": [],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_response(
            AGENT_ID,
            "remote answer",
            /*duration_ms*/ 19,
        )))
        .expect(1)
        .mount(&server)
        .await;

    let response = test
        .processor
        .chat(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            CancellationToken::new(),
        )
        .await
        .expect("remote success should not be changed by local persistence failure");

    assert_eq!(
        response,
        AgentPlatformChatResponse {
            agent_id: AGENT_ID.to_string(),
            message: "remote answer".to_string(),
            thoughts: Vec::new(),
            skills_used: Vec::new(),
            resource_events: Vec::new(),
            tokens: AgentPlatformTokenUsage {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
            },
            duration_ms: 19,
        }
    );
    assert_eq!(
        test.processor
            .session_path(USER_ID, THREAD_ID, AGENT_ID)
            .exists(),
        false
    );
    server.verify().await;
}

#[tokio::test]
async fn invalid_remote_answer_is_not_hidden_as_a_persistence_warning() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let test = test_processor(&server, temp.path(), TestTimeouts::default());
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat")))
        .and(header("x-api-key", API_KEY))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(chat_response(AGENT_ID, "   ", /*duration_ms*/ 3)),
        )
        .expect(1)
        .mount(&server)
        .await;

    let error = test
        .processor
        .chat(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            CancellationToken::new(),
        )
        .await
        .expect_err("blank remote answer should remain a response error");

    assert_eq!(
        error,
        JSONRPCErrorError {
            code: INTERNAL_ERROR_CODE,
            message: "Agent Platform returned an empty response".to_string(),
            data: None,
        }
    );
    assert_eq!(
        test.processor
            .session_path(USER_ID, THREAD_ID, AGENT_ID)
            .exists(),
        false
    );
    server.verify().await;
}

#[tokio::test]
async fn two_http_rounds_are_atomically_replaced_and_restore_with_identity_isolation() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let history_root = temp.path().join("sessions");
    let test = test_processor(&server, &history_root, TestTimeouts::default());
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat")))
        .and(header("x-api-key", API_KEY))
        .and(body_json(json!({
            "message": "question-one",
            "history": [],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_response(
            AGENT_ID,
            "answer-one",
            /*duration_ms*/ 10,
        )))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat")))
        .and(header("x-api-key", API_KEY))
        .and(body_json(json!({
            "message": "question-two",
            "history": [
                {"role": "user", "content": "question-one"},
                {"role": "assistant", "content": "answer-one"},
            ],
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(chat_response(
            AGENT_ID,
            "answer-two",
            /*duration_ms*/ 11,
        )))
        .expect(1)
        .mount(&server)
        .await;

    let first = test
        .processor
        .chat(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question-one"),
            CancellationToken::new(),
        )
        .await
        .expect("first HTTP round should complete");
    let second = test
        .processor
        .chat(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question-two"),
            CancellationToken::new(),
        )
        .await
        .expect("second HTTP round should complete");
    assert_eq!(first.message, "answer-one");
    assert_eq!(second.message, "answer-two");

    let stored: Value = serde_json::from_str(
        &tokio::fs::read_to_string(test.processor.session_path(USER_ID, THREAD_ID, AGENT_ID))
            .await
            .expect("session should be atomically persisted"),
    )
    .expect("stored session should be valid JSON");
    let expected_messages = vec![
        message("user", "question-one"),
        message("assistant", "answer-one"),
        message("user", "question-two"),
        message("assistant", "answer-two"),
    ];
    assert_eq!(
        stored,
        json!({
            "userId": USER_ID,
            "threadId": THREAD_ID,
            "agentId": AGENT_ID,
            "messages": expected_messages,
        })
    );
    let entries = std::fs::read_dir(&history_root)
        .expect("history directory should remain readable")
        .collect::<Result<Vec<_>, _>>()
        .expect("history entries should be readable");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0]
            .path()
            .extension()
            .and_then(std::ffi::OsStr::to_str),
        Some("json")
    );

    mount_user(&server, "other-token", /*user_id*/ 99).await;
    mount_agent_status(&server, "other-token", AGENT_ID, /*api_enabled*/ 1).await;
    mount_agent_status(&server, ACCESS_TOKEN, "agent-other", /*api_enabled*/ 1).await;
    let restored = test_processor(&server, &history_root, TestTimeouts::default());
    let same_session = restored
        .processor
        .session_read(session_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID))
        .await
        .expect("same identity should restore after processor reconstruction");
    assert_eq!(same_session.messages, expected_messages);
    for params in [
        session_params(ACCESS_TOKEN, "thread-other", AGENT_ID),
        session_params("other-token", THREAD_ID, AGENT_ID),
        session_params(ACCESS_TOKEN, THREAD_ID, "agent-other"),
    ] {
        let isolated = restored
            .processor
            .session_read(params)
            .await
            .expect("isolated identity should have an independent empty session");
        assert_eq!(isolated.messages, Vec::<AgentPlatformHistoryMessage>::new());
    }
    server.verify().await;
}

#[tokio::test]
async fn delayed_stream_headers_emit_timeout_failure_without_history() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let mut test = test_processor(
        &server,
        temp.path(),
        TestTimeouts {
            request: Duration::from_millis(500),
            stream_idle: Duration::from_secs(2),
            ..TestTimeouts::default()
        },
    );
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat/stream")))
        .and(header("x-api-key", API_KEY))
        .respond_with(
            sse_response("data: {\"event\":\"done\"}\n\n").set_delay(Duration::from_secs(2)),
        )
        .mount(&server)
        .await;

    let run_id = "run-timeout".to_string();
    let session_guard = Arc::new(Mutex::new(())).lock_owned().await;
    let cancellation = CancellationToken::new();
    test.processor.inner.runs.lock().await.insert(
        run_id.clone(),
        RunRecord {
            cancellation: cancellation.clone(),
            connection_id: CONNECTION,
            state: RunState::Running,
        },
    );
    let admission_permit = test
        .processor
        .inner
        .admission
        .acquire(CONNECTION, &cancellation)
        .await
        .expect("test stream should acquire admission");
    test.processor
        .run_stream(
            CONNECTION,
            run_id.clone(),
            AgentPlatformUser {
                id: USER_ID,
                username: "owner".to_string(),
            },
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            cancellation,
            session_guard,
            admission_permit,
        )
        .await;
    let ServerNotification::AgentPlatformChatFailed(failed) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected Agent Platform failed notification");
    };
    assert_eq!(failed.run_id, run_id);
    assert_eq!(failed.code, INTERNAL_ERROR_CODE);
    assert_eq!(failed.error, "Agent Platform response headers timed out");
    assert_eq!(failed.cancelled, false);
    let session = test
        .processor
        .load_session(USER_ID, THREAD_ID, AGENT_ID)
        .await
        .expect("timed-out run should leave a readable session");
    assert_eq!(session.messages, Vec::<AgentPlatformHistoryMessage>::new());
}

#[tokio::test]
async fn stream_total_deadline_wins_over_the_longer_request_timeout() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("test SSE listener should bind");
    let base_url = format!(
        "http://{}",
        listener
            .local_addr()
            .expect("test SSE listener should expose its address")
    );
    let temp = TempDir::new().expect("temporary history root should be created");
    let mut test = test_processor_for_base_url(
        base_url,
        temp.path(),
        TestTimeouts {
            preflight: Duration::from_secs(5),
            request: Duration::from_secs(5),
            stream_idle: Duration::from_secs(5),
            stream_total: Duration::from_secs(2),
        },
    );
    let (release_server, wait_for_release) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener
            .accept()
            .await
            .expect("test SSE connection should arrive");
        let mut request = [0; 4096];
        let request_len = socket
            .read(&mut request)
            .await
            .expect("test SSE request should be readable");
        let request = String::from_utf8_lossy(&request[..request_len]);
        assert!(request.starts_with(&format!(
            "POST /api/v1/open/agent/{AGENT_ID}/chat/stream HTTP/1.1"
        )));
        socket
            .write_all(
                concat!(
                    "HTTP/1.1 200 OK\r\n",
                    "Content-Type: text/event-stream\r\n",
                    "Connection: close\r\n\r\n",
                    "data: {\"event\":\"message\",\"chunk\":\"partial\"}\n\n",
                )
                .as_bytes(),
            )
            .await
            .expect("test SSE response should be writable");
        socket
            .flush()
            .await
            .expect("test SSE response should flush");
        let _ = wait_for_release.await;
    });
    let cancellation = CancellationToken::new();

    let error = test
        .processor
        .consume_stream(
            CONNECTION,
            "run-total-timeout",
            &chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            &[],
            &cancellation,
        )
        .await
        .expect_err("the total stream deadline should stop a delayed response");
    assert_eq!(
        error,
        JSONRPCErrorError {
            code: INTERNAL_ERROR_CODE,
            message: "Agent Platform stream total time limit reached".to_string(),
            data: None,
        }
    );
    let ServerNotification::AgentPlatformChatDelta(delta) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected a delta before the total stream deadline");
    };
    assert_eq!(delta.delta, "partial");
    let _ = release_server.send(());
    server_task
        .await
        .expect("test SSE server task should complete");
}

#[tokio::test]
async fn explicit_stream_error_emits_failure_without_committing_partial_output() {
    let server = MockServer::start().await;
    let temp = TempDir::new().expect("temporary history root should be created");
    let mut test = test_processor(&server, temp.path(), TestTimeouts::default());
    mount_user(&server, ACCESS_TOKEN, USER_ID).await;
    mount_agent_status(&server, ACCESS_TOKEN, AGENT_ID, /*api_enabled*/ 1).await;
    let stream = concat!(
        "data: {\"event\":\"message\",\"chunk\":\"partial\"}\n\n",
        "data: {\"event\":\"error\",\"message\":\"model failed\"}\n\n",
    );
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/chat/stream")))
        .and(header("x-api-key", API_KEY))
        .respond_with(sse_response(stream))
        .mount(&server)
        .await;

    let started = test
        .processor
        .chat_start(
            CONNECTION,
            chat_params(ACCESS_TOKEN, THREAD_ID, AGENT_ID, "question"),
            CancellationToken::new(),
        )
        .await
        .expect("stream should start");
    let ServerNotification::AgentPlatformChatDelta(delta) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected partial delta before explicit stream error");
    };
    assert_eq!(delta.delta, "partial");
    let ServerNotification::AgentPlatformChatFailed(failed) =
        next_notification(&mut test.notifications, CONNECTION).await
    else {
        panic!("expected Agent Platform failed notification");
    };
    assert_eq!(failed.run_id, started.run_id);
    assert_eq!(failed.code, INTERNAL_ERROR_CODE);
    assert_eq!(failed.error, "model failed");
    assert_eq!(failed.cancelled, false);
    let session = test
        .processor
        .load_session(USER_ID, THREAD_ID, AGENT_ID)
        .await
        .expect("failed stream should leave a readable session");
    assert_eq!(session.messages, Vec::<AgentPlatformHistoryMessage>::new());
}
