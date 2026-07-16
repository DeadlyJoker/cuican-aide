use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::*;

fn receipt(status: ReceiptStatus) -> OfficeMessageReceipt {
    OfficeMessageReceipt {
        receipt_id: "receipt-1".to_string(),
        client_user_message_id: "client-1".to_string(),
        payload_hash: "a".repeat(64),
        message_id: "message-1".to_string(),
        sequence: 1,
        text: "Bounded text".to_string(),
        locale: Some("en".to_string()),
        mentions: Vec::new(),
        message_intent: Some("task".to_string()),
        intent_classifier_version: Some(1),
        status,
        action: ReceiptAction::StartRun,
        run_id: Some("run-1".to_string()),
        thread_id: Some("thread-1".to_string()),
        expected_turn_id: None,
        turn_id: Some("turn-1".to_string()),
        after_run_id: None,
        queue_position: None,
        lease_id: None,
        lease_expires_at: None,
        attempts: 1,
        created_at: "2026-07-13T00:00:00Z".to_string(),
        updated_at: "2026-07-13T00:00:01Z".to_string(),
        error: None,
    }
}

#[tokio::test]
async fn receipt_store_round_trips_without_copying_unbounded_payloads() {
    let temp_dir = TempDir::new().expect("tempdir");
    let path = temp_dir.path().join("receipts.state");
    let expected = OfficeMessageReceiptStore {
        version: RECEIPT_STORE_VERSION,
        office_record_id: "record-1".to_string(),
        record_revision: "revision-1".to_string(),
        receipts: vec![receipt(ReceiptStatus::Delivered)],
    };

    write_store(&path, &expected).await.expect("write store");
    let actual = read_store(&path, "record-1").await.expect("read store");
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn corrupt_non_authoritative_store_is_treated_as_an_empty_mirror() {
    let temp_dir = TempDir::new().expect("tempdir");
    let path = temp_dir.path().join("receipts.state");
    tokio::fs::write(&path, b"not-json")
        .await
        .expect("write corrupt store");

    assert_eq!(
        read_store(&path, "record-1").await.expect("read store"),
        empty_store("record-1")
    );
}

#[tokio::test]
async fn deleting_an_office_removes_its_receipt_mirror() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let path = receipt_store_path(&cwd, "record-1").expect("receipt path");
    tokio::fs::create_dir_all(path.parent().expect("receipt parent"))
        .await
        .expect("create receipt directory");
    tokio::fs::write(&path, b"mirror")
        .await
        .expect("write receipt mirror");

    delete_for_office(&cwd, "record-1")
        .await
        .expect("delete receipt mirror");

    assert!(!path.exists());
}

#[test]
fn receipt_validation_enforces_text_error_attempt_and_queue_bounds() {
    let valid = receipt(ReceiptStatus::Queued);
    assert!(valid.is_valid());

    let mut oversized = valid.clone();
    oversized.text = "x".repeat(901);
    assert!(!oversized.is_valid());

    let mut too_many_attempts = valid.clone();
    too_many_attempts.attempts = MAX_DISPATCH_ATTEMPTS + 1;
    assert!(!too_many_attempts.is_valid());

    let mut invalid_position = valid;
    invalid_position.queue_position = Some(0);
    assert!(!invalid_position.is_valid());
}
