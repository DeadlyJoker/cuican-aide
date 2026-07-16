use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::fs;

use super::*;

#[tokio::test]
async fn enqueue_deduplicates_a_turn_and_resolve_removes_it() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let original = OfficeOrphanDispatch::manager(
        "record-a".to_string(),
        "run-a".to_string(),
        "thread-a".to_string(),
        "turn-a".to_string(),
    );
    enqueue(&cwd, original).await.expect("enqueue original");
    let replacement = OfficeOrphanDispatch::delegation(
        "record-a".to_string(),
        "run-a".to_string(),
        "delegation-a".to_string(),
        "thread-a".to_string(),
        "turn-a".to_string(),
    );
    enqueue(&cwd, replacement.clone())
        .await
        .expect("replace duplicate turn");

    assert_eq!(list(&cwd).await.expect("list queue"), vec![replacement]);

    resolve(&cwd, "thread-a", "turn-a")
        .await
        .expect("resolve turn");
    assert_eq!(list(&cwd).await.expect("list empty queue"), Vec::new());
}

#[tokio::test]
async fn queue_is_hard_capped_and_evicts_the_oldest_entry() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    for index in 0..=MAX_ORPHAN_DISPATCHES {
        enqueue(
            &cwd,
            OfficeOrphanDispatch::manager(
                format!("record-{index}"),
                format!("run-{index}"),
                format!("thread-{index}"),
                format!("turn-{index}"),
            ),
        )
        .await
        .expect("enqueue bounded entry");
    }

    let entries = list(&cwd).await.expect("list bounded queue");
    assert_eq!(entries.len(), MAX_ORPHAN_DISPATCHES);
    assert_eq!(
        entries.first().map(|entry| entry.record_id.as_str()),
        Some("record-1")
    );
    assert_eq!(
        entries.last().map(|entry| entry.record_id.as_str()),
        Some("record-64")
    );
}

#[tokio::test]
async fn concurrent_enqueues_do_not_lose_distinct_turns() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let mut tasks = Vec::new();
    for index in 0..8 {
        let cwd = cwd.clone();
        tasks.push(tokio::spawn(async move {
            enqueue(
                &cwd,
                OfficeOrphanDispatch::verification(
                    format!("record-{index}"),
                    format!("run-{index}"),
                    format!("verification-{index}"),
                    format!("thread-{index}"),
                    format!("turn-{index}"),
                ),
            )
            .await
        }));
    }
    for task in tasks {
        task.await
            .expect("enqueue task")
            .expect("enqueue distinct turn");
    }

    let mut entries = list(&cwd).await.expect("list concurrent queue");
    entries.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    assert_eq!(entries.len(), 8);
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.thread_id.as_str())
            .collect::<Vec<_>>(),
        (0..8)
            .map(|index| format!("thread-{index}"))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn corrupt_or_oversized_queue_fails_closed() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let path = queue_path(&cwd).expect("queue path");
    fs::create_dir_all(path.parent().expect("queue parent"))
        .await
        .expect("create queue parent");
    fs::write(&path, b"not-json")
        .await
        .expect("write corrupt queue");
    assert!(list(&cwd).await.is_err());

    fs::write(
        &path,
        vec![b'x'; usize::try_from(MAX_ORPHAN_DISPATCH_QUEUE_BYTES).unwrap() + 1],
    )
    .await
    .expect("write oversized queue");
    assert!(list(&cwd).await.is_err());
}
