#![allow(clippy::expect_used)]

use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_message_item_added;
use core_test_support::responses::ev_output_text_delta;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::sse;
use core_test_support::skip_if_no_network;
use core_test_support::test_crewon::TestCrewon;
use core_test_support::test_crewon::test_crewon;
use core_test_support::wait_for_event;
use crewon_model_provider_info::ModelProviderInfo;
use crewon_model_provider_info::WireApi;
use crewon_protocol::items::AgentMessageContent;
use crewon_protocol::items::TurnItem;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::ItemCompletedEvent;
use crewon_protocol::protocol::Op;
use crewon_protocol::user_input::UserInput;
use pretty_assertions::assert_eq;
use serde_json::Value;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_string_contains;
use wiremock::matchers::method;
use wiremock::matchers::path;

fn load_reference() -> Value {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/turn-error-release.reference.json"
    )
    .expect("resolve turn error release fixture");
    let fixture = std::fs::read_to_string(fixture_path).expect("read turn error release fixture");
    serde_json::from_str(&fixture).expect("parse turn error release fixture")
}

fn reference_string(reference: &Value, pointer: &str) -> String {
    reference
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("reference string missing at {pointer}"))
        .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continue_after_stream_error() {
    skip_if_no_network!();

    let reference = load_reference();
    let expected_output = reference_string(&reference, "/events/2/data/output");
    let server = MockServer::start().await;

    let fail = ResponseTemplate::new(500)
        .insert_header("content-type", "application/json")
        .set_body_string(
            serde_json::json!({
                "error": {"type": "bad_request", "message": "synthetic client error"}
            })
            .to_string(),
        );

    // The provider below disables request retries (request_max_retries = 0),
    // so the failing request should only occur once.
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .and(body_string_contains("first message"))
        .respond_with(fail)
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;

    let ok = ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_raw(
            sse(vec![
                ev_response_created("resp_ok2"),
                ev_message_item_added("msg_ok2", ""),
                ev_output_text_delta(&expected_output),
                ev_assistant_message("msg_ok2", &expected_output),
                ev_completed("resp_ok2"),
            ]),
            "text/event-stream",
        );

    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .and(body_string_contains("follow up"))
        .respond_with(ok)
        .expect(1)
        .mount(&server)
        .await;

    // Configure a provider that uses the Responses API and points at our mock
    // server. Use an existing env var (PATH) to satisfy the auth plumbing
    // without requiring a real secret.
    let provider = ModelProviderInfo {
        name: "mock-openai".into(),
        base_url: Some(format!("{}/v1", server.uri())),
        env_key: Some("PATH".into()),
        env_key_instructions: None,
        experimental_bearer_token: None,
        auth: None,
        aws: None,
        wire_api: WireApi::Responses,
        query_params: None,
        http_headers: None,
        env_http_headers: None,
        request_max_retries: Some(0),
        stream_max_retries: Some(0),
        stream_idle_timeout_ms: Some(2_000),
        websocket_connect_timeout_ms: None,
        requires_openai_auth: false,
        supports_websockets: false,
    };

    let TestCrewon { crewon: codex, .. } = test_crewon()
        .with_config(move |config| {
            config.base_instructions = Some("You are a helpful assistant".to_string());
            config.model_provider = provider;
        })
        .build(&server)
        .await
        .unwrap();

    codex
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: "first message".into(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await
        .unwrap();

    // Expect an Error followed by TurnComplete so the session is released.
    let first_failed = matches!(
        wait_for_event(&codex, |ev| matches!(ev, EventMsg::Error(_))).await,
        EventMsg::Error(_)
    );

    let first_released = matches!(
        wait_for_event(&codex, |ev| matches!(ev, EventMsg::TurnComplete(_))).await,
        EventMsg::TurnComplete(_)
    );

    // 2) Second turn: now send another prompt that should succeed using the
    // mock server SSE stream. If the agent failed to clear the running task on
    // error above, this submission would be rejected/queued indefinitely.
    codex
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: "follow up".into(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await
        .unwrap();

    let mut completed_output = None;
    let second_completed = matches!(
        wait_for_event(&codex, |event| match event {
            EventMsg::AgentMessage(event) => {
                completed_output = Some(event.message.clone());
                false
            }
            EventMsg::ItemCompleted(ItemCompletedEvent {
                item: TurnItem::AgentMessage(item),
                ..
            }) => {
                completed_output = Some(
                    item.content
                        .iter()
                        .map(|content| match content {
                            AgentMessageContent::Text { text } => text.as_str(),
                        })
                        .collect::<String>(),
                );
                false
            }
            EventMsg::TurnComplete(event) => {
                completed_output = event.last_agent_message.clone();
                true
            }
            _ => false,
        })
        .await,
        EventMsg::TurnComplete(_)
    );
    let request_count = server
        .received_requests()
        .await
        .expect("read captured requests")
        .len();
    let candidate = serde_json::json!({
        "schemaVersion": "crewon.trace.v0",
        "caseId": "AR-003-turn-error-release",
        "events": [
            {
                "schemaVersion": "crewon.turn-event.v0",
                "sequence": 1,
                "type": "turn.failed",
                "identity": {"turnSlot": "first"},
                "data": {"category": "provider", "retryable": !first_failed}
            },
            {
                "schemaVersion": "crewon.turn-event.v0",
                "sequence": 2,
                "type": "turn.released",
                "identity": {"turnSlot": "first"},
                "data": {"workItemSettled": first_released}
            },
            {
                "schemaVersion": "crewon.turn-event.v0",
                "sequence": 3,
                "type": "turn.completed",
                "identity": {"turnSlot": "second"},
                "data": {"output": completed_output.unwrap_or_default()}
            }
        ],
        "finalState": {
            "firstStatus": if first_failed { "failed" } else { "running" },
            "secondStatus": if second_completed { "completed" } else { "running" },
            "pendingWorkItems": if first_released { 0 } else { 1 },
            "requestCount": request_count
        }
    });

    assert_eq!(candidate, reference);
}
