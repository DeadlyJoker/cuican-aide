#![allow(clippy::expect_used)]

//! Verifies that the agent retries when the SSE stream terminates before
//! delivering a `response.completed` event.

use core_test_support::responses;
use core_test_support::skip_if_no_network;
use core_test_support::streaming_sse::StreamingSseChunk;
use core_test_support::streaming_sse::StreamingSseServer;
use core_test_support::streaming_sse::start_streaming_sse_server;
use core_test_support::test_crewon::TestCrewon;
use core_test_support::test_crewon::test_crewon;
use core_test_support::wait_for_event;
use crewon_core::CrewonThread;
use crewon_model_provider_info::ModelProviderInfo;
use crewon_model_provider_info::WireApi;
use crewon_protocol::items::AgentMessageContent;
use crewon_protocol::items::AgentMessageItem;
use crewon_protocol::items::TurnItem;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::ItemCompletedEvent;
use crewon_protocol::protocol::ItemStartedEvent;
use crewon_protocol::protocol::Op;
use crewon_protocol::user_input::UserInput;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;

fn sse_incomplete() -> String {
    responses::sse(vec![serde_json::json!({
        "type": "response.output_item.done",
    })])
}

#[derive(Debug, Default)]
struct ObservedRetryTrace {
    started_item_ids: Vec<String>,
    deltas: Vec<String>,
    completed_outputs: Vec<String>,
    stream_errors: Vec<String>,
    usage: Option<Value>,
}

impl ObservedRetryTrace {
    fn discarded_output(&self) -> bool {
        self.started_item_ids.len() > self.completed_outputs.len()
    }
}

fn load_reference(file_name: &str) -> Value {
    let relative_path = format!("../../packages/test-contracts/fixtures/{file_name}");
    let fixture_path = crewon_utils_cargo_bin::find_resource!(relative_path)
        .expect("resolve Agent retry reference fixture");
    let fixture = std::fs::read_to_string(fixture_path).expect("read Agent retry fixture");
    serde_json::from_str(&fixture).expect("parse Agent retry fixture")
}

fn reference_u64(reference: &Value, pointer: &str) -> u64 {
    reference
        .pointer(pointer)
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("reference integer missing at {pointer}"))
}

fn reference_string(reference: &Value, pointer: &str) -> String {
    reference
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("reference string missing at {pointer}"))
        .to_string()
}

fn reference_deltas(reference: &Value) -> Vec<String> {
    reference["events"]
        .as_array()
        .expect("reference events should be an array")
        .iter()
        .filter(|event| event["type"] == "model.output.delta")
        .map(|event| {
            event["data"]["delta"]
                .as_str()
                .expect("reference delta should be a string")
                .to_string()
        })
        .collect()
}

fn reference_discarded_output(reference: &Value) -> bool {
    reference["events"]
        .as_array()
        .expect("reference events should be an array")
        .iter()
        .find(|event| event["type"] == "model.sampling.retry")
        .and_then(|event| event["data"]["discardedOutput"].as_bool())
        .expect("reference retry discard flag should be a boolean")
}

fn request_input(request: &[u8]) -> Vec<Value> {
    serde_json::from_slice::<Value>(request).expect("parse Responses request body")["input"]
        .as_array()
        .expect("Responses request input array")
        .clone()
}

fn provider(base_url: String, stream_max_retries: u64) -> ModelProviderInfo {
    ModelProviderInfo {
        name: "openai".into(),
        base_url: Some(base_url),
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
        stream_max_retries: Some(stream_max_retries),
        stream_idle_timeout_ms: Some(2000),
        websocket_connect_timeout_ms: None,
        requires_openai_auth: false,
        supports_websockets: false,
    }
}

async fn build_crewon(server: &StreamingSseServer, stream_max_retries: u64) -> TestCrewon {
    let model_provider = provider(format!("{}/v1", server.uri()), stream_max_retries);
    test_crewon()
        .with_config(move |config| {
            config.model_provider = model_provider;
        })
        .build_with_streaming_server(server)
        .await
        .expect("build streaming retry test")
}

