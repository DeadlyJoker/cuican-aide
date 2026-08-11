use crewon_device_protocol::DeviceFilesystemReadAck;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::parse_device_filesystem_read_ack;
use crewon_device_protocol::parse_device_filesystem_read_command;
use crewon_device_protocol::parse_device_filesystem_read_event;
use pretty_assertions::assert_eq;
use serde_json::Value;

use crate::AcknowledgeFilesystemReadOutcome;
use crate::DeviceWorkspaceJournal;
use crate::PrepareFilesystemReadOutcome;
use crate::RecordFilesystemReadTerminalOutcome;

#[tokio::test]
async fn persists_read_accept_terminal_and_cumulative_ack_across_restart() {
    let directory = tempfile::tempdir().expect("temporary journal directory");
    let path = directory.path().join("device.sqlite");
    let (command, accepted, terminal, ack) = fixture();
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    let PrepareFilesystemReadOutcome::New(prepared) = journal
        .prepare_filesystem_read(&command, &accepted)
        .await
        .expect("commit accepted before execution")
    else {
        panic!("expected new read execution");
    };
    assert_eq!(prepared.terminal, None);
    journal.close().await;

    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen journal");
    assert!(matches!(
        journal
            .prepare_filesystem_read(&command, &accepted)
            .await
            .expect("replay accepted"),
        PrepareFilesystemReadOutcome::AcceptedReplay(_)
    ));
    assert!(matches!(
        journal
            .record_filesystem_read_terminal(&terminal)
            .await
            .expect("commit terminal"),
        RecordFilesystemReadTerminalOutcome::Committed(_)
    ));
    let AcknowledgeFilesystemReadOutcome::Advanced(acknowledged) = journal
        .acknowledge_filesystem_read(&ack)
        .await
        .expect("commit cumulative ACK")
    else {
        panic!("expected advanced ACK");
    };
    assert_eq!(acknowledged.acknowledged_through, 2);
    journal.close().await;

    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen terminal journal");
    let execution = journal
        .get_filesystem_read(&command.command.execution_id)
        .await
        .expect("read durable execution")
        .expect("execution exists");
    assert_eq!(execution.command, command);
    assert_eq!(execution.accepted, accepted);
    assert_eq!(execution.terminal, Some(terminal.clone()));
    assert_eq!(execution.acknowledged_through, 2);
    assert!(matches!(
        journal
            .record_filesystem_read_terminal(&terminal)
            .await
            .expect("terminal replay"),
        RecordFilesystemReadTerminalOutcome::Replayed(_)
    ));
}

#[tokio::test]
async fn rejects_command_terminal_and_ack_identity_drift() {
    let directory = tempfile::tempdir().expect("temporary journal directory");
    let path = directory.path().join("device.sqlite");
    let (command, accepted, terminal, ack) = fixture();
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    journal
        .prepare_filesystem_read(&command, &accepted)
        .await
        .expect("prepare read");

    let mut changed_command = command.clone();
    changed_command.arguments.relative_path_segments = vec!["other.txt".to_string()];
    assert_eq!(
        journal
            .prepare_filesystem_read(&changed_command, &accepted)
            .await
            .expect_err("command drift fails closed")
            .code(),
        "device_journal_filesystem_read_command_conflict",
    );
    let mut changed_terminal = terminal.clone();
    event_envelope_mut(&mut changed_terminal).connection_epoch += 1;
    assert_eq!(
        journal
            .record_filesystem_read_terminal(&changed_terminal)
            .await
            .expect_err("terminal identity drift fails closed")
            .code(),
        "device_journal_filesystem_read_identity_mismatch",
    );
    journal
        .record_filesystem_read_terminal(&terminal)
        .await
        .expect("commit terminal");
    let mut changed_ack = ack;
    changed_ack.command_digest = format!("sha256:{}", "d".repeat(64));
    assert_eq!(
        journal
            .acknowledge_filesystem_read(&changed_ack)
            .await
            .expect_err("ACK identity drift fails closed")
            .code(),
        "device_journal_filesystem_read_ack_invalid",
    );
}

