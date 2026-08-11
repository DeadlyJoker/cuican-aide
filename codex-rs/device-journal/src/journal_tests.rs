use std::path::Path;

use pretty_assertions::assert_eq;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;

use super::AcknowledgeWorkspaceListOutcome;
use super::DeviceWorkspaceJournal;
use super::PrepareWorkspaceListOutcome;
use super::RecordTerminalOutcome;
use super::WorkspaceJournalAcknowledgement;
use super::WorkspaceJournalListQuery;
use super::test_support;

fn database() -> (TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().expect("create journal test directory");
    let path = directory.path().join("device-journal.sqlite");
    (directory, path)
}

#[tokio::test]
async fn commits_accepted_before_the_external_execution_barrier_and_reopens_crash_state() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);

    let outcome = journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("durably accept command");
    let PrepareWorkspaceListOutcome::New(expected) = outcome else {
        panic!("fresh command must be new");
    };

    let independent = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open independent journal before any scan");
    assert_eq!(
        independent
            .get_workspace_list(&command.execution_id)
            .await
            .expect("load accepted authority"),
        Some(expected.clone()),
    );
    assert_eq!(expected.terminal, None);
    journal.close().await;
    independent.close().await;

    let reopened = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen after simulated crash");
    assert_eq!(
        reopened
            .prepare_workspace_list(&command, &accepted)
            .await
            .expect("replay accepted command"),
        PrepareWorkspaceListOutcome::AcceptedReplay(expected),
    );
}

#[tokio::test]
async fn replays_terminal_before_ack_across_process_reopen() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    let terminal = test_support::completed(&command, &accepted);
    journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("accept command");
    let RecordTerminalOutcome::Committed(expected) = journal
        .record_terminal(&terminal)
        .await
        .expect("commit terminal")
    else {
        panic!("fresh terminal must commit");
    };
    journal.close().await;

    let reopened = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen journal");
    assert_eq!(
        reopened
            .prepare_workspace_list(&command, &accepted)
            .await
            .expect("replay command with terminal"),
        PrepareWorkspaceListOutcome::TerminalReplay(expected.clone()),
    );
    assert_eq!(
        reopened
            .record_terminal(&terminal)
            .await
            .expect("replay terminal"),
        RecordTerminalOutcome::Replayed(expected),
    );
}

#[tokio::test]
async fn exact_expired_command_replays_without_repeating_temporal_admission() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(path)
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("accept structurally valid historical command");

    assert!(matches!(
        journal
            .prepare_workspace_list(&command, &accepted)
            .await
            .expect("journal replay does not apply wall-clock expiry"),
        PrepareWorkspaceListOutcome::AcceptedReplay(_)
    ));
}

#[tokio::test]
async fn rejects_changed_signed_command_accepted_and_terminal_records() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(path)
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("accept command");

    let mut changed_command = command.clone();
    changed_command.authorization.signature = "B".repeat(86);
    assert_eq!(
        journal
            .prepare_workspace_list(&changed_command, &accepted)
            .await
            .expect_err("signed command substitution must conflict")
            .code(),
        "device_journal_command_conflict",
    );
    let mut changed_accepted = accepted.clone();
    if let crewon_device_protocol::DeviceWorkspaceListEvent::Accepted { envelope, .. } =
        &mut changed_accepted
    {
        envelope.observed_at = "2026-08-08T00:00:09Z".to_string();
    }
    assert_eq!(
        journal
            .prepare_workspace_list(&command, &changed_accepted)
            .await
            .expect_err("accepted event substitution must conflict")
            .code(),
        "device_journal_accepted_conflict",
    );
    journal
        .record_terminal(&test_support::completed(&command, &accepted))
        .await
        .expect("commit terminal");
    assert_eq!(
        journal
            .record_terminal(&test_support::failed(&command, &accepted))
            .await
            .expect_err("changed terminal must conflict")
            .code(),
        "device_journal_terminal_conflict",
    );
}