async fn submit_hello(crewon: &CrewonThread) {
    crewon
        .submit(Op::UserInput {
            items: vec![UserInput::Text {
                text: "hello".into(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        })
        .await
        .expect("submit retry test turn");
}

async fn observe_retry_trace(crewon: &CrewonThread) -> ObservedRetryTrace {
    let mut trace = ObservedRetryTrace::default();
    wait_for_event(crewon, |event| match event {
        EventMsg::ItemStarted(ItemStartedEvent {
            item: TurnItem::AgentMessage(item),
            ..
        }) => {
            trace.started_item_ids.push(item.id.clone());
            false
        }
        EventMsg::AgentMessageContentDelta(event) => {
            trace.deltas.push(event.delta.clone());
            false
        }
        EventMsg::ItemCompleted(ItemCompletedEvent {
            item: TurnItem::AgentMessage(item),
            ..
        }) => {
            trace.completed_outputs.push(agent_message_text(item));
            false
        }
        EventMsg::StreamError(event) => {
            trace.stream_errors.push(event.message.clone());
            false
        }
        EventMsg::TokenCount(event) => {
            if let Some(info) = &event.info {
                trace.usage = Some(json!({
                    "inputTokens": info.total_token_usage.input_tokens,
                    "cachedInputTokens": info.total_token_usage.cached_input_tokens,
                    "outputTokens": info.total_token_usage.output_tokens,
                    "totalTokens": info.total_token_usage.total_tokens,
                }));
            }
            false
        }
        EventMsg::TurnComplete(_) => true,
        _ => false,
    })
    .await;
    trace
}

fn agent_message_text(item: &AgentMessageItem) -> String {
    item.content
        .iter()
        .map(|content| match content {
            AgentMessageContent::Text { text } => text.as_str(),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_on_early_close() {
    skip_if_no_network!();

    let reference = load_reference("stream-early-close-retry.reference.json");
    let stream_max_retries = reference_u64(&reference, "/finalState/samplingRetries");

    let incomplete_sse = sse_incomplete();
    let completed_sse = responses::sse(vec![
        responses::ev_response_created("resp_ok"),
        responses::ev_message_item_added("msg_ok", ""),
        responses::ev_output_text_delta("done"),
        responses::ev_assistant_message("msg_ok", "done"),
        responses::ev_completed("resp_ok"),
    ]);

    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: incomplete_sse,
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: completed_sse,
        }],
    ])
    .await;

    let TestCrewon { crewon: codex, .. } = build_crewon(&server, stream_max_retries).await;
    submit_hello(&codex).await;
    let observed = observe_retry_trace(&codex).await;

    let requests = server.requests().await;
    assert_eq!(
        requests.len() as u64,
        reference_u64(&reference, "/finalState/requestCount"),
        "expected retry after incomplete SSE stream"
    );
    assert_eq!(observed.deltas, reference_deltas(&reference));
    assert_eq!(
        observed.completed_outputs,
        vec![reference_string(&reference, "/finalState/finalOutput")]
    );
    assert_eq!(observed.stream_errors.len() as u64, stream_max_retries);
    assert_eq!(
        observed.discarded_output(),
        reference_discarded_output(&reference)
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_after_partial_output_without_committing_the_abandoned_item() {
    skip_if_no_network!();

    let reference = load_reference("stream-partial-close-retry.reference.json");
    let stream_max_retries = reference_u64(&reference, "/finalState/samplingRetries");
    let incomplete_sse = responses::sse(vec![
        responses::ev_response_created("resp_draft"),
        responses::ev_message_item_added("msg_draft", ""),
        responses::ev_output_text_delta("draft"),
    ]);
    let completed_sse = responses::sse(vec![
        responses::ev_response_created("resp_final"),
        responses::ev_message_item_added("msg_final", ""),
        responses::ev_output_text_delta("done"),
        responses::ev_assistant_message("msg_final", "done"),
        responses::ev_completed("resp_final"),
    ]);
    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: incomplete_sse,
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: completed_sse,
        }],
    ])
    .await;

    let TestCrewon { crewon: codex, .. } = build_crewon(&server, stream_max_retries).await;
    submit_hello(&codex).await;
    let observed = observe_retry_trace(&codex).await;

    assert_eq!(
        server.requests().await.len() as u64,
        reference_u64(&reference, "/finalState/requestCount")
    );
    assert_eq!(observed.deltas, reference_deltas(&reference));
    assert_eq!(
        observed.completed_outputs,
        vec![reference_string(&reference, "/finalState/finalOutput")]
    );
    assert_eq!(observed.stream_errors.len() as u64, stream_max_retries);
    assert_eq!(
        observed.discarded_output(),
        reference_discarded_output(&reference)
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_assistant_item_is_preserved_in_retry_request() {
    skip_if_no_network!();
    let reference = load_reference("stream-completed-assistant-close-retry.reference.json");
    let completed_content = reference_string(&reference, "/completedItem/content");

    let first_sse = responses::sse(vec![
        responses::ev_response_created("resp_first"),
        responses::ev_message_item_added("msg_first", ""),
        responses::ev_output_text_delta(&completed_content),
        responses::ev_assistant_message("msg_first", &completed_content),
    ]);
    let second_sse = responses::sse(vec![
        responses::ev_response_created("resp_final"),
        responses::ev_message_item_added("msg_final", ""),
        responses::ev_output_text_delta("done"),
        responses::ev_assistant_message("msg_final", "done"),
        responses::ev_completed("resp_final"),
    ]);
    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: first_sse,
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: second_sse,
        }],
    ])
    .await;

    let TestCrewon { crewon, .. } = build_crewon(
        &server,
        reference_u64(&reference, "/finalState/samplingRetries"),
    )
    .await;
    submit_hello(&crewon).await;
    let observed = observe_retry_trace(&crewon).await;

    let requests = server.requests().await;
    assert_eq!(
        requests.len() as u64,
        reference_u64(&reference, "/finalState/requestCount")
    );
    let assistant_texts = request_input(&requests[1])
        .into_iter()
        .filter(|item| item["type"] == "message" && item["role"] == "assistant")
        .flat_map(|item| item["content"].as_array().cloned().unwrap_or_default())
        .filter_map(|content| content["text"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    assert_eq!(assistant_texts, vec![completed_content]);
    assert_eq!(
        observed.completed_outputs,
        reference["finalState"]["completedAssistantOutputs"]
            .as_array()
            .expect("completed outputs array")
            .iter()
            .map(|value| value.as_str().expect("completed output string").to_string())
            .collect::<Vec<_>>()
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_tool_item_is_preserved_in_retry_request() {
    skip_if_no_network!();
    let reference = load_reference("stream-completed-tool-close-retry.reference.json");

    let call_id = reference_string(&reference, "/completedItem/callId");
    let tool_name = reference_string(&reference, "/completedItem/name");
    let tool_input = reference_string(&reference, "/completedItem/input");
    let first_sse = responses::sse(vec![
        responses::ev_response_created("resp_first"),
        responses::ev_function_call(&call_id, &tool_name, &tool_input),
    ]);
    let second_sse = responses::sse(vec![
        responses::ev_response_created("resp_final"),
        responses::ev_assistant_message("msg_final", "done"),
        responses::ev_completed("resp_final"),
    ]);
    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: first_sse,
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: second_sse,
        }],
    ])
    .await;

    let TestCrewon { crewon, .. } = build_crewon(&server, 1).await;
    submit_hello(&crewon).await;
    let observed = observe_retry_trace(&crewon).await;

    let requests = server.requests().await;
    assert_eq!(
        requests.len() as u64,
        reference_u64(&reference, "/finalState/requestCount")
    );
    let second_input = request_input(&requests[1]);
    assert_eq!(
        second_input
            .iter()
            .filter(|item| item["type"] == "function_call")
            .cloned()
            .collect::<Vec<_>>(),
        vec![serde_json::json!({
            "type": "function_call",
            "name": &tool_name,
            "arguments": &tool_input,
            "call_id": &call_id,
        })]
    );
    assert_eq!(
        second_input
            .iter()
            .find(|item| { item["type"] == "function_call_output" && item["call_id"] == call_id })
            .expect("function call output in retry request")["output"],
        reference_string(&reference, "/expectedSecondRequestItems/1/output")
    );
    assert_eq!(
        observed.completed_outputs,
        vec![reference_string(&reference, "/finalState/finalOutput")]
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_assistant_item_before_tool_is_preserved_for_follow_up() {
    assert_completed_assistant_item_before_tool_is_preserved_for_follow_up(
        "mixed-assistant-tool-response.reference.json",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_turn_false_completed_assistant_and_tool_continue_same_turn() {
    assert_completed_assistant_item_before_tool_is_preserved_for_follow_up(
        "provider-end-turn-mixed-tool-continuation.reference.json",
    )
    .await;
}

async fn assert_completed_assistant_item_before_tool_is_preserved_for_follow_up(
    fixture_name: &str,
) {
    skip_if_no_network!();
    let reference = load_reference(fixture_name);
    let commentary = reference_string(&reference, "/completedAssistantItems/0/content");
    let call_id = reference_string(&reference, "/toolCall/callId");
    let tool_name = reference_string(&reference, "/toolCall/name");
    let tool_input = reference_string(&reference, "/toolCall/input");
    let tool_output = reference_string(&reference, "/toolResult/output");

    let first_completed = if reference["providerEndTurn"] == false {
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_mixed",
                "end_turn": false,
                "usage": {
                    "input_tokens": reference["firstUsage"]["inputTokens"],
                    "input_tokens_details": {"cached_tokens": reference["firstUsage"]["cachedInputTokens"]},
                    "output_tokens": reference["firstUsage"]["outputTokens"],
                    "output_tokens_details": null,
                    "total_tokens": reference["firstUsage"]["totalTokens"]
                }
            }
        })
    } else {
        responses::ev_completed("resp_mixed")
    };
    let first_sse = responses::sse(vec![
        responses::ev_response_created("resp_mixed"),
        responses::ev_message_item_added("msg_commentary", ""),
        responses::ev_output_text_delta(&commentary),
        json!({
            "type": "response.output_item.done",
            "item": {
                "type": "message",
                "role": "assistant",
                "id": "msg_commentary",
                "content": [{"type": "output_text", "text": &commentary}],
                "phase": "commentary"
            }
        }),
        responses::ev_custom_tool_call(&call_id, &tool_name, &tool_input),
        first_completed,
    ]);
    let second_sse = responses::sse(vec![
        responses::ev_response_created("resp_final"),
        responses::ev_message_item_added("msg_final", ""),
        responses::ev_output_text_delta("done"),
        responses::ev_assistant_message("msg_final", "done"),
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_final",
                "usage": {
                    "input_tokens": 4,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens": 1,
                    "output_tokens_details": null,
                    "total_tokens": 5
                }
            }
        }),
    ]);
    let (server, _) = start_streaming_sse_server(vec![
        vec![StreamingSseChunk {
            gate: None,
            body: first_sse,
        }],
        vec![StreamingSseChunk {
            gate: None,
            body: second_sse,
        }],
    ])
    .await;

    let TestCrewon { crewon, .. } = build_crewon(&server, 1).await;
    submit_hello(&crewon).await;
    let observed = observe_retry_trace(&crewon).await;

    let requests = server.requests().await;
    assert_eq!(
        requests.len() as u64,
        reference_u64(&reference, "/finalState/requestCount")
    );
    let suffix = request_input(&requests[1])
        .into_iter()
        .filter_map(|item| match item["type"].as_str() {
            Some("message") if item["role"] == "assistant" => Some(json!({
                "type": "message",
                "role": "assistant",
                "content": item["content"][0]["text"].clone(),
            })),
            Some("custom_tool_call") => Some(json!({
                "type": "tool_call",
                "kind": "custom",
                "callId": item["call_id"].clone(),
                "name": item["name"].clone(),
                "input": item["input"].clone(),
            })),
            Some("custom_tool_call_output") => Some(json!({
                "type": "tool_result",
                "kind": "custom",
                "callId": item["call_id"].clone(),
                "output": item["output"].clone(),
            })),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        suffix,
        reference["expectedSecondRequestSuffix"]
            .as_array()
            .expect("expected second request suffix")
            .clone()
    );
    assert_eq!(
        suffix
            .iter()
            .filter(|item| item["type"] == "tool_result" && item["output"] == tool_output)
            .count() as u64,
        reference_u64(&reference, "/finalState/toolInvocationCount")
    );
    assert_eq!(
        observed.completed_outputs,
        reference["finalState"]["completedAssistantOutputs"]
            .as_array()
            .expect("completed outputs")
            .iter()
            .map(|value| value.as_str().expect("completed output").to_string())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        observed.usage.expect("Rust terminal usage"),
        reference["finalState"]["usage"]
    );

    server.shutdown().await;
}
