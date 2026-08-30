use chrono::DateTime;
use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::DeviceWorkspaceListEventEnvelope;
use crewon_device_protocol::parse_device_workspace_list_ack;
use crewon_device_protocol::parse_device_workspace_list_command;
use crewon_device_protocol::parse_device_workspace_list_event;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

use crate::DeviceJournalError;
use crate::authority;

pub(crate) struct EncodedCommand {
    pub record: DeviceWorkspaceListCommand,
    pub json: String,
    pub fingerprint: String,
}

pub(crate) struct EncodedEvent {
    pub record: DeviceWorkspaceListEvent,
    pub json: String,
    pub fingerprint: String,
    pub event_type: &'static str,
}

pub(crate) struct EncodedAck {
    pub record: DeviceWorkspaceListAck,
    pub json: String,
    pub fingerprint: String,
}

pub(crate) fn encode_command(
    command: &DeviceWorkspaceListCommand,
) -> Result<EncodedCommand, DeviceJournalError> {
    let value =
        serde_json::to_value(command).map_err(|_| authority("device_journal_command_invalid"))?;
    let record = parse_device_workspace_list_command(value)
        .map_err(|_| authority("device_journal_command_invalid"))?;
    encode_validated_command(record)
}

pub(crate) fn decode_command(
    json: &str,
    fingerprint: &str,
) -> Result<EncodedCommand, DeviceJournalError> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| authority("device_journal_authority_corrupt"))?;
    let record = parse_device_workspace_list_command(value)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let encoded = encode_validated_command(record)?;
    if encoded.json != json || encoded.fingerprint != fingerprint {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(encoded)
}

pub(crate) fn encode_event(
    event: &DeviceWorkspaceListEvent,
) -> Result<EncodedEvent, DeviceJournalError> {
    let value =
        serde_json::to_value(event).map_err(|_| authority("device_journal_event_invalid"))?;
    let record = parse_device_workspace_list_event(value)
        .map_err(|_| authority("device_journal_event_invalid"))?;
    encode_validated_event(record)
}

pub(crate) fn decode_event(
    json: &str,
    fingerprint: &str,
    event_type: &str,
) -> Result<EncodedEvent, DeviceJournalError> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| authority("device_journal_authority_corrupt"))?;
    let record = parse_device_workspace_list_event(value)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let encoded = encode_validated_event(record)?;
    if encoded.json != json
        || encoded.fingerprint != fingerprint
        || encoded.event_type != event_type
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(encoded)
}

pub(crate) fn encode_ack(ack: &DeviceWorkspaceListAck) -> Result<EncodedAck, DeviceJournalError> {
    let value = serde_json::to_value(ack).map_err(|_| authority("device_journal_ack_invalid"))?;
    let record = parse_device_workspace_list_ack(value)
        .map_err(|_| authority("device_journal_ack_invalid"))?;
    encode_validated_ack(record)
}

pub(crate) fn decode_ack(json: &str, fingerprint: &str) -> Result<EncodedAck, DeviceJournalError> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| authority("device_journal_authority_corrupt"))?;
    let record = parse_device_workspace_list_ack(value)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let encoded = encode_validated_ack(record)?;
    if encoded.json != json || encoded.fingerprint != fingerprint {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(encoded)
}

fn encode_validated_command(
    record: DeviceWorkspaceListCommand,
) -> Result<EncodedCommand, DeviceJournalError> {
    let json =
        serde_json::to_string(&record).map_err(|_| authority("device_journal_command_invalid"))?;
    Ok(EncodedCommand {
        fingerprint: fingerprint(&json),
        record,
        json,
    })
}

fn encode_validated_event(
    record: DeviceWorkspaceListEvent,
) -> Result<EncodedEvent, DeviceJournalError> {
    let event_type = event_type(&record);
    let json =
        serde_json::to_string(&record).map_err(|_| authority("device_journal_event_invalid"))?;
    Ok(EncodedEvent {
        fingerprint: fingerprint(&json),
        record,
        json,
        event_type,
    })
}

fn encode_validated_ack(record: DeviceWorkspaceListAck) -> Result<EncodedAck, DeviceJournalError> {
    let json =
        serde_json::to_string(&record).map_err(|_| authority("device_journal_ack_invalid"))?;
    Ok(EncodedAck {
        fingerprint: fingerprint(&json),
        record,
        json,
    })
}

pub(crate) fn event_envelope(
    event: &DeviceWorkspaceListEvent,
) -> &DeviceWorkspaceListEventEnvelope {
    match event {
        DeviceWorkspaceListEvent::Accepted { envelope, .. }
        | DeviceWorkspaceListEvent::Completed { envelope, .. }
        | DeviceWorkspaceListEvent::Failed { envelope, .. }
        | DeviceWorkspaceListEvent::Canceled { envelope, .. }
        | DeviceWorkspaceListEvent::UnknownOutcome { envelope, .. } => envelope,
    }
}

pub(crate) fn event_type(event: &DeviceWorkspaceListEvent) -> &'static str {
    match event {
        DeviceWorkspaceListEvent::Accepted { .. } => "workspace_list.accepted",
        DeviceWorkspaceListEvent::Completed { .. } => "workspace_list.completed",
        DeviceWorkspaceListEvent::Failed { .. } => "workspace_list.failed",
        DeviceWorkspaceListEvent::Canceled { .. } => "workspace_list.canceled",
        DeviceWorkspaceListEvent::UnknownOutcome { .. } => "workspace_list.unknown_outcome",
    }
}

