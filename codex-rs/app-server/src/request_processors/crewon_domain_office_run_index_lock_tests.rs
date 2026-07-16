use std::fs;
use std::time::Duration;

use tempfile::TempDir;
use tokio::time::sleep;
use tokio::time::timeout;

use super::acquire_run_index_lock;
use super::office_run_index_path;

#[tokio::test]
async fn stale_run_index_lock_files_do_not_block_recovery() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let index_path = office_run_index_path(&cwd).expect("resolve run index path");
    fs::create_dir_all(index_path.parent().expect("run index parent"))
        .expect("create run index directory");

    let advisory_lock_path = index_path.with_file_name("index.json.lock");
    fs::write(&advisory_lock_path, b"stale advisory lock file")
        .expect("create stale advisory lock file");
    let legacy_lock_path = index_path.with_file_name("index.lock");
    fs::write(&legacy_lock_path, b"stale legacy lock file").expect("create stale legacy lock file");

    let first = timeout(Duration::from_secs(1), acquire_run_index_lock(&cwd))
        .await
        .expect("stale lock files must not block recovery")
        .expect("acquire run index lock");
    drop(first);

    let second = timeout(Duration::from_secs(1), acquire_run_index_lock(&cwd))
        .await
        .expect("released advisory lock must remain reusable")
        .expect("reacquire run index lock");
    drop(second);

    assert!(advisory_lock_path.exists());
    assert!(legacy_lock_path.exists());
}

#[tokio::test]
async fn run_index_lock_serializes_concurrent_mutations() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let first = acquire_run_index_lock(&cwd)
        .await
        .expect("acquire first run index lock");

    let waiter_cwd = cwd.clone();
    let waiter = tokio::spawn(async move { acquire_run_index_lock(&waiter_cwd).await });
    sleep(Duration::from_millis(40)).await;
    assert!(!waiter.is_finished());

    drop(first);
    let second = timeout(Duration::from_secs(1), waiter)
        .await
        .expect("waiter must resume after the first guard is released")
        .expect("waiter task")
        .expect("acquire second run index lock");
    drop(second);
}
