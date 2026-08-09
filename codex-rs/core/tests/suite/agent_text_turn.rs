#![allow(clippy::expect_used)]

use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_message_item_added;
use core_test_support::responses::ev_output_text_delta;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_once;
use core_test_support::responses::sse;
use core_test_support::skip_if_no_network;
use core_test_support::test_crewon::test_crewon;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::Op;
use crewon_protocol::user_input::UserInput;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;

fn load_reference() -> Value {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/agent-text-turn.reference.json"
    )
    .expect("resolve AR-001 basic text Turn fixture");
    serde_json::from_str(
        &std::fs::read_to_string(fixture_path).expect("read AR-001 basic text Turn fixture"),
    )
    .expect("parse AR-001 basic text Turn fixture")
}

fn reference_string(reference: &Value, pointer: &str) -> String {
    reference
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("reference string missing at {pointer}"))
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn basic_text_turn_matches_shared_request_event_history_and_terminal_trace() {
    skip_if_no_network!();

    let reference = load_reference();
    let input = reference_string(&reference, "/events/0/data/input");
    let first_delta = reference_string(&reference, "/events/2/data/delta");
    let second_delta = reference_string(&reference, "/events/3/data/delta");
    let output = reference_string(&reference, "/events/4/data/output");
    let server = core_test_support::responses::start_mock_server().await;
    let completed = json!({
        "type": "response.completed",
        "response": {
            "id": "resp-ar-001",
            "usage": {
                "input_tokens": 4,
                "input_tokens_details": null,
                "output_tokens": 1,
                "output_tokens_details": null,
                "total_tokens": 5
            }
        }
    });
    let response_mock = mount_sse_once(
        &server,
        sse(vec![
            ev_response_created("resp-ar-001"),
            ev_message_item_added("msg-ar-001", ""),
            ev_output_text_delta(&first_delta),
            ev_output_text_delta(&second_delta),
            ev_assistant_message("msg-ar-001", &output),
            completed,
        ]),
    )
    .await;
    let mut builder = test_crewon().with_config(|config| {
        config.base_instructions = Some("AR-001 deterministic fixture".to_string());
    });
    let test = builder
        .build(&server)
        .await
        .expect("build AR-001 Rust reference runtime");

    test.crewon
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: input.clone(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await
        .expect("submit AR-001 user input");

    let mut turn_started = false;
    let mut deltas = Vec::new();
    let mut assistant_messages = Vec::new();
    let mut usage = None;
    let mut turn_completed = false;
    while !turn_completed {
        let event = test
            .crewon
            .next_event()
            .await
            .expect("receive AR-001 event");
        match event.msg {
            EventMsg::TurnStarted(_) => turn_started = true,
            EventMsg::AgentMessageContentDelta(event) => deltas.push(event.delta),
            EventMsg::AgentMessage(event) => assistant_messages.push(event.message),
            EventMsg::TokenCount(event) => {
                if let Some(info) = event.info {
                    usage = Some(json!({
                        "inputTokens": info.total_token_usage.input_tokens,
                        "outputTokens": info.total_token_usage.output_tokens,
                        "totalTokens": info.total_token_usage.total_tokens
                    }));
                }
            }
            EventMsg::TurnComplete(_) => turn_completed = true,
            _ => {}
        }
    }

    assert!(turn_started, "missing Rust TurnStarted event");
    assert_eq!(deltas, vec![first_delta.clone(), second_delta.clone()]);
    assert_eq!(assistant_messages, vec![output.clone()]);
    let request = response_mock.single_request();
    let request_history = request
        .message_input_texts("user")
        .into_iter()
        .filter(|text| text == &input)
        .map(|content| json!({ "type": "message", "role": "user", "content": content }))
        .collect::<Vec<_>>();
    let expected_history = reference["finalState"]["history"]
        .as_array()
        .expect("AR-001 final history array");
    let rollout_history = projected_rollout_history(
        test.crewon
            .rollout_path()
            .expect("AR-001 rollout path")
            .as_path(),
        expected_history,
    );
    let identity = json!({ "turnSlot": "first" });
    let candidate = json!({
        "schemaVersion": "crewon.trace.v0",
        "caseId": "AR-001-basic-text-turn",
        "events": [
            trace_event(1, "turn.started", &identity, json!({ "input": input })),
            trace_event(2, "model.requested", &identity, json!({
                "requestIndex": 1,
                "history": request_history
            })),
            trace_event(3, "model.output.delta", &identity, json!({ "delta": first_delta })),
            trace_event(4, "model.output.delta", &identity, json!({ "delta": second_delta })),
            trace_event(5, "assistant.committed", &identity, json!({ "output": output })),
            trace_event(6, "turn.completed", &identity, json!({ "output": output })),
            trace_event(7, "turn.released", &identity, json!({ "activeTurn": false }))
        ],
        "finalState": {
            "activeTurn": false,
            "history": rollout_history,
            "lastAssistantMessage": assistant_messages.into_iter().next().expect("assistant output"),
            "requestCount": 1,
            "terminalStatus": "completed",
            "usage": usage.expect("Rust usage event")
        }
    });

    assert_eq!(candidate, reference);
}

fn trace_event(sequence: u64, event_type: &str, identity: &Value, data: Value) -> Value {
    json!({
        "schemaVersion": "crewon.turn-event.v0",
        "sequence": sequence,
        "type": event_type,
        "identity": identity,
        "data": data
    })
}

fn projected_rollout_history(path: &std::path::Path, expected: &[Value]) -> Vec<Value> {
    std::fs::read_to_string(path)
        .expect("read AR-001 rollout")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("parse AR-001 rollout line"))
        .filter(|line| line.get("type").and_then(Value::as_str) == Some("response_item"))
        .filter_map(|line| project_message(&line["payload"]))
        .filter(|message| expected.contains(message))
        .collect()
}

fn project_message(payload: &Value) -> Option<Value> {
    if payload.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let role = payload.get("role")?.as_str()?;
    if !matches!(role, "user" | "assistant") {
        return None;
    }
    let content = payload
        .get("content")?
        .as_array()?
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<String>();
    Some(json!({ "type": "message", "role": role, "content": content }))
}
