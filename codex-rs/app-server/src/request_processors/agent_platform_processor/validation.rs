use crewon_app_server_protocol::AgentPlatformChatParams;
use crewon_app_server_protocol::AgentPlatformSessionParams;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_utils_output_truncation::approx_token_count;

use crate::error_code::invalid_params;

use super::MAX_AGENT_ID_BYTES;
use super::MAX_CONTEXT_TOKENS;
use super::MAX_MESSAGE_CHARS;
use super::MAX_THREAD_ID_BYTES;

pub(super) fn validate_chat_params(
    params: &AgentPlatformChatParams,
) -> Result<(), JSONRPCErrorError> {
    validate_thread_id(&params.thread_id)?;
    validate_agent_id(&params.agent_id)?;
    let message = &params.message;
    if message.trim().is_empty() {
        return Err(invalid_params("Agent Platform message must not be empty"));
    }
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(invalid_params(format!(
            "Agent Platform message must not exceed {MAX_MESSAGE_CHARS} characters"
        )));
    }
    if approx_token_count(message) > MAX_CONTEXT_TOKENS {
        return Err(invalid_params(format!(
            "Agent Platform message must not exceed {MAX_CONTEXT_TOKENS} approximate tokens"
        )));
    }
    Ok(())
}

pub(super) fn validate_session_params(
    params: &AgentPlatformSessionParams,
) -> Result<(), JSONRPCErrorError> {
    validate_thread_id(&params.thread_id)?;
    validate_agent_id(&params.agent_id)
}

fn validate_thread_id(thread_id: &str) -> Result<(), JSONRPCErrorError> {
    if thread_id.trim().is_empty() || thread_id.len() > MAX_THREAD_ID_BYTES {
        return Err(invalid_params(format!(
            "Agent Platform threadId must contain 1 to {MAX_THREAD_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

pub(super) fn validate_agent_id(agent_id: &str) -> Result<(), JSONRPCErrorError> {
    if agent_id.is_empty()
        || agent_id.len() > MAX_AGENT_ID_BYTES
        || !agent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(invalid_params(
            "Agent Platform agentId must be a safe URL path segment",
        ));
    }
    Ok(())
}
