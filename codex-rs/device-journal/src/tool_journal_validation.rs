use crewon_device_protocol::DeviceExecutionAck;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;

use crate::DeviceJournalError;
use crate::ToolJournalExecution;
use crate::authority;
use crate::tool_journal_codec::event_envelope;

pub(super) fn validate_accepted(
    command: &DeviceExecutionCommand,
    event: &DeviceExecutionEvent,
) -> Result<(), DeviceJournalError> {
    let DeviceExecutionEvent::Accepted { envelope, data } = event else {
        return Err(authority("device_tool_accepted_invalid"));
    };
    if envelope.sequence != 1
        || envelope.protocol_version != command.protocol_version
        || envelope.device_id != command.device_id
        || envelope.execution_id != command.execution_id
        || data.lease_epoch != command.lease_epoch
        || data.action_digest != command.action_digest
        || chrono::DateTime::parse_from_rfc3339(&envelope.observed_at).is_err()
    {
        return Err(authority("device_tool_accepted_invalid"));
    }
    Ok(())
}

pub(super) fn validate_terminal(
    execution: &ToolJournalExecution,
    terminal: &DeviceExecutionEvent,
) -> Result<(), DeviceJournalError> {
    if matches!(
        terminal,
        DeviceExecutionEvent::Accepted { .. } | DeviceExecutionEvent::Output { .. }
    ) {
        return Err(authority("device_tool_terminal_invalid"));
    }
    let accepted = event_envelope(&execution.accepted);
    let terminal = event_envelope(terminal);
    let accepted_at = chrono::DateTime::parse_from_rfc3339(&accepted.observed_at)
        .map_err(|_| authority("device_tool_terminal_invalid"))?;
    let terminal_at = chrono::DateTime::parse_from_rfc3339(&terminal.observed_at)
        .map_err(|_| authority("device_tool_terminal_invalid"))?;
    if terminal.sequence != 2
        || terminal.protocol_version != accepted.protocol_version
        || terminal.device_id != accepted.device_id
        || terminal.execution_id != accepted.execution_id
        || terminal.receipt_id != accepted.receipt_id
        || terminal_at < accepted_at
    {
        return Err(authority("device_tool_terminal_invalid"));
    }
    Ok(())
}

pub(super) fn validate_ack(
    execution: &ToolJournalExecution,
    ack: &DeviceExecutionAck,
) -> Result<(), DeviceJournalError> {
    if ack.protocol_version != execution.command.protocol_version
        || ack.device_id != execution.command.device_id
        || ack.execution_id != execution.command.execution_id
        || !(1..=2).contains(&ack.through_sequence)
        || ack.through_sequence > if execution.terminal.is_some() { 2 } else { 1 }
    {
        return Err(authority("device_tool_ack_identity_mismatch"));
    }
    Ok(())
}

pub(super) fn validate_ack_time(
    execution: &ToolJournalExecution,
    ack: &DeviceExecutionAck,
    prior: Option<&DeviceExecutionAck>,
) -> Result<(), DeviceJournalError> {
    let event = match ack.through_sequence {
        1 => &execution.accepted,
        2 => execution
            .terminal
            .as_ref()
            .ok_or_else(|| authority("device_tool_ack_event_missing"))?,
        _ => return Err(authority("device_tool_ack_identity_mismatch")),
    };
    let acknowledged_at = chrono::DateTime::parse_from_rfc3339(&ack.acknowledged_at)
        .map_err(|_| authority("device_tool_ack_time_invalid"))?;
    let event_at = chrono::DateTime::parse_from_rfc3339(&event_envelope(event).observed_at)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let prior_at = prior
        .map(|prior| chrono::DateTime::parse_from_rfc3339(&prior.acknowledged_at))
        .transpose()
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    if acknowledged_at < event_at || prior_at.is_some_and(|prior| acknowledged_at < prior) {
        return Err(authority("device_tool_ack_time_invalid"));
    }
    Ok(())
}

pub(super) fn same_ack_identity(left: &DeviceExecutionAck, right: &DeviceExecutionAck) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    left.acknowledged_at.clear();
    right.acknowledged_at.clear();
    left == right
}
