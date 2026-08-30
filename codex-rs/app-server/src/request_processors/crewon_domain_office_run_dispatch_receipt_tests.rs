use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use crewon_core::UserInputOnceState;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::error_code::internal_error;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchAdmissionState;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptStatus;
use crate::request_processors::crewon_domain_processor::write_domain_record;

const RECORD_ID: &str = "record-fault";
const INTENT_ID: &str = "intent-fault";
const SOURCE_THREAD_ID: &str = "source-thread-fault";
const SOURCE_TURN_ID: &str = "source-turn-fault";
const RUN_ID: &str = "run-fault";
const DELEGATION_ID: &str = "delegation-fault";
const TARGET_THREAD_ID: &str = "target-thread-fault";
const TURN_ID: &str = "turn-admitted-fault";
const PROMPT: &str = "Complete the exact fault-injection task.";

fn token() -> OfficeDispatchReceiptToken<'static> {
    OfficeDispatchReceiptToken {
        record_id: RECORD_ID,
        intent_id: INTENT_ID,
        source_thread_id: SOURCE_THREAD_ID,
        source_turn_id: SOURCE_TURN_ID,
        run_id: RUN_ID,
        delegation_id: DELEGATION_ID,
        target_thread_id: TARGET_THREAD_ID,
        prompt: PROMPT,
    }
}

fn office_config() -> JsonValue {
    json!({
        "title": "Dispatch receipt fault Office",
        "workspace": {
            "recordId": RECORD_ID,
            "threadId": "office-thread-fault",
            "activity": {
                "runs": [{
                    "id": RUN_ID,
                    "delegations": [{
                        "id": DELEGATION_ID,
                        "status": "queued",
                        "target": TARGET_THREAD_ID,
                        "threadId": TARGET_THREAD_ID,
                        "dispatchLeaseId": "lease-fault",
                        "dispatchLeaseStartedAt": "2026-07-26T01:00:00Z",
                        "dispatchLeaseExpiresAt": "2026-07-26T01:02:00Z"
                    }]
                }]
            }
        }
    })
}

async fn seed_office(cwd: &str) -> (PathBuf, JsonValue) {
    let config = office_config();
    let directory = super::super::domain_directory(cwd, DomainKind::Office).unwrap();
    tokio::fs::create_dir_all(&directory).await.unwrap();
    let path = directory.join("dispatch-receipt-fault.json");
    write_domain_record(
        DomainKind::Office,
        &path,
        "2026-07-26T01:00:00Z".to_string(),
        config.clone(),
    )
    .await
    .unwrap();
    (path, config)
}

async fn persisted_config(path: &Path) -> JsonValue {
    persisted_record(path).await.1["config"].clone()
}

async fn persisted_record(path: &Path) -> (Vec<u8>, JsonValue) {
    let bytes = tokio::fs::read(path).await.unwrap();
    let record = serde_json::from_slice(&bytes).unwrap();
    (bytes, record)
}

fn delegation(config: &JsonValue) -> &JsonValue {
    &config["workspace"]["activity"]["runs"][0]["delegations"][0]
}

fn receipt(config: &JsonValue) -> OfficeDispatchReceipt {
    crewon_domain_office_dispatch_receipt::read_dispatch_receipt(delegation(config))
        .unwrap()
        .expect("dispatch receipt")
}

fn observed_config(slot: &Arc<Mutex<Option<JsonValue>>>) -> JsonValue {
    slot.lock()
        .unwrap()
        .clone()
        .expect("writer should observe mutated config")
}

fn assert_office_envelope(record: &JsonValue, expected_config: &JsonValue) {
    assert_eq!(record["version"], json!(1));
    assert_eq!(record["kind"], json!("office"));
    assert_eq!(&record["config"], expected_config);
}

fn config_without_receipt(config: &JsonValue) -> JsonValue {
    let mut config = config.clone();
    delegation_mut(&mut config, RUN_ID, DELEGATION_ID)
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("dispatchReceipt");
    config
}