#[tokio::test]
async fn rejects_backward_ack_time_regression_and_redundant_column_corruption() {
    let directory = tempfile::tempdir().expect("temporary journal directory");
    let path = directory.path().join("device.sqlite");
    let (command, accepted, terminal, mut ack) = fixture();
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    journal
        .prepare_filesystem_read(&command, &accepted)
        .await
        .expect("prepare");
    journal
        .record_filesystem_read_terminal(&terminal)
        .await
        .expect("terminal");
    ack.acknowledged_at = "2026-08-08T00:00:02Z".to_string();
    assert_eq!(
        journal
            .acknowledge_filesystem_read(&ack)
            .await
            .expect_err("ACK before event")
            .code(),
        "device_journal_filesystem_read_ack_time_invalid"
    );
    ack.acknowledged_at = "2026-08-08T00:00:05Z".to_string();
    journal
        .acknowledge_filesystem_read(&ack)
        .await
        .expect("ACK terminal");
    let mut backward = ack.clone();
    backward.through_sequence = 1;
    assert_eq!(
        journal
            .acknowledge_filesystem_read(&backward)
            .await
            .expect_err("backward ACK")
            .code(),
        "device_journal_filesystem_read_ack_backward"
    );
    let mut drift = ack.clone();
    drift.receipt_id = "other-receipt".to_string();
    assert_eq!(
        journal
            .acknowledge_filesystem_read(&drift)
            .await
            .expect_err("same sequence drift")
            .code(),
        "device_journal_filesystem_read_ack_invalid"
    );
    journal.close().await;

    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path);
    let pool = sqlx::SqlitePool::connect_with(options)
        .await
        .expect("raw pool");
    sqlx::query("UPDATE filesystem_read_acks SET acknowledged_at = ? WHERE execution_id = ?")
        .bind("2026-08-08T00:00:06Z")
        .bind(&command.command.execution_id)
        .execute(&pool)
        .await
        .expect("corrupt redundant ACK time");
    pool.close().await;
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen schema");
    assert_eq!(
        journal
            .get_filesystem_read(&command.command.execution_id)
            .await
            .expect_err("redundant column corruption")
            .code(),
        "device_journal_authority_corrupt"
    );
}

#[tokio::test]
async fn rejects_unbounded_or_path_like_execution_lookup() {
    let directory = tempfile::tempdir().expect("temporary journal directory");
    let journal = DeviceWorkspaceJournal::open(directory.path().join("device.sqlite"))
        .await
        .expect("open journal");
    for invalid in ["../escape", &"x".repeat(513)] {
        assert_eq!(
            journal
                .get_filesystem_read(invalid)
                .await
                .expect_err("invalid execution id")
                .code(),
            "device_journal_execution_id_invalid",
        );
    }
}

pub(crate) fn fixture() -> (
    crewon_device_protocol::DeviceFilesystemReadCommand,
    DeviceFilesystemReadEvent,
    DeviceFilesystemReadEvent,
    DeviceFilesystemReadAck,
) {
    let path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve shared fixture");
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read shared fixture"))
            .expect("parse shared fixture");
    let valid = &fixture["valid"];
    (
        parse_device_filesystem_read_command(valid["filesystemReadCommand"].clone())
            .expect("parse command"),
        parse_device_filesystem_read_event(valid["filesystemReadEvents"][0].clone())
            .expect("parse accepted"),
        parse_device_filesystem_read_event(valid["filesystemReadEvents"][1].clone())
            .expect("parse terminal"),
        parse_device_filesystem_read_ack(valid["filesystemReadAck"].clone()).expect("parse ACK"),
    )
}

pub(crate) fn event_envelope_mut(
    event: &mut DeviceFilesystemReadEvent,
) -> &mut crewon_device_protocol::DeviceFilesystemReadEventEnvelope {
    match event {
        DeviceFilesystemReadEvent::Accepted { envelope, .. }
        | DeviceFilesystemReadEvent::Completed { envelope, .. }
        | DeviceFilesystemReadEvent::Failed { envelope, .. }
        | DeviceFilesystemReadEvent::Canceled { envelope, .. }
        | DeviceFilesystemReadEvent::UnknownOutcome { envelope, .. } => envelope,
    }
}