#[tokio::test]
async fn enforces_global_accepted_receipt_identity() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(path)
        .await
        .expect("open journal");
    let (first_command, first_accepted) = test_support::authority(1);
    let (second_command, mut second_accepted) = test_support::authority(2);
    journal
        .prepare_workspace_list(&first_command, &first_accepted)
        .await
        .expect("accept first command");
    test_support::set_receipt_id(&mut second_accepted, "workspace-receipt-001".to_string());
    assert_eq!(
        journal
            .prepare_workspace_list(&second_command, &second_accepted)
            .await
            .expect_err("accepted receipt cannot identify two executions")
            .code(),
        "device_journal_accepted_receipt_conflict",
    );
}

#[tokio::test]
async fn makes_ack_identity_exact_monotonic_and_durable() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    let ack_one = test_support::ack(&command, &accepted, 1);
    let ack_two = test_support::ack(&command, &accepted, 2);
    journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("accept command");
    assert_eq!(
        journal
            .acknowledge_workspace_list(&ack_two)
            .await
            .expect_err("cannot acknowledge an absent terminal")
            .code(),
        "device_journal_ack_event_missing",
    );
    assert!(matches!(
        journal
            .acknowledge_workspace_list(&ack_one)
            .await
            .expect("ack accepted event"),
        AcknowledgeWorkspaceListOutcome::Advanced(_)
    ));
    assert!(matches!(
        journal
            .acknowledge_workspace_list(&ack_one)
            .await
            .expect("repeat exact ack"),
        AcknowledgeWorkspaceListOutcome::Replayed(_)
    ));
    journal
        .record_terminal(&test_support::completed(&command, &accepted))
        .await
        .expect("commit terminal");
    let AcknowledgeWorkspaceListOutcome::Advanced(expected) = journal
        .acknowledge_workspace_list(&ack_two)
        .await
        .expect("ack terminal")
    else {
        panic!("ack two must advance");
    };
    assert_eq!(
        journal
            .acknowledge_workspace_list(&ack_one)
            .await
            .expect_err("ack cannot move backward")
            .code(),
        "device_journal_ack_backward",
    );
    let mut forged = ack_two.clone();
    forged.acknowledged_at = "2026-08-08T00:00:09Z".to_string();
    assert!(matches!(
        journal
            .acknowledge_workspace_list(&forged)
            .await
            .expect("same durable ACK identity may retry with a later local timestamp"),
        AcknowledgeWorkspaceListOutcome::Replayed(_)
    ));
    let mut earlier = ack_two.clone();
    earlier.acknowledged_at = "2026-08-08T00:00:04Z".to_string();
    assert_eq!(
        journal
            .acknowledge_workspace_list(&earlier)
            .await
            .expect_err("retry timestamp cannot precede the first durable ACK")
            .code(),
        "device_journal_ack_time_invalid",
    );
    journal.close().await;
    let reopened = DeviceWorkspaceJournal::open(path)
        .await
        .expect("reopen journal");
    assert_eq!(
        reopened
            .get_workspace_list(&command.execution_id)
            .await
            .expect("read acknowledged authority"),
        Some(expected),
    );
}

#[tokio::test]
async fn pages_unacknowledged_authority_with_a_strict_bound_and_cursor() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(path)
        .await
        .expect("open journal");
    for suffix in 1..=3 {
        let (command, accepted) = test_support::authority(suffix);
        journal
            .prepare_workspace_list(&command, &accepted)
            .await
            .expect("accept page fixture");
    }
    let first = journal
        .list_unacknowledged_workspace_lists(&WorkspaceJournalListQuery {
            after_execution_id: None,
            limit: 2,
        })
        .await
        .expect("load first bounded page");
    assert_eq!(
        first
            .executions
            .iter()
            .map(|execution| execution.command.execution_id.as_str())
            .collect::<Vec<_>>(),
        vec!["workspace-execution-001", "workspace-execution-002"],
    );
    assert_eq!(
        first.next_cursor.as_deref(),
        Some("workspace-execution-002")
    );
    let second = journal
        .list_unacknowledged_workspace_lists(&WorkspaceJournalListQuery {
            after_execution_id: first.next_cursor,
            limit: 2,
        })
        .await
        .expect("load second bounded page");
    assert_eq!(second.executions.len(), 1);
    assert_eq!(second.next_cursor, None);
    assert_eq!(
        journal
            .list_unacknowledged_workspace_lists(&WorkspaceJournalListQuery {
                after_execution_id: None,
                limit: 101,
            })
            .await
            .expect_err("reject an unbounded Hello page")
            .code(),
        "device_journal_query_invalid",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_same_execution_has_one_durable_winner() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(path)
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    let first = journal.clone();
    let second = journal.clone();
    let (left, right) = tokio::join!(
        first.prepare_workspace_list(&command, &accepted),
        second.prepare_workspace_list(&command, &accepted),
    );
    let outcomes = [left.expect("first prepare"), right.expect("second prepare")];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, PrepareWorkspaceListOutcome::New(_)))
            .count(),
        1,
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, PrepareWorkspaceListOutcome::AcceptedReplay(_)))
            .count(),
        1,
    );
}

