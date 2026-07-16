use std::sync::Arc;

use tokio::sync::Barrier;

use super::OfficeThreadCapabilityLocks;

#[tokio::test]
async fn same_thread_waits_until_the_current_capability_guard_is_released() {
    let locks = OfficeThreadCapabilityLocks::default();
    let first = locks.acquire("thread-1").await;
    let started = Arc::new(Barrier::new(/*n*/ 2));
    let task_locks = locks.clone();
    let task_started = Arc::clone(&started);
    let waiter = tokio::spawn(async move {
        task_started.wait().await;
        let _guard = task_locks.acquire("thread-1").await;
    });
    started.wait().await;
    assert!(!waiter.is_finished());

    drop(first);
    waiter.await.expect("same-thread waiter");
}

#[tokio::test]
async fn different_threads_acquire_independently() {
    let locks = OfficeThreadCapabilityLocks::default();
    let _first = locks.acquire("thread-1").await;

    let second = tokio::time::timeout(
        std::time::Duration::from_secs(/*secs*/ 1),
        locks.acquire("thread-2"),
    )
    .await
    .expect("different thread must not wait");

    drop(second);
}

#[tokio::test]
async fn equivalent_uuid_spellings_share_one_capability_lock() {
    let locks = OfficeThreadCapabilityLocks::default();
    let first = locks.acquire("019f7f63-33cb-7dd0-8d6f-f8a04bf3ca3a").await;
    let task_locks = locks.clone();
    let waiter = tokio::spawn(async move {
        let _guard = task_locks
            .acquire("019F7F63-33CB-7DD0-8D6F-F8A04BF3CA3A")
            .await;
    });
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());

    drop(first);
    waiter.await.expect("canonical UUID waiter");
}
