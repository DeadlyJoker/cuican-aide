use std::path::PathBuf;
use std::sync::Arc;

use crewon_app_server_protocol::AgentPlatformChatParams;
use crewon_app_server_protocol::AgentPlatformHistoryMessage;
use crewon_app_server_protocol::AgentPlatformUser;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_utils_output_truncation::approx_token_count;
use sha2::Digest;
use sha2::Sha256;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use crate::error_code::internal_error;

use super::AgentPlatformRequestProcessor;
use super::MAX_CONTEXT_TOKENS;
use super::MAX_HISTORY_MESSAGES;
use super::MAX_SESSION_FILE_BYTES;
use super::StoredSession;

impl AgentPlatformRequestProcessor {
    pub(super) async fn persist_completed_turn(
        &self,
        user: &AgentPlatformUser,
        params: &AgentPlatformChatParams,
        answer: &str,
    ) -> Result<(), JSONRPCErrorError> {
        validate_completed_answer(answer)?;
        if let Err(error) = self.append_completed_turn(user, params, answer).await {
            tracing::warn!(
                user_id = user.id,
                agent_id = params.agent_id,
                code = error.code,
                error = error.message,
                "Agent Platform completed remotely but local history could not be persisted"
            );
        }
        Ok(())
    }

    pub(super) async fn context_for(
        &self,
        user: &AgentPlatformUser,
        params: &AgentPlatformChatParams,
    ) -> Result<Vec<AgentPlatformHistoryMessage>, JSONRPCErrorError> {
        let session = self
            .load_session(user.id, &params.thread_id, &params.agent_id)
            .await?;
        Ok(trim_history(session.messages, &params.message))
    }

    async fn append_completed_turn(
        &self,
        user: &AgentPlatformUser,
        params: &AgentPlatformChatParams,
        answer: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let mut session = self
            .load_session(user.id, &params.thread_id, &params.agent_id)
            .await?;
        session.messages.extend([
            AgentPlatformHistoryMessage {
                role: "user".to_string(),
                content: params.message.clone(),
            },
            AgentPlatformHistoryMessage {
                role: "assistant".to_string(),
                content: answer.to_string(),
            },
        ]);
        session.messages = latest_complete_rounds(session.messages);
        self.write_session(&session).await
    }

    pub(super) async fn load_session(
        &self,
        user_id: i64,
        thread_id: &str,
        agent_id: &str,
    ) -> Result<StoredSession, JSONRPCErrorError> {
        let path = self.session_path(user_id, thread_id, agent_id);
        match fs::File::open(&path).await {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take((MAX_SESSION_FILE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|error| internal_error(error.to_string()))?;
                if bytes.len() > MAX_SESSION_FILE_BYTES {
                    return Err(internal_error("Agent Platform session file is too large"));
                }
                let mut session = serde_json::from_slice::<StoredSession>(&bytes)
                    .map_err(|error| internal_error(error.to_string()))?;
                if session.user_id != user_id
                    || session.thread_id != thread_id
                    || session.agent_id != agent_id
                {
                    return Err(internal_error(
                        "Agent Platform session identity did not match",
                    ));
                }
                session.messages = latest_complete_rounds(session.messages);
                Ok(session)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StoredSession {
                user_id,
                thread_id: thread_id.to_string(),
                agent_id: agent_id.to_string(),
                messages: Vec::new(),
            }),
            Err(error) => Err(internal_error(error.to_string())),
        }
    }

