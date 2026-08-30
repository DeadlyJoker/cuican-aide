use crewon_app_server_protocol::JSONRPCErrorError;
use serde_json::Map;
use serde_json::Value as JsonValue;

use crate::error_code::invalid_params;

use super::MAX_AGENT_ID_BYTES;
use super::MAX_WORKFLOW_ID_BYTES;
use super::MAX_WORKFLOW_INPUT_BYTES;
use super::MAX_WORKFLOW_INPUT_CHARS;

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

pub(super) fn validate_workflow_id(workflow_id: &str) -> Result<(), JSONRPCErrorError> {
    let valid_number = workflow_id.parse::<i64>().is_ok_and(|value| value > 0);
    if workflow_id.is_empty()
        || workflow_id.len() > MAX_WORKFLOW_ID_BYTES
        || !workflow_id.bytes().all(|byte| byte.is_ascii_digit())
        || !valid_number
    {
        return Err(invalid_params(
            "Agent Platform workflowId must be a positive integer URL path segment",
        ));
    }
    Ok(())
}

pub(super) fn workflow_input_data(input: &str) -> Result<JsonValue, JSONRPCErrorError> {
    let input = input.trim();
    if input.is_empty()
        || input.len() > MAX_WORKFLOW_INPUT_BYTES
        || input.chars().count() > MAX_WORKFLOW_INPUT_CHARS
        || input
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(invalid_params(
            "Agent Platform Workflow input is invalid or too large",
        ));
    }
    if input.starts_with('{') {
        return serde_json::from_str::<JsonValue>(input)
            .ok()
            .filter(JsonValue::is_object)
            .ok_or_else(|| {
                invalid_params("Agent Platform Workflow JSON input must be a valid object")
            });
    }
    let mut input_data = Map::new();
    input_data.insert("input".to_string(), JsonValue::String(input.to_string()));
    input_data.insert("prompt".to_string(), JsonValue::String(input.to_string()));
    Ok(JsonValue::Object(input_data))
}
