use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::AgentPlatformWorkflowExecuteParams;
use crewon_app_server_protocol::AgentPlatformWorkflowExecuteResponse;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

const ACCESS_TOKEN: &str = "owner-token";
const API_KEY: &str = "space-api-key";
const INVALID_REQUEST_ERROR_CODE: i64 = -32600;
const WORKFLOW_ID: &str = "7";
const TIMEOUT: Duration = Duration::from_secs(30);

async fn initialized_app_server(
    codex_home: &TempDir,
    agent_platform: &MockServer,
) -> Result<TestAppServer> {
    let base_url = agent_platform.uri();
    let mut app = TestAppServer::new_with_env(
        codex_home.path(),
        &[
            ("CREWON_AGENT_PLATFORM_BASE_URL", Some(base_url.as_str())),
            ("CREWON_AGENT_PLATFORM_API_KEY", Some(API_KEY)),
        ],
    )
    .await?;
    timeout(TIMEOUT, app.initialize()).await??;
    Ok(app)
}

async fn execute_workflow(
    app: &mut TestAppServer,
    params: AgentPlatformWorkflowExecuteParams,
) -> Result<AgentPlatformWorkflowExecuteResponse> {
    let request_id = app
        .send_raw_request(
            "agentPlatform/workflow/execute",
            Some(serde_json::to_value(params)?),
        )
        .await?;
    let response: JSONRPCResponse = timeout(
        TIMEOUT,
        app.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

#[tokio::test]
async fn workflow_execute_rpc_uses_bearer_preflight_and_server_api_key() -> Result<()> {
    let agent_platform = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/workflows/{WORKFLOW_ID}/api-status")))
        .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": 7,
            "api_enabled": 1,
        })))
        .expect(1)
        .mount(&agent_platform)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("/api/v1/open/workflow/{WORKFLOW_ID}/execute")))
        .and(header("x-api-key", API_KEY))
        .and(body_json(json!({
            "inputs": {
                "input": "Review this delivery",
                "prompt": "Review this delivery",
            }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "workflow_id": 7,
            "execution_id": 91,
            "status": "completed",
            "outputs": {"result": "approved"},
            "started_at": "2026-07-27T01:02:03Z",
            "finished_at": "2026-07-27T01:02:04Z",
            "duration_seconds": 1.25,
            "executed_nodes": ["start", "review"],
            "node_results": {"review": {"status": "success"}},
            "error": null,
            "active_connections": 1,
        })))
        .expect(1)
        .mount(&agent_platform)
        .await;

    let codex_home = TempDir::new()?;
    let mut app = initialized_app_server(&codex_home, &agent_platform).await?;
    let response = execute_workflow(
        &mut app,
        AgentPlatformWorkflowExecuteParams {
            access_token: ACCESS_TOKEN.to_string(),
            workflow_id: WORKFLOW_ID.to_string(),
            input: "  Review this delivery  ".to_string(),
        },
    )
    .await?;

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
            active_connections: 1,
        }
    );
    let requests = agent_platform
        .received_requests()
        .await
        .expect("Agent Platform request journal should be readable");
    assert_eq!(requests.len(), 2);
    let preflight = requests
        .iter()
        .find(|request| request.url.path().ends_with("/api-status"))
        .expect("Bearer preflight request should be recorded");
    let execution = requests
        .iter()
        .find(|request| request.url.path().ends_with("/execute"))
        .expect("Open API execution request should be recorded");
    assert_eq!(
        preflight
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        Some("Bearer owner-token")
    );
    assert_eq!(preflight.headers.get("x-api-key"), None);
    assert_eq!(execution.headers.get("authorization"), None);
    assert_eq!(
        execution
            .headers
            .get("x-api-key")
            .and_then(|value| value.to_str().ok()),
        Some(API_KEY)
    );
    agent_platform.verify().await;
    app.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn workflow_execute_rpc_rejects_workspace_and_context_authority() -> Result<()> {
    let agent_platform = MockServer::start().await;
    let codex_home = TempDir::new()?;
    let mut app = initialized_app_server(&codex_home, &agent_platform).await?;

    for (field, value) in [
        ("workspaceCwd", json!("/Users/owner/private")),
        ("context", json!({"secret": "not-client-authoritative"})),
    ] {
        let mut params = json!({
            "accessToken": ACCESS_TOKEN,
            "workflowId": WORKFLOW_ID,
            "input": "Review this delivery",
        });
        params
            .as_object_mut()
            .expect("Workflow params fixture should be an object")
            .insert(field.to_string(), value);
        let request_id = app
            .send_raw_request("agentPlatform/workflow/execute", Some(params))
            .await?;
        let error: JSONRPCError = timeout(
            TIMEOUT,
            app.read_stream_until_error_message(RequestId::Integer(request_id)),
        )
        .await??;
        assert_eq!(
            error.error.code, INVALID_REQUEST_ERROR_CODE,
            "unexpected field {field} should be rejected by the RPC protocol"
        );
        assert!(error.error.message.contains("unknown field"));
    }

    assert!(
        agent_platform
            .received_requests()
            .await
            .expect("Agent Platform request journal should be readable")
            .is_empty()
    );
    app.shutdown().await?;
    Ok(())
}
