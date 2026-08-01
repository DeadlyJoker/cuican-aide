use std::fs;

use crewon_protocol::ThreadId;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use uuid::Uuid;

use super::LocalThreadStore;
use super::test_support::test_config;
use super::test_support::write_session_file;
use crate::ThreadMetadataPatch;
use crate::ThreadStore;
use crate::ThreadStoreError;
use crate::UpdateThreadMetadataParams;

#[tokio::test]
async fn metadata_mutation_rejects_rollout_outside_crewon_home() {
    let home = TempDir::new().expect("home temp dir");
    let outside = TempDir::new().expect("outside temp dir");
    let uuid = Uuid::from_u128(4201);
    let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
    fs::create_dir_all(home.path().join(crewon_rollout::SESSIONS_SUBDIR))
        .expect("sessions directory");
    fs::create_dir_all(home.path().join(crewon_rollout::ARCHIVED_SESSIONS_SUBDIR))
        .expect("archived sessions directory");
    let outside_path = write_session_file(outside.path(), "2025-01-03T12-00-00", uuid)
        .expect("outside session file");
    let before = fs::read(outside_path.as_path()).expect("outside rollout bytes");
    let store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);

    let error = store
        .update_thread_metadata(UpdateThreadMetadataParams {
            thread_id,
            patch: ThreadMetadataPatch {
                rollout_path: Some(outside_path.clone()),
                preview: Some("must not be written".to_string()),
                ..Default::default()
            },
            include_archived: true,
        })
        .await
        .expect_err("out-of-home rollout must be rejected");

    assert!(matches!(error, ThreadStoreError::InvalidRequest { .. }));
    assert_eq!(
        fs::read(outside_path).expect("outside rollout bytes after rejection"),
        before
    );
}
