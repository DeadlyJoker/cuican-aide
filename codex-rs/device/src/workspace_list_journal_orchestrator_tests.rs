use std::fs::File;
use std::sync::Arc;
use std::sync::Barrier;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use crewon_device_journal::DeviceWorkspaceJournal;
use pretty_assertions::assert_eq;

use super::NativeWorkspaceListDispatchOutcome;
use super::NativeWorkspaceListOrchestrator;
use crate::ConnectionEpochFence;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::workspace_list_dispatcher::execute_admitted_workspace_list;
use crate::workspace_list_journal_test_support as support;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn public_observer_sees_durable_accepted_before_handle_acquisition_and_scan() {
    let workspace = tempfile::tempdir().expect("temporary workspace");
    File::create(workspace.path().join("entry")).expect("workspace entry");
    let registry = Arc::new(WorkspaceDirectoryRegistry::new());
    let binding = registry
        .register("workspace-binding-1", workspace.path())
        .expect("register workspace");
    let fixture = support::signed_fixture(&binding, 102);
    let state = tempfile::tempdir().expect("Native state directory");
    let fence = Box::leak(Box::new(
        ConnectionEpochFence::open("device-1", state.path().join("epoch"))
            .expect("open epoch fence"),
    ));
    let authorizer = Box::leak(Box::new(support::authorizer(&fixture.signing_key)));
    let connection = support::establish(
        fence,
        authorizer,
        &fixture.welcome,
        "2026-08-08T00:00:03Z",
    );
    let journal = DeviceWorkspaceJournal::open(state.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let now = support::timestamp("2026-08-08T00:00:04Z");
    let orchestrator = NativeWorkspaceListOrchestrator::with_clock(journal.clone(), move || now);
    let observer_reached = Arc::new(Barrier::new(2));
    let release_observer = Arc::new(Barrier::new(2));
    let observed = Arc::new(Mutex::new(None));
    let task = {
        let orchestrator = orchestrator.clone();
        let connection = connection.clone();
        let registry = Arc::clone(&registry);
        let frame = support::command_frame(&fixture.command);
        let observer_reached = Arc::clone(&observer_reached);
        let release_observer = Arc::clone(&release_observer);
        let observed = Arc::clone(&observed);
        tokio::spawn(async move {
            orchestrator
                .dispatch_workspace_list_with_accepted_observer(
                    &connection,
                    &frame,
                    &registry,
                    &WorkspaceListCancellation::default(),
                    move |accepted| {
                        *observed.lock().expect("lock observed accepted") =
                            Some(accepted.clone());
                        observer_reached.wait();
                        release_observer.wait();
                    },
                )
                .await
        })
    };
    observer_reached.wait();

    let authority = journal
        .get_workspace_list(&fixture.command.execution_id)
        .await
        .expect("read journal while observer blocks")
        .expect("accepted authority is committed before observer");
    assert_eq!(
        observed.lock().expect("lock observed accepted").clone(),
        Some(authority.accepted.clone()),
    );
    assert_eq!(authority.terminal, None);
    release_observer.wait();
    assert!(matches!(
        task.await
            .expect("join observed dispatch")
            .expect("resolve observed dispatch"),
        NativeWorkspaceListDispatchOutcome::FreshResolved {
            terminal: crewon_device_protocol::DeviceWorkspaceListEvent::Completed { .. },
            ..
        }
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn accepted_is_durable_before_scan_and_same_process_replay_is_single_flight() {
    let workspace = tempfile::tempdir().expect("temporary workspace");
    File::create(workspace.path().join("entry")).expect("workspace entry");
    let registry = Arc::new(WorkspaceDirectoryRegistry::new());
    let binding = registry
        .register("workspace-binding-1", workspace.path())
        .expect("register workspace");
    let fixture = support::signed_fixture(&binding, 101);
    let state = tempfile::tempdir().expect("Native state directory");
    let fence = Box::leak(Box::new(
        ConnectionEpochFence::open("device-1", state.path().join("epoch"))
            .expect("open epoch fence"),
    ));
    let authorizer = Box::leak(Box::new(support::authorizer(&fixture.signing_key)));
    let connection = support::establish(
        fence,
        authorizer,
        &fixture.welcome,
        "2026-08-08T00:00:03Z",
    );
    let journal_path = state.path().join("journal.sqlite");
    let journal = DeviceWorkspaceJournal::open(&journal_path)
        .await
        .expect("open journal");
    let now = support::timestamp("2026-08-08T00:00:04Z");
    let orchestrator = NativeWorkspaceListOrchestrator::with_clock(journal.clone(), move || now);
    let independent_now = support::timestamp("2026-08-08T00:00:04Z");
    let independent =
        NativeWorkspaceListOrchestrator::with_clock(journal.clone(), move || independent_now);
    let command_frame = support::command_frame(&fixture.command);
    let reached_scan = Arc::new(Barrier::new(2));
    let release_scan = Arc::new(Barrier::new(2));
    let scan_count = Arc::new(AtomicUsize::new(0));
    let task = {
        let orchestrator = orchestrator.clone();
        let connection = connection.clone();
        let registry = Arc::clone(&registry);
        let command_frame = command_frame.clone();
        let reached_scan = Arc::clone(&reached_scan);
        let release_scan = Arc::clone(&release_scan);
        let scan_count = Arc::clone(&scan_count);
        tokio::spawn(async move {
            orchestrator
                .dispatch_workspace_list_with_executor(
                    &connection,
                    &command_frame,
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

    let accepted_only = journal
        .get_workspace_list(&fixture.command.execution_id)
        .await
        .expect("read journal while scan is blocked")
        .expect("accepted authority exists before scan completes");
    assert_eq!(accepted_only.terminal, None);
    assert!(matches!(
        independent
            .dispatch_workspace_list(
                &connection,
                &command_frame,
                &registry,
                &WorkspaceListCancellation::default(),
            )
            .await
            .expect("replay while original scan is in flight"),
        NativeWorkspaceListDispatchOutcome::AcceptedInFlight { .. }
    ));
    assert_eq!(scan_count.load(Ordering::SeqCst), 1);

    release_scan.wait();
    let outcome = task.await.expect("join scan task").expect("resolve scan");
    assert!(matches!(
        outcome,
        NativeWorkspaceListDispatchOutcome::FreshResolved {
            terminal: crewon_device_protocol::DeviceWorkspaceListEvent::Completed { .. },
            ..
        }
    ));
    assert!(
        journal
            .get_workspace_list(&fixture.command.execution_id)
            .await
            .expect("read completed journal")
            .expect("execution exists")
            .terminal
            .is_some()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn workspace_handle_contention_never_holds_the_journal_writer_or_blocks_ack() {
    let workspace = tempfile::tempdir().expect("temporary workspace");
    File::create(workspace.path().join("entry")).expect("workspace entry");
    let registry = Arc::new(WorkspaceDirectoryRegistry::new());
    let binding = registry
        .register("workspace-binding-1", workspace.path())
        .expect("register workspace");
    let fixture = support::signed_fixture(&binding, 201);
    let second_command = support::second_command(&fixture);
    let state = tempfile::tempdir().expect("Native state directory");
    let fence = Box::leak(Box::new(
        ConnectionEpochFence::open("device-1", state.path().join("epoch"))
            .expect("open epoch fence"),
    ));
    let authorizer = Box::leak(Box::new(support::authorizer(&fixture.signing_key)));
    let connection = support::establish(
        fence,
        authorizer,
        &fixture.welcome,
        "2026-08-08T00:00:03Z",
    );
    let journal = DeviceWorkspaceJournal::open(state.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let now = support::timestamp("2026-08-08T00:00:04Z");
    let orchestrator = NativeWorkspaceListOrchestrator::with_clock(journal.clone(), move || now);
    let first_scan = Arc::new(Barrier::new(2));
    let release_first = Arc::new(Barrier::new(2));
    let first_task = {
        let orchestrator = orchestrator.clone();
        let connection = connection.clone();
        let registry = Arc::clone(&registry);
        let frame = support::command_frame(&fixture.command);
        let first_scan = Arc::clone(&first_scan);
        let release_first = Arc::clone(&release_first);
        tokio::spawn(async move {
            orchestrator
                .dispatch_workspace_list_with_executor(
                    &connection,
                    &frame,
                    &registry,
                    &WorkspaceListCancellation::default(),
                    |_| {},
                    move |admitted, cancellation| {
                        first_scan.wait();
                        release_first.wait();
                        execute_admitted_workspace_list(admitted, cancellation)
                    },
                )
                .await
        })
    };
    first_scan.wait();
    let first = journal
        .get_workspace_list(&fixture.command.execution_id)
        .await
        .expect("load first accepted")
        .expect("first accepted exists");

    let second_accepted = Arc::new(Barrier::new(2));
    let release_second = Arc::new(Barrier::new(2));
    let second_task = {
        let orchestrator = orchestrator.clone();
        let connection = connection.clone();
        let registry = Arc::clone(&registry);
        let frame = support::command_frame(&second_command);
        let second_accepted = Arc::clone(&second_accepted);
        let release_second = Arc::clone(&release_second);
        tokio::spawn(async move {
            orchestrator
                .dispatch_workspace_list_with_executor(
                    &connection,
                    &frame,
                    &registry,
                    &WorkspaceListCancellation::default(),
                    move |_| {
                        second_accepted.wait();
                        release_second.wait();
                    },
                    execute_admitted_workspace_list,
                )
                .await
        })
    };
    second_accepted.wait();

    orchestrator
        .acknowledge(&support::ack(
            &first.accepted,
            1,
            "2026-08-08T00:00:05Z",
        ))
        .await
        .expect("ACK commits while second execution waits outside DB transaction");
    release_second.wait();
    assert!(matches!(
        second_task
            .await
            .expect("join second execution")
            .expect("resolve second execution"),
        NativeWorkspaceListDispatchOutcome::FreshResolved {
            terminal: crewon_device_protocol::DeviceWorkspaceListEvent::UnknownOutcome { .. },
            ..
        }
    ));

    release_first.wait();
    assert!(matches!(
        first_task
            .await
            .expect("join first execution")
            .expect("resolve first execution"),
        NativeWorkspaceListDispatchOutcome::FreshResolved {
            terminal: crewon_device_protocol::DeviceWorkspaceListEvent::Completed { .. },
            ..
        }
    ));
}
