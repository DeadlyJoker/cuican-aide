use core_test_support::responses;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_message_item_added;
use core_test_support::responses::ev_output_text_delta;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::sse;
use core_test_support::skip_if_no_network;
use core_test_support::test_crewon::test_crewon;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::Op;
use crewon_protocol::user_input::UserInput;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;

fn completed(id: &str, input_tokens: i64, output_tokens: i64, end_turn: Option<bool>) -> Value {
    json!({
        "type": "response.completed",
        "response": {
            "id": id,
            "end_turn": end_turn,
            "usage": {
                "input_tokens": input_tokens,
                "input_tokens_details": null,
                "output_tokens": output_tokens,
                "output_tokens_details": null,
                "total_tokens": input_tokens + output_tokens
            }
        }
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_turn_false_empty_response_continues_same_turn() {
    skip_if_no_network!();
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/provider-end-turn-continuation.reference.json"
    )
    .expect("resolve AR-031 fixture");
    let reference: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture_path).expect("read AR-031 fixture"))
            .expect("parse AR-031 fixture");
    let server = responses::start_mock_server().await;
    let mock = mount_sse_sequence(
        &server,
        vec![
            sse(vec![
                ev_response_created("resp-ar-031-1"),
                completed("resp-ar-031-1", 4, 0, Some(false)),
            ]),
            sse(vec![
                ev_response_created("resp-ar-031-2"),
                ev_message_item_added("msg-ar-031", ""),
                ev_output_text_delta("done"),
                ev_assistant_message("msg-ar-031", "done"),
                completed("resp-ar-031-2", 5, 1, None),
            ]),
        ],
    )
    .await;
    let test = test_crewon()
        .build(&server)
        .await
        .expect("build AR-031 Rust reference runtime");
    test.crewon
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: "hello".to_string(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await
        .expect("submit AR-031 input");

    let mut stable_events = Vec::new();
    let mut terminal_output = None;
    let mut final_usage = None;
    loop {
        let event = test
            .crewon
            .next_event()
            .await
            .expect("receive AR-031 event");
        match event.msg {
            EventMsg::AgentMessageContentDelta(event) => stable_events.push(json!({
                "type": "model.output.delta",
                "delta": event.delta
            })),
            EventMsg::TokenCount(event) => {
                if let Some(info) = event.info {
                    stable_events.push(json!({
                        "type": "usage.recorded",
                        "inputTokens": info.last_token_usage.input_tokens,
                        "outputTokens": info.last_token_usage.output_tokens,
                        "totalTokens": info.last_token_usage.total_tokens
                    }));
                    final_usage = Some(json!({
                        "inputTokens": info.total_token_usage.input_tokens,
                        "outputTokens": info.total_token_usage.output_tokens,
                        "totalTokens": info.total_token_usage.total_tokens
                    }));
                }
            }
            EventMsg::AgentMessage(event) => terminal_output = Some(event.message),
            EventMsg::TurnComplete(event) => {
                let output = event.last_agent_message.expect("AR-031 terminal output");
                stable_events.push(json!({ "type": "segment.completed", "output": output }));
                break;
            }
            _ => {}
        }
    }
    let requests = mock.requests();
    let candidate = json!({
        "expectedRequests": requests.iter().map(|request| {
            request.message_input_texts("user").into_iter().filter(|content| content == "hello").map(|content| json!({
                "type": "message", "role": "user", "content": content
            })).collect::<Vec<_>>()
        }).collect::<Vec<_>>(),
        "expectedStableEvents": stable_events,
        "finalState": {
            "requestCount": requests.len(),
            "samplingRetries": 0,
            "terminal": "completed",
            "output": terminal_output.expect("AR-031 assistant output"),
            "usage": final_usage.expect("AR-031 usage")
        }
    });
    assert_eq!(candidate["expectedRequests"], reference["expectedRequests"]);
    assert_eq!(
        candidate["expectedStableEvents"],
        reference["expectedStableEvents"]
    );
    assert_eq!(candidate["finalState"], reference["finalState"]);
}
