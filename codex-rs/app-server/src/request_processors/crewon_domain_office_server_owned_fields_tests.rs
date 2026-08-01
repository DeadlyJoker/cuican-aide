use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;

use super::*;

fn receipt(status: &str) -> JsonValue {
    json!({
        "authority": "crewon.app-server.office-dispatch-receipt/v1",
        "version": 1,
        "receiptId": "office-dispatch-v1-receipt",
        "recordId": "record-1",
        "intentId": "intent-1",
        "sourceThreadId": "source-thread-1",
        "sourceTurnId": "source-turn-1",
        "runId": "run-1",
        "delegationId": "delegation-1",
        "targetThreadId": "target-thread-1",
        "dispatchKind": "delegation",
        "clientUserMessageId": "office-dispatch-v1-receipt",
        "payloadHash": "a".repeat(64),
        "promptSnapshot": "Complete the durable task.",
        "status": status,
        "admissionState": "admissionOnly",
        "turnId": "turn-1",
        "reserveCount": 1,
        "lastError": null,
        "createdAt": "2026-07-26T01:00:00Z",
        "updatedAt": "2026-07-26T01:01:00Z"
    })
}

fn config_with_receipt() -> JsonValue {
    json!({
        "title": "Canonical Office",
        "workspace": {
            "activity": {
                "runs": [{
                    "id": "run-1",
                    "delegations": [{
                        "id": "delegation-1",
                        "member": "Engineer",
                        "task": "Complete the durable task.",
                        "threadId": "target-thread-1",
                        "target": "target-thread-1",
                        "dispatchMethod": "turnStart",
                        "status": "completed",
                        "turnId": "turn-1",
                        "updatedAt": "2026-07-26T01:02:00Z",
                        "completedAt": "2026-07-26T01:02:00Z",
                        "resultPreview": "Done.",
                        "dispatchReceipt": receipt("admitted")
                    }]
                }]
            }
        }
    })
}

#[test]
fn stale_caller_cannot_delete_existing_receipt() {
    let latest = config_with_receipt();
    let mut caller = latest.clone();
    caller["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .unwrap()
        .remove("dispatchReceipt");

    assert_eq!(
        merge_office_server_owned_fields(&latest, caller),
        Err(OfficeServerOwnedFieldsError::Conflict)
    );
}

#[test]
fn caller_cannot_tamper_with_or_roll_back_receipt() {
    let latest = config_with_receipt();
    let mut tampered = latest.clone();
    tampered["workspace"]["activity"]["runs"][0]["delegations"][0]["dispatchReceipt"]["payloadHash"] =
        json!("b".repeat(64));
    let mut rolled_back = latest.clone();
    rolled_back["workspace"]["activity"]["runs"][0]["delegations"][0]["dispatchReceipt"] =
        receipt("starting");

    assert_eq!(
        merge_office_server_owned_fields(&latest, tampered),
        Err(OfficeServerOwnedFieldsError::Conflict)
    );
    assert_eq!(
        merge_office_server_owned_fields(&latest, rolled_back),
        Err(OfficeServerOwnedFieldsError::Conflict)
    );
}

#[test]
fn business_edit_preserves_latest_durable_runtime_fields() {
    let latest = config_with_receipt();
    let mut caller = latest.clone();
    caller["title"] = json!("Caller business title");
    let caller_delegation = caller["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .unwrap();
    caller_delegation.insert("task".to_string(), json!("Updated business task label"));
    caller_delegation.insert("status".to_string(), json!("queued"));
    caller_delegation.remove("turnId");
    caller_delegation.insert("dispatchLeaseId".to_string(), json!("stale-caller-lease"));
    caller_delegation.insert("error".to_string(), json!("stale error"));

    let merged = merge_office_server_owned_fields(&latest, caller).unwrap();
    let mut expected = latest;
    expected["title"] = json!("Caller business title");
    expected["workspace"]["activity"]["runs"][0]["delegations"][0]["task"] =
        json!("Updated business task label");

    assert_eq!(merged, expected);
}

#[test]
fn caller_cannot_inject_new_receipt() {
    let mut latest = config_with_receipt();
    latest["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .unwrap()
        .remove("dispatchReceipt");
    let caller = config_with_receipt();

    assert_eq!(
        merge_office_server_owned_fields(&latest, caller),
        Err(OfficeServerOwnedFieldsError::Conflict)
    );
}

#[test]
fn receipt_identity_mismatch_fails_closed() {
    let latest = config_with_receipt();
    let mut caller = latest.clone();
    caller["workspace"]["activity"]["runs"][0]["delegations"][0]["dispatchReceipt"]["delegationId"] =
        json!("delegation-2");

    assert_eq!(
        merge_office_server_owned_fields(&latest, caller),
        Err(OfficeServerOwnedFieldsError::Conflict)
    );
}

#[test]
fn duplicate_missing_and_damaged_identity_shapes_fail_closed() {
    let latest = config_with_receipt();
    let caller = latest.clone();

    let mut duplicate_run = latest.clone();
    let duplicate = duplicate_run["workspace"]["activity"]["runs"][0].clone();
    duplicate_run["workspace"]["activity"]["runs"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert_eq!(
        merge_office_server_owned_fields(&duplicate_run, caller.clone()),
        Err(OfficeServerOwnedFieldsError::InvalidCanonicalShape)
    );

    let mut missing_delegation_id = caller.clone();
    missing_delegation_id["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .unwrap()
        .remove("id");
    assert_eq!(
        merge_office_server_owned_fields(&latest, missing_delegation_id),
        Err(OfficeServerOwnedFieldsError::InvalidCallerShape)
    );

    let mut damaged_array = caller;
    damaged_array["workspace"]["activity"]["runs"][0]["delegations"] = json!({});
    assert_eq!(
        merge_office_server_owned_fields(&latest, damaged_array),
        Err(OfficeServerOwnedFieldsError::InvalidCallerShape)
    );
}

#[test]
fn new_record_rejects_receipt_injection() {
    assert_eq!(
        reject_office_dispatch_receipt_injection(&config_with_receipt()),
        Err(OfficeServerOwnedFieldsError::Conflict)
    );

    let mut caller = config_with_receipt();
    caller["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .unwrap()
        .remove("dispatchReceipt");
    assert_eq!(reject_office_dispatch_receipt_injection(&caller), Ok(()));
}
