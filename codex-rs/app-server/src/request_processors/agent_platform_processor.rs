use std::sync::Arc;
use std::time::Duration;

use crewon_app_server_protocol::AgentPlatformAgentInfoResponse;
use crewon_app_server_protocol::AgentPlatformAgentParams;
use crewon_app_server_protocol::AgentPlatformAuthParams;
use crewon_app_server_protocol::AgentPlatformAuthResponse;
use crewon_app_server_protocol::AgentPlatformWorkflowExecuteParams;
use crewon_app_server_protocol::AgentPlatformWorkflowExecuteResponse;
use crewon_app_server_protocol::AgentPlatformWorkflowInfoParams;
use crewon_app_server_protocol::AgentPlatformWorkflowInfoResponse;
use crewon_app_server_protocol::JSONRPCErrorError;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::error_code::internal_error;

mod remote;
mod validation;

const MAX_ACCESS_TOKEN_BYTES: usize = 64 * 1024;
const MAX_AGENT_ID_BYTES: usize = 128;
const MAX_WORKFLOW_ID_BYTES: usize = 20;
const MAX_WORKFLOW_INPUT_CHARS: usize = 10_000;
const MAX_WORKFLOW_INPUT_BYTES: usize = 64 * 1024;
const MAX_REMOTE_JSON_BYTES: usize = 1_000_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) struct AgentPlatformRequestProcessor {
    inner: Arc<Inner>,
}

struct Inner {
    base_url: Option<String>,
    allow_insecure_http: bool,
    api_key: Option<String>,
    client: reqwest::Client,
    preflight_timeout: Duration,
    request_timeout: Duration,
}

#[derive(Deserialize)]
struct RemoteUser {
    id: i64,
    username: String,
}

#[derive(Deserialize)]
struct RemoteAgentStatus {
    id: i64,
    uid: Option<String>,
    api_enabled: i64,
}

#[derive(Deserialize)]
struct RemoteAgentInfo {
    id: i64,
    uid: Option<String>,
    name: String,
    description: Option<String>,
    max_concurrency: u32,
    active_connections: u32,
}

#[derive(Deserialize)]
struct RemoteWorkflowStatus {
    id: i64,
    api_enabled: i64,
}

#[derive(Deserialize)]
struct RemoteWorkflowInfo {
    id: i64,
    name: String,
    description: Option<String>,
    is_published: i64,
    version: i64,
    #[serde(default)]
    input_variables: Vec<JsonValue>,
    max_concurrency: u32,
    active_connections: u32,
}

#[derive(Serialize)]
struct RemoteWorkflowExecuteRequest {
    input_data: JsonValue,
}

#[derive(Deserialize)]
struct RemoteWorkflowExecution {
    workflow_id: i64,
    #[serde(alias = "id")]
    execution_id: i64,
    status: String,
    #[serde(default, alias = "output_data")]
    outputs: JsonValue,
    started_at: Option<String>,
    finished_at: Option<String>,
    duration_seconds: Option<f64>,
    #[serde(default)]
    executed_nodes: Vec<JsonValue>,
    #[serde(default)]
    node_results: JsonValue,
    #[serde(alias = "error_message")]
    error: Option<String>,
    #[serde(default)]
    active_connections: u32,
}

