use pretty_assertions::assert_eq;
use serde_json::json;

use super::*;

#[test]
fn delivery_variant_fields_serialize_as_camel_case() {
    assert_eq!(
        serde_json::to_value(OfficeMessageDelivery::Steered {
            run_id: "run-1".to_string(),
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
        })
        .expect("serialize delivery"),
        json!({
            "type": "steered",
            "runId": "run-1",
            "threadId": "thread-1",
            "turnId": "turn-1",
        })
    );
    assert_eq!(
        serde_json::to_value(OfficeMessageDelivery::Processing {
            phase: OfficeMessageProcessingPhase::Recovering,
            retry_after_ms: 250,
        })
        .expect("serialize processing delivery"),
        json!({
            "type": "processing",
            "phase": "recovering",
            "retryAfterMs": 250,
        })
    );
}

#[test]
fn submit_params_reject_client_built_message_fields() {
    let error = serde_json::from_value::<OfficeMessageSubmitParams>(json!({
        "cwd": "/workspace",
        "config": {},
        "text": "hello",
        "clientUserMessageId": "client-1",
        "message": { "author": "forged" }
    }))
    .expect_err("unknown message field must be rejected");

    assert!(error.to_string().contains("unknown field `message`"));
}
