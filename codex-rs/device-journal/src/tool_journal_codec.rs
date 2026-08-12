use crewon_device_protocol::DeviceExecutionAck;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::DeviceExecutionEventEnvelope;
use crewon_device_protocol::parse_device_execution_ack;
use crewon_device_protocol::parse_device_execution_command;
use crewon_device_protocol::parse_device_execution_event;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

use crate::DeviceJournalError;
use crate::authority;

pub(super) struct EncodedCommand {
    pub record: DeviceExecutionCommand,
    pub json: String,
    pub fingerprint: String,
}

pub(super) struct EncodedEvent {
    pub record: DeviceExecutionEvent,
    pub json: String,
    pub fingerprint: String,
    pub event_type: &'static str,
}

pub(super) struct EncodedAck {
    pub record: DeviceExecutionAck,
    pub json: String,
    pub fingerprint: String,
}

pub(super) fn encode_command(
    command: &DeviceExecutionCommand,
) -> Result<EncodedCommand, DeviceJournalError> {
    let value =
        serde_json::to_value(command).map_err(|_| authority("device_tool_command_invalid"))?;
    let record = parse_device_execution_command(value)
        .map_err(|_| authority("device_tool_command_invalid"))?;
    encode_validated_command(record)
}

pub(super) fn decode_command(
    json: &str,
    fingerprint: &str,
) -> Result<EncodedCommand, DeviceJournalError> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| authority("device_journal_authority_corrupt"))?;
    let record = parse_device_execution_command(value)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let encoded = encode_validated_command(record)?;
    if encoded.json != json || encoded.fingerprint != fingerprint {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(encoded)
}

pub(super) fn encode_event(
    event: &DeviceExecutionEvent,
) -> Result<EncodedEvent, DeviceJournalError> {
    let value = serde_json::to_value(event).map_err(|_| authority("device_tool_event_invalid"))?;
    let record =
        parse_device_execution_event(value).map_err(|_| authority("device_tool_event_invalid"))?;
    encode_validated_event(record)
}

pub(super) fn decode_event(
    json: &str,
    fingerprint: &str,
    stored_type: &str,
) -> Result<EncodedEvent, DeviceJournalError> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| authority("device_journal_authority_corrupt"))?;
    let record = parse_device_execution_event(value)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let encoded = encode_validated_event(record)?;
    if encoded.json != json
        || encoded.fingerprint != fingerprint
        || encoded.event_type != stored_type
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(encoded)
}

pub(super) fn encode_ack(ack: &DeviceExecutionAck) -> Result<EncodedAck, DeviceJournalError> {
    let value = serde_json::to_value(ack).map_err(|_| authority("device_tool_ack_invalid"))?;
    let record =
        parse_device_execution_ack(value).map_err(|_| authority("device_tool_ack_invalid"))?;
    encode_validated_ack(record)
}

pub(super) fn decode_ack(json: &str, fingerprint: &str) -> Result<EncodedAck, DeviceJournalError> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| authority("device_journal_authority_corrupt"))?;
    let record = parse_device_execution_ack(value)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let encoded = encode_validated_ack(record)?;
    if encoded.json != json || encoded.fingerprint != fingerprint {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(encoded)
}

fn encode_validated_command(
    record: DeviceExecutionCommand,
) -> Result<EncodedCommand, DeviceJournalError> {
    let json =
        serde_json::to_string(&record).map_err(|_| authority("device_tool_command_invalid"))?;
    Ok(EncodedCommand {
        fingerprint: fingerprint(&json),
        record,
        json,
    })
}

fn encode_validated_event(
    record: DeviceExecutionEvent,
) -> Result<EncodedEvent, DeviceJournalError> {
    let event_type = event_type(&record)?;
    let json =
        serde_json::to_string(&record).map_err(|_| authority("device_tool_event_invalid"))?;
    Ok(EncodedEvent {
        fingerprint: fingerprint(&json),
        record,
        json,
        event_type,
    })
}

fn encode_validated_ack(record: DeviceExecutionAck) -> Result<EncodedAck, DeviceJournalError> {
    let json = serde_json::to_string(&record).map_err(|_| authority("device_tool_ack_invalid"))?;
    Ok(EncodedAck {
        fingerprint: fingerprint(&json),
        record,
        json,
    })
}

pub(super) fn event_envelope(event: &DeviceExecutionEvent) -> &DeviceExecutionEventEnvelope {
    match event {
        DeviceExecutionEvent::Accepted { envelope, .. }
        | DeviceExecutionEvent::Output { envelope, .. }
        | DeviceExecutionEvent::Completed { envelope, .. }
        | DeviceExecutionEvent::Failed { envelope, .. }
        | DeviceExecutionEvent::Canceled { envelope, .. }
        | DeviceExecutionEvent::UnknownOutcome { envelope, .. } => envelope,
    }
}

pub(super) fn event_type(event: &DeviceExecutionEvent) -> Result<&'static str, DeviceJournalError> {
    match event {
        DeviceExecutionEvent::Accepted { .. } => Ok("execution.accepted"),
        DeviceExecutionEvent::Completed { .. } => Ok("execution.completed"),
        DeviceExecutionEvent::Failed { .. } => Ok("execution.failed"),
        DeviceExecutionEvent::Canceled { .. } => Ok("execution.canceled"),
        DeviceExecutionEvent::UnknownOutcome { .. } => Ok("execution.unknown_outcome"),
        DeviceExecutionEvent::Output { .. } => Err(authority("device_tool_event_invalid")),
    }
}

pub(super) fn fingerprint(json: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(json.as_bytes()))
}
