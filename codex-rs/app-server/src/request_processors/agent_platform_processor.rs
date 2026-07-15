use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crewon_app_server_protocol::AgentPlatformAgentInfoResponse;
use crewon_app_server_protocol::AgentPlatformAgentParams;
use crewon_app_server_protocol::AgentPlatformAuthParams;
use crewon_app_server_protocol::AgentPlatformAuthResponse;
use crewon_app_server_protocol::AgentPlatformChatParams;
use crewon_app_server_protocol::AgentPlatformChatResponse;
use crewon_app_server_protocol::AgentPlatformChatStartResponse;
use crewon_app_server_protocol::AgentPlatformHistoryMessage;
use crewon_app_server_protocol::AgentPlatformRunCancelParams;
use crewon_app_server_protocol::AgentPlatformRunCancelResponse;
use crewon_app_server_protocol::AgentPlatformSessionClearResponse;
use crewon_app_server_protocol::AgentPlatformSessionParams;
use crewon_app_server_protocol::AgentPlatformSessionReadResponse;
use crewon_app_server_protocol::JSONRPCErrorError;
use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use tokio::fs;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error_code::internal_error;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::OutgoingMessageSender;

mod admission;
mod remote;
mod session;
mod stream;
mod validation;

use admission::AdmissionController;
use remote::remote_error;
#[cfg(test)]
use session::trim_history;
#[cfg(test)]
use stream::take_sse_frame;
use validation::validate_chat_params;
use validation::validate_session_params;

const MAX_HISTORY_MESSAGES: usize = 20;
const MAX_CONTEXT_TOKENS: usize = 10_000;
const MAX_MESSAGE_CHARS: usize = 10_000;
const MAX_SESSION_FILE_BYTES: usize = 1_000_000;
const MAX_SESSION_FILES: usize = 1_000;
const MAX_ACCESS_TOKEN_BYTES: usize = 64 * 1024;
const MAX_AGENT_ID_BYTES: usize = 128;
const MAX_THREAD_ID_BYTES: usize = 1_024;
const MAX_REMOTE_JSON_BYTES: usize = 1_000_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);
const STREAM_TOTAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
pub(crate) struct AgentPlatformRequestProcessor {
    inner: Arc<Inner>,
}

struct Inner {
    admission: AdmissionController,
    base_url: Option<String>,
    allow_insecure_http: bool,
    api_key: Option<String>,
    client: reqwest::Client,
    history_root: PathBuf,
    history_write_lock: Mutex<()>,
    outgoing: Arc<OutgoingMessageSender>,
    preflight_timeout: Duration,
    request_timeout: Duration,
    runs: Mutex<HashMap<String, RunRecord>>,
    session_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    stream_idle_timeout: Duration,
    stream_total_timeout: Duration,
}

