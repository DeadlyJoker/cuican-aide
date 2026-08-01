use std::sync::Arc;
use std::time::Duration;

use crewon_app_server_protocol::AgentPlatformAgentInfoResponse;
use crewon_app_server_protocol::AgentPlatformAgentParams;
use crewon_app_server_protocol::AgentPlatformAuthParams;
use crewon_app_server_protocol::AgentPlatformAuthResponse;
use crewon_app_server_protocol::AgentPlatformUser;
use crewon_app_server_protocol::AgentPlatformWorkflowExecuteParams;
use crewon_app_server_protocol::AgentPlatformWorkflowExecuteResponse;
use crewon_app_server_protocol::AgentPlatformWorkflowInfoParams;
use crewon_app_server_protocol::AgentPlatformWorkflowInfoResponse;
use crewon_app_server_protocol::JSONRPCErrorError;
use pretty_assertions::assert_eq;
use serde_json::json;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

use super::AgentPlatformRequestProcessor;
use super::Inner;
use super::MAX_ACCESS_TOKEN_BYTES;
use super::MAX_AGENT_ID_BYTES;
use super::MAX_REMOTE_JSON_BYTES;
use crate::error_code::INTERNAL_ERROR_CODE;
use crate::error_code::INVALID_PARAMS_ERROR_CODE;

const ACCESS_TOKEN: &str = "owner-token";
const API_KEY: &str = "space-api-key";
const AGENT_ID: &str = "agent-7";
const WORKFLOW_ID: &str = "7";

#[derive(Clone, Copy)]
struct TestTimeouts {
    preflight: Duration,
    request: Duration,
}

impl Default for TestTimeouts {
    fn default() -> Self {
        Self {
            preflight: Duration::from_secs(2),
            request: Duration::from_secs(2),
        }
    }
}

fn test_processor(server: &MockServer) -> AgentPlatformRequestProcessor {
    test_processor_for_base_url(server.uri(), TestTimeouts::default())
}

fn test_processor_without_api_key(server: &MockServer) -> AgentPlatformRequestProcessor {
    let mut processor = test_processor(server);
    Arc::get_mut(&mut processor.inner)
        .expect("test processor inner should not be shared")
        .api_key = None;
    processor
}

fn test_processor_for_base_url(
    base_url: String,
    timeouts: TestTimeouts,
) -> AgentPlatformRequestProcessor {
    let client = reqwest::Client::builder()
        .connect_timeout(timeouts.request)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("test HTTP client should build");
    AgentPlatformRequestProcessor {
        inner: Arc::new(Inner {
            base_url: Some(base_url),
            allow_insecure_http: false,
            api_key: Some(API_KEY.to_string()),
            client,
            preflight_timeout: timeouts.preflight,
            request_timeout: timeouts.request,
        }),
    }
}

async fn mount_agent_status(
    server: &MockServer,
    requested_agent_id: &str,
    canonical_agent_id: &str,
    api_enabled: i64,
) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/agents/{requested_agent_id}/api-status"
        )))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 7,
            "uid": canonical_agent_id,
            "api_enabled": api_enabled,
        })))
        .mount(server)
        .await;
}

async fn mount_workflow_status(
    server: &MockServer,
    requested_workflow_id: &str,
    canonical_workflow_id: i64,
    api_enabled: i64,
) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/api/v1/workflows/{requested_workflow_id}/api-status"
        )))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": canonical_workflow_id,
            "api_enabled": api_enabled,
        })))
        .mount(server)
        .await;
}

#[test]
fn public_http_requires_an_explicit_insecure_transport_opt_in() {
    let mut processor = test_processor_for_base_url(
        "http://example.com/api".to_string(),
        TestTimeouts::default(),
    );

    let error = processor
        .base_url()
        .expect_err("public HTTP should be rejected by default");
    assert!(error.message.contains("must use HTTPS"));

    Arc::get_mut(&mut processor.inner)
        .expect("test processor should have unique ownership")
        .allow_insecure_http = true;
    assert_eq!(
        processor
            .base_url()
            .expect("explicit opt-in should permit public HTTP"),
        "http://example.com/api"
    );
}

