use super::crewon_domain_office_dispatch_receipt::*;
use crewon_core::UserInputOnceState;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;

const PROMPT: &str = "Complete the exact delegated task.";

fn token(prompt: &str) -> OfficeDispatchReceiptToken<'_> {
    OfficeDispatchReceiptToken {
        record_id: "record-1",
        intent_id: "intent-1",
        source_thread_id: "source-thread-1",
        source_turn_id: "source-turn-1",
        run_id: "run-1",
        delegation_id: "delegation-1",
        target_thread_id: "target-thread-1",
        prompt,
    }
}

fn delegation() -> JsonValue {
    json!({ "id": "delegation-1", "status": "queued" })
}

#[test]
fn matching_starting_reservation_is_idempotent() {
    let mut delegation = delegation();
    let first = reserve_starting(&mut delegation, token(PROMPT), "2026-07-26T01:00:00Z").unwrap();
    let second = reserve_starting(&mut delegation, token(PROMPT), "2026-07-26T01:01:00Z").unwrap();

    assert_eq!(first.reserve_count, 1);
    assert_eq!(second.reserve_count, 2);
    assert_eq!(delegation["status"], "queued");
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        json!({
            "authority": "crewon.app-server.office-dispatch-receipt/v1",
            "version": 1,
            "receiptId": first.receipt_id,
            "recordId": "record-1",
            "intentId": "intent-1",
            "sourceThreadId": "source-thread-1",
            "sourceTurnId": "source-turn-1",
            "runId": "run-1",
            "delegationId": "delegation-1",
            "targetThreadId": "target-thread-1",
            "dispatchKind": "delegation",
            "clientUserMessageId": first.client_user_message_id,
            "payloadHash": first.payload_hash,
            "promptSnapshot": PROMPT,
            "status": "starting",
            "admissionState": null,
            "turnId": null,
            "reserveCount": 1,
            "lastError": null,
            "createdAt": "2026-07-26T01:00:00Z",
            "updatedAt": "2026-07-26T01:00:00Z",
        })
    );
    let serialized = delegation["dispatchReceipt"].to_string();
    assert!(!serialized.contains("cwd"));
    assert!(!serialized.contains("secret"));
}

#[test]
fn prompt_or_target_drift_conflicts() {
    let mut delegation = delegation();
    reserve_starting(&mut delegation, token(PROMPT), "2026-07-26T01:00:00Z").unwrap();

    assert_eq!(
        reserve_starting(
            &mut delegation,
            token("Complete a different delegated task."),
            "2026-07-26T01:01:00Z",
        ),
        Err(OfficeDispatchReceiptError::Conflict)
    );
    let mut drifted_token = token(PROMPT);
    drifted_token.target_thread_id = "target-thread-2";
    assert_eq!(
        mark_admitted(
            &mut delegation,
            drifted_token,
            "turn-1",
            UserInputOnceState::AdmissionOnly,
            "2026-07-26T01:01:00Z",
        ),
        Err(OfficeDispatchReceiptError::Conflict)
    );
}

