use std::fs;

use crewon_device_protocol::DeviceAcceptedData;
use crewon_device_protocol::DeviceExecutionAck;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::DeviceExecutionEventEnvelope;
use crewon_device_protocol::DeviceUnknownOutcomeData;
use crewon_device_protocol::parse_device_execution_command;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use crate::AcknowledgeToolOutcome;
use crate::DeviceWorkspaceJournal;
use crate::PrepareToolOutcome;
use crate::RecordToolTerminalOutcome;
use crate::ToolJournalListQuery;

#[tokio::test]
async fn accepted_and_terminal_are_durable_before_ack_and_replay_exactly() {
    let directory = TempDir::new().expect("journal directory");
    let path = directory.path().join("journal.sqlite");
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    let command = command();
    let accepted = accepted(&command);
    let prepared = journal
        .prepare_tool_with_admission(&command, || Ok::<_, ()>((accepted.clone(), "permit")))
        .await
        .expect("prepare");
    let PrepareToolOutcome::New {
        execution,
        admitted,
    } = prepared
    else {
        panic!("fresh prepare required");
    };
    assert_eq!(admitted, "permit");
    assert_eq!(execution.accepted, accepted);
    let terminal = unknown(&accepted);
    assert!(matches!(
        journal
            .record_tool_terminal(&terminal)
            .await
            .expect("terminal"),
        RecordToolTerminalOutcome::Committed(_)
    ));
    let replay = journal
        .prepare_tool_with_admission(&command, || -> Result<(DeviceExecutionEvent, ()), ()> {
            panic!("replay must not admit")
        })
        .await
        .expect("replay");
    let PrepareToolOutcome::TerminalReplay(replayed) = replay else {
        panic!("terminal replay required");
    };
    assert_eq!(replayed.terminal, Some(terminal.clone()));
    let ack = ack(&terminal, 2);
    assert!(matches!(
        journal.acknowledge_tool(&ack).await.expect("ack"),
        AcknowledgeToolOutcome::Advanced(_)
    ));
    assert!(matches!(
        journal.acknowledge_tool(&ack).await.expect("ack replay"),
        AcknowledgeToolOutcome::Replayed(_)
    ));
    journal.close().await;

    let reopened = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen journal");
    assert!(
        reopened
            .list_unacknowledged_tools(&ToolJournalListQuery {
                after_execution_id: None,
                limit: 10
            })
            .await
            .expect("list")
            .executions
            .is_empty()
    );
}

#[tokio::test]
async fn accepted_only_restart_is_listed_without_invoking_admission() {
    let directory = TempDir::new().expect("journal directory");
    let path = directory.path().join("journal.sqlite");
    let command = command();
    let accepted = accepted(&command);
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    journal
        .prepare_tool_with_admission(&command, || Ok::<_, ()>((accepted.clone(), ())))
        .await
        .expect("prepare");
    journal.close().await;
    let reopened = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen journal");
    let replay = reopened
        .prepare_tool_with_admission(&command, || -> Result<(DeviceExecutionEvent, ()), ()> {
            panic!("accepted replay must not admit")
        })
        .await
        .expect("accepted replay");
    assert!(matches!(replay, PrepareToolOutcome::AcceptedReplay(_)));
    let page = reopened
        .list_unacknowledged_tools(&ToolJournalListQuery {
            after_execution_id: None,
            limit: 10,
        })
        .await
        .expect("list");
    assert_eq!(page.executions.len(), 1);
    assert_eq!(page.executions[0].terminal, None);
}

