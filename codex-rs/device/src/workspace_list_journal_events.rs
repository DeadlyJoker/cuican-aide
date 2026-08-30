use chrono::DateTime;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_journal::WorkspaceJournalExecution;
use crewon_device_protocol::DeviceWorkspaceListAcceptedData;
use crewon_device_protocol::DeviceWorkspaceListCanceledData;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListCompletedData;
use crewon_device_protocol::DeviceWorkspaceListEntry;
use crewon_device_protocol::DeviceWorkspaceListEntryKind;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::DeviceWorkspaceListEventEnvelope;
use crewon_device_protocol::DeviceWorkspaceListFailedData;
use crewon_device_protocol::DeviceWorkspaceListResult as ProtocolWorkspaceListResult;
use crewon_device_protocol::DeviceWorkspaceListUnknownOutcomeData;
use uuid::Uuid;

use crate::DeviceWorkspaceListResult;
use crate::NativeDeviceAdmissionError;
use crate::WorkspaceDirectoryEntryKind;

pub(crate) fn accepted_event(
    command: &DeviceWorkspaceListCommand,
    connection_epoch: u64,
    observed_at: DateTime<Utc>,
) -> DeviceWorkspaceListEvent {
    DeviceWorkspaceListEvent::Accepted {
        envelope: event_envelope(
            command,
            format!("workspace-receipt-{}", Uuid::new_v4()),
            connection_epoch,
            1,
            observed_at,
        ),
        data: DeviceWorkspaceListAcceptedData {
            lease_id: command.lease_id.clone(),
            lease_epoch: command.lease_epoch,
            expires_at: command.expires_at.clone(),
            policy_snapshot_id: command.policy_snapshot_id.clone(),
        },
    }
}

pub(crate) fn completed_terminal(
    execution: &WorkspaceJournalExecution,
    result: DeviceWorkspaceListResult,
    observed_at: DateTime<Utc>,
) -> Result<DeviceWorkspaceListEvent, NativeDeviceAdmissionError> {
    let entries = result
        .entries
        .into_iter()
        .map(|entry| DeviceWorkspaceListEntry {
            name: entry.name,
            kind: match entry.kind {
                WorkspaceDirectoryEntryKind::File => DeviceWorkspaceListEntryKind::File,
                WorkspaceDirectoryEntryKind::Directory => DeviceWorkspaceListEntryKind::Directory,
            },
        })
        .collect();
    Ok(DeviceWorkspaceListEvent::Completed {
        envelope: terminal_envelope(execution, observed_at)?,
        data: DeviceWorkspaceListCompletedData {
            result: ProtocolWorkspaceListResult {
                schema_version: result.schema_version,
                execution_id: result.execution_id,
                action_digest: result.action_digest,
                command_digest: result.command_digest,
                entries,
                truncated: result.truncated,
            },
        },
    })
}

pub(crate) fn failed_terminal(
    execution: &WorkspaceJournalExecution,
    error: &NativeDeviceAdmissionError,
    observed_at: DateTime<Utc>,
) -> Result<DeviceWorkspaceListEvent, NativeDeviceAdmissionError> {
    let envelope = terminal_envelope(execution, observed_at)?;
    Ok(if error.code == "workspace_list_canceled" {
        DeviceWorkspaceListEvent::Canceled {
            envelope,
            data: DeviceWorkspaceListCanceledData {
                reason_code: error.code.to_string(),
            },
        }
    } else {
        DeviceWorkspaceListEvent::Failed {
            envelope,
            data: DeviceWorkspaceListFailedData {
                code: error.code.to_string(),
                retryable: false,
            },
        }
    })
}

pub(crate) fn unknown_terminal(
    execution: &WorkspaceJournalExecution,
    observed_at: DateTime<Utc>,
) -> Result<DeviceWorkspaceListEvent, NativeDeviceAdmissionError> {
    Ok(DeviceWorkspaceListEvent::UnknownOutcome {
        envelope: terminal_envelope(execution, observed_at)?,
        data: DeviceWorkspaceListUnknownOutcomeData {
            provider_receipt_id: None,
        },
    })
}

fn terminal_envelope(
    execution: &WorkspaceJournalExecution,
    observed_at: DateTime<Utc>,
) -> Result<DeviceWorkspaceListEventEnvelope, NativeDeviceAdmissionError> {
    let accepted = match &execution.accepted {
        DeviceWorkspaceListEvent::Accepted { envelope, .. } => envelope,
        _ => {
            return Err(NativeDeviceAdmissionError::new(
                "device_journal_authority_corrupt",
            ));
        }
    };
    Ok(event_envelope(
        &execution.command,
        accepted.receipt_id.clone(),
        accepted.connection_epoch,
        2,
        observed_at,
    ))
}

fn event_envelope(
    command: &DeviceWorkspaceListCommand,
    receipt_id: String,
    connection_epoch: u64,
    sequence: u64,
    observed_at: DateTime<Utc>,
) -> DeviceWorkspaceListEventEnvelope {
    DeviceWorkspaceListEventEnvelope {
        schema_version: "crewon.device-workspace-list-event.v0".to_string(),
        protocol_version: command.protocol_version,
        command_kind: command.command_kind.clone(),
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        receipt_id,
        connection_epoch,
        workspace_binding_id: command.workspace_binding_id.clone(),
        incarnation_id: command.incarnation_id.clone(),
        device_binding_id: command.device_binding_id.clone(),
        runtime_binding_id: command.runtime_binding_id.clone(),
        action_digest: command.action_digest.clone(),
        command_digest: command.command_digest.clone(),
        sequence,
        observed_at: observed_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}