pub(crate) fn validate_fresh_acceptance(
    command: &DeviceWorkspaceListCommand,
    accepted: &DeviceWorkspaceListEvent,
) -> Result<(), DeviceJournalError> {
    let DeviceWorkspaceListEvent::Accepted { envelope, data } = accepted else {
        return Err(authority("device_journal_accepted_invalid"));
    };
    if envelope.device_id != command.device_id
        || envelope.execution_id != command.execution_id
        || envelope.workspace_binding_id != command.workspace_binding_id
        || envelope.incarnation_id != command.incarnation_id
        || envelope.device_binding_id != command.device_binding_id
        || envelope.runtime_binding_id != command.runtime_binding_id
        || envelope.action_digest != command.action_digest
        || envelope.command_digest != command.command_digest
        || data.lease_id != command.lease_id
        || data.lease_epoch != command.lease_epoch
        || data.expires_at != command.expires_at
        || data.policy_snapshot_id != command.policy_snapshot_id
    {
        return Err(authority("device_journal_identity_mismatch"));
    }
    if timestamp(&envelope.observed_at)? < timestamp(&command.authorization.issued_at)?
        || timestamp(&envelope.observed_at)? > timestamp(&command.expires_at)?
    {
        return Err(authority("device_journal_event_time_invalid"));
    }
    Ok(())
}

pub(crate) fn validate_terminal_identity(
    execution: &crate::WorkspaceJournalExecution,
    terminal: &DeviceWorkspaceListEvent,
) -> Result<(), DeviceJournalError> {
    if matches!(terminal, DeviceWorkspaceListEvent::Accepted { .. }) {
        return Err(authority("device_journal_terminal_invalid"));
    }
    let accepted = event_envelope(&execution.accepted);
    let terminal = event_envelope(terminal);
    if terminal.execution_id != execution.command.execution_id
        || terminal.device_id != accepted.device_id
        || terminal.receipt_id != accepted.receipt_id
        || terminal.connection_epoch != accepted.connection_epoch
        || terminal.workspace_binding_id != accepted.workspace_binding_id
        || terminal.incarnation_id != accepted.incarnation_id
        || terminal.device_binding_id != accepted.device_binding_id
        || terminal.runtime_binding_id != accepted.runtime_binding_id
        || terminal.action_digest != accepted.action_digest
        || terminal.command_digest != accepted.command_digest
    {
        return Err(authority("device_journal_identity_mismatch"));
    }
    if timestamp(&terminal.observed_at)? < timestamp(&accepted.observed_at)? {
        return Err(authority("device_journal_event_time_invalid"));
    }
    Ok(())
}

pub(crate) fn validate_ack_identity(
    execution: &crate::WorkspaceJournalExecution,
    ack: &DeviceWorkspaceListAck,
) -> Result<(), DeviceJournalError> {
    let accepted = event_envelope(&execution.accepted);
    if ack.execution_id != execution.command.execution_id
        || ack.device_id != accepted.device_id
        || ack.receipt_id != accepted.receipt_id
        || ack.connection_epoch != accepted.connection_epoch
        || ack.workspace_binding_id != accepted.workspace_binding_id
        || ack.incarnation_id != accepted.incarnation_id
        || ack.device_binding_id != accepted.device_binding_id
        || ack.runtime_binding_id != accepted.runtime_binding_id
        || ack.action_digest != accepted.action_digest
        || ack.command_digest != accepted.command_digest
    {
        return Err(authority("device_journal_identity_mismatch"));
    }
    Ok(())
}

pub(crate) fn validate_ack_time(
    execution: &crate::WorkspaceJournalExecution,
    ack: &DeviceWorkspaceListAck,
    prior: Option<&DeviceWorkspaceListAck>,
) -> Result<(), DeviceJournalError> {
    let event_time = match ack.through_sequence {
        1 => &event_envelope(&execution.accepted).observed_at,
        2 => {
            &event_envelope(
                execution
                    .terminal
                    .as_ref()
                    .ok_or_else(|| authority("device_journal_ack_event_missing"))?,
            )
            .observed_at
        }
        _ => return Err(authority("device_journal_ack_invalid")),
    };
    if timestamp(&ack.acknowledged_at)? < timestamp(event_time)? {
        return Err(authority("device_journal_ack_time_invalid"));
    }
    if let Some(prior) = prior
        && timestamp(&ack.acknowledged_at)? < timestamp(&prior.acknowledged_at)?
    {
        return Err(authority("device_journal_ack_time_invalid"));
    }
    Ok(())
}

pub(crate) fn same_ack_identity(
    left: &DeviceWorkspaceListAck,
    right: &DeviceWorkspaceListAck,
) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    left.acknowledged_at.clear();
    right.acknowledged_at.clear();
    left == right
}

pub(crate) fn valid_cursor(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.len() <= 512
        && cursor.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn fingerprint(json: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(json.as_bytes());
    let mut encoded = String::with_capacity(71);
    encoded.push_str("sha256:");
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn timestamp(value: &str) -> Result<DateTime<chrono::FixedOffset>, DeviceJournalError> {
    DateTime::parse_from_rfc3339(value).map_err(|_| authority("device_journal_timestamp_invalid"))
}
