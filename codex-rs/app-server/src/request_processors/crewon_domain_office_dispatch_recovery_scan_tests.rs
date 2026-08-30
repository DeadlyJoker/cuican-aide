use pretty_assertions::assert_eq;
use serde_json::json;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::fs;

use super::*;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken;
use crate::request_processors::crewon_domain_office_dispatch_receipt::reserve_starting;

const INTENT_ID: &str = "intent-exact";
const SOURCE_THREAD_ID: &str = "source-thread-exact";
const SOURCE_TURN_ID: &str = "source-turn-exact";
const PROMPT: &str = "Use the exact persisted recovery prompt.";

fn office_config_with_receipt(
    record_id: &str,
    office_thread_id: &str,
    run_id: &str,
    delegation_id: &str,
    target_thread_id: &str,
) -> JsonValue {
    let mut delegation = json!({
        "id": delegation_id,
        "status": "queued",
        "target": target_thread_id,
        "threadId": target_thread_id,
    });
    reserve_starting(
        &mut delegation,
        OfficeDispatchReceiptToken {
            record_id,
            intent_id: INTENT_ID,
            source_thread_id: SOURCE_THREAD_ID,
            source_turn_id: SOURCE_TURN_ID,
            run_id,
            delegation_id,
            target_thread_id,
            prompt: PROMPT,
        },
        "2026-07-26T01:00:00Z",
    )
    .unwrap();
    json!({
        "title": format!("Office {record_id}"),
        "workspace": {
            "recordId": record_id,
            "threadId": office_thread_id,
            "activity": {
                "runs": [{
                    "id": run_id,
                    "delegations": [delegation],
                }],
            },
        },
    })
}

fn office_config_without_receipt(record_id: &str, office_thread_id: &str) -> JsonValue {
    json!({
        "title": format!("Office {record_id}"),
        "workspace": {
            "recordId": record_id,
            "threadId": office_thread_id,
            "activity": {
                "runs": [{
                    "id": format!("run-{record_id}"),
                    "delegations": [{
                        "id": format!("delegation-next-{record_id}"),
                        "status": "queued",
                        "target": format!("target-next-{record_id}"),
                        "threadId": format!("target-next-{record_id}"),
                    }],
                }],
            },
        },
    })
}

async fn write_office_record(cwd: &str, file_name: &str, config: &JsonValue) -> PathBuf {
    let directory = domain_directory(cwd, DomainKind::Office).unwrap();
    fs::create_dir_all(&directory).await.unwrap();
    let file_path = directory.join(file_name);
    super::super::super::write_domain_record(
        DomainKind::Office,
        &file_path,
        "2026-07-26T01:00:00Z".to_string(),
        config.clone(),
    )
    .await
    .unwrap();
    file_path
}

#[tokio::test]
async fn returns_none_when_no_exact_receipt_exists() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();

    assert_eq!(
        scan_exact_office_dispatch_recovery(&cwd, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID,)
            .await
            .unwrap(),
        None
    );

    let ordinary = office_config_without_receipt("record-next", "office-thread-next");
    write_office_record(&cwd, "ordinary.json", &ordinary).await;
    assert_eq!(
        scan_exact_office_dispatch_recovery(&cwd, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID,)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn returns_the_unique_exact_record_and_never_uses_the_next_candidate() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let ordinary = office_config_without_receipt("record-next", "office-thread-next");
    write_office_record(&cwd, "a-ordinary.json", &ordinary).await;
    let exact = office_config_with_receipt(
        "record-exact",
        "office-thread-exact",
        "run-exact",
        "delegation-exact",
        "target-thread-exact",
    );
    let exact_path = write_office_record(&cwd, "b-exact.json", &exact).await;

    let scanned =
        scan_exact_office_dispatch_recovery(&cwd, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID)
            .await
            .unwrap()
            .unwrap();

    assert_eq!(scanned.file_path, exact_path.to_string_lossy().into_owned());
    assert_eq!(scanned.config, exact);
    assert_eq!(scanned.recovery.record_id, "record-exact");
    assert_eq!(scanned.recovery.run_id, "run-exact");
    assert_eq!(scanned.recovery.delegation_id, "delegation-exact");
    assert_eq!(scanned.recovery.target_thread_id, "target-thread-exact");
    assert_eq!(scanned.recovery.prompt_snapshot, PROMPT);
}

#[tokio::test]
async fn duplicate_exact_matches_across_records_fail_closed() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    for index in 1..=2 {
        let config = office_config_with_receipt(
            &format!("record-{index}"),
            &format!("office-thread-{index}"),
            &format!("run-{index}"),
            &format!("delegation-{index}"),
            &format!("target-thread-{index}"),
        );
        write_office_record(&cwd, &format!("record-{index}.json"), &config).await;
    }

    let error =
        scan_exact_office_dispatch_recovery(&cwd, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID)
            .await
            .unwrap_err();
    assert!(error.message.contains("multiple canonical Office records"));
}

#[tokio::test]
async fn duplicate_record_identity_fails_closed_even_with_one_exact_receipt() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let exact = office_config_with_receipt(
        "record-exact",
        "office-thread-exact",
        "run-exact",
        "delegation-exact",
        "target-thread-exact",
    );
    write_office_record(&cwd, "a-exact.json", &exact).await;
    let duplicate_identity = office_config_without_receipt("record-exact", "office-thread-other");
    write_office_record(&cwd, "b-duplicate-identity.json", &duplicate_identity).await;

    let error =
        scan_exact_office_dispatch_recovery(&cwd, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID)
            .await
            .unwrap_err();
    assert!(error.message.contains("recordId is not unique"));
}

#[tokio::test]
async fn any_corrupt_receipt_fails_closed_even_when_an_exact_match_exists() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let exact = office_config_with_receipt(
        "record-exact",
        "office-thread-exact",
        "run-exact",
        "delegation-exact",
        "target-thread-exact",
    );
    write_office_record(&cwd, "a-exact.json", &exact).await;
    let mut corrupt = office_config_with_receipt(
        "record-corrupt",
        "office-thread-corrupt",
        "run-corrupt",
        "delegation-corrupt",
        "target-thread-corrupt",
    );
    corrupt["workspace"]["activity"]["runs"][0]["delegations"][0]["dispatchReceipt"]["version"] =
        json!(2);
    write_office_record(&cwd, "b-corrupt.json", &corrupt).await;

    let error =
        scan_exact_office_dispatch_recovery(&cwd, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID)
            .await
            .unwrap_err();
    assert!(error.message.contains("receipt is corrupt"));
}

#[tokio::test]
async fn invalid_identity_and_incomplete_bounded_scans_fail_closed() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let error = scan_exact_office_dispatch_recovery(&cwd, " ", SOURCE_THREAD_ID, SOURCE_TURN_ID)
        .await
        .unwrap_err();
    assert!(error.message.contains("identity is invalid"));

    for index in 0..=AUTO_SYNC_OFFICE_SCAN_LIMIT {
        let config = office_config_without_receipt(
            &format!("record-{index}"),
            &format!("office-thread-{index}"),
        );
        write_office_record(&cwd, &format!("record-{index:04}.json"), &config).await;
    }
    let error =
        scan_exact_office_dispatch_recovery(&cwd, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID)
            .await
            .unwrap_err();
    assert!(error.message.contains("scan exceeds"));
}
