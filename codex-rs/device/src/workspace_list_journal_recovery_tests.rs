use std::fs::File;
use std::sync::Arc;
use std::sync::Barrier;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crewon_device_journal::AcknowledgeWorkspaceListOutcome;
use crewon_device_journal::DeviceWorkspaceJournal;
use crewon_device_journal::WorkspaceJournalListQuery;
use pretty_assertions::assert_eq;

use super::NativeWorkspaceListDispatchOutcome;
use super::NativeWorkspaceListOrchestrator;
use crate::ConnectionEpochFence;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::workspace_list_dispatcher::execute_admitted_workspace_list;
use crate::workspace_list_journal_events::accepted_event;
use crate::workspace_list_journal_test_support as support;

#[tokio::test]
async fn crash_reopen_turns_expired_accepted_only_into_unknown_without_touching_a_handle() {
    let workspace = tempfile::tempdir().expect("temporary workspace");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", workspace.path())
        .expect("register original workspace");
    let fixture = support::signed_fixture(&binding, 301);
    let state = tempfile::tempdir().expect("Native state directory");
    let epoch_path = state.path().join("epoch");
    let fence = ConnectionEpochFence::open("device-1", &epoch_path).expect("open epoch fence");
    let authorizer = support::authorizer(&fixture.signing_key);
    let _original = support::establish(
        &fence,
        &authorizer,
        &fixture.welcome,
        "2026-08-08T00:00:03Z",
    );
    let journal_path = state.path().join("journal.sqlite");
    let journal = DeviceWorkspaceJournal::open(&journal_path)
        .await
        .expect("open journal");
    let accepted = accepted_event(
        &fixture.command,
        fixture.welcome.connection_epoch,
        support::timestamp("2026-08-08T00:00:04Z"),
    );
    journal
        .prepare_workspace_list(&fixture.command, &accepted)
        .await
        .expect("seed accepted-only crash authority");
    journal.close().await;
    drop(_original);
    drop(fence);

    let reopened_fence =
        ConnectionEpochFence::open("device-1", &epoch_path).expect("reopen durable epoch fence");
    let mut takeover = support::newer_welcome(&fixture.welcome, "2026-08-08T03:00:00Z");
    takeover.sent_at = "2026-08-08T02:00:00Z".to_string();
    let connection = support::establish(
        &reopened_fence,
        &authorizer,
        &takeover,
        "2026-08-08T02:00:00Z",
    );
    let reopened = DeviceWorkspaceJournal::open(&journal_path)
        .await
        .expect("reopen journal after crash");
    let recovery_now = support::timestamp("2026-08-08T02:00:00Z");
    let orchestrator =
        NativeWorkspaceListOrchestrator::with_clock(reopened.clone(), move || recovery_now);
    let replacement_registry = WorkspaceDirectoryRegistry::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let outcome = orchestrator
        .dispatch_workspace_list_with_executor(
            &connection,
            &support::command_frame(&fixture.command),
            &replacement_registry,
            &WorkspaceListCancellation::default(),
            {
                let calls = Arc::clone(&calls);
                move |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                }
            },
            {
                let calls = Arc::clone(&calls);
                move |admitted, cancellation| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    execute_admitted_workspace_list(admitted, cancellation)
                }
            },
        )
        .await
        .expect("recover accepted-only authority");
    assert!(matches!(
        outcome,
        NativeWorkspaceListDispatchOutcome::RecoveredUnknownOutcome {
            terminal: crewon_device_protocol::DeviceWorkspaceListEvent::UnknownOutcome { .. },
            ..
        }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        orchestrator
            .dispatch_workspace_list(
                &connection,
                &support::command_frame(&fixture.command),
                &replacement_registry,
                &WorkspaceListCancellation::default(),
            )
            .await
            .expect("replay recovered terminal"),
        NativeWorkspaceListDispatchOutcome::TerminalReplay {
            terminal: crewon_device_protocol::DeviceWorkspaceListEvent::UnknownOutcome { .. },
            ..
        }
    ));
}