impl AgentPlatformRequestProcessor {
    pub(crate) fn new() -> Self {
        let base_url = std::env::var("CREWON_AGENT_PLATFORM_BASE_URL")
            .ok()
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());
        let api_key = std::env::var("CREWON_AGENT_PLATFORM_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let allow_insecure_http = std::env::var("CREWON_AGENT_PLATFORM_ALLOW_INSECURE_HTTP")
            .is_ok_and(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"));
        Self {
            inner: Arc::new(Inner {
                base_url,
                allow_insecure_http,
                api_key,
                client: reqwest::Client::builder()
                    .connect_timeout(CONNECT_TIMEOUT)
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap_or_else(|error| {
                        panic!("Agent Platform HTTP client configuration should be valid: {error}")
                    }),
                preflight_timeout: PREFLIGHT_TIMEOUT,
                request_timeout: REQUEST_TIMEOUT,
            }),
        }
    }

    pub(crate) async fn authenticate(
        &self,
        params: AgentPlatformAuthParams,
    ) -> Result<AgentPlatformAuthResponse, JSONRPCErrorError> {
        let user = self.verify_user(&params.access_token).await?;
        Ok(AgentPlatformAuthResponse { user })
    }

    pub(crate) async fn agent_info(
        &self,
        params: AgentPlatformAgentParams,
    ) -> Result<AgentPlatformAgentInfoResponse, JSONRPCErrorError> {
        let agent_id = self
            .verify_enabled_agent_access(&params.access_token, &params.agent_id)
            .await?;
        let response: RemoteAgentInfo = self
            .send_open_api(
                reqwest::Method::GET,
                &format!("/api/v1/open/agent/{agent_id}/info"),
                /*body*/ None::<&()>,
            )
            .await?;
        Ok(response.into())
    }

    pub(crate) async fn workflow_info(
        &self,
        params: AgentPlatformWorkflowInfoParams,
    ) -> Result<AgentPlatformWorkflowInfoResponse, JSONRPCErrorError> {
        let workflow_id = self
            .verify_enabled_workflow_access(&params.access_token, &params.workflow_id)
            .await?;
        let response: RemoteWorkflowInfo = self
            .send_workflow_open_api(
                reqwest::Method::GET,
                &format!("/api/v1/open/workflow/{workflow_id}/info"),
                /*body*/ None::<&()>,
            )
            .await?;
        if response.id.to_string() != workflow_id {
            return Err(internal_error(
                "Agent Platform Workflow info identity did not match the authorized resource",
            ));
        }
        Ok(response.into())
    }

    pub(crate) async fn execute_workflow(
        &self,
        params: AgentPlatformWorkflowExecuteParams,
    ) -> Result<AgentPlatformWorkflowExecuteResponse, JSONRPCErrorError> {
        let input_data = validation::workflow_input_data(&params.input)?;
        let workflow_id = self
            .verify_workflow_access(&params.access_token, &params.workflow_id)
            .await?;
        let response = self
            .inner
            .client
            .post(format!(
                "{}/api/v1/workflows/{workflow_id}/execute",
                self.base_url()?
            ))
            .bearer_auth(&params.access_token)
            .json(&RemoteWorkflowExecuteRequest { input_data })
            .timeout(self.inner.request_timeout)
            .send()
            .await
            .map_err(|error| internal_error(error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(remote::remote_response_error(status, response).await);
        }
        let response = remote::decode_json_response::<RemoteWorkflowExecution>(response).await?;
        if response.workflow_id.to_string() != workflow_id
            || response.execution_id <= 0
            || response.status.trim().is_empty()
        {
            return Err(internal_error(
                "Agent Platform Workflow execution response was invalid",
            ));
        }
        Ok(response.into())
    }
}

impl From<RemoteAgentInfo> for AgentPlatformAgentInfoResponse {
    fn from(value: RemoteAgentInfo) -> Self {
        Self {
            id: value.id,
            uid: value.uid,
            name: value.name,
            description: value.description,
            max_concurrency: value.max_concurrency,
            active_connections: value.active_connections,
        }
    }
}

impl From<RemoteWorkflowInfo> for AgentPlatformWorkflowInfoResponse {
    fn from(value: RemoteWorkflowInfo) -> Self {
        Self {
            id: value.id,
            name: value.name,
            description: value.description,
            is_published: value.is_published,
            version: value.version,
            input_variables: value.input_variables,
            max_concurrency: value.max_concurrency,
            active_connections: value.active_connections,
        }
    }
}

impl From<RemoteWorkflowExecution> for AgentPlatformWorkflowExecuteResponse {
    fn from(value: RemoteWorkflowExecution) -> Self {
        Self {
            workflow_id: value.workflow_id,
            execution_id: value.execution_id,
            status: value.status,
            outputs: value.outputs,
            started_at: value.started_at,
            finished_at: value.finished_at,
            duration_seconds: value.duration_seconds,
            executed_nodes: value.executed_nodes,
            node_results: value.node_results,
            error: value.error,
            active_connections: value.active_connections,
        }
    }
}

#[cfg(test)]
#[path = "agent_platform_processor_tests.rs"]
mod tests;
