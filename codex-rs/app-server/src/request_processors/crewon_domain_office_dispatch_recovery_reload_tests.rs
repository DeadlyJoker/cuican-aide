use crewon_core::UserInputOnceState;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::fs;

use super::*;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken;
use crate::request_processors::crewon_domain_office_dispatch_receipt::mark_admitted;
use crate::request_processors::crewon_domain_office_dispatch_receipt::reserve_starting;

const INTENT_ID: &str = "intent-exact";
const SOURCE_THREAD_ID: &str = "source-thread-exact";
const SOURCE_TURN_ID: &str = "source-turn-exact";
const PROMPT: &str = "Use only the exact persisted recovery prompt.";

fn delegation(
    record_id: &str,
    run_id: &str,
    delegation_id: &str,
    target_thread_id: &str,
    prompt: &str,
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
            prompt,
        },
        "2026-07-26T01:00:00Z",
    )
    .unwrap();
    delegation
}

fn office_config(prompt: &str) -> JsonValue {
    json!({
        "title": "Exact recovery Office",
        "workspace": {
            "recordId": "record-exact",
            "threadId": "office-thread-exact",
            "activity": {
                "runs": [{
                    "id": "run-exact",
                    "delegations": [delegation(
                        "record-exact",
                        "run-exact",
                        "delegation-exact",
                        "target-thread-exact",
                        prompt,
                    )],
                }],
            },
        },
    })
}

fn expected_recovery(config: &JsonValue) -> LocatedOfficeDispatchRecovery {
    locate_office_dispatch_recovery(config, INTENT_ID, SOURCE_THREAD_ID, SOURCE_TURN_ID)
        .unwrap()
        .unwrap()
}

async fn write_office_record(cwd: &str, file_name: &str, config: &JsonValue) -> PathBuf {
    let directory = domain_directory(cwd, DomainKind::Office).unwrap();
    fs::create_dir_all(&directory).await.unwrap();
    let file_path = directory.join(file_name);
    write_exact_record(&file_path, config).await;
    file_path
}

async fn write_exact_record(file_path: &Path, config: &JsonValue) {
    super::super::super::write_domain_record(
        DomainKind::Office,
        file_path,
        "2026-07-26T01:00:00Z".to_string(),
        config.clone(),
    )
    .await
    .unwrap();
}

fn exact_delegation(config: &mut JsonValue) -> &mut JsonValue {
    &mut config["workspace"]["activity"]["runs"][0]["delegations"][0]
}

#[tokio::test]
async fn reloads_the_exact_unchanged_canonical_record() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let config = office_config(PROMPT);
    let expected = expected_recovery(&config);
    let file_path = write_office_record(&cwd, "exact.json", &config).await;

    let reloaded =
        reload_exact_office_dispatch_recovery(&cwd, &file_path.to_string_lossy(), &expected)
            .await
            .unwrap();

    assert_eq!(reloaded.config, config);
    assert_eq!(reloaded.file_path, file_path.to_string_lossy().into_owned());
    assert_eq!(reloaded.recovery, expected);
}

#[tokio::test]
async fn deletion_and_replacement_fail_closed() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let config = office_config(PROMPT);
    let expected = expected_recovery(&config);
    let file_path = write_office_record(&cwd, "exact.json", &config).await;
    fs::remove_file(&file_path).await.unwrap();
    let error =
        reload_exact_office_dispatch_recovery(&cwd, &file_path.to_string_lossy(), &expected)
            .await
            .unwrap_err();
    assert!(error.message.contains("record no longer exists"));

    let replacement = json!({
        "title": "Replacement Office",
        "workspace": {
            "recordId": "replacement-record",
            "threadId": "replacement-thread",
            "activity": { "runs": [] },
        },
    });
    write_exact_record(&file_path, &replacement).await;
    let error =
        reload_exact_office_dispatch_recovery(&cwd, &file_path.to_string_lossy(), &expected)
            .await
            .unwrap_err();
    assert!(error.message.contains("receipt no longer exists"));
}

#[tokio::test]
async fn valid_status_or_payload_changes_fail_the_full_identity_cas() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let starting = office_config(PROMPT);
    let expected = expected_recovery(&starting);
    let file_path = write_office_record(&cwd, "exact.json", &starting).await;

    let mut admitted = starting.clone();
    mark_admitted(
        exact_delegation(&mut admitted),
        OfficeDispatchReceiptToken {
            record_id: "record-exact",
            intent_id: INTENT_ID,
            source_thread_id: SOURCE_THREAD_ID,
            source_turn_id: SOURCE_TURN_ID,
            run_id: "run-exact",
            delegation_id: "delegation-exact",
            target_thread_id: "target-thread-exact",
            prompt: PROMPT,
        },
        "turn-admitted",
        UserInputOnceState::Persisted,
        "2026-07-26T01:01:00Z",
    )
    .unwrap();
    write_exact_record(&file_path, &admitted).await;
    let error =
        reload_exact_office_dispatch_recovery(&cwd, &file_path.to_string_lossy(), &expected)
            .await
            .unwrap_err();
    assert!(error.message.contains("changed after discovery"));

    let different_prompt = office_config("A different valid persisted prompt.");
    write_exact_record(&file_path, &different_prompt).await;
    let error =
        reload_exact_office_dispatch_recovery(&cwd, &file_path.to_string_lossy(), &expected)
            .await
            .unwrap_err();
    assert!(error.message.contains("changed after discovery"));
}

#[tokio::test]
async fn paths_outside_the_cwd_and_parent_traversal_fail_closed() {
    let temp_dir = TempDir::new().unwrap();
    let other_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let config = office_config(PROMPT);
    let expected = expected_recovery(&config);
    let outside = other_dir.path().join("outside.json");
    let error = reload_exact_office_dispatch_recovery(&cwd, &outside.to_string_lossy(), &expected)
        .await
        .unwrap_err();
    assert!(error.message.contains("inside"));

    let traversal = temp_dir
        .path()
        .join(".crewon/offices/../outside.json")
        .to_string_lossy()
        .into_owned();
    let error = reload_exact_office_dispatch_recovery(&cwd, &traversal, &expected)
        .await
        .unwrap_err();
    assert!(error.message.contains("parent segments"));
}

#[tokio::test]
async fn duplicate_exact_matches_inside_the_record_fail_closed() {
    let temp_dir = TempDir::new().unwrap();
    let cwd = temp_dir.path().to_string_lossy().to_string();
    let mut config = office_config(PROMPT);
    let expected = expected_recovery(&config);
    let duplicate = delegation(
        "record-exact",
        "run-exact",
        "delegation-duplicate",
        "target-thread-duplicate",
        PROMPT,
    );
    config["workspace"]["activity"]["runs"][0]["delegations"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let file_path = write_office_record(&cwd, "duplicate.json", &config).await;

    let error =
        reload_exact_office_dispatch_recovery(&cwd, &file_path.to_string_lossy(), &expected)
            .await
            .unwrap_err();
    assert!(error.message.contains("receipt is corrupt"));
}