    #[expect(
        clippy::await_holding_invalid_type,
        reason = "session file-count enforcement and the following atomic write must stay serialized"
    )]
    pub(super) async fn write_session(
        &self,
        session: &StoredSession,
    ) -> Result<(), JSONRPCErrorError> {
        let path = self.session_path(session.user_id, &session.thread_id, &session.agent_id);
        let contents =
            serde_json::to_string(session).map_err(|error| internal_error(error.to_string()))?;
        if contents.len() > MAX_SESSION_FILE_BYTES {
            return Err(internal_error("Agent Platform session file is too large"));
        }
        let _write_guard = self.inner.history_write_lock.lock().await;
        if !fs::try_exists(&path)
            .await
            .map_err(|error| internal_error(error.to_string()))?
            && self.session_file_count().await? >= super::MAX_SESSION_FILES
        {
            return Err(internal_error("Agent Platform session file limit reached"));
        }
        tokio::task::spawn_blocking(move || crewon_utils_path::write_atomically(&path, &contents))
            .await
            .map_err(|error| internal_error(error.to_string()))?
            .map_err(|error| internal_error(error.to_string()))
    }

    async fn session_file_count(&self) -> Result<usize, JSONRPCErrorError> {
        let mut entries = match fs::read_dir(&self.inner.history_root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(internal_error(error.to_string())),
        };
        let mut count = 0;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| internal_error(error.to_string()))?
        {
            if entry
                .path()
                .extension()
                .is_some_and(|value| value == "json")
            {
                count += 1;
                if count >= super::MAX_SESSION_FILES {
                    break;
                }
            }
        }
        Ok(count)
    }

    pub(super) fn session_path(&self, user_id: i64, thread_id: &str, agent_id: &str) -> PathBuf {
        self.inner.history_root.join(format!(
            "{}.json",
            session_key(user_id, thread_id, agent_id)
        ))
    }

    pub(super) async fn session_lock(
        &self,
        user_id: i64,
        thread_id: &str,
        agent_id: &str,
    ) -> Arc<Mutex<()>> {
        let key = session_key(user_id, thread_id, agent_id);
        let mut locks = self.inner.session_locks.lock().await;
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        Arc::clone(locks.entry(key).or_insert_with(|| Arc::new(Mutex::new(()))))
    }
}

fn validate_completed_answer(answer: &str) -> Result<(), JSONRPCErrorError> {
    if answer.trim().is_empty() {
        return Err(internal_error("Agent Platform returned an empty response"));
    }
    if answer.chars().count() > super::MAX_MESSAGE_CHARS {
        return Err(internal_error(format!(
            "Agent Platform response exceeded {} characters",
            super::MAX_MESSAGE_CHARS
        )));
    }
    if approx_token_count(answer) > MAX_CONTEXT_TOKENS {
        return Err(internal_error(format!(
            "Agent Platform response exceeded {MAX_CONTEXT_TOKENS} approximate tokens"
        )));
    }
    Ok(())
}

pub(super) fn trim_history(
    messages: Vec<AgentPlatformHistoryMessage>,
    current_message: &str,
) -> Vec<AgentPlatformHistoryMessage> {
    let current_tokens = approx_token_count(current_message);
    if current_tokens > MAX_CONTEXT_TOKENS {
        return Vec::new();
    }
    let mut remaining = MAX_CONTEXT_TOKENS.saturating_sub(current_tokens);
    let mut kept = Vec::new();
    for round in complete_rounds(messages)
        .into_iter()
        .rev()
        .take(MAX_HISTORY_MESSAGES / 2)
    {
        let length = round
            .iter()
            .map(|message| approx_token_count(&message.content))
            .sum::<usize>();
        if length > remaining {
            break;
        }
        remaining -= length;
        kept.push(round);
    }
    kept.reverse();
    kept.into_iter().flatten().collect()
}

fn latest_complete_rounds(
    messages: Vec<AgentPlatformHistoryMessage>,
) -> Vec<AgentPlatformHistoryMessage> {
    complete_rounds(messages)
        .into_iter()
        .rev()
        .take(MAX_HISTORY_MESSAGES / 2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .flatten()
        .collect()
}

fn complete_rounds(
    messages: Vec<AgentPlatformHistoryMessage>,
) -> Vec<[AgentPlatformHistoryMessage; 2]> {
    let mut rounds = Vec::new();
    let mut messages = messages.into_iter();
    while let (Some(user), Some(assistant)) = (messages.next(), messages.next()) {
        if user.role == "user"
            && assistant.role == "assistant"
            && !user.content.trim().is_empty()
            && !assistant.content.trim().is_empty()
            && user.content.chars().count() <= super::MAX_MESSAGE_CHARS
            && assistant.content.chars().count() <= super::MAX_MESSAGE_CHARS
            && approx_token_count(&user.content) <= MAX_CONTEXT_TOKENS
            && approx_token_count(&assistant.content) <= MAX_CONTEXT_TOKENS
        {
            rounds.push([user, assistant]);
        }
    }
    rounds
}

fn session_key(user_id: i64, thread_id: &str, agent_id: &str) -> String {
    let digest = Sha256::digest(format!("{user_id}\0{thread_id}\0{agent_id}"));
    format!("{digest:x}")
}
