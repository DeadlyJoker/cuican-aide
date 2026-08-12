use std::fs;

use crewon_device_protocol::DeviceAcceptedData;
use crewon_device_protocol::DeviceExecutionAck;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::DeviceExecutionEventEnvelope;
use crewon_device_protocol::DeviceUnknownOutcomeData;
use crewon_device_protocol::parse_device_execution_command;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde_json::Value;
use tempfile::TempDir;

use crate::AcknowledgeToolOutcome;
use crate::DeviceWorkspaceJournal;
use crate::PrepareToolOutcome;
use crate::RecordToolTerminalOutcome;
use crate::ToolJournalListQuery;

#[derive(Deserialize)]
struct Reference {
    valid: ValidReference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidReference {
    filesystem_read_command: Value,
}

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

fn command() -> DeviceExecutionCommand {
    let path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("fixture");
    let fixture: Reference = serde_json::from_str(&fs::read_to_string(path).expect("read fixture"))
        .expect("parse fixture");
    parse_device_execution_command(fixture.valid.filesystem_read_command).expect("parse command")
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
