use std::path::Path;

use crewon_protocol::ThreadId;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::SessionMeta;
use crewon_protocol::protocol::SessionMetaLine;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::ensure_history_matches;

fn session_meta(thread_id: ThreadId, cwd: &Path) -> RolloutItem {
    RolloutItem::SessionMeta(SessionMetaLine {
        meta: SessionMeta {
            id: thread_id,
            cwd: cwd.to_path_buf(),
            ..SessionMeta::default()
        },
        git: None,
        scene_runtime: None,
    })
}

#[test]
fn history_workspace_uses_only_the_target_thread_session_meta() {
    let requested_workspace = TempDir::new().expect("requested workspace");
    let target_workspace = TempDir::new().expect("target workspace");
    let parent_id = ThreadId::new();
    let target_id = ThreadId::new();
    let items = vec![
        session_meta(parent_id, requested_workspace.path()),
        session_meta(target_id, target_workspace.path()),
    ];

    let error = ensure_history_matches(
        requested_workspace.path().to_string_lossy().as_ref(),
        &target_id.to_string(),
        &items,
    )
    .expect_err("parent metadata must not authorize the target thread");

    assert!(error.message.contains("belongs to a different workspace"));
}

#[test]
fn history_workspace_rejects_conflicting_target_session_meta() {
    let first_workspace = TempDir::new().expect("first workspace");
    let second_workspace = TempDir::new().expect("second workspace");
    let thread_id = ThreadId::new();
    let items = vec![
        session_meta(thread_id, first_workspace.path()),
        session_meta(thread_id, second_workspace.path()),
    ];

    let error = ensure_history_matches(
        first_workspace.path().to_string_lossy().as_ref(),
        &thread_id.to_string(),
        &items,
    )
    .expect_err("conflicting target metadata must fail closed");

    assert_eq!(
        error.message,
        format!("Office thread {thread_id} has conflicting persisted workspace metadata")
    );
}
