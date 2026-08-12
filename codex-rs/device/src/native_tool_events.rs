use chrono::DateTime;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_journal::ToolJournalExecution;
use crewon_device_protocol::DeviceAcceptedData;
use crewon_device_protocol::DeviceCompletedData;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::DeviceExecutionEventEnvelope;
use crewon_device_protocol::DeviceUnknownOutcomeData;
use uuid::Uuid;

use crate::NativeDeviceAdmissionError;

pub(crate) fn accepted(
    command: &DeviceExecutionCommand,
    now: DateTime<Utc>,
) -> DeviceExecutionEvent {
    DeviceExecutionEvent::Accepted {
        envelope: event_envelope(command, format!("tool-receipt-{}", Uuid::new_v4()), 1, now),
        data: DeviceAcceptedData {
            lease_epoch: command.lease_epoch,
            action_digest: command.action_digest.clone(),
        },
    }
}

pub(crate) fn completed(
    execution: &ToolJournalExecution,
    data: DeviceCompletedData,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEvent, NativeDeviceAdmissionError> {
    Ok(DeviceExecutionEvent::Completed {
        envelope: terminal_envelope(execution, now)?,
        data,
    })
}

pub(crate) fn failed(
    execution: &ToolJournalExecution,
    code: &str,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEvent, NativeDeviceAdmissionError> {
    Ok(DeviceExecutionEvent::Failed {
        envelope: terminal_envelope(execution, now)?,
        data: crewon_device_protocol::DeviceFailedData {
            code: code.to_string(),
            retryable: false,
        },
    })
}

pub(crate) fn unknown(
    execution: &ToolJournalExecution,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEvent, NativeDeviceAdmissionError> {
    Ok(DeviceExecutionEvent::UnknownOutcome {
        envelope: terminal_envelope(execution, now)?,
        data: DeviceUnknownOutcomeData {
            provider_receipt_id: None,
        },
    })
}

fn terminal_envelope(
    execution: &ToolJournalExecution,
    now: DateTime<Utc>,
) -> Result<DeviceExecutionEventEnvelope, NativeDeviceAdmissionError> {
    let DeviceExecutionEvent::Accepted { envelope, .. } = &execution.accepted else {
        return Err(NativeDeviceAdmissionError::new(
            "device_journal_authority_corrupt",
        ));
    };
    Ok(event_envelope(
        &execution.command,
        envelope.receipt_id.clone(),
        2,
        now,
    ))
}

fn event_envelope(
    command: &DeviceExecutionCommand,
    receipt_id: String,
    sequence: u64,
    now: DateTime<Utc>,
) -> DeviceExecutionEventEnvelope {
    DeviceExecutionEventEnvelope {
        schema_version: "crewon.device-event.v0".to_string(),
        protocol_version: command.protocol_version,
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        receipt_id,
        sequence,
        observed_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}
