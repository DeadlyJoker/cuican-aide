use std::path::Path;
use std::path::PathBuf;

use crewon_protocol::ThreadId;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::ThreadMemoryMode;
use crewon_protocol::protocol::UserMessageEvent;
use crewon_rollout::RolloutRecorder;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;

use super::LocalThreadStore;
use crate::AppendThreadItemsParams;
use crate::ResumeThreadParams;
use crate::ThreadPersistenceMetadata;
use crate::ThreadStore;
use crate::ThreadStoreError;
use crate::local::test_support::test_config;
use crate::local::test_support::write_session_file;

#[tokio::test]
async fn second_store_conflicts_while_writer_is_live_and_succeeds_after_shutdown() {
    let home = TempDir::new().expect("temp dir");
    let uuid = uuid::Uuid::from_u128(501);
    let thread_id = thread_id(uuid);
    let rollout_path =
        write_session_file(home.path(), "2025-01-05T10-00-00", uuid).expect("session file");
    let first_store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);
    let second_store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);

    first_store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path.clone(),
            /*history*/ None,
        ))
        .await
        .expect("first store should own the writer");

    let error = second_store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path.clone(),
            /*history*/ None,
        ))
        .await
        .expect_err("a second store must not acquire the same live writer");
    assert!(matches!(error, ThreadStoreError::Conflict { .. }));

    first_store
        .shutdown_thread(thread_id)
        .await
        .expect("release first writer");
    second_store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path,
            /*history*/ None,
        ))
        .await
        .expect("second store should acquire writer after shutdown");
    second_store
        .shutdown_thread(thread_id)
        .await
        .expect("release second writer");
}

#[tokio::test]
async fn resume_rejects_stale_history_and_accepts_fresh_history_after_conflict() {
    let home = TempDir::new().expect("temp dir");
    let uuid = uuid::Uuid::from_u128(502);
    let thread_id = thread_id(uuid);
    let rollout_path =
        write_session_file(home.path(), "2025-01-05T10-30-00", uuid).expect("session file");
    let (stale_history, loaded_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(rollout_path.as_path())
            .await
            .expect("load initial history");
    assert_eq!(loaded_thread_id, Some(thread_id));
    assert_eq!(parse_errors, 0);

    let mutating_store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);
    mutating_store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path.clone(),
            /*history*/ None,
        ))
        .await
        .expect("resume writer used to append a concurrent item");
    mutating_store
        .append_items(AppendThreadItemsParams {
            thread_id,
            items: vec![user_message_item("appended after stale snapshot")],
        })
        .await
        .expect("append after stale snapshot");
    mutating_store
        .shutdown_thread(thread_id)
        .await
        .expect("release mutating writer");

    let resumed_store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);
    let error = resumed_store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path.clone(),
            Some(stale_history),
        ))
        .await
        .expect_err("stale pre-lock history must fail closed");
    assert!(matches!(error, ThreadStoreError::Conflict { .. }));

    let (fresh_history, loaded_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(rollout_path.as_path())
            .await
            .expect("load fresh history");
    assert_eq!(loaded_thread_id, Some(thread_id));
    assert_eq!(parse_errors, 0);
    resumed_store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path,
            Some(fresh_history),
        ))
        .await
        .expect("fresh history should resume after conflict released the lock");
    resumed_store
        .shutdown_thread(thread_id)
        .await
        .expect("release resumed writer");
}

#[tokio::test]
async fn resume_rejects_same_length_history_with_changed_item() {
    let home = TempDir::new().expect("temp dir");
    let uuid = uuid::Uuid::from_u128(504);
    let thread_id = thread_id(uuid);
    let rollout_path =
        write_session_file(home.path(), "2025-01-05T11-30-00", uuid).expect("session file");
    let (fresh_history, loaded_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(rollout_path.as_path())
            .await
            .expect("load current history");
    assert_eq!(loaded_thread_id, Some(thread_id));
    assert_eq!(parse_errors, 0);
    let mut changed_history = fresh_history.clone();
    let message = changed_history
        .iter_mut()
        .find_map(|item| match item {
            RolloutItem::EventMsg(EventMsg::UserMessage(event)) => Some(&mut event.message),
            RolloutItem::SessionMeta(_)
            | RolloutItem::ResponseItem(_)
            | RolloutItem::Compacted(_)
            | RolloutItem::TurnContext(_)
            | RolloutItem::EventMsg(_)
            | RolloutItem::UserInputOnceMarker(_) => None,
        })
        .expect("fixture should contain a user message");
    *message = "changed without changing item count".to_string();

    let store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);
    let error = store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path.clone(),
            Some(changed_history),
        ))
        .await
        .expect_err("same-length semantic history changes must fail closed");
    assert!(matches!(error, ThreadStoreError::Conflict { .. }));

    store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path,
            Some(fresh_history),
        ))
        .await
        .expect("failed exact comparison must release the writer lease");
    store
        .shutdown_thread(thread_id)
        .await
        .expect("release exact-history writer");
}

