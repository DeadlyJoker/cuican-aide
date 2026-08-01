use super::*;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchAdmissionState;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken;
use crate::request_processors::crewon_domain_office_dispatch_receipt::mark_admitted;
use crate::request_processors::crewon_domain_office_dispatch_receipt::reserve_starting;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

const RECORD_ID: &str = "office-record";
const SOURCE_THREAD_ID: &str = "source-thread";
const SOURCE_TURN_ID: &str = "source-turn";
const RUN_ID: &str = "run-1";
const DELEGATION_ID: &str = "delegation-1";
const TARGET_THREAD_ID: &str = "target-thread";
const PROMPT: &str = "Perform the exact delegated task";
const TURN_ID: &str = "member-turn";

fn config_with_starting_receipt(intent_id: &str) -> JsonValue {
    let mut config = json!({
        "workspace": {
            "recordId": RECORD_ID,
            "activity": {
                "runs": [{
                    "id": RUN_ID,
                    "delegations": [{
                        "id": DELEGATION_ID,
                        "status": "queued",
                        "target": TARGET_THREAD_ID,
                        "dispatchLeaseId": "child-lease",
                        "dispatchLeaseStartedAt": "2000-01-01T00:00:00Z",
                        "dispatchLeaseExpiresAt": "2000-01-01T00:00:01Z"
                    }]
                }]
            }
        }
    });
    let mut delegation_value = config["workspace"]["activity"]["runs"][0]["delegations"][0].clone();
    reserve_starting(
        &mut delegation_value,
        token(intent_id),
        "2026-07-26T00:00:00Z",
    )
    .expect("reserve starting receipt");
    config["workspace"]["activity"]["runs"][0]["delegations"][0] = delegation_value;
    config
}

fn token(intent_id: &str) -> OfficeDispatchReceiptToken<'_> {
    OfficeDispatchReceiptToken {
        record_id: RECORD_ID,
        intent_id,
        source_thread_id: SOURCE_THREAD_ID,
        source_turn_id: SOURCE_TURN_ID,
        run_id: RUN_ID,
        delegation_id: DELEGATION_ID,
        target_thread_id: TARGET_THREAD_ID,
        prompt: PROMPT,
    }
}

fn recovery(config: &JsonValue, intent_id: &str) -> LocatedOfficeDispatchRecovery {
    locate_office_dispatch_recovery(config, intent_id, SOURCE_THREAD_ID, SOURCE_TURN_ID)
        .expect("valid recovery scan")
        .expect("recovery receipt")
}

#[test]
fn starting_receipt_enters_execution_unknown_with_exact_turn_and_is_idempotent() {
    let intent_id = "intent-starting";
    let config = config_with_starting_receipt(intent_id);
    let expected = recovery(&config, intent_id);

    let (quarantined, changed, updated) = quarantine_dispatch_execution_unknown(
        config,
        &expected,
        TURN_ID,
        UserInputOnceState::AdmissionOnly,
    )
    .expect("quarantine starting receipt");

    assert!(changed);
    assert_eq!(
        updated.status,
        OfficeDispatchReceiptStatus::ExecutionUnknown
    );
    assert_eq!(updated.turn_id.as_deref(), Some(TURN_ID));
    assert_eq!(
        updated.admission_state,
        Some(OfficeDispatchAdmissionState::AdmissionOnly)
    );
    assert_eq!(
        updated.last_error.as_deref(),
        Some(EXECUTION_UNKNOWN_MESSAGE)
    );
    let delegation = &quarantined["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(delegation["turnId"], TURN_ID);
    assert!(delegation.get("dispatchLeaseId").is_none());
    assert!(delegation.get("dispatchLeaseStartedAt").is_none());
    assert!(delegation.get("dispatchLeaseExpiresAt").is_none());

    let (replayed, replay_changed, replayed_recovery) = quarantine_dispatch_execution_unknown(
        quarantined.clone(),
        &updated,
        TURN_ID,
        UserInputOnceState::AdmissionOnly,
    )
    .expect("replay quarantine");
    assert!(!replay_changed);
    assert_eq!(replayed, quarantined);
    assert_eq!(replayed_recovery, updated);
}

#[test]
fn admitted_receipt_rejects_changed_reconciliation_identity() {
    let intent_id = "intent-admitted";
    let mut config = config_with_starting_receipt(intent_id);
    let delegation = &mut config["workspace"]["activity"]["runs"][0]["delegations"][0];
    mark_admitted(
        delegation,
        token(intent_id),
        TURN_ID,
        UserInputOnceState::Persisted,
        "2026-07-26T00:00:01Z",
    )
    .expect("mark admitted");
    let expected = recovery(&config, intent_id);

    let error = quarantine_dispatch_execution_unknown(
        config,
        &expected,
        "different-turn",
        UserInputOnceState::Persisted,
    )
    .expect_err("changed turn must conflict");
    assert_eq!(
        error.message,
        "Office dispatch receipt cannot enter execution reconciliation"
    );
}

#[tokio::test]
async fn scheduler_execution_unknown_transition_is_terminal_and_idempotent() {
    let workspace = TempDir::new().expect("workspace");
    let cwd = workspace.path().to_string_lossy().into_owned();
    let intent_id = queue_auto_dispatch_intent(
        &cwd,
        SOURCE_THREAD_ID,
        SOURCE_TURN_ID,
        "test execution ambiguity",
    )
    .await
    .expect("queue intent");
    assert!(
        claim_auto_dispatch_intent(
            &cwd,
            &intent_id,
            SOURCE_THREAD_ID,
            SOURCE_TURN_ID,
            "scheduler-lease",
        )
        .await
        .expect("claim intent")
    );
    let config = config_with_starting_receipt(&intent_id);
    let expected = recovery(&config, &intent_id);

    mark_auto_dispatch_intent_execution_unknown(
        &cwd,
        "scheduler-lease",
        &expected,
        "/tmp/office.json",
        TURN_ID,
    )
    .await
    .expect("mark scheduler unknown");
    let first = read_scheduler_queue(&cwd).await.expect("read queue");
    let intent = first.intents.first().expect("intent");
    assert_eq!(intent.status, EXECUTION_UNKNOWN_STATE);
    assert_eq!(intent.dispatched_turn_id.as_deref(), Some(TURN_ID));
    assert_eq!(
        intent.last_error.as_deref(),
        Some(EXECUTION_UNKNOWN_MESSAGE)
    );
    assert!(intent.lease_id.is_none());

    mark_auto_dispatch_intent_execution_unknown(
        &cwd,
        "scheduler-lease",
        &expected,
        "/tmp/office.json",
        TURN_ID,
    )
    .await
    .expect("replay scheduler unknown");
    assert_eq!(
        read_scheduler_queue(&cwd).await.expect("read replay"),
        first
    );
}