#[tokio::test]
async fn authentication_returns_only_the_verified_user() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    Mock::given(method("GET"))
        .and(path("/api/v1/auth/me"))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 42,
            "username": "owner",
        })))
        .expect(1)
        .mount(&server)
        .await;

    let response = processor
        .authenticate(AgentPlatformAuthParams {
            access_token: ACCESS_TOKEN.to_string(),
        })
        .await
        .expect("valid bearer should authenticate");

    assert_eq!(
        response,
        AgentPlatformAuthResponse {
            user: AgentPlatformUser {
                id: 42,
                username: "owner".to_string(),
            },
        }
    );
    server.verify().await;
}

#[tokio::test]
async fn unsafe_or_oversized_identity_is_rejected_before_remote_access() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    let cases = [
        (
            AgentPlatformAgentParams {
                access_token: ACCESS_TOKEN.to_string(),
                agent_id: "../agent?admin=1".to_string(),
            },
            JSONRPCErrorError {
                code: INVALID_PARAMS_ERROR_CODE,
                message: "Agent Platform agentId must be a safe URL path segment".to_string(),
                data: None,
            },
        ),
        (
            AgentPlatformAgentParams {
                access_token: ACCESS_TOKEN.to_string(),
                agent_id: "a".repeat(MAX_AGENT_ID_BYTES + 1),
            },
            JSONRPCErrorError {
                code: INVALID_PARAMS_ERROR_CODE,
                message: "Agent Platform agentId must be a safe URL path segment".to_string(),
                data: None,
            },
        ),
        (
            AgentPlatformAgentParams {
                access_token: "t".repeat(MAX_ACCESS_TOKEN_BYTES + 1),
                agent_id: AGENT_ID.to_string(),
            },
            JSONRPCErrorError {
                code: 401,
                message: "missing or invalid Agent Platform access token".to_string(),
                data: None,
            },
        ),
    ];

    for (params, expected) in cases {
        assert_eq!(
            processor
                .agent_info(params)
                .await
                .expect_err("invalid identity should be rejected"),
            expected
        );
    }
    let requests = server
        .received_requests()
        .await
        .expect("request journal should be readable");
    assert_eq!(requests.len(), 0);
}

#[tokio::test]
async fn remote_redirects_are_rejected_without_following_the_location() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
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
            "id": 42,
            "username": "redirected-user",
        })))
        .expect(0)
        .mount(&server)
        .await;

    let error = processor
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
async fn agent_info_uses_bearer_authority_and_server_side_api_key() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    mount_agent_status(&server, "legacy-agent", AGENT_ID, /*api_enabled*/ 1).await;
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

    let info = processor
        .agent_info(AgentPlatformAgentParams {
            access_token: ACCESS_TOKEN.to_string(),
            agent_id: "legacy-agent".to_string(),
        })
        .await
        .expect("enabled Agent should be readable");

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
    server.verify().await;
}

#[tokio::test]
async fn agent_info_rejects_disabled_agents_before_open_api_access() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    mount_agent_status(&server, AGENT_ID, AGENT_ID, /*api_enabled*/ 0).await;

    let error = processor
        .agent_info(AgentPlatformAgentParams {
            access_token: ACCESS_TOKEN.to_string(),
            agent_id: AGENT_ID.to_string(),
        })
        .await
        .expect_err("disabled Agent should be rejected");

    assert_eq!(error.code, 403);
    assert_eq!(error.message, "Agent Open API is not enabled");
    server.verify().await;
}