#[tokio::test]
async fn duplicate_execution_with_changed_digest_or_binding_fails_closed() {
    let directory = TempDir::new().expect("journal directory");
    let journal = DeviceWorkspaceJournal::open(directory.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let command = command();
    journal
        .prepare_tool_with_admission(&command, || Ok::<_, ()>((accepted(&command), ())))
        .await
        .expect("prepare");
    let mut changed = command.clone();
    changed.action_digest =
        "sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd".to_string();
    let error = journal
        .prepare_tool_with_admission(&changed, || Ok::<_, ()>((accepted(&changed), ())))
        .await
        .expect_err("digest conflict");
    let crate::PrepareToolError::Journal(error) = error else {
        panic!("journal conflict required");
    };
    assert_eq!(error.code(), "device_tool_command_conflict");
    let mut changed = command.clone();
    changed.workspace_binding_id = "workspace-other".to_string();
    let error = journal
        .prepare_tool_with_admission(&changed, || Ok::<_, ()>((accepted(&changed), ())))
        .await
        .expect_err("binding conflict");
    let crate::PrepareToolError::Journal(error) = error else {
        panic!("journal conflict required");
    };
    assert_eq!(error.code(), "device_tool_command_conflict");
}

#[tokio::test]
async fn accepted_receipt_is_globally_unique() {
    let directory = TempDir::new().expect("journal directory");
    let journal = DeviceWorkspaceJournal::open(directory.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let first = command();
    journal
        .prepare_tool_with_admission(&first, || Ok::<_, ()>((accepted(&first), ())))
        .await
        .expect("first receipt owner");
    let mut second = first.clone();
    second.execution_id = "execution-filesystem-2".to_string();
    let error = journal
        .prepare_tool_with_admission(&second, || Ok::<_, ()>((accepted(&second), ())))
        .await
        .expect_err("receipt conflict");
    let crate::PrepareToolError::Journal(error) = error else {
        panic!("journal conflict required");
    };
    assert_eq!(error.code(), "device_tool_receipt_conflict");
}

#[tokio::test]
async fn rejects_terminal_and_ack_time_regressions() {
    let directory = TempDir::new().expect("journal directory");
    let journal = DeviceWorkspaceJournal::open(directory.path().join("journal.sqlite"))
        .await
        .expect("open journal");
    let command = command();
    let accepted = accepted(&command);
    journal
        .prepare_tool_with_admission(&command, || Ok::<_, ()>((accepted.clone(), ())))
        .await
        .expect("prepare");
    let mut terminal = unknown(&accepted);
    event_envelope_mut(&mut terminal).observed_at = "2026-08-08T00:00:00Z".to_string();
    assert_eq!(
        journal
            .record_tool_terminal(&terminal)
            .await
            .expect_err("terminal before accepted")
            .code(),
        "device_tool_terminal_invalid",
    );
    let terminal = unknown(&accepted);
    journal
        .record_tool_terminal(&terminal)
        .await
        .expect("terminal");
    let mut early = ack(&terminal, 2);
    early.acknowledged_at = "2026-08-08T00:00:01Z".to_string();
    assert_eq!(
        journal
            .acknowledge_tool(&early)
            .await
            .expect_err("ACK before terminal")
            .code(),
        "device_tool_ack_time_invalid",
    );
}

#[tokio::test]
async fn fails_closed_on_redundant_event_and_ack_corruption() {
    let directory = TempDir::new().expect("journal directory");
    let path = directory.path().join("journal.sqlite");
    let command = command();
    let accepted = accepted(&command);
    let terminal = unknown(&accepted);
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("open journal");
    journal
        .prepare_tool_with_admission(&command, || Ok::<_, ()>((accepted, ())))
        .await
        .expect("prepare");
    journal
        .record_tool_terminal(&terminal)
        .await
        .expect("terminal");
    journal
        .acknowledge_tool(&ack(&terminal, 2))
        .await
        .expect("ACK");
    journal.close().await;
    let pool = raw_pool(&path).await;
    sqlx::query("UPDATE tool_events SET observed_at = ? WHERE execution_id = ? AND sequence = 2")
        .bind("2026-08-08T00:00:09Z")
        .bind(&command.execution_id)
        .execute(&pool)
        .await
        .expect("corrupt event column");
    pool.close().await;
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen schema");
    assert_eq!(
        journal
            .get_tool(&command.execution_id)
            .await
            .expect_err("event corruption")
            .code(),
        "device_journal_authority_corrupt",
    );
    journal.close().await;

    let pool = raw_pool(&path).await;
    sqlx::query("UPDATE tool_events SET observed_at = ? WHERE execution_id = ? AND sequence = 2")
        .bind("2026-08-08T00:00:02Z")
        .bind(&command.execution_id)
        .execute(&pool)
        .await
        .expect("restore event column");
    sqlx::query("UPDATE tool_acks SET acknowledged_at = ? WHERE execution_id = ?")
        .bind("2026-08-08T00:00:09Z")
        .bind(&command.execution_id)
        .execute(&pool)
        .await
        .expect("corrupt ACK column");
    pool.close().await;
    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("reopen schema");
    assert_eq!(
        journal
            .get_tool(&command.execution_id)
            .await
            .expect_err("tool projection must validate ACK authority")
            .code(),
        "device_journal_authority_corrupt",
    );
}

#[tokio::test]
async fn schema_rejects_non_sha256_fingerprint_and_missing_tool_index() {
    let directory = TempDir::new().expect("journal directory");
    let path = directory.path().join("journal.sqlite");
    DeviceWorkspaceJournal::open(&path)
        .await
        .expect("create schema")
        .close()
        .await;
    let pool = raw_pool(&path).await;
    let error = sqlx::query("INSERT INTO tool_executions (execution_id, command_json, command_fingerprint, device_id, capability, lease_id, lease_epoch, action_digest, created_at) VALUES ('execution-forged', '{}', 'sha256:INVALID', 'device-1', 'workspace.read', 'lease-1', 1, ?, '2026-08-08T00:00:01Z')")
        .bind(format!("sha256:{}", "a".repeat(64)))
        .execute(&pool)
        .await
        .expect_err("fingerprint CHECK");
    assert!(error.to_string().contains("CHECK constraint failed"));
    sqlx::query("DROP INDEX tool_events_accepted_receipt_idx")
        .execute(&pool)
        .await
        .expect("drop authority index");
    pool.close().await;
    assert_eq!(
        DeviceWorkspaceJournal::open(path)
            .await
            .err()
            .expect("missing index")
            .code(),
        "device_journal_schema_corrupt",
    );
}

fn command() -> DeviceExecutionCommand {
    let path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("fixture");
    let fixture: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).expect("read fixture"))
            .expect("parse fixture");
    parse_device_execution_command(fixture["valid"]["filesystemReadCommand"].clone())
        .expect("parse command")
}