#[tokio::test]
async fn pages_only_positive_acknowledgement_heads_for_hello_projection() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(path)
        .await
        .expect("open journal");
    let (unacknowledged_command, unacknowledged) = test_support::authority(1);
    journal
        .prepare_workspace_list(&unacknowledged_command, &unacknowledged)
        .await
        .expect("prepare unacknowledged execution");
    for suffix in [2, 3] {
        let (command, accepted) = test_support::authority(suffix);
        journal
            .prepare_workspace_list(&command, &accepted)
            .await
            .expect("prepare acknowledged execution");
        journal
            .acknowledge_workspace_list(&test_support::ack(&command, &accepted, 1))
            .await
            .expect("advance acknowledgement");
    }

    let first = journal
        .list_workspace_list_acknowledgements(&WorkspaceJournalListQuery {
            after_execution_id: None,
            limit: 1,
        })
        .await
        .expect("first acknowledgement page");
    assert_eq!(
        first.acknowledgements,
        vec![WorkspaceJournalAcknowledgement {
            execution_id: "workspace-execution-002".to_string(),
            through_sequence: 1,
        }]
    );
    assert_eq!(
        first.next_cursor,
        Some("workspace-execution-002".to_string())
    );
    assert_eq!(
        journal
            .list_workspace_list_acknowledgements(&WorkspaceJournalListQuery {
                after_execution_id: first.next_cursor,
                limit: 1,
            })
            .await
            .expect("second acknowledgement page")
            .acknowledgements,
        vec![WorkspaceJournalAcknowledgement {
            execution_id: "workspace-execution-003".to_string(),
            through_sequence: 1,
        }]
    );
}

#[tokio::test]
async fn fails_closed_on_row_corruption_and_newer_schema() {
    let (_directory, path) = database();
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("accept command");
    journal.close().await;
    let pool = raw_pool(&path).await;
    sqlx::query(
        "UPDATE workspace_events SET runtime_binding_id = 'forged-runtime' WHERE sequence = 1",
    )
    .execute(&pool)
    .await
    .expect("inject column versus JSON corruption");
    pool.close().await;
    let reopened = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("schema remains valid");
    assert_eq!(
        reopened
            .get_workspace_list(&command.execution_id)
            .await
            .expect_err("row corruption must fail closed")
            .code(),
        "device_journal_authority_corrupt",
    );
    reopened.close().await;
    let pool = raw_pool(&path).await;
    sqlx::query("UPDATE device_journal_schema SET version = 3 WHERE singleton = 1")
        .execute(&pool)
        .await
        .expect("inject newer schema version");
    pool.close().await;
    assert_eq!(
        DeviceWorkspaceJournal::open(path)
            .await
            .err()
            .expect("newer schema must fail closed")
            .code(),
        "device_journal_schema_unsupported",
    );
}

#[tokio::test]
async fn rejects_a_versioned_schema_missing_the_receipt_unique_authority() {
    let (_directory, path) = database();
    DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal")
        .close()
        .await;
    let pool = raw_pool(&path).await;
    sqlx::query("DROP INDEX workspace_events_accepted_receipt_idx")
        .execute(&pool)
        .await
        .expect("corrupt schema authority");
    pool.close().await;
    assert_eq!(
        DeviceWorkspaceJournal::open(path)
            .await
            .err()
            .expect("missing authority index must fail closed")
            .code(),
        "device_journal_schema_corrupt",
    );
}

async fn raw_pool(path: &Path) -> sqlx::SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(path))
        .await
        .expect("open raw journal pool")
}
