use crewon_core::UserInputOnceState;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken;
use crate::request_processors::crewon_domain_office_dispatch_receipt::mark_admitted;
use crate::request_processors::crewon_domain_office_dispatch_receipt::mark_starting_failed;
use crate::request_processors::crewon_domain_office_dispatch_receipt::reserve_starting;

const PROMPT_SNAPSHOT: &str = "Use only the persisted recovery prompt.";
const STARTED_AT: &str = "2026-07-26T01:00:00Z";

fn token() -> OfficeDispatchReceiptToken<'static> {
    OfficeDispatchReceiptToken {
        record_id: "record-1",
        intent_id: "intent-1",
        source_thread_id: "source-thread-1",
        source_turn_id: "source-turn-1",
        run_id: "run-1",
        delegation_id: "delegation-exact",
        target_thread_id: "target-thread-exact",
        prompt: PROMPT_SNAPSHOT,
    }
}

fn starting_fixture() -> (JsonValue, LocatedOfficeDispatchRecovery) {
    let mut exact = json!({
        "id": "delegation-exact",
        "status": "queued",
        "target": "target-thread-exact",
        "threadId": "target-thread-exact",
        "task": "This mutable task must not be used as the recovery prompt.",
        "memoryRefs": ["memory-that-must-not-be-rebuilt"],
        "retryOfDelegationId": "delegation-original",
        "dispatchLeaseId": "old-exact-lease",
        "dispatchLeaseStartedAt": "2026-07-26T00:00:00Z",
        "dispatchLeaseExpiresAt": "2026-07-26T00:02:00Z"
    });
    reserve_starting(&mut exact, token(), STARTED_AT).unwrap();
    let config = json!({
        "workspace": {
            "recordId": "record-1",
            "activity": {
                "runs": [{
                    "id": "run-1",
                    "delegations": [
                        {
                            "id": "delegation-next",
                            "status": "queued",
                            "target": "target-thread-next",
                            "threadId": "target-thread-next",
                            "dispatchLeaseId": "next-lease-must-remain"
                        },
                        exact
                    ]
                }]
            }
        }
    });
    let recovery =
        locate_office_dispatch_recovery(&config, "intent-1", "source-thread-1", "source-turn-1")
            .unwrap()
            .unwrap();
    (config, recovery)
}

fn exact_delegation(config: &mut JsonValue) -> &mut JsonValue {
    &mut config["workspace"]["activity"]["runs"][0]["delegations"][1]
}

fn persisted_record(config: JsonValue, saved_at: &str) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({
        "version": 1,
        "kind": "office",
        "savedAt": saved_at,
        "config": config,
    }))
    .unwrap()
}