fn accepted(command: &DeviceExecutionCommand) -> DeviceExecutionEvent {
    DeviceExecutionEvent::Accepted {
        envelope: envelope(command, "receipt-1", 1),
        data: DeviceAcceptedData {
            lease_epoch: command.lease_epoch,
            action_digest: command.action_digest.clone(),
        },
    }
}

fn unknown(accepted: &DeviceExecutionEvent) -> DeviceExecutionEvent {
    let DeviceExecutionEvent::Accepted { envelope, .. } = accepted else {
        panic!("accepted")
    };
    DeviceExecutionEvent::UnknownOutcome {
        envelope: DeviceExecutionEventEnvelope {
            sequence: 2,
            observed_at: "2026-08-08T00:00:02Z".to_string(),
            ..envelope.clone()
        },
        data: DeviceUnknownOutcomeData {
            provider_receipt_id: None,
        },
    }
}

fn envelope(
    command: &DeviceExecutionCommand,
    receipt_id: &str,
    sequence: u64,
) -> DeviceExecutionEventEnvelope {
    DeviceExecutionEventEnvelope {
        schema_version: "crewon.device-event.v0".to_string(),
        protocol_version: 1,
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        receipt_id: receipt_id.to_string(),
        sequence,
        observed_at: format!("2026-08-08T00:00:0{sequence}Z"),
    }
}

fn ack(event: &DeviceExecutionEvent, through_sequence: u64) -> DeviceExecutionAck {
    let envelope = match event {
        DeviceExecutionEvent::UnknownOutcome { envelope, .. } => envelope,
        _ => panic!("terminal"),
    };
    DeviceExecutionAck {
        schema_version: "crewon.device-ack.v0".to_string(),
        protocol_version: 1,
        device_id: envelope.device_id.clone(),
        execution_id: envelope.execution_id.clone(),
        through_sequence,
        acknowledged_at: "2026-08-08T00:00:03Z".to_string(),
    }
}

fn event_envelope_mut(event: &mut DeviceExecutionEvent) -> &mut DeviceExecutionEventEnvelope {
    match event {
        DeviceExecutionEvent::Accepted { envelope, .. }
        | DeviceExecutionEvent::Output { envelope, .. }
        | DeviceExecutionEvent::Completed { envelope, .. }
        | DeviceExecutionEvent::Failed { envelope, .. }
        | DeviceExecutionEvent::Canceled { envelope, .. }
        | DeviceExecutionEvent::UnknownOutcome { envelope, .. } => envelope,
    }
}

async fn raw_pool(path: &std::path::Path) -> sqlx::SqlitePool {
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path);
    sqlx::SqlitePool::connect_with(options)
        .await
        .expect("raw pool")
}
