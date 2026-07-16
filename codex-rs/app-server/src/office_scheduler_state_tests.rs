use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS;
use super::OfficeSchedulerTargetCursor;
use super::OfficeSchedulerWorkspacePosition;
use super::compare_exchange_workspace_position;
use super::remember_workspace;
use super::workspace_cwds;
use super::workspace_position;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_remember_and_cursor_updates_do_not_lose_state_or_expose_partial_json() {
    let codex_home = Arc::new(TempDir::new().expect("temporary codex home"));
    let target_cwd = "/workspace/target";
    remember_workspace(codex_home.path(), target_cwd)
        .await
        .expect("initialize scheduler state");

    let done = Arc::new(AtomicBool::new(false));
    let observer_done = Arc::clone(&done);
    let state_path = codex_home
        .path()
        .join("office-scheduler")
        .join("workspaces.json");
    let observer = tokio::task::spawn_blocking(move || {
        while !observer_done.load(Ordering::Acquire) {
            let bytes = std::fs::read(&state_path).expect("read scheduler state during writes");
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .expect("scheduler state is always complete JSON");
            std::thread::yield_now();
        }
    });

    let cursor_home = Arc::clone(&codex_home);
    let cursor_writer = tokio::spawn(async move {
        for index in 0..64 {
            let expected = workspace_position(cursor_home.path(), target_cwd)
                .await
                .expect("read current scheduler cursor");
            let next = OfficeSchedulerWorkspacePosition {
                record_cursor: Some(format!("record-{index:03}")),
                target_cursor: Some(OfficeSchedulerTargetCursor {
                    record_id: format!("record-{index:03}"),
                    thread_id: format!("thread-{index:03}"),
                }),
            };
            let updated = compare_exchange_workspace_position(
                cursor_home.path(),
                target_cwd,
                &expected,
                next,
            )
            .await
            .expect("update scheduler cursor");
            assert!(updated);
        }
    });

    let mut remember_writers = Vec::new();
    for index in 0..32 {
        let remember_home = Arc::clone(&codex_home);
        remember_writers.push(tokio::spawn(async move {
            remember_workspace(remember_home.path(), &format!("/workspace/{index:03}"))
                .await
                .expect("remember scheduler workspace");
        }));
    }
    for writer in remember_writers {
        writer.await.expect("remember writer task");
    }
    cursor_writer.await.expect("cursor writer task");
    done.store(true, Ordering::Release);
    observer.await.expect("state observer task");

    let cwds = workspace_cwds(codex_home.path())
        .await
        .expect("read scheduler workspaces");
    assert_eq!(cwds.len(), 33);
    assert!(cwds.iter().any(|cwd| cwd == target_cwd));
    for index in 0..32 {
        assert!(
            cwds.iter()
                .any(|cwd| cwd == &format!("/workspace/{index:03}"))
        );
    }
    assert_eq!(
        workspace_position(codex_home.path(), target_cwd)
            .await
            .expect("read final scheduler cursor"),
        OfficeSchedulerWorkspacePosition {
            record_cursor: Some("record-063".to_string()),
            target_cursor: Some(OfficeSchedulerTargetCursor {
                record_id: "record-063".to_string(),
                thread_id: "thread-063".to_string(),
            }),
        }
    );
}

#[tokio::test]
async fn scheduler_state_keeps_only_the_most_recent_64_workspaces() {
    let codex_home = TempDir::new().expect("temporary codex home");
    for index in 0..80 {
        remember_workspace(codex_home.path(), &format!("/workspace/{index:03}"))
            .await
            .expect("remember scheduler workspace");
    }

    let cwds = workspace_cwds(codex_home.path())
        .await
        .expect("read bounded scheduler workspaces");

    assert_eq!(cwds.len(), MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS);
    assert_eq!(cwds.first().map(String::as_str), Some("/workspace/079"));
    assert!(cwds.iter().all(|cwd| cwd != "/workspace/000"));
}

#[tokio::test]
async fn cursor_compare_exchange_does_not_overwrite_newer_progress() {
    let codex_home = TempDir::new().expect("temporary codex home");
    let cwd = "/workspace/project";
    remember_workspace(codex_home.path(), cwd)
        .await
        .expect("remember scheduler workspace");
    let initial = workspace_position(codex_home.path(), cwd)
        .await
        .expect("read initial cursor");
    let advanced = OfficeSchedulerWorkspacePosition {
        record_cursor: Some("record-024".to_string()),
        target_cursor: None,
    };
    assert!(
        compare_exchange_workspace_position(codex_home.path(), cwd, &initial, advanced.clone(),)
            .await
            .expect("advance cursor")
    );

    assert!(
        !compare_exchange_workspace_position(
            codex_home.path(),
            cwd,
            &initial,
            OfficeSchedulerWorkspacePosition::default(),
        )
        .await
        .expect("reject stale cursor update")
    );
    assert_eq!(
        workspace_position(codex_home.path(), cwd)
            .await
            .expect("read retained cursor"),
        advanced
    );
}