#[tokio::test]
async fn reserve_before_write_error_leaves_disk_unreserved_and_retry_converges() {
    let workspace = TempDir::new().unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let (path, config) = seed_office(&cwd).await;
    let original_bytes = tokio::fs::read(&path).await.unwrap();
    let observed = Arc::new(Mutex::new(None));
    let writer_observed = Arc::clone(&observed);

    let error = reserve_delegation_starting_with_writer(
        &cwd,
        config,
        RUN_ID,
        DELEGATION_ID,
        token(),
        move |_, config| async move {
            *writer_observed.lock().unwrap() = Some(config);
            Err(internal_error("injected receipt reserve before write"))
        },
    )
    .await
    .expect_err("receipt reserve write must fail");
    assert_eq!(error.message, "injected receipt reserve before write");
    assert_eq!(tokio::fs::read(&path).await.unwrap(), original_bytes);

    let in_memory = observed_config(&observed);
    let in_memory_receipt = receipt(&in_memory);
    assert_eq!(
        in_memory_receipt.status,
        OfficeDispatchReceiptStatus::Starting
    );
    assert_eq!(in_memory_receipt.reserve_count, 1);
    assert_eq!(in_memory_receipt.turn_id, None);

    let persisted = persisted_config(&path).await;
    assert!(
        crewon_domain_office_dispatch_receipt::read_dispatch_receipt(delegation(&persisted))
            .unwrap()
            .is_none()
    );

    let (converged, converged_receipt) =
        reserve_delegation_starting(&cwd, persisted, RUN_ID, DELEGATION_ID, token())
            .await
            .unwrap();
    assert_eq!(
        converged_receipt.status,
        OfficeDispatchReceiptStatus::Starting
    );
    assert_eq!(converged_receipt.reserve_count, 1);
    assert_eq!(converged_receipt.turn_id, None);
    let persisted = persisted_config(&path).await;
    assert_eq!(receipt(&persisted), converged_receipt);
    assert_eq!(receipt(&converged), converged_receipt);
    assert_eq!(
        config_without_receipt(&converged),
        config_without_receipt(&in_memory)
    );
    assert_eq!(
        config_without_receipt(&persisted),
        config_without_receipt(&in_memory)
    );
}

#[tokio::test]
async fn reserve_after_commit_error_preserves_starting_receipt_and_retry_converges() {
    let workspace = TempDir::new().unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let (path, config) = seed_office(&cwd).await;
    let observed = Arc::new(Mutex::new(None));
    let writer_observed = Arc::clone(&observed);

    let error = reserve_delegation_starting_with_writer(
        &cwd,
        config,
        RUN_ID,
        DELEGATION_ID,
        token(),
        move |cwd, config| async move {
            *writer_observed.lock().unwrap() = Some(config.clone());
            save_record(DomainKind::Office, &cwd, config).await?;
            Err(internal_error(
                "injected receipt reserve after committed rename",
            ))
        },
    )
    .await
    .expect_err("receipt reserve must report ambiguous persistence");
    assert_eq!(
        error.message,
        "injected receipt reserve after committed rename"
    );

    let in_memory = observed_config(&observed);
    let (_, record) = persisted_record(&path).await;
    assert_office_envelope(&record, &in_memory);
    let persisted = record["config"].clone();
    let first_receipt = receipt(&in_memory);
    assert_eq!(receipt(&persisted), first_receipt);
    assert_eq!(first_receipt.status, OfficeDispatchReceiptStatus::Starting);
    assert_eq!(first_receipt.reserve_count, 1);
    assert_eq!(first_receipt.turn_id, None);

    let (converged, converged_receipt) =
        reserve_delegation_starting(&cwd, persisted, RUN_ID, DELEGATION_ID, token())
            .await
            .unwrap();
    assert_eq!(
        converged_receipt.status,
        OfficeDispatchReceiptStatus::Starting
    );
    assert_eq!(converged_receipt.reserve_count, 2);
    assert_eq!(converged_receipt.turn_id, None);
    let persisted = persisted_config(&path).await;
    assert_eq!(receipt(&persisted), converged_receipt);
    assert_eq!(receipt(&converged), converged_receipt);
    assert_eq!(
        config_without_receipt(&converged),
        config_without_receipt(&in_memory)
    );
    assert_eq!(
        config_without_receipt(&persisted),
        config_without_receipt(&in_memory)
    );
}