#[tokio::test]
async fn prepares_and_writes_only_the_exact_scanned_record_path() {
    let (config, recovery) = starting_fixture();
    let original_receipt =
        config["workspace"]["activity"]["runs"][0]["delegations"][1]["dispatchReceipt"].clone();
    let workspace = TempDir::new().unwrap();
    let office_directory = workspace.path().join(".crewon").join("offices");
    tokio::fs::create_dir_all(&office_directory).await.unwrap();
    let exact_path = office_directory.join("exact.json");
    tokio::fs::write(
        &exact_path,
        persisted_record(config, "2026-07-26T01:00:00Z"),
    )
    .await
    .unwrap();
    let duplicate_path = office_directory.join("newer-duplicate-record-id.json");
    let duplicate_record = persisted_record(
        json!({
            "title": "Duplicate recordId must remain untouched",
            "workspace": {
                "recordId": "record-1",
                "activity": { "runs": [] },
                "duplicateSentinel": "unchanged"
            }
        }),
        "2026-07-26T02:00:00Z",
    );
    tokio::fs::write(&duplicate_path, &duplicate_record)
        .await
        .unwrap();

    let prepared = prepare_recovered_delegation_dispatch(
        &workspace.path().to_string_lossy(),
        &exact_path.to_string_lossy(),
        &recovery,
    )
    .await
    .unwrap();

    assert_eq!(prepared.cwd, workspace.path().to_string_lossy());
    assert_eq!(prepared.run_id, "run-1");
    assert_eq!(prepared.delegation_id, "delegation-exact");
    assert_eq!(
        prepared.retry_of_delegation_id.as_deref(),
        Some("delegation-original")
    );
    assert_eq!(prepared.thread_id, "target-thread-exact");
    assert_eq!(prepared.prompt, PROMPT_SNAPSHOT);
    assert_eq!(
        prepared.client_user_message_id.as_deref(),
        Some(recovery.client_user_message_id.as_str())
    );

    let delegations = prepared.config["workspace"]["activity"]["runs"][0]["delegations"]
        .as_array()
        .unwrap();
    assert_eq!(
        delegations[0]["dispatchLeaseId"],
        json!("next-lease-must-remain")
    );
    assert_ne!(delegations[1]["dispatchLeaseId"], json!("old-exact-lease"));
    let lease_started = parse_office_scheduler_timestamp(
        delegations[1]["dispatchLeaseStartedAt"].as_str().unwrap(),
    )
    .unwrap();
    let lease_expires = parse_office_scheduler_timestamp(
        delegations[1]["dispatchLeaseExpiresAt"].as_str().unwrap(),
    )
    .unwrap();
    assert!(lease_expires > lease_started);
    assert_eq!(delegations[1]["dispatchReceipt"], original_receipt);
    assert_eq!(
        delegations[1]["memoryRefs"],
        json!(["memory-that-must-not-be-rebuilt"])
    );

    let persisted_exact: JsonValue =
        serde_json::from_slice(&tokio::fs::read(&exact_path).await.unwrap()).unwrap();
    assert_eq!(persisted_exact["config"], prepared.config);
    assert_eq!(
        tokio::fs::read(&duplicate_path).await.unwrap(),
        duplicate_record
    );
}

#[test]
fn locator_mismatch_and_corrupt_latest_receipt_fail_closed() {
    let (config, recovery) = starting_fixture();
    let mut mismatched = recovery.clone();
    mismatched.payload_hash = "different-payload".to_string();
    let error = prepare_recovered_delegation_from_latest(
        "/workspace",
        config.clone(),
        &mismatched,
        Utc::now(),
    )
    .unwrap_err();
    assert!(error.message.contains("does not match persisted receipt"));

    let mut corrupt = config;
    corrupt["workspace"]["activity"]["runs"][0]["delegations"][1]["dispatchReceipt"]["payloadHash"] =
        json!("invalid-payload-hash");
    let error =
        prepare_recovered_delegation_from_latest("/workspace", corrupt, &recovery, Utc::now())
            .unwrap_err();
    assert!(
        error.message.contains("receipt is corrupt"),
        "unexpected error: {}",
        error.message
    );
}

#[test]
fn non_starting_receipts_fail_closed_without_refreshing_a_lease() {
    let (starting, recovery) = starting_fixture();

    let mut admitted = starting.clone();
    mark_admitted(
        exact_delegation(&mut admitted),
        token(),
        "turn-accepted",
        UserInputOnceState::Persisted,
        "2026-07-26T01:01:00Z",
    )
    .unwrap();
    let error =
        prepare_recovered_delegation_from_latest("/workspace", admitted, &recovery, Utc::now())
            .unwrap_err();
    assert!(error.message.contains("no longer starting"));

    let mut failed = starting;
    mark_starting_failed(
        exact_delegation(&mut failed),
        token(),
        "dispatch failed before admission",
        "2026-07-26T01:01:00Z",
    )
    .unwrap();
    let error =
        prepare_recovered_delegation_from_latest("/workspace", failed, &recovery, Utc::now())
            .unwrap_err();
    assert!(error.message.contains("no longer starting"));
}