struct RunRecord {
    cancellation: CancellationToken,
    connection_id: ConnectionId,
    state: RunState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunState {
    Running,
    Finalizing,
    Cancelled,
}

#[derive(Clone, Copy)]
enum AgentAccessRequirement {
    Owned,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    user_id: i64,
    thread_id: String,
    agent_id: String,
    messages: Vec<AgentPlatformHistoryMessage>,
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
struct RemoteTokenUsage {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
}

#[derive(Deserialize)]
struct RemoteChatResponse {
    agent_id: String,
    message: String,
    thoughts: Vec<serde_json::Value>,
    skills_used: Vec<serde_json::Value>,
    #[serde(default)]
    resource_events: Vec<crewon_app_server_protocol::AgentPlatformResourceEvent>,
    tokens: RemoteTokenUsage,
    duration_ms: u64,
}

#[derive(Serialize)]
struct RemoteChatRequest<'a> {
    message: &'a str,
    history: &'a [AgentPlatformHistoryMessage],
}

impl AgentPlatformRequestProcessor {
    pub(crate) fn new(codex_home: PathBuf, outgoing: Arc<OutgoingMessageSender>) -> Self {
        let base_url = std::env::var("CREWON_AGENT_PLATFORM_BASE_URL")
            .ok()
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());
        let api_key = std::env::var("CREWON_AGENT_PLATFORM_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let allow_insecure_http = std::env::var("CREWON_AGENT_PLATFORM_ALLOW_INSECURE_HTTP")
            .is_ok_and(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"));
        let deployment_namespace = format!(
            "{:x}",
            Sha256::digest(base_url.as_deref().unwrap_or("unconfigured"))
        );
        Self {
            inner: Arc::new(Inner {
                admission: AdmissionController::new(),
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
                history_root: codex_home
                    .join("agent-platform-sessions")
                    .join(deployment_namespace),
                history_write_lock: Mutex::new(()),
                outgoing,
                preflight_timeout: PREFLIGHT_TIMEOUT,
                request_timeout: REQUEST_TIMEOUT,
                runs: Mutex::new(HashMap::new()),
                session_locks: Mutex::new(HashMap::new()),
                stream_idle_timeout: STREAM_IDLE_TIMEOUT,
                stream_total_timeout: STREAM_TOTAL_TIMEOUT,
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
            .verify_agent_access(
                &params.access_token,
                &params.agent_id,
                AgentAccessRequirement::Enabled,
            )
            .await?;
        let response: RemoteAgentInfo = self
            .send_open_api(
                reqwest::Method::GET,
                &format!("/api/v1/open/agent/{agent_id}/info"),
                /*body*/ None::<&RemoteChatRequest<'_>>,
            )
            .await?;
        Ok(response.into())
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "an Agent Platform session must stay serialized through remote execution and persistence"
    )]
    pub(crate) async fn chat(
        &self,
        connection_id: ConnectionId,
        mut params: AgentPlatformChatParams,
        connection_cancellation: CancellationToken,
    ) -> Result<AgentPlatformChatResponse, JSONRPCErrorError> {
        validate_chat_params(&params)?;
        let _admission_permit = self
            .inner
            .admission
            .acquire(connection_id, &connection_cancellation)
            .await?;
        let user = tokio::select! {
            _ = connection_cancellation.cancelled() => {
                return Err(internal_error("Agent Platform connection closed"));
            }
            result = self.verify_user(&params.access_token) => result?,
        };
        params.agent_id = tokio::select! {
            _ = connection_cancellation.cancelled() => {
                return Err(internal_error("Agent Platform connection closed"));
            }
            result = self.verify_agent_access(
                &params.access_token,
                &params.agent_id,
                AgentAccessRequirement::Enabled,
            ) => result?,
        };
        let session_lock = self
            .session_lock(user.id, &params.thread_id, &params.agent_id)
            .await;
        let _guard = session_lock.try_lock_owned().map_err(|_| {
            remote_error(
                StatusCode::CONFLICT,
                "Agent Platform session already has an active operation",
            )
        })?;
        let history = self.context_for(&user, &params).await?;
        let path = format!("/api/v1/open/agent/{}/chat", params.agent_id);
        let request = RemoteChatRequest {
            message: &params.message,
            history: &history,
        };
        let response: RemoteChatResponse = tokio::select! {
            _ = connection_cancellation.cancelled() => {
                return Err(internal_error("Agent Platform connection closed"));
            }
            result = self.send_open_api(
                reqwest::Method::POST,
                &path,
                Some(&request),
            ) => result?,
        };
        let response = AgentPlatformChatResponse::from(response);
        if connection_cancellation.is_cancelled() {
            return Err(internal_error("Agent Platform connection closed"));
        }
        self.persist_completed_turn(&user, &params, &response.message)
            .await?;
        Ok(response)
    }

    pub(crate) async fn chat_start(
        &self,
        connection_id: ConnectionId,
        mut params: AgentPlatformChatParams,
        connection_cancellation: CancellationToken,
    ) -> Result<AgentPlatformChatStartResponse, JSONRPCErrorError> {
        validate_chat_params(&params)?;
        let admission_permit = self
            .inner
            .admission
            .acquire(connection_id, &connection_cancellation)
            .await?;
        let user = tokio::select! {
            _ = connection_cancellation.cancelled() => {
                return Err(internal_error("Agent Platform connection closed"));
            }
            result = self.verify_user(&params.access_token) => result?,
        };
        params.agent_id = tokio::select! {
            _ = connection_cancellation.cancelled() => {
                return Err(internal_error("Agent Platform connection closed"));
            }
            result = self.verify_agent_access(
                &params.access_token,
                &params.agent_id,
                AgentAccessRequirement::Enabled,
            ) => result?,
        };
        let session_lock = self
            .session_lock(user.id, &params.thread_id, &params.agent_id)
            .await;
        let session_guard = session_lock.try_lock_owned().map_err(|_| {
            remote_error(
                StatusCode::CONFLICT,
                "Agent Platform session already has an active operation",
            )
        })?;
        let run_id = Uuid::now_v7().to_string();
        let cancellation = connection_cancellation.child_token();
        if cancellation.is_cancelled() {
            return Err(internal_error("Agent Platform connection closed"));
        }
        let mut runs = self.inner.runs.lock().await;
        runs.insert(
            run_id.clone(),
            RunRecord {
                cancellation: cancellation.clone(),
                connection_id,
                state: RunState::Running,
            },
        );
        drop(runs);
        let processor = self.clone();
        let spawned_run_id = run_id.clone();
        tokio::spawn(async move {
            processor
                .run_stream(
                    connection_id,
                    spawned_run_id,
                    user,
                    params,
                    cancellation,
                    session_guard,
                    admission_permit,
                )
                .await;
        });
        Ok(AgentPlatformChatStartResponse { run_id })
    }

    pub(crate) async fn run_cancel(
        &self,
        connection_id: ConnectionId,
        params: AgentPlatformRunCancelParams,
    ) -> AgentPlatformRunCancelResponse {
        let mut runs = self.inner.runs.lock().await;
        if let Some(record) = runs.get_mut(&params.run_id)
            && record.connection_id == connection_id
            && record.state == RunState::Running
            && !record.cancellation.is_cancelled()
        {
            record.state = RunState::Cancelled;
            record.cancellation.cancel();
            return AgentPlatformRunCancelResponse { cancelled: true };
        }
        AgentPlatformRunCancelResponse { cancelled: false }
    }

    pub(crate) async fn connection_closed(&self, connection_id: ConnectionId) {
        self.inner.admission.connection_closed(connection_id).await;
        let mut runs = self.inner.runs.lock().await;
        for record in runs.values_mut() {
            if record.connection_id == connection_id && record.state == RunState::Running {
                record.state = RunState::Cancelled;
                record.cancellation.cancel();
            }
        }
    }

    async fn begin_run_finalization(&self, run_id: &str) -> bool {
        let mut runs = self.inner.runs.lock().await;
        let Some(record) = runs.get_mut(run_id) else {
            return false;
        };
        if record.state != RunState::Running || record.cancellation.is_cancelled() {
            if record.cancellation.is_cancelled() {
                record.state = RunState::Cancelled;
            }
            return false;
        }
        record.state = RunState::Finalizing;
        true
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "session reads must not race with execution or clearing the same Agent history"
    )]
    pub(crate) async fn session_read(
        &self,
        mut params: AgentPlatformSessionParams,
    ) -> Result<AgentPlatformSessionReadResponse, JSONRPCErrorError> {
        validate_session_params(&params)?;
        let user = self.verify_user(&params.access_token).await?;
        params.agent_id = self
            .verify_agent_access(
                &params.access_token,
                &params.agent_id,
                AgentAccessRequirement::Owned,
            )
            .await?;
        let session_lock = self
            .session_lock(user.id, &params.thread_id, &params.agent_id)
            .await;
        let _guard = session_lock.try_lock_owned().map_err(|_| {
            remote_error(
                StatusCode::CONFLICT,
                "Agent Platform session already has an active operation",
            )
        })?;
        let session = self
            .load_session(user.id, &params.thread_id, &params.agent_id)
            .await?;
        Ok(AgentPlatformSessionReadResponse {
            messages: session.messages,
        })
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "session clearing must not race with execution or reading the same Agent history"
    )]
    pub(crate) async fn session_clear(
        &self,
        mut params: AgentPlatformSessionParams,
    ) -> Result<AgentPlatformSessionClearResponse, JSONRPCErrorError> {
        validate_session_params(&params)?;
        let user = self.verify_user(&params.access_token).await?;
        params.agent_id = self
            .verify_agent_access(
                &params.access_token,
                &params.agent_id,
                AgentAccessRequirement::Owned,
            )
            .await?;
        let session_lock = self
            .session_lock(user.id, &params.thread_id, &params.agent_id)
            .await;
        let _guard = session_lock.try_lock_owned().map_err(|_| {
            remote_error(
                StatusCode::CONFLICT,
                "Agent Platform session already has an active operation",
            )
        })?;
        let path = self.session_path(user.id, &params.thread_id, &params.agent_id);
        match fs::remove_file(path).await {
            Ok(()) => Ok(AgentPlatformSessionClearResponse { cleared: true }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(AgentPlatformSessionClearResponse { cleared: false })
            }
            Err(error) => Err(internal_error(error.to_string())),
        }
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

impl From<RemoteChatResponse> for AgentPlatformChatResponse {
    fn from(value: RemoteChatResponse) -> Self {
        Self {
            agent_id: value.agent_id,
            message: value.message,
            thoughts: value.thoughts,
            skills_used: value.skills_used,
            resource_events: value.resource_events,
            tokens: crewon_app_server_protocol::AgentPlatformTokenUsage {
                prompt_tokens: value.tokens.prompt_tokens,
                completion_tokens: value.tokens.completion_tokens,
                total_tokens: value.tokens.total_tokens,
            },
            duration_ms: value.duration_ms,
        }
    }
}

#[cfg(test)]
#[path = "agent_platform_processor_tests.rs"]
mod tests;
