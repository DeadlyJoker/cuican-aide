use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::UserInput;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crate::error_code::invalid_request;
use crate::task_control::cloud_agent_thread_projection::CloudAgentThreadProjectionError;

pub(super) fn cloud_agent_text_input(params: &TurnStartParams) -> Result<&str, JSONRPCErrorError> {
    if params.responsesapi_client_metadata.is_some()
        || params.additional_context.is_some()
        || params.environments.is_some()
        || params.cwd.is_some()
        || params.runtime_workspace_roots.is_some()
        || params.approval_policy.is_some()
        || params.approvals_reviewer.is_some()
        || params.sandbox_policy.is_some()
        || params.permissions.is_some()
        || params.model.is_some()
        || params.service_tier.is_some()
        || params.effort.is_some()
        || params.summary.is_some()
        || params.personality.is_some()
        || params.output_schema.is_some()
        || params.collaboration_mode.is_some()
    {
        return Err(invalid_request(
            "Cloud Agent turn/start overrides are not supported",
        ));
    }
    match params.input.as_slice() {
        [
            UserInput::Text {
                text,
                text_elements,
            },
        ] if !text.trim().is_empty() && text_elements.is_empty() => Ok(text),
        [_] | [] | [_, ..] => Err(invalid_request(
            "Cloud Agent turn/start supports exactly one plain text input",
        )),
    }
}

pub(super) fn map_cloud_agent_turn_error(
    error: crate::task_control::cloud_agent_turn_coordinator::CloudAgentTurnStartError,
) -> JSONRPCErrorError {
    use crate::task_control::cloud_agent_turn_coordinator::CloudAgentTurnStartError;

    match error {
        CloudAgentTurnStartError::InvalidRequest => {
            invalid_params("Cloud Agent turn/start request is invalid")
        }
        CloudAgentTurnStartError::Unauthorized => {
            invalid_request("Cloud Agent Turn request is not authorized")
        }
        CloudAgentTurnStartError::CapabilityUnsupported => {
            invalid_request("Cloud Agent execution capability is unsupported")
        }
        CloudAgentTurnStartError::AuthorityChanged => {
            invalid_request("Cloud Agent execution authority changed")
        }
        CloudAgentTurnStartError::Conflict => {
            invalid_request("Cloud Agent Turn conflicts with durable state")
        }
        CloudAgentTurnStartError::ActiveTurnExists => {
            invalid_request("A Cloud Agent Turn is already active")
        }
        CloudAgentTurnStartError::CapacityExceeded => {
            invalid_request("Cloud Agent Turn capacity was exceeded")
        }
        CloudAgentTurnStartError::StateUnavailable => {
            internal_error("Cloud Agent Turn state is unavailable")
        }
    }
}

pub(super) fn map_cloud_agent_turn_interrupt_error(
    error: crate::task_control::cloud_agent_turn_cancellation::CloudAgentTurnInterruptError,
) -> JSONRPCErrorError {
    use crate::task_control::cloud_agent_turn_cancellation::CloudAgentTurnInterruptError;

    match error {
        CloudAgentTurnInterruptError::InvalidRequest => {
            invalid_params("Cloud Agent turn/interrupt request is invalid")
        }
        CloudAgentTurnInterruptError::Unauthorized => {
            invalid_request("Cloud Agent Turn interrupt is not authorized")
        }
        CloudAgentTurnInterruptError::NotFound => invalid_request("Cloud Agent Turn was not found"),
        CloudAgentTurnInterruptError::AuthorityChanged => {
            invalid_request("Cloud Agent Turn interrupt authority changed")
        }
        CloudAgentTurnInterruptError::Conflict => {
            invalid_request("Cloud Agent Turn interrupt conflicts with durable state")
        }
        CloudAgentTurnInterruptError::StateUnavailable => {
            internal_error("Cloud Agent Turn interrupt state is unavailable")
        }
    }
}

pub(super) fn map_cloud_agent_thread_projection_error(
    error: CloudAgentThreadProjectionError,
) -> JSONRPCErrorError {
    match error {
        CloudAgentThreadProjectionError::Unauthorized => {
            invalid_request("Thread execution context request is not authorized")
        }
        CloudAgentThreadProjectionError::NotFound => {
            invalid_request("Cloud Agent Turn was not found")
        }
        CloudAgentThreadProjectionError::InvalidCursor => {
            invalid_request("Cloud Agent Thread cursor is invalid")
        }
        CloudAgentThreadProjectionError::CapacityExceeded => {
            invalid_request("Cloud Agent Thread history capacity was exceeded")
        }
        CloudAgentThreadProjectionError::InvalidProjection => {
            internal_error("Cloud Agent Thread projection is invalid")
        }
        CloudAgentThreadProjectionError::StateUnavailable => {
            internal_error("Cloud Agent Thread projection is unavailable")
        }
    }
}

#[cfg(test)]
#[path = "message_processor_platform_control_tests.rs"]
mod tests;
