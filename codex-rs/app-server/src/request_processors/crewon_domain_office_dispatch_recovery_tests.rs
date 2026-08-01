use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;

use super::*;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken;
use crate::request_processors::crewon_domain_office_dispatch_receipt::reserve_starting;

const PROMPT: &str = "Complete the exact delegated task.";

fn config(receipts: Vec<JsonValue>) -> JsonValue {
    json!({
        "workspace": {
            "recordId": "record-1",
            "activity": {
                "runs": [{
                    "id": "run-1",
                    "delegations": receipts.into_iter().enumerate().map(|(index, receipt)| {
                        json!({
                            "id": format!("delegation-{}", index + 1),
                            "status": "queued",
                            "target": format!("target-thread-{}", index + 1),
                            "threadId": format!("target-thread-{}", index + 1),
                            "dispatchReceipt": receipt,
                        })
                    }).collect::<Vec<_>>()
                }]
            }
        }
    })
}

fn receipt(index: usize) -> JsonValue {
    let delegation_id = format!("delegation-{index}");
    let target_thread_id = format!("target-thread-{index}");
    let mut delegation = json!({
        "id": delegation_id,
        "status": "queued",
    });
    reserve_starting(
        &mut delegation,
        OfficeDispatchReceiptToken {
            record_id: "record-1",
            intent_id: "intent-1",
            source_thread_id: "source-thread-1",
            source_turn_id: "source-turn-1",
            run_id: "run-1",
            delegation_id: delegation_id.as_str(),
            target_thread_id: target_thread_id.as_str(),
            prompt: PROMPT,
        },
        "2026-07-26T01:00:00Z",
    )
    .unwrap();
    delegation["dispatchReceipt"].clone()
}

#[test]
fn returns_none_without_receipts_or_exact_match() {
    assert_eq!(
        locate_office_dispatch_recovery(
            &json!({
                "workspace": {
                    "activity": { "runs": [] }
                }
            }),
            "intent-1",
            "source-thread-1",
            "source-turn-1",
        ),
        Ok(None)
    );
    assert_eq!(
        locate_office_dispatch_recovery(
            &config(Vec::new()),
            "intent-1",
            "source-thread-1",
            "source-turn-1",
        ),
        Ok(None)
    );
    assert_eq!(
        locate_office_dispatch_recovery(
            &config(vec![receipt(1)]),
            "different-intent",
            "source-thread-1",
            "source-turn-1",
        ),
        Ok(None)
    );
}

#[test]
fn unknown_receipt_authority_is_corrupt() {
    assert_eq!(
        locate_office_dispatch_recovery(
            &config(vec![json!({
                "authority": "third-party.custom-receipt/v1",
                "payload": "opaque"
            })]),
            "intent-1",
            "source-thread-1",
            "source-turn-1",
        ),
        Err(OfficeDispatchRecoveryLocatorError::Corrupt)
    );
}

#[test]
fn returns_the_unique_exact_recovery_reference() {
    let located = locate_office_dispatch_recovery(
        &config(vec![receipt(1)]),
        "intent-1",
        "source-thread-1",
        "source-turn-1",
    )
    .unwrap()
    .unwrap();

    assert_eq!(
        located,
        LocatedOfficeDispatchRecovery {
            receipt_id: located.client_user_message_id.clone(),
            record_id: "record-1".to_string(),
            intent_id: "intent-1".to_string(),
            source_thread_id: "source-thread-1".to_string(),
            source_turn_id: "source-turn-1".to_string(),
            run_id: "run-1".to_string(),
            delegation_id: "delegation-1".to_string(),
            target_thread_id: "target-thread-1".to_string(),
            client_user_message_id: located.client_user_message_id.clone(),
            payload_hash: located.payload_hash.clone(),
            prompt_snapshot: PROMPT.to_string(),
            status: OfficeDispatchReceiptStatus::Starting,
            admission_state: None,
            turn_id: None,
            last_error: None,
        }
    );
}

#[test]
fn multiple_exact_receipts_are_corrupt() {
    assert_eq!(
        locate_office_dispatch_recovery(
            &config(vec![receipt(1), receipt(2)]),
            "intent-1",
            "source-thread-1",
            "source-turn-1",
        ),
        Err(OfficeDispatchRecoveryLocatorError::Corrupt)
    );
}

#[test]
fn malformed_receipt_is_corrupt_instead_of_being_ignored() {
    let mut malformed = receipt(1);
    malformed["version"] = json!(2);
    assert_eq!(
        locate_office_dispatch_recovery(
            &config(vec![malformed]),
            "intent-1",
            "source-thread-1",
            "source-turn-1",
        ),
        Err(OfficeDispatchRecoveryLocatorError::Corrupt)
    );
}

#[test]
fn receipt_must_match_its_record_and_containers() {
    for (field, value) in [
        ("recordId", "record-2"),
        ("runId", "run-2"),
        ("delegationId", "delegation-2"),
        ("targetThreadId", "target-thread-2"),
    ] {
        let mut mismatched = receipt(1);
        mismatched[field] = json!(value);
        assert_eq!(
            locate_office_dispatch_recovery(
                &config(vec![mismatched]),
                "intent-1",
                "source-thread-1",
                "source-turn-1",
            ),
            Err(OfficeDispatchRecoveryLocatorError::Corrupt),
            "field {field} should fail closed"
        );
    }
}
