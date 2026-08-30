use std::time::Duration;

use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::sleep;
use tokio::time::timeout;

use super::*;

#[tokio::test]
async fn sidecar_round_trip_preserves_identity_generation_and_state() {
    let temp_dir = TempDir::new().expect("tempdir");
    let locked = lock(temp_dir.path(), "workspace-thread")
        .await
        .expect("lock identity");
    let active = OfficeWorkspaceIdentity::active(
        locked.thread_id_hash().to_string(),
        "record-a".to_string(),
        /*generation*/ 3,
    )
    .expect("active identity");
    locked.write(&active).await.expect("write active identity");

    assert_eq!(
        locked.read().await.expect("read active identity"),
        Some(active.clone())
    );

    let deleting = active.with_state(OfficeWorkspaceIdentityState::Deleting);
    locked
        .write(&deleting)
        .await
        .expect("write deleting identity");
    assert_eq!(
        locked.read().await.expect("read deleting identity"),
        Some(deleting.clone())
    );

    let deleted = deleting.with_state(OfficeWorkspaceIdentityState::Deleted);
    locked
        .write(&deleted)
        .await
        .expect("write deleted identity");
    assert_eq!(
        locked.read().await.expect("read deleted identity"),
        Some(deleted)
    );
    assert_eq!(active.record_id(), "record-a");
    assert_eq!(active.generation(), 3);
    assert_eq!(active.state(), OfficeWorkspaceIdentityState::Active);
    assert_eq!(active.next_generation().expect("next generation"), 4);
}

#[tokio::test]
async fn sidecar_path_uses_only_the_thread_id_hash() {
    let temp_dir = TempDir::new().expect("tempdir");
    let raw_thread_id = "private/workspace/thread";
    let locked = lock(temp_dir.path(), raw_thread_id)
        .await
        .expect("lock identity");
    let identity = OfficeWorkspaceIdentity::active(
        locked.thread_id_hash().to_string(),
        "record-a".to_string(),
        /*generation*/ 1,
    )
    .expect("active identity");
    locked.write(&identity).await.expect("write identity");

    let sidecar_path = locked.sidecar_path.to_string_lossy();
    assert!(!sidecar_path.contains(raw_thread_id));
    assert_eq!(
        locked.sidecar_path.parent(),
        Some(temp_dir.path().join(SIDECAR_DIRECTORY_NAME).as_path())
    );
}

#[tokio::test]
async fn sidecar_lock_serializes_the_same_workspace_identity() {
    let temp_dir = TempDir::new().expect("tempdir");
    let first = lock(temp_dir.path(), "workspace-thread")
        .await
        .expect("first lock");
    let directory = temp_dir.path().to_path_buf();
    let waiter = tokio::spawn(async move { lock(&directory, "workspace-thread").await });

    sleep(Duration::from_millis(40)).await;
    assert!(!waiter.is_finished());
    drop(first);

    let second = timeout(Duration::from_secs(1), waiter)
        .await
        .expect("waiter should not deadlock")
        .expect("waiter task")
        .expect("second lock");
    drop(second);
}

#[tokio::test]
async fn corrupt_or_oversized_sidecars_fail_closed() {
    let temp_dir = TempDir::new().expect("tempdir");
    let locked = lock(temp_dir.path(), "workspace-thread")
        .await
        .expect("lock identity");
    std::fs::create_dir_all(locked.sidecar_path.parent().expect("sidecar parent"))
        .expect("create sidecar parent");
    std::fs::write(&locked.sidecar_path, b"not-json").expect("write corrupt sidecar");
    let error = locked
        .read()
        .await
        .expect_err("corrupt sidecar must fail closed");
    assert!(error.message.contains("failed to parse"));

    std::fs::write(
        &locked.sidecar_path,
        vec![b'x'; usize::try_from(MAX_SIDECAR_BYTES).expect("size") + 1],
    )
    .expect("write oversized sidecar");
    let error = locked
        .read()
        .await
        .expect_err("oversized sidecar must fail closed");
    assert!(error.message.contains("invalid or oversized"));
}

#[tokio::test]
async fn sidecar_rejects_zero_generation_and_mismatched_hashes() {
    let temp_dir = TempDir::new().expect("tempdir");
    let locked = lock(temp_dir.path(), "workspace-thread")
        .await
        .expect("lock identity");
    let error = OfficeWorkspaceIdentity::active(
        locked.thread_id_hash().to_string(),
        "record-a".to_string(),
        /*generation*/ 0,
    )
    .expect_err("zero generation must fail");
    assert!(error.message.contains("generation must be positive"));

    let other_hash = sha256_hex(b"other-thread");
    let identity =
        OfficeWorkspaceIdentity::active(other_hash, "record-a".to_string(), /*generation*/ 1)
            .expect("identity with other hash");
    let error = locked
        .write(&identity)
        .await
        .expect_err("mismatched hash must fail");
    assert!(error.message.contains("different threadId hash"));
}

#[tokio::test]
async fn unreadable_neighbor_does_not_claim_an_unbound_workspace_thread() {
    let temp_dir = TempDir::new().expect("tempdir");
    let office_directory = temp_dir.path().join(".crewon").join("offices");
    std::fs::create_dir_all(&office_directory).expect("create Office directory");
    std::fs::write(office_directory.join("corrupt-neighbor.json"), b"{not json")
        .expect("write corrupt Office neighbor");

    assert_eq!(
        workspace_thread_state(
            temp_dir.path().to_string_lossy().as_ref(),
            "ordinary-unbound-thread",
        )
        .await
        .expect("unrelated corrupt record must remain isolated"),
        OfficeWorkspaceThreadState::Unbound
    );
}

#[tokio::test]
async fn unreadable_neighbor_does_not_hide_a_bound_legacy_workspace_thread() {
    let temp_dir = TempDir::new().expect("tempdir");
    let office_directory = temp_dir.path().join(".crewon").join("offices");
    std::fs::create_dir_all(&office_directory).expect("create Office directory");
    std::fs::write(office_directory.join("corrupt-neighbor.json"), b"{not json")
        .expect("write corrupt Office neighbor");
    std::fs::write(
        office_directory.join("healthy-office.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "kind": "office",
            "savedAt": "2026-07-15T00:00:00.000Z",
            "config": {
                "title": "Healthy Office",
                "workspace": {
                    "recordId": "healthy-record",
                    "threadId": "bound-legacy-thread",
                    "members": [],
                    "messages": [],
                    "tasks": [],
                    "activity": { "runs": [], "artifacts": [] }
                }
            }
        }))
        .expect("serialize healthy Office record"),
    )
    .expect("write healthy Office record");

    assert_eq!(
        workspace_thread_state(
            temp_dir.path().to_string_lossy().as_ref(),
            "bound-legacy-thread",
        )
        .await
        .expect("matching healthy record must remain authoritative"),
        OfficeWorkspaceThreadState::ActiveIdle
    );
}
