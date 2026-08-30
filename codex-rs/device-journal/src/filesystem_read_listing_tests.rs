use crewon_device_protocol::DeviceFilesystemReadAck;
use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::canonical_device_filesystem_read_command_digest;
use pretty_assertions::assert_eq;

use crate::DeviceWorkspaceJournal;
use crate::FilesystemReadJournalListQuery;
use crate::filesystem_read_tests::event_envelope_mut;
use crate::filesystem_read_tests::fixture;

#[tokio::test]
async fn pages_unacknowledged_reads_in_utf8_execution_order_across_restart() {
    let directory = tempfile::tempdir().expect("temporary journal directory");
    let path = directory.path().join("device.sqlite");
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    for (id, state) in [("read-a", 0), ("read-b", 1), ("read-c", 2), ("read-d", 3)] {
        let (command, accepted, terminal, ack) = identified(id);
        journal
            .prepare_filesystem_read(&command, &accepted)
            .await
            .expect("prepare read");
        if state > 0 {
            journal
                .record_filesystem_read_terminal(&terminal)
                .await
                .expect("terminal");
        }
        if state == 2 {
            let mut accepted_ack = ack;
            accepted_ack.through_sequence = 1;
            accepted_ack.acknowledged_at = "2026-08-08T00:00:05Z".to_string();
            journal
                .acknowledge_filesystem_read(&accepted_ack)
                .await
                .expect("partial ACK");
        } else if state == 3 {
            journal
                .acknowledge_filesystem_read(&ack)
                .await
                .expect("full ACK");
        }
    }
    journal.close().await;
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen journal");
    let first = journal
        .list_unacknowledged_filesystem_reads(&FilesystemReadJournalListQuery {
            after_execution_id: None,
            limit: 2,
        })
        .await
        .expect("first page");
    assert_eq!(
        first
            .executions
            .iter()
            .map(|item| item.command.command.execution_id.as_str())
            .collect::<Vec<_>>(),
        ["read-a", "read-b"]
    );
    assert_eq!(first.next_cursor.as_deref(), Some("read-b"));
    let second = journal
        .list_unacknowledged_filesystem_reads(&FilesystemReadJournalListQuery {
            after_execution_id: first.next_cursor,
            limit: 2,
        })
        .await
        .expect("second page");
    assert_eq!(
        second
            .executions
            .iter()
            .map(|item| item.command.command.execution_id.as_str())
            .collect::<Vec<_>>(),
        ["read-c"]
    );
    assert_eq!(second.next_cursor, None);
    for invalid_limit in [0, crate::MAX_JOURNAL_PAGE_SIZE + 1] {
        assert_eq!(
            journal
                .list_unacknowledged_filesystem_reads(&FilesystemReadJournalListQuery {
                    after_execution_id: None,
                    limit: invalid_limit,
                })
                .await
                .expect_err("invalid page limit")
                .code(),
            "device_journal_query_invalid",
        );
    }
}

fn identified(
    id: &str,
) -> (
    DeviceFilesystemReadCommand,
    DeviceFilesystemReadEvent,
    DeviceFilesystemReadEvent,
    DeviceFilesystemReadAck,
) {
    let (mut command, mut accepted, mut terminal, mut ack) = fixture();
    command.command.execution_id = id.to_string();
    command.command.idempotency_key = format!("key-{id}");
    let digest = canonical_device_filesystem_read_command_digest(&command).expect("digest command");
    for event in [&mut accepted, &mut terminal] {
        let envelope = event_envelope_mut(event);
        envelope.execution_id = id.to_string();
        envelope.receipt_id = format!("receipt-{id}");
        envelope.command_digest = digest.clone();
    }
    ack.execution_id = id.to_string();
    ack.receipt_id = format!("receipt-{id}");
    ack.command_digest = digest;
    (command, accepted, terminal, ack)
}
