use crate::error::ApiError;
use http::HeaderMap;
use std::sync::OnceLock;

pub(crate) const TURN_STATE_HEADER: &str = "x-codex-turn-state";
const MAX_TURN_STATE_BYTES: usize = 4 * 1024;

pub(crate) fn observe_turn_state(
    headers: &HeaderMap,
    state: &OnceLock<String>,
) -> Result<(), ApiError> {
    let mut values = headers.get_all(TURN_STATE_HEADER).iter();
    let Some(value) = values.next() else {
        return Ok(());
    };
    if values.next().is_some() {
        return Err(invalid("turn_state_header_duplicate"));
    }
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_TURN_STATE_BYTES
        || bytes
            .iter()
            .any(|byte| !(b' '..=b'~').contains(byte) || *byte == b',')
    {
        return Err(invalid("turn_state_header_invalid"));
    }
    let value = value
        .to_str()
        .map_err(|_| invalid("turn_state_header_invalid"))?;
    if let Some(current) = state.get() {
        if current != value {
            return Err(invalid("turn_state_header_conflict"));
        }
        return Ok(());
    }
    state
        .set(value.to_string())
        .map_err(|_| invalid("turn_state_header_conflict"))
}

fn invalid(message: &str) -> ApiError {
    ApiError::InvalidRequest {
        message: message.to_string(),
    }
}

#[cfg(test)]
#[path = "turn_state_tests.rs"]
mod tests;