#[test]
fn admitted_transition_preserves_queued_status_and_cannot_roll_back() {
    let mut admitted_delegation = delegation();
    reserve_starting(
        &mut admitted_delegation,
        token(PROMPT),
        "2026-07-26T01:00:00Z",
    )
    .unwrap();
    let admitted = mark_admitted(
        &mut admitted_delegation,
        token(PROMPT),
        "turn-1",
        UserInputOnceState::AdmissionOnly,
        "2026-07-26T01:01:00Z",
    )
    .unwrap();

    assert_eq!(admitted.status, OfficeDispatchReceiptStatus::Admitted);
    assert_eq!(admitted.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(
        admitted.admission_state,
        Some(OfficeDispatchAdmissionState::AdmissionOnly)
    );
    assert_eq!(admitted_delegation["status"], "queued");
    assert_eq!(admitted_delegation["turnId"], "turn-1");
    assert_eq!(
        mark_admitted(
            &mut admitted_delegation,
            token(PROMPT),
            "turn-1",
            UserInputOnceState::AdmissionOnly,
            "2026-07-26T01:02:00Z",
        ),
        Ok(admitted)
    );
    assert_eq!(
        reserve_starting(
            &mut admitted_delegation,
            token(PROMPT),
            "2026-07-26T01:02:00Z",
        ),
        Err(OfficeDispatchReceiptError::InvalidTransition)
    );
    admitted_delegation["dispatchReceipt"]["status"] =
        serde_json::to_value(OfficeDispatchReceiptStatus::Started).unwrap();
    assert_eq!(
        reserve_starting(
            &mut admitted_delegation,
            token(PROMPT),
            "2026-07-26T01:02:00Z",
        ),
        Err(OfficeDispatchReceiptError::InvalidTransition)
    );

    let mut failed_delegation = delegation();
    reserve_starting(
        &mut failed_delegation,
        token(PROMPT),
        "2026-07-26T01:00:00Z",
    )
    .unwrap();
    mark_starting_failed(
        &mut failed_delegation,
        token(PROMPT),
        "dispatch failed",
        "2026-07-26T01:01:00Z",
    )
    .unwrap();
    assert_eq!(
        reserve_starting(
            &mut failed_delegation,
            token(PROMPT),
            "2026-07-26T01:02:00Z",
        ),
        Err(OfficeDispatchReceiptError::InvalidTransition)
    );
}

#[test]
fn malformed_starting_receipt_fails_closed() {
    let mut delegation = delegation();
    reserve_starting(&mut delegation, token(PROMPT), "2026-07-26T01:00:00Z").unwrap();
    delegation["dispatchReceipt"]["turnId"] = json!("orphan-turn");

    assert_eq!(
        reserve_starting(&mut delegation, token(PROMPT), "2026-07-26T01:01:00Z",),
        Err(OfficeDispatchReceiptError::InvalidReceipt)
    );
}

#[test]
fn admission_commit_rechecks_delegation_identity_and_turn_cas() {
    let mut wrong_delegation = delegation();
    reserve_starting(&mut wrong_delegation, token(PROMPT), "2026-07-26T01:00:00Z").unwrap();
    wrong_delegation["id"] = json!("delegation-2");
    assert_eq!(
        mark_admitted(
            &mut wrong_delegation,
            token(PROMPT),
            "turn-1",
            UserInputOnceState::AdmissionOnly,
            "2026-07-26T01:01:00Z",
        ),
        Err(OfficeDispatchReceiptError::InvalidDelegation)
    );

    let mut conflicting_turn = delegation();
    reserve_starting(&mut conflicting_turn, token(PROMPT), "2026-07-26T01:00:00Z").unwrap();
    conflicting_turn["turnId"] = json!("turn-2");
    assert_eq!(
        mark_admitted(
            &mut conflicting_turn,
            token(PROMPT),
            "turn-1",
            UserInputOnceState::AdmissionOnly,
            "2026-07-26T01:01:00Z",
        ),
        Err(OfficeDispatchReceiptError::Conflict)
    );
}

#[test]
fn prompt_snapshot_is_bounded_and_hash_is_recomputed_on_read() {
    assert_eq!(validate_prompt_snapshot(PROMPT), Ok(()));
    assert_eq!(validate_prompt_snapshot(&"x".repeat(4_000)), Ok(()));
    assert_eq!(
        validate_prompt_snapshot(""),
        Err(OfficeDispatchReceiptError::InvalidReceipt)
    );
    assert_eq!(
        validate_prompt_snapshot(" \n\t"),
        Err(OfficeDispatchReceiptError::InvalidReceipt)
    );
    let mut oversized_delegation = delegation();
    let original_delegation = oversized_delegation.clone();
    let oversized = "x".repeat(4_001);
    assert_eq!(
        validate_prompt_snapshot(&oversized),
        Err(OfficeDispatchReceiptError::InvalidReceipt)
    );
    assert_eq!(
        reserve_starting(
            &mut oversized_delegation,
            token(&oversized),
            "2026-07-26T01:00:00Z",
        ),
        Err(OfficeDispatchReceiptError::InvalidReceipt)
    );
    assert_eq!(oversized_delegation, original_delegation);

    let mut delegation = delegation();
    reserve_starting(&mut delegation, token(PROMPT), "2026-07-26T01:00:00Z").unwrap();
    delegation["dispatchReceipt"]["payloadHash"] = json!("a".repeat(64));
    assert_eq!(
        read_dispatch_receipt(&delegation),
        Err(OfficeDispatchReceiptError::Conflict)
    );
}

#[test]
fn starting_failure_is_bounded_idempotent_and_conflict_safe() {
    let mut delegation = delegation();
    reserve_starting(&mut delegation, token(PROMPT), "2026-07-26T01:00:00Z").unwrap();
    let long_error = format!("failed {}", "x".repeat(1_000));
    let failed = mark_starting_failed(
        &mut delegation,
        token(PROMPT),
        &long_error,
        "2026-07-26T01:01:00Z",
    )
    .unwrap();
    assert_eq!(failed.status, OfficeDispatchReceiptStatus::Failed);
    assert_eq!(failed.last_error.as_ref().unwrap().chars().count(), 512);
    assert_eq!(
        mark_starting_failed(
            &mut delegation,
            token(PROMPT),
            &long_error,
            "2026-07-26T01:02:00Z",
        ),
        Ok(failed)
    );
    assert_eq!(
        mark_starting_failed(
            &mut delegation,
            token(PROMPT),
            "different failure",
            "2026-07-26T01:02:00Z",
        ),
        Err(OfficeDispatchReceiptError::Conflict)
    );
}