#[tokio::test]
async fn admitted_before_write_error_leaves_disk_starting_and_retry_converges() {
    let workspace = TempDir::new().unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let (path, config) = seed_office(&cwd).await;
    let (starting, starting_receipt) =
        reserve_delegation_starting(&cwd, config, RUN_ID, DELEGATION_ID, token())
            .await
            .unwrap();
    let starting_bytes = tokio::fs::read(&path).await.unwrap();
    let observed = Arc::new(Mutex::new(None));
    let writer_observed = Arc::clone(&observed);

    let error = commit_delegation_admitted_with_writer(
        &cwd,
        starting,
        RUN_ID,
        DELEGATION_ID,
        token(),
        TURN_ID,
        UserInputOnceState::AdmissionOnly,
        move |_, config| async move {
            *writer_observed.lock().unwrap() = Some(config);
            Err(internal_error("injected admitted receipt before write"))
        },
    )
    .await
    .expect_err("admitted receipt write must fail");
    assert_eq!(error.message, "injected admitted receipt before write");
    assert_eq!(tokio::fs::read(&path).await.unwrap(), starting_bytes);

    let in_memory = observed_config(&observed);
    let in_memory_receipt = receipt(&in_memory);
    assert_eq!(
        in_memory_receipt.status,
        OfficeDispatchReceiptStatus::Admitted
    );
    assert_eq!(
        in_memory_receipt.admission_state,
        Some(OfficeDispatchAdmissionState::AdmissionOnly)
    );
    assert_eq!(in_memory_receipt.reserve_count, 1);
    assert_eq!(in_memory_receipt.turn_id.as_deref(), Some(TURN_ID));

    let persisted = persisted_config(&path).await;
    assert_eq!(receipt(&persisted), starting_receipt);
    assert_eq!(
        receipt(&persisted).status,
        OfficeDispatchReceiptStatus::Starting
    );
    assert_eq!(receipt(&persisted).turn_id, None);

    let (_, converged, converged_receipt) = commit_delegation_admitted(
        &cwd,
        persisted,
        RUN_ID,
        DELEGATION_ID,
        token(),
        TURN_ID,
        UserInputOnceState::AdmissionOnly,
    )
    .await
    .unwrap();
    assert_eq!(converged_receipt, in_memory_receipt);
    let persisted = persisted_config(&path).await;
    assert_eq!(receipt(&persisted), converged_receipt);
    assert_eq!(receipt(&converged), converged_receipt);
    assert_eq!(
        config_without_receipt(&converged),
        config_without_receipt(&in_memory)
    );
    assert_eq!(
        config_without_receipt(&persisted),
        config_without_receipt(&in_memory)
    );
}

#[tokio::test]
async fn admitted_after_commit_error_preserves_receipt_and_retry_is_idempotent() {
    let workspace = TempDir::new().unwrap();
    let cwd = workspace.path().to_string_lossy().into_owned();
    let (path, config) = seed_office(&cwd).await;
    let (starting, _) = reserve_delegation_starting(&cwd, config, RUN_ID, DELEGATION_ID, token())
        .await
        .unwrap();
    let observed = Arc::new(Mutex::new(None));
    let writer_observed = Arc::clone(&observed);

    let error = commit_delegation_admitted_with_writer(
        &cwd,
        starting,
        RUN_ID,
        DELEGATION_ID,
        token(),
        TURN_ID,
        UserInputOnceState::AdmissionOnly,
        move |cwd, config| async move {
            *writer_observed.lock().unwrap() = Some(config.clone());
            save_record(DomainKind::Office, &cwd, config).await?;
            Err(internal_error(
                "injected admitted receipt after committed rename",
            ))
        },
    )
    .await
    .expect_err("admitted receipt must report ambiguous persistence");
    assert_eq!(
        error.message,
        "injected admitted receipt after committed rename"
    );

    let in_memory = observed_config(&observed);
    let in_memory_receipt = receipt(&in_memory);
    let (_, record) = persisted_record(&path).await;
    assert_office_envelope(&record, &in_memory);
    let persisted = record["config"].clone();
    assert_eq!(receipt(&persisted), in_memory_receipt);
    assert_eq!(
        in_memory_receipt.status,
        OfficeDispatchReceiptStatus::Admitted
    );
    assert_eq!(
        in_memory_receipt.admission_state,
        Some(OfficeDispatchAdmissionState::AdmissionOnly)
    );
    assert_eq!(in_memory_receipt.reserve_count, 1);
    assert_eq!(in_memory_receipt.turn_id.as_deref(), Some(TURN_ID));

    let (_, converged, converged_receipt) = commit_delegation_admitted(
        &cwd,
        persisted,
        RUN_ID,
        DELEGATION_ID,
        token(),
        TURN_ID,
        UserInputOnceState::AdmissionOnly,
    )
    .await
    .unwrap();
    assert_eq!(converged_receipt, in_memory_receipt);
    let persisted = persisted_config(&path).await;
    assert_eq!(receipt(&persisted), converged_receipt);
    assert_eq!(receipt(&converged), converged_receipt);
    assert_eq!(
        config_without_receipt(&converged),
        config_without_receipt(&in_memory)
    );
    assert_eq!(
        config_without_receipt(&persisted),
        config_without_receipt(&in_memory)
    );
}
