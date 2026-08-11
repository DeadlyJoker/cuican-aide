use chrono::DateTime;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_journal::FilesystemReadJournalExecution;
use crewon_device_protocol::DeviceFilesystemReadAcceptedData;
use crewon_device_protocol::DeviceFilesystemReadCanceledData;
use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::DeviceFilesystemReadCompletedData;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::DeviceFilesystemReadEventEnvelope;
use crewon_device_protocol::DeviceFilesystemReadFailedData;
use crewon_device_protocol::DeviceFilesystemReadResult;
use crewon_device_protocol::DeviceFilesystemReadUnknownOutcomeData;
use crewon_device_protocol::canonical_device_filesystem_read_command_digest;
use sha2::Digest as _;
use sha2::Sha256;
use uuid::Uuid;

use crate::NativeDeviceAdmissionError;
use crate::WorkspaceFileReadResult;

pub(crate) fn accepted_event(
    command: &DeviceFilesystemReadCommand,
    connection_epoch: u64,
    observed_at: DateTime<Utc>,
) -> Result<DeviceFilesystemReadEvent, NativeDeviceAdmissionError> {
    Ok(DeviceFilesystemReadEvent::Accepted {
        envelope: envelope(
            command,
            format!("workspace-read-receipt-{}", Uuid::new_v4()),
            connection_epoch,
            1,
            observed_at,
        )?,
        data: DeviceFilesystemReadAcceptedData {
            lease_id: command.command.lease_id.clone(),
            lease_epoch: command.command.lease_epoch,
            expires_at: command.command.expires_at.clone(),
        },
    })
}

pub(crate) fn completed_terminal(
    execution: &FilesystemReadJournalExecution,
    result: WorkspaceFileReadResult,
    observed_at: DateTime<Utc>,
) -> Result<DeviceFilesystemReadEvent, NativeDeviceAdmissionError> {
    let output_digest = format!("sha256:{:x}", Sha256::digest(result.content.as_bytes()));
    Ok(DeviceFilesystemReadEvent::Completed {
        envelope: terminal_envelope(execution, observed_at)?,
        data: DeviceFilesystemReadCompletedData {
            result: DeviceFilesystemReadResult {
                schema_version: result.schema_version,
                encoding: result.encoding,
                byte_length: u64::try_from(result.byte_length).map_err(|_| {
                    NativeDeviceAdmissionError::new("workspace_file_read_result_invalid")
                })?,
                content: result.content,
                output_digest,
            },
        },
    })
}

pub(crate) fn failed_terminal(
    execution: &FilesystemReadJournalExecution,
    error: &NativeDeviceAdmissionError,
    observed_at: DateTime<Utc>,
) -> Result<DeviceFilesystemReadEvent, NativeDeviceAdmissionError> {
    let envelope = terminal_envelope(execution, observed_at)?;
    Ok(if error.code == "workspace_file_read_canceled" {
        DeviceFilesystemReadEvent::Canceled {
            envelope,
            data: DeviceFilesystemReadCanceledData {
                reason_code: error.code.to_string(),
            },
        }
    } else {
        DeviceFilesystemReadEvent::Failed {
            envelope,
            data: DeviceFilesystemReadFailedData {
                code: error.code.to_string(),
                retryable: false,
            },
        }
    })
}

pub(crate) fn unknown_terminal(
    execution: &FilesystemReadJournalExecution,
    observed_at: DateTime<Utc>,
) -> Result<DeviceFilesystemReadEvent, NativeDeviceAdmissionError> {
    Ok(DeviceFilesystemReadEvent::UnknownOutcome {
        envelope: terminal_envelope(execution, observed_at)?,
        data: DeviceFilesystemReadUnknownOutcomeData {
            provider_receipt_id: None,
        },
    })
}

fn terminal_envelope(
    execution: &FilesystemReadJournalExecution,
    observed_at: DateTime<Utc>,
) -> Result<DeviceFilesystemReadEventEnvelope, NativeDeviceAdmissionError> {
    let DeviceFilesystemReadEvent::Accepted { envelope: accepted, .. } = &execution.accepted else {
        return Err(NativeDeviceAdmissionError::new(
            "device_journal_authority_corrupt",
        ));
    };
    envelope(
        &execution.command,
        accepted.receipt_id.clone(),
        accepted.connection_epoch,
        2,
        observed_at,
    )
}

fn envelope(
    command: &DeviceFilesystemReadCommand,
    receipt_id: String,
    connection_epoch: u64,
    sequence: u64,
    observed_at: DateTime<Utc>,
) -> Result<DeviceFilesystemReadEventEnvelope, NativeDeviceAdmissionError> {
    Ok(DeviceFilesystemReadEventEnvelope {
        schema_version: "crewon.device-filesystem-read-event.v0".to_string(),
        protocol_version: command.command.protocol_version,
        command_kind: "workspaceRead".to_string(),
        device_id: command.command.device_id.clone(),
        execution_id: command.command.execution_id.clone(),
        receipt_id,
        connection_epoch,
        workspace_binding_id: command.command.workspace_binding_id.clone(),
        incarnation_id: command.arguments.workspace_incarnation_id.clone(),
        command_digest: canonical_device_filesystem_read_command_digest(command)
            .map_err(NativeDeviceAdmissionError::from_protocol)?,
        sequence,
        observed_at: observed_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}
