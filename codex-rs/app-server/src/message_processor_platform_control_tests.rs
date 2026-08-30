use std::path::PathBuf;

use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::UserInput;
use pretty_assertions::assert_eq;

use super::cloud_agent_text_input;
use super::map_cloud_agent_thread_projection_error;
use super::map_cloud_agent_turn_interrupt_error;
use crate::task_control::cloud_agent_thread_projection::CloudAgentThreadProjectionError;
use crate::task_control::cloud_agent_turn_cancellation::CloudAgentTurnInterruptError;

#[test]
fn cloud_agent_turn_accepts_only_one_plain_text_input_without_overrides() {
    let params = TurnStartParams {
        thread_id: "019f550e-ba52-7490-a248-b0d3a84103c1".to_string(),
        client_user_message_id: Some("client-message-1".to_string()),
        input: vec![UserInput::Text {
            text: "Ship it".to_string(),
            text_elements: Vec::new(),
        }],
        ..TurnStartParams::default()
    };
    assert_eq!(
        cloud_agent_text_input(&params).expect("plain text"),
        "Ship it"
    );

    let with_skill = TurnStartParams {
        input: vec![UserInput::Skill {
            name: "unsafe-implicit-export".to_string(),
            path: PathBuf::from("/tmp/skill"),
        }],
        ..params.clone()
    };
    assert!(cloud_agent_text_input(&with_skill).is_err());

    let with_override = TurnStartParams {
        model: Some("provider-controlled-model".to_string()),
        ..params
    };
    assert!(cloud_agent_text_input(&with_override).is_err());
}

#[test]
fn cloud_agent_thread_projection_preserves_execution_context_authorization_error() {
    let error =
        map_cloud_agent_thread_projection_error(CloudAgentThreadProjectionError::Unauthorized);

    assert_eq!(
        error.message,
        "Thread execution context request is not authorized"
    );
}

#[test]
fn cloud_agent_interrupt_preserves_not_found_and_state_failure_classes() {
    assert_eq!(
        map_cloud_agent_turn_interrupt_error(CloudAgentTurnInterruptError::NotFound).message,
        "Cloud Agent Turn was not found"
    );
    assert_eq!(
        map_cloud_agent_turn_interrupt_error(CloudAgentTurnInterruptError::StateUnavailable)
            .message,
        "Cloud Agent Turn interrupt state is unavailable"
    );
}