#[tokio::test]
async fn reconnect_projection_and_cumulative_ack_are_durable_and_redacted() {
    let workspace = tempfile::tempdir().expect("temporary workspace");
    File::create(workspace.path().join("entry")).expect("workspace entry");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", workspace.path())
        .expect("register workspace");
    let fixture = support::signed_fixture(&binding, 401);
    let state = tempfile::tempdir().expect("Native state directory");
    let fence = ConnectionEpochFence::open("device-1", state.path().join("epoch"))
        .expect("open epoch fence");
    let authorizer = support::authorizer(&fixture.signing_key);
    let connection = support::establish(
        &fence,
        &authorizer,
        &fixture.welcome,
        "2026-08-08T00:00:03Z",
    );
    let journal = DeviceWorkspaceJournal::open(state.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let now = support::timestamp("2026-08-08T00:00:04Z");
    let orchestrator = NativeWorkspaceListOrchestrator::with_clock(journal, move || now);
    let outcome = orchestrator
        .dispatch_workspace_list(
            &connection,
            &support::command_frame(&fixture.command),
            &registry,
            &WorkspaceListCancellation::default(),
        )
        .await
        .expect("dispatch workspace listing");
    let NativeWorkspaceListDispatchOutcome::FreshResolved { accepted, terminal } = outcome else {
        panic!("fresh dispatch must resolve");
    };
    let query = WorkspaceJournalListQuery {
        after_execution_id: None,
        limit: 10,
    };
    let initial = orchestrator
        .reconnect_page(&query)
        .await
        .expect("project unacknowledged events");
    assert_eq!(initial.items.len(), 1);
    assert_eq!(
        initial.items[0].events,
        vec![accepted.clone(), terminal.clone()]
    );

    let ack_one = support::ack(&accepted, 1, "2026-08-08T00:00:05Z");
    orchestrator
        .acknowledge(&ack_one)
        .await
        .expect("ack accepted event");
    assert_eq!(
        orchestrator
            .reconnect_page(&query)
            .await
            .expect("project terminal only")
            .items[0]
            .events,
        vec![terminal],
    );
    let mut ack_one_retry = ack_one;
    ack_one_retry.acknowledged_at = "2026-08-08T00:00:06Z".to_string();
    assert!(matches!(
        orchestrator
            .acknowledge(&ack_one_retry)
            .await
            .expect("replay cumulative ACK"),
        AcknowledgeWorkspaceListOutcome::Replayed(_)
    ));
    orchestrator
        .acknowledge(&support::ack(&accepted, 2, "2026-08-08T00:00:07Z"))
        .await
        .expect("ack terminal event");
    assert_eq!(
        orchestrator
            .reconnect_page(&query)
            .await
            .expect("fully acknowledged execution is absent")
            .items,
        Vec::new(),
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn epoch_takeover_after_scan_start_records_unknown_instead_of_old_completion() {
    let workspace = tempfile::tempdir().expect("temporary workspace");
    File::create(workspace.path().join("entry")).expect("workspace entry");
    let registry = Arc::new(WorkspaceDirectoryRegistry::new());
    let binding = registry
        .register("workspace-binding-1", workspace.path())
        .expect("register workspace");
    let fixture = support::signed_fixture(&binding, 501);
    let state = tempfile::tempdir().expect("Native state directory");
    let fence = Box::leak(Box::new(
        ConnectionEpochFence::open("device-1", state.path().join("epoch"))
            .expect("open epoch fence"),
    ));
    let authorizer = Box::leak(Box::new(support::authorizer(&fixture.signing_key)));
    let connection =
        support::establish(fence, authorizer, &fixture.welcome, "2026-08-08T00:00:03Z");
    let journal = DeviceWorkspaceJournal::open(state.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let now = support::timestamp("2026-08-08T00:00:04Z");
    let orchestrator = NativeWorkspaceListOrchestrator::with_clock(journal, move || now);
    let reached_scan = Arc::new(Barrier::new(2));
    let release_scan = Arc::new(Barrier::new(2));
    let scan_count = Arc::new(AtomicUsize::new(0));
    let task = {
        let orchestrator = orchestrator.clone();
        let connection = connection.clone();
        let registry = Arc::clone(&registry);
        let frame = support::command_frame(&fixture.command);
        let reached_scan = Arc::clone(&reached_scan);
        let release_scan = Arc::clone(&release_scan);
        let scan_count = Arc::clone(&scan_count);
        tokio::spawn(async move {
            orchestrator
                .dispatch_workspace_list_with_executor(
                    &connection,
                    &frame,
                    &registry,
                    &WorkspaceListCancellation::default(),
                    |_| {},
                    move |admitted, cancellation| {
                        scan_count.fetch_add(1, Ordering::SeqCst);
                        reached_scan.wait();
                        release_scan.wait();
                        execute_admitted_workspace_list(admitted, cancellation)
                    },
                )
                .await
        })
    };
    reached_scan.wait();
    let takeover = support::newer_welcome(&fixture.welcome, "2026-08-08T00:00:35Z");
    let _new_connection = support::establish(fence, authorizer, &takeover, "2026-08-08T00:00:04Z");
    release_scan.wait();
    assert!(matches!(
        task.await
            .expect("join scan task")
            .expect("resolve epoch takeover"),
        NativeWorkspaceListDispatchOutcome::FreshResolved {
            terminal: crewon_device_protocol::DeviceWorkspaceListEvent::UnknownOutcome { .. },
            ..
        }
    ));
    assert_eq!(scan_count.load(Ordering::SeqCst), 1);
}