#[tokio::test]
async fn agent_info_rejects_a_json_response_larger_than_one_megabyte() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    mount_agent_status(&server, AGENT_ID, AGENT_ID, /*api_enabled*/ 1).await;
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/open/agent/{AGENT_ID}/info")))
        .and(header("x-api-key", API_KEY))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "padding": "x".repeat(MAX_REMOTE_JSON_BYTES),
        })))
        .expect(1)
        .mount(&server)
        .await;

    let error = processor
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
async fn workflow_info_uses_bearer_preflight_and_server_side_api_key() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    mount_workflow_status(&server, "0007", 7, /*api_enabled*/ 1).await;
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/open/workflow/{WORKFLOW_ID}/info")))
        .and(header("x-api-key", API_KEY))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 7,
            "name": "Delivery review",
            "description": "Review a delivery",
            "is_published": 1,
            "version": 3,
            "input_variables": [{"name": "input", "required": true}],
            "max_concurrency": 4,
            "active_connections": 1,
        })))
        .expect(1)
        .mount(&server)
        .await;

    let response = processor
        .workflow_info(AgentPlatformWorkflowInfoParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: "0007".to_string(),
        })
        .await
        .expect("owned enabled Workflow should be readable");

    assert_eq!(
        response,
        AgentPlatformWorkflowInfoResponse {
            id: 7,
            name: "Delivery review".to_string(),
            description: Some("Review a delivery".to_string()),
            is_published: 1,
            version: 3,
            input_variables: vec![json!({"name": "input", "required": true})],
            max_concurrency: 4,
            active_connections: 1,
        }
    );
    assert_open_requests_do_not_receive_bearer_authority(&server).await;
    server.verify().await;
}

#[tokio::test]
async fn workflow_execute_sends_only_bounded_prompt_input_to_the_authenticated_api() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    mount_workflow_status(&server, WORKFLOW_ID, 7, /*api_enabled*/ 1).await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/workflows/{WORKFLOW_ID}/execute")))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workflow_id": 7,
            "id": 91,
            "status": "completed",
            "output_data": {"result": "approved"},
            "started_at": "2026-07-27T01:02:03Z",
            "finished_at": "2026-07-27T01:02:04Z",
            "duration_seconds": 1.25,
            "executed_nodes": ["start", "review"],
            "node_results": {"review": {"status": "success"}},
            "error_message": null,
        })))
        .expect(1)
        .mount(&server)
        .await;

    let response = processor
        .execute_workflow(AgentPlatformWorkflowExecuteParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
            input: "  Review this delivery  ".to_string(),
        })
        .await
        .expect("owned enabled Workflow should execute");

    assert_eq!(
        response,
        AgentPlatformWorkflowExecuteResponse {
            workflow_id: 7,
            execution_id: 91,
            status: "completed".to_string(),
            outputs: json!({"result": "approved"}),
            started_at: Some("2026-07-27T01:02:03Z".to_string()),
            finished_at: Some("2026-07-27T01:02:04Z".to_string()),
            duration_seconds: Some(1.25),
            executed_nodes: vec![json!("start"), json!("review")],
            node_results: json!({"review": {"status": "success"}}),
            error: None,
            active_connections: 0,
        }
    );
    let requests = server
        .received_requests()
        .await
        .expect("request journal should be readable");
    let execute_request = requests
        .iter()
        .find(|request| request.url.path().ends_with("/execute"))
        .expect("authenticated Workflow execute request");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&execute_request.body)
            .expect("Workflow execute request should be JSON"),
        json!({
            "input_data": {
                "input": "Review this delivery",
                "prompt": "Review this delivery",
            }
        })
    );
    assert_eq!(execute_request.headers.get("x-api-key"), None);
    server.verify().await;
}

#[tokio::test]
async fn workflow_execute_does_not_require_public_api_enablement_or_a_space_api_key() {
    let server = MockServer::start().await;
    let processor = test_processor_without_api_key(&server);
    mount_workflow_status(&server, WORKFLOW_ID, 7, /*api_enabled*/ 0).await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/workflows/{WORKFLOW_ID}/execute")))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workflow_id": 7,
            "id": 92,
            "status": "completed",
            "output_data": {},
            "started_at": null,
            "finished_at": null,
            "duration_seconds": null,
            "executed_nodes": [],
            "node_results": {},
            "error_message": null,
        })))
        .expect(1)
        .mount(&server)
        .await;

    let response = processor
        .execute_workflow(AgentPlatformWorkflowExecuteParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
            input: r#"{"enterprise_name":"Example Co","requested_amount":1200}"#.to_string(),
        })
        .await
        .expect("owned Workflow should execute without public API enablement or a space key");

    assert_eq!(response.execution_id, 92);
    let requests = server
        .received_requests()
        .await
        .expect("request journal should be readable");
    let execute_request = requests
        .iter()
        .find(|request| request.url.path().ends_with("/execute"))
        .expect("authenticated Workflow execute request");
    assert_eq!(execute_request.headers.get("x-api-key"), None);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&execute_request.body)
            .expect("Workflow execute request should be JSON"),
        json!({
            "input_data": {
                "enterprise_name": "Example Co",
                "requested_amount": 1200,
            }
        })
    );
    server.verify().await;
}

