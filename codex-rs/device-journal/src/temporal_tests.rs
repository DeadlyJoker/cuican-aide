use pretty_assertions::assert_eq;

use super::DeviceWorkspaceJournal;
use super::AcknowledgeWorkspaceListOutcome;
use super::test_support;

#[tokio::test]
async fn rejects_accepted_outside_the_admitted_command_window() {
    let directory = tempfile::tempdir().expect("create journal test directory");
    let journal = DeviceWorkspaceJournal::open(directory.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    for observed_at in ["2026-08-07T23:59:59Z", "2026-08-08T01:00:01Z"] {
        let mut invalid = accepted.clone();
        if let crewon_device_protocol::DeviceWorkspaceListEvent::Accepted { envelope, .. } =
            &mut invalid
        {
            envelope.observed_at = observed_at.to_string();
        }
        assert_eq!(
            journal
                .prepare_workspace_list(&command, &invalid)
                .await
                .expect_err("accepted event must be inside command admission window")
                .code(),
            "device_journal_event_time_invalid",
        );
    }
    assert_eq!(
        journal
            .get_workspace_list(&command.execution_id)
            .await
            .expect("read after rejected acceptance"),
        None,
    );
}

#[tokio::test]
async fn rejects_terminal_and_ack_time_regressions() {
    let directory = tempfile::tempdir().expect("create journal test directory");
    let journal = DeviceWorkspaceJournal::open(directory.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("accept command");
    let mut early_ack = test_support::ack(&command, &accepted, 1);
    early_ack.acknowledged_at = "2026-08-08T00:00:00Z".to_string();
    assert_eq!(
        journal
            .acknowledge_workspace_list(&early_ack)
            .await
            .expect_err("ack cannot precede the event it covers")
            .code(),
        "device_journal_ack_time_invalid",
    );
    let mut early_terminal = test_support::completed(&command, &accepted);
    if let crewon_device_protocol::DeviceWorkspaceListEvent::Completed { envelope, .. } =
        &mut early_terminal
    {
        envelope.observed_at = "2026-08-08T00:00:00Z".to_string();
    }
    assert_eq!(
        journal
            .record_terminal(&early_terminal)
            .await
            .expect_err("terminal cannot precede accepted")
            .code(),
        "device_journal_event_time_invalid",
    );
    assert_eq!(
        journal
            .get_workspace_list(&command.execution_id)
            .await
            .expect("authority remains accepted-only after rejected terminal")
            .expect("accepted authority exists")
            .terminal,
        None,
    );
}

#[tokio::test]
async fn cumulative_ack_can_jump_to_terminal_but_never_backfill_or_change_identity() {
    let directory = tempfile::tempdir().expect("create journal test directory");
    let journal = DeviceWorkspaceJournal::open(directory.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let (command, accepted) = test_support::authority(1);
    journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("accept command");
    journal
        .record_terminal(&test_support::completed(&command, &accepted))
        .await
        .expect("record terminal");
    let ack_two = test_support::ack(&command, &accepted, 2);
    assert!(matches!(
        journal
            .acknowledge_workspace_list(&ack_two)
            .await
            .expect("cumulative ACK two covers both events"),
        AcknowledgeWorkspaceListOutcome::Advanced(_)
    ));
    assert_eq!(
        journal
            .acknowledge_workspace_list(&test_support::ack(&command, &accepted, 1))
            .await
            .expect_err("cumulative head cannot be backfilled")
            .code(),
        "device_journal_ack_backward",
    );
    let mut forged = ack_two;
    forged.runtime_binding_id = "other-runtime-binding".to_string();
    assert_eq!(
        journal
            .acknowledge_workspace_list(&forged)
            .await
            .expect_err("ACK identity cannot be substituted")
            .code(),
        "device_journal_identity_mismatch",
    );
}
