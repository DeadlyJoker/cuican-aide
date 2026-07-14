use crewon_app_server_protocol::AgentPlatformChatCompletedNotification;
use crewon_app_server_protocol::AgentPlatformChatDeltaNotification;
use crewon_app_server_protocol::AgentPlatformChatFailedNotification;
use crewon_app_server_protocol::AgentPlatformChatParams;
use crewon_app_server_protocol::AgentPlatformChatResponse;
use crewon_app_server_protocol::AgentPlatformHistoryMessage;
use crewon_app_server_protocol::AgentPlatformResourceEvent;
use crewon_app_server_protocol::AgentPlatformResourceEventNotification;
use crewon_app_server_protocol::AgentPlatformUser;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ServerNotification;
use crewon_utils_output_truncation::approx_bytes_for_tokens;
use futures::StreamExt;
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::error_code::internal_error;
use crate::outgoing_message::ConnectionId;

use super::AgentPlatformRequestProcessor;
use super::MAX_CONTEXT_TOKENS;
use super::RemoteChatRequest;
use super::admission::AdmissionPermit;
use super::remote::json_u64;
use super::remote::remote_stream_response_error;

const FINAL_NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(10);

impl AgentPlatformRequestProcessor {
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "a streaming Agent Platform session must stay serialized through completion persistence"
    )]
    #[expect(
        clippy::too_many_arguments,
        reason = "the spawned stream owns each bounded run dependency until cleanup"
    )]
    pub(super) async fn run_stream(
        &self,
        connection_id: ConnectionId,
        run_id: String,
        user: AgentPlatformUser,
        params: AgentPlatformChatParams,
        cancellation: CancellationToken,
        session_guard: tokio::sync::OwnedMutexGuard<()>,
        admission_permit: AdmissionPermit,
    ) {
        let result = async {
            if cancellation.is_cancelled() {
                return Err(internal_error("Agent Platform run cancelled"));
            }
            let history = tokio::select! {
                _ = cancellation.cancelled() => {
                    Err(internal_error("Agent Platform run cancelled"))
                }
                result = self.context_for(&user, &params) => result,
            }?;
            let response = self
                .consume_stream(connection_id, &run_id, &params, &history, &cancellation)
                .await?;
            if cancellation.is_cancelled() {
                return Err(internal_error("Agent Platform run cancelled"));
            }
            if !self.begin_run_finalization(&run_id).await {
                return Err(internal_error("Agent Platform run cancelled"));
            }
            self.persist_completed_turn(&user, &params, &response.message)
                .await?;
            Ok(response)
        }
        .await;

        match result {
            Ok(response) => {
                self.send_final_notification(
                    connection_id,
                    &run_id,
                    ServerNotification::AgentPlatformChatCompleted(
                        AgentPlatformChatCompletedNotification {
                            run_id: run_id.clone(),
                            thread_id: params.thread_id.clone(),
                            agent_id: params.agent_id.clone(),
                            message: response.message,
                            thoughts: response.thoughts,
                            skills_used: response.skills_used,
                            resource_events: response.resource_events,
                            tokens: response.tokens,
                            duration_ms: response.duration_ms,
                        },
                    ),
                )
                .await;
            }
            Err(error) => {
                let cancelled =
                    cancellation.is_cancelled() || !self.begin_run_finalization(&run_id).await;
                self.send_failed(connection_id, &run_id, &params, error, cancelled)
                    .await;
            }
        }
        self.inner.runs.lock().await.remove(&run_id);
        drop(admission_permit);
        drop(session_guard);
    }

    pub(super) async fn consume_stream(
        &self,
        connection_id: ConnectionId,
        run_id: &str,
        params: &AgentPlatformChatParams,
        history: &[AgentPlatformHistoryMessage],
        cancellation: &CancellationToken,
    ) -> Result<AgentPlatformChatResponse, JSONRPCErrorError> {
        let started = Instant::now();
        let deadline = started + self.inner.stream_total_timeout;
        let request = self
            .inner
            .client
            .post(format!(
                "{}/api/v1/open/agent/{}/chat/stream",
                self.base_url()?,
                params.agent_id
            ))
            .header("X-API-Key", self.api_key()?)
            .json(&RemoteChatRequest {
                message: &params.message,
                history,
            });
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                return Err(internal_error("Agent Platform run cancelled"));
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(internal_error("Agent Platform stream total time limit reached"));
            }
            response = tokio::time::timeout(self.inner.request_timeout, request.send()) => {
                response
                    .map_err(|_| internal_error("Agent Platform response headers timed out"))?
                    .map_err(|error| internal_error(error.to_string()))?
            }
        };
        let status = response.status();
        if !status.is_success() {
            return Err(remote_stream_response_error(
                status,
                response,
                cancellation,
                deadline,
                self.inner.stream_idle_timeout,
            )
            .await);
        }

        let mut bytes = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut answer = String::new();
        let mut thoughts = Vec::new();
        let mut skills_used = Vec::new();
        let mut resource_events = Vec::new();
        let mut tokens = crewon_app_server_protocol::AgentPlatformTokenUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        };
        let mut received_done = false;
        let max_response_bytes = approx_bytes_for_tokens(MAX_CONTEXT_TOKENS);

        'stream: loop {
            let next = tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    return Err(internal_error("Agent Platform run cancelled"));
                }
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(internal_error("Agent Platform stream total time limit reached"));
                }
                next = tokio::time::timeout(self.inner.stream_idle_timeout, bytes.next()) => {
                    next.map_err(|_| internal_error("Agent Platform stream timed out"))?
                },
            };
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk.map_err(|error| internal_error(error.to_string()))?;
            buffer.extend_from_slice(&chunk);
            while let Some(frame) = take_sse_frame(&mut buffer, max_response_bytes)? {
                let Some(data) = sse_data(&frame) else {
                    continue;
                };
                let event = serde_json::from_str::<serde_json::Value>(&data)
                    .map_err(|error| internal_error(error.to_string()))?;
                match event.get("event").and_then(serde_json::Value::as_str) {
                    Some("message") => {
                        let delta = event
                            .get("chunk")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        if delta.is_empty() {
                            continue;
                        }
                        if answer.len().saturating_add(delta.len()) > max_response_bytes {
                            return Err(internal_error(format!(
                                "Agent Platform response exceeded {MAX_CONTEXT_TOKENS} approximate tokens"
                            )));
                        }
                        answer.push_str(delta);
                        let connections = [connection_id];
                        let send = self.inner.outgoing.send_server_notification_to_connections(
                            &connections,
                            ServerNotification::AgentPlatformChatDelta(
                                AgentPlatformChatDeltaNotification {
                                    run_id: run_id.to_string(),
                                    thread_id: params.thread_id.clone(),
                                    agent_id: params.agent_id.clone(),
                                    delta: delta.to_string(),
                                },
                            ),
                        );
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => {
                                return Err(internal_error("Agent Platform run cancelled"));
                            }
                            _ = tokio::time::sleep_until(deadline) => {
                                return Err(internal_error(
                                    "Agent Platform stream total time limit reached",
                                ));
                            }
                            result = tokio::time::timeout(self.inner.stream_idle_timeout, send) => {
                                result.map_err(|_| {
                                    internal_error("Agent Platform notification delivery timed out")
                                })?;
                            }
                        }
                    }
                    Some("done") => {
                        thoughts = event
                            .get("agent_thoughts")
                            .and_then(serde_json::Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        skills_used = event
                            .get("skills_used")
                            .and_then(serde_json::Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        if let Some(events) = event
                            .get("resource_events")
                            .and_then(serde_json::Value::as_array)
                        {
                            resource_events = events
                                .iter()
                                .cloned()
                                .map(serde_json::from_value)
                                .collect::<Result<Vec<AgentPlatformResourceEvent>, _>>()
                                .map_err(|error| internal_error(error.to_string()))?;
                        }
                        if let Some(usage) = event.get("token_usage") {
                            tokens.prompt_tokens = json_u64(usage, "prompt_tokens");
                            tokens.completion_tokens = json_u64(usage, "completion_tokens");
                            tokens.total_tokens = json_u64(usage, "total_tokens");
                        }
                        received_done = true;
                        break 'stream;
                    }
                    Some("error") => {
                        let message = event
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Agent Platform stream failed");
                        return Err(internal_error(message));
                    }
                    Some("resource_event") => {
                        let resource_event =
                            serde_json::from_value::<AgentPlatformResourceEvent>(event.clone())
                                .map_err(|error| internal_error(error.to_string()))?;
                        resource_events.push(resource_event.clone());
                        let connections = [connection_id];
                        self.inner
                            .outgoing
                            .send_server_notification_to_connections(
                                &connections,
                                ServerNotification::AgentPlatformResourceEvent(
                                    AgentPlatformResourceEventNotification {
                                        run_id: run_id.to_string(),
                                        thread_id: params.thread_id.clone(),
                                        agent_id: params.agent_id.clone(),
                                        event: resource_event,
                                    },
                                ),
                            )
                            .await;
                    }
                    _ => {}
                }
            }
        }
        if !received_done {
            return Err(internal_error("Agent Platform stream ended before done"));
        }
        Ok(AgentPlatformChatResponse {
            agent_id: params.agent_id.clone(),
            message: answer,
            thoughts,
            skills_used,
            resource_events,
            tokens,
            duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        })
    }

    pub(super) async fn send_failed(
        &self,
        connection_id: ConnectionId,
        run_id: &str,
        params: &AgentPlatformChatParams,
        error: JSONRPCErrorError,
        cancelled: bool,
    ) {
        self.send_final_notification(
            connection_id,
            run_id,
            ServerNotification::AgentPlatformChatFailed(AgentPlatformChatFailedNotification {
                run_id: run_id.to_string(),
                thread_id: params.thread_id.clone(),
                agent_id: params.agent_id.clone(),
                code: error.code,
                error: error.message,
                cancelled,
            }),
        )
        .await;
    }

    async fn send_final_notification(
        &self,
        connection_id: ConnectionId,
        run_id: &str,
        notification: ServerNotification,
    ) {
        let connections = [connection_id];
        let send = self
            .inner
            .outgoing
            .send_server_notification_to_connections(&connections, notification);
        if tokio::time::timeout(FINAL_NOTIFICATION_TIMEOUT, send)
            .await
            .is_err()
        {
            tracing::warn!(run_id, "Agent Platform final notification timed out");
        }
    }
}

fn sse_data(frame: &str) -> Option<String> {
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(|value| value.strip_prefix(' ').unwrap_or(value))
        .collect::<Vec<_>>();
    (!data.is_empty()).then(|| data.join("\n"))
}

pub(super) fn take_sse_frame(
    buffer: &mut Vec<u8>,
    max_frame_bytes: usize,
) -> Result<Option<String>, JSONRPCErrorError> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    let separator = match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    let Some((separator, separator_len)) = separator else {
        if buffer.len() > max_frame_bytes {
            return Err(internal_error("Agent Platform SSE frame was too large"));
        }
        return Ok(None);
    };
    if separator > max_frame_bytes {
        return Err(internal_error("Agent Platform SSE frame was too large"));
    }
    let frame = buffer.drain(..separator).collect::<Vec<_>>();
    buffer.drain(..separator_len);
    String::from_utf8(frame)
        .map(Some)
        .map_err(|error| internal_error(format!("Agent Platform SSE was not valid UTF-8: {error}")))
}
