use std::fs::OpenOptions;
use std::time::Duration;

use tempfile::TempDir;
use tokio::time::sleep;
use tokio::time::timeout;

use super::lock;
use super::record_lock_path;

#[tokio::test]
async fn exact_record_lock_serializes_waiters_without_deadlock() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let record_path = temp_dir.path().join("office.json");
    let first = lock(&record_path).await.expect("acquire first lock");
    let waiter_path = record_path.clone();
    let waiter = tokio::spawn(async move { lock(&waiter_path).await });

    sleep(Duration::from_millis(40)).await;
    assert!(!waiter.is_finished());
    drop(first);

    let second = timeout(Duration::from_secs(1), waiter)
        .await
        .expect("waiter should not deadlock")
        .expect("waiter task")
        .expect("acquire second lock");
    drop(second);
    assert!(record_path.with_file_name("office.json.lock").exists());
}

#[tokio::test]
async fn blocked_record_does_not_stall_an_unrelated_office() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let blocked_record_path = temp_dir.path().join("blocked-office.json");
    let unrelated_record_path = temp_dir.path().join("unrelated-office.json");
    let raw_lock_path = record_lock_path(&blocked_record_path).expect("raw lock path");
    let raw_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(raw_lock_path)
        .expect("open raw lock");
    raw_lock.lock().expect("hold raw cross-process-style lock");

    let blocked_waiter_path = blocked_record_path.clone();
    let blocked_waiter = tokio::spawn(async move { lock(&blocked_waiter_path).await });
    sleep(Duration::from_millis(40)).await;
    assert!(!blocked_waiter.is_finished());

    let unrelated = timeout(Duration::from_secs(1), lock(&unrelated_record_path))
        .await
        .expect("unrelated record must not wait behind blocked record")
        .expect("acquire unrelated record lock");
    drop(unrelated);

    raw_lock.unlock().expect("release raw lock");
    let blocked = timeout(Duration::from_secs(1), blocked_waiter)
        .await
        .expect("blocked record lock should resume")
        .expect("blocked waiter task")
        .expect("acquire formerly blocked record lock");
    drop(blocked);
}