#[tokio::test]
async fn invalid_workflow_id_or_input_is_rejected_before_remote_access() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    let invalid_id = processor
        .workflow_info(AgentPlatformWorkflowInfoParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: "../7?admin=true".to_string(),
        })
        .await
        .expect_err("unsafe Workflow id should fail locally");
    let empty_input = processor
        .execute_workflow(AgentPlatformWorkflowExecuteParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
            input: " \n\t ".to_string(),
        })
        .await
        .expect_err("empty Workflow input should fail locally");
    let oversized_input = processor
        .execute_workflow(AgentPlatformWorkflowExecuteParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
            input: "x".repeat(super::MAX_WORKFLOW_INPUT_CHARS + 1),
        })
        .await
        .expect_err("oversized Workflow input should fail locally");
    let malformed_json = processor
        .execute_workflow(AgentPlatformWorkflowExecuteParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
            input: "{not-json}".to_string(),
        })
        .await
        .expect_err("malformed Workflow JSON should fail locally");

    assert_eq!(invalid_id.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(empty_input.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(oversized_input.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(malformed_json.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        server
            .received_requests()
            .await
            .expect("request journal should be readable")
            .len(),
        0
    );
}

#[test]
fn workflow_params_reject_workspace_paths_and_arbitrary_context_fields() {
    for field in ["workspaceCwd", "context", "attachments"] {
        let mut value = json!({
            "accessToken": ACCESS_TOKEN,
            "workflowId": WORKFLOW_ID,
            "input": "Review this delivery",
        });
        value
            .as_object_mut()
            .expect("Workflow params fixture should be an object")
            .insert(field.to_string(), json!("/Users/owner/private"));
        assert!(
            serde_json::from_value::<AgentPlatformWorkflowExecuteParams>(value).is_err(),
            "unexpected field {field} should be rejected"
        );
    }
}

#[tokio::test]
async fn disabled_workflow_is_rejected_before_open_api_access() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    mount_workflow_status(&server, WORKFLOW_ID, 7, /*api_enabled*/ 0).await;

    let error = processor
        .workflow_info(AgentPlatformWorkflowInfoParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
        })
        .await
        .expect_err("disabled Workflow should be rejected");

    assert_eq!(error.code, 403);
    assert_eq!(error.message, "Workflow Open API is not enabled");
    server.verify().await;
}

#[tokio::test]
async fn workflow_info_rejects_an_open_api_response_for_another_resource() {
    let server = MockServer::start().await;
    let processor = test_processor(&server);
    mount_workflow_status(&server, WORKFLOW_ID, 7, /*api_enabled*/ 1).await;
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/open/workflow/{WORKFLOW_ID}/info")))
        .and(header("x-api-key", API_KEY))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 8,
            "name": "Wrong Workflow",
            "description": null,
            "is_published": 1,
            "version": 1,
            "input_variables": [],
            "max_concurrency": 1,
            "active_connections": 0,
        })))
        .expect(1)
        .mount(&server)
        .await;

    let error = processor
        .workflow_info(AgentPlatformWorkflowInfoParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
        })
        .await
        .expect_err("mismatched Workflow identity should fail closed");

    assert_eq!(error.code, INTERNAL_ERROR_CODE);
    assert_eq!(
        error.message,
        "Agent Platform Workflow info identity did not match the authorized resource"
    );
    server.verify().await;
}

async fn assert_open_requests_do_not_receive_bearer_authority(server: &MockServer) {
    let requests = server
        .received_requests()
        .await
        .expect("request journal should be readable");
    for request in requests
        .iter()
        .filter(|request| request.url.path().contains("/open/workflow/"))
    {
        assert_eq!(request.headers.get("authorization"), None);
    }
}
