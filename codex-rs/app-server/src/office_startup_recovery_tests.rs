use super::OFFICE_STARTUP_RECOVERY_CONCURRENCY;
use super::recover_office_startup_cwds_with;
use crate::office_scheduler_state::MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS;
use pretty_assertions::assert_eq;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::sync::mpsc;

#[tokio::test]
async fn waiting_first_workspace_does_not_block_later_workspace_recovery() {
    let first_workspace_gate = Arc::new(Semaphore::new(/*permits*/ 0));
    let (started_tx, mut started_rx) = mpsc::unbounded_channel();
    let recovery = tokio::spawn({
        let first_workspace_gate = first_workspace_gate.clone();
        async move {
            recover_office_startup_cwds_with(
                vec![
                    "/workspace/waiting".to_string(),
                    "/workspace/ready".to_string(),
                ],
                move |cwd| {
                    let first_workspace_gate = first_workspace_gate.clone();
                    let started_tx = started_tx.clone();
                    async move {
                        started_tx.send(cwd.clone()).expect("start receiver open");
                        if cwd == "/workspace/waiting" {
                            let permit = first_workspace_gate
                                .acquire_owned()
                                .await
                                .expect("gate remains open");
                            permit.forget();
                        }
                    }
                },
            )
            .await;
        }
    });

    let mut started = Vec::new();
    while !started.iter().any(|cwd| cwd == "/workspace/ready") {
        started.push(
            tokio::time::timeout(Duration::from_secs(/*secs*/ 1), started_rx.recv())
                .await
                .expect("later recovery should start while the first is waiting")
                .expect("start sender open"),
        );
    }
    assert!(started.iter().any(|cwd| cwd == "/workspace/waiting"));
    assert!(!recovery.is_finished());

    first_workspace_gate.add_permits(/*n*/ 1);
    recovery.await.expect("recovery task succeeds");
}

#[tokio::test]
async fn startup_recovery_processes_full_workspace_capacity_with_bounded_concurrency() {
    let gate = Arc::new(Semaphore::new(/*permits*/ 0));
    let active = Arc::new(AtomicUsize::new(/*v*/ 0));
    let completed = Arc::new(AtomicUsize::new(/*v*/ 0));
    let peak = Arc::new(AtomicUsize::new(/*v*/ 0));
    let (started_tx, mut started_rx) = mpsc::unbounded_channel();
    let cwds = (0..MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS)
        .map(|index| format!("/workspace/{index}"))
        .collect();
    let recovery = tokio::spawn({
        let active = active.clone();
        let completed = completed.clone();
        let gate = gate.clone();
        let peak = peak.clone();
        async move {
            recover_office_startup_cwds_with(cwds, move |cwd| {
                let active = active.clone();
                let completed = completed.clone();
                let gate = gate.clone();
                let peak = peak.clone();
                let started_tx = started_tx.clone();
                async move {
                    let current = active.fetch_add(/*val*/ 1, Ordering::SeqCst) + 1;
                    peak.fetch_max(current, Ordering::SeqCst);
                    started_tx.send(cwd).expect("start receiver open");
                    let permit = gate.acquire_owned().await.expect("gate remains open");
                    permit.forget();
                    active.fetch_sub(/*val*/ 1, Ordering::SeqCst);
                    completed.fetch_add(/*val*/ 1, Ordering::SeqCst);
                }
            })
            .await;
        }
    });

    for _ in 0..OFFICE_STARTUP_RECOVERY_CONCURRENCY {
        tokio::time::timeout(Duration::from_secs(/*secs*/ 1), started_rx.recv())
            .await
            .expect("initial bounded batch starts")
            .expect("start sender open");
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(/*millis*/ 50), started_rx.recv())
            .await
            .is_err()
    );
    assert_eq!(
        peak.load(Ordering::SeqCst),
        OFFICE_STARTUP_RECOVERY_CONCURRENCY
    );

    gate.add_permits(/*n*/ MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS);
    recovery.await.expect("recovery task succeeds");

    assert_eq!(
        completed.load(Ordering::SeqCst),
        MAX_OFFICE_SCHEDULER_WORKSPACE_CWDS
    );
    assert_eq!(
        peak.load(Ordering::SeqCst),
        OFFICE_STARTUP_RECOVERY_CONCURRENCY
    );
}