#[tokio::test]
async fn resume_rejects_malformed_rollout_and_releases_writer_lock() {
    let home = TempDir::new().expect("temp dir");
    let uuid = uuid::Uuid::from_u128(503);
    let thread_id = thread_id(uuid);
    let rollout_path =
        write_session_file(home.path(), "2025-01-05T11-00-00", uuid).expect("session file");
    let original_contents = tokio::fs::read(rollout_path.as_path())
        .await
        .expect("read original rollout");
    let (history, loaded_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(rollout_path.as_path())
            .await
            .expect("load history before corruption");
    assert_eq!(loaded_thread_id, Some(thread_id));
    assert_eq!(parse_errors, 0);

    let mut rollout = tokio::fs::OpenOptions::new()
        .append(true)
        .open(rollout_path.as_path())
        .await
        .expect("open rollout for corruption");
    rollout
        .write_all(b"{not-valid-json}\n")
        .await
        .expect("append malformed line");
    rollout.flush().await.expect("flush malformed line");
    drop(rollout);

    let store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);
    let error = store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path.clone(),
            Some(history.clone()),
        ))
        .await
        .expect_err("parse errors must fail closed even when parsed items match");
    if cfg!(feature = "legacy-fence-artifact") {
        assert!(matches!(error, ThreadStoreError::Conflict { .. }));
    } else {
        assert!(matches!(error, ThreadStoreError::InvalidRequest { .. }));
    }

    tokio::fs::write(rollout_path.as_path(), original_contents)
        .await
        .expect("repair malformed rollout");
    store
        .resume_thread(resume_params(
            home.path(),
            thread_id,
            rollout_path,
            Some(history),
        ))
        .await
        .expect("repair should succeed because failed handoff released the lock");
    store
        .shutdown_thread(thread_id)
        .await
        .expect("release repaired writer");
}

#[tokio::test]
async fn resume_rejects_requested_thread_id_that_does_not_match_rollout() {
    let home = TempDir::new().expect("temp dir");
    let rollout_uuid = uuid::Uuid::from_u128(505);
    let rollout_thread_id = thread_id(rollout_uuid);
    let requested_thread_id = thread_id(uuid::Uuid::from_u128(506));
    let rollout_path =
        write_session_file(home.path(), "2025-01-05T12-00-00", rollout_uuid).expect("session file");
    let store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);

    let error = store
        .resume_thread(resume_params(
            home.path(),
            requested_thread_id,
            rollout_path.clone(),
            /*history*/ None,
        ))
        .await
        .expect_err("request thread id must match the rollout SessionMeta id");
    assert!(matches!(error, ThreadStoreError::InvalidRequest { .. }));

    store
        .resume_thread(resume_params(
            home.path(),
            rollout_thread_id,
            rollout_path,
            /*history*/ None,
        ))
        .await
        .expect("invalid request must release its incorrect writer lease");
    store
        .shutdown_thread(rollout_thread_id)
        .await
        .expect("release correct writer");
}

fn thread_id(uuid: uuid::Uuid) -> ThreadId {
    ThreadId::from_string(&uuid.to_string()).expect("valid thread id")
}

fn resume_params(
    codex_home: &Path,
    thread_id: ThreadId,
    rollout_path: PathBuf,
    history: Option<Vec<RolloutItem>>,
) -> ResumeThreadParams {
    ResumeThreadParams {
        thread_id,
        rollout_path: Some(rollout_path),
        history,
        include_archived: false,
        metadata: ThreadPersistenceMetadata {
            cwd: Some(codex_home.to_path_buf()),
            model_provider: "test-provider".to_string(),
            memory_mode: ThreadMemoryMode::Enabled,
        },
    }
}

fn user_message_item(message: &str) -> RolloutItem {
    RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
        client_id: None,
        message: message.to_string(),
        images: None,
        local_images: Vec::new(),
        text_elements: Vec::new(),
        ..Default::default()
    }))
}
