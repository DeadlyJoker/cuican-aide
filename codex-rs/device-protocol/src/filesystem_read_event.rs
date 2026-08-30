use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

use crate::DEVICE_PROTOCOL_VERSION;
use crate::DeviceProtocolError;
use crate::bounded_json;
use crate::deserialize;
use crate::error;
use crate::field_value;
use crate::require_digest;
use crate::require_object;
use crate::require_opaque_id;
use crate::require_positive;
use crate::require_safe_code;
use crate::require_timestamp;

const MAX_EVENT_BYTES: usize = 96 * 1024;
const MAX_ACK_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadEventEnvelope {
    pub schema_version: String,
    pub protocol_version: u64,
    pub command_kind: String,
    pub device_id: String,
    pub execution_id: String,
    pub receipt_id: String,
    pub connection_epoch: u64,
    pub workspace_binding_id: String,
    pub incarnation_id: String,
    pub command_digest: String,
    pub sequence: u64,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadAcceptedData {
    pub lease_id: String,
    pub lease_epoch: u64,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadResult {
    pub schema_version: String,
    pub encoding: String,
    pub content: String,
    pub byte_length: u64,
    pub output_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadCompletedData {
    pub result: DeviceFilesystemReadResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadFailedData {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadCanceledData {
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadUnknownOutcomeData {
    pub provider_receipt_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DeviceFilesystemReadEvent {
    #[serde(rename = "workspace_read.accepted")]
    Accepted {
        #[serde(flatten)]
        envelope: DeviceFilesystemReadEventEnvelope,
        data: DeviceFilesystemReadAcceptedData,
    },
    #[serde(rename = "workspace_read.completed")]
    Completed {
        #[serde(flatten)]
        envelope: DeviceFilesystemReadEventEnvelope,
        data: DeviceFilesystemReadCompletedData,
    },
    #[serde(rename = "workspace_read.failed")]
    Failed {
        #[serde(flatten)]
        envelope: DeviceFilesystemReadEventEnvelope,
        data: DeviceFilesystemReadFailedData,
    },
    #[serde(rename = "workspace_read.canceled")]
    Canceled {
        #[serde(flatten)]
        envelope: DeviceFilesystemReadEventEnvelope,
        data: DeviceFilesystemReadCanceledData,
    },
    #[serde(rename = "workspace_read.unknown_outcome")]
    UnknownOutcome {
        #[serde(flatten)]
        envelope: DeviceFilesystemReadEventEnvelope,
        data: DeviceFilesystemReadUnknownOutcomeData,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFilesystemReadAck {
    pub schema_version: String,
    pub protocol_version: u64,
    pub command_kind: String,
    pub device_id: String,
    pub execution_id: String,
    pub receipt_id: String,
    pub connection_epoch: u64,
    pub workspace_binding_id: String,
    pub incarnation_id: String,
    pub command_digest: String,
    pub through_sequence: u64,
    pub acknowledged_at: String,
}

pub fn parse_device_filesystem_read_event(
    value: Value,
) -> Result<DeviceFilesystemReadEvent, DeviceProtocolError> {
    let object = require_object(&value, "device_filesystem_read_event_invalid")?;
    require_exact_keys(
        object,
        &[
            "commandDigest",
            "commandKind",
            "connectionEpoch",
            "data",
            "deviceId",
            "executionId",
            "incarnationId",
            "observedAt",
            "protocolVersion",
            "receiptId",
            "schemaVersion",
            "sequence",
            "type",
            "workspaceBindingId",
        ],
        "device_filesystem_read_event_invalid",
    )?;
    validate_envelope(object, "crewon.device-filesystem-read-event.v0")?;
    require_timestamp(
        field_value(object, "observedAt", "device_event_timestamp_invalid")?,
        "device_event_timestamp_invalid",
    )?;
    let event_type = field_value(object, "type", "device_filesystem_read_event_invalid")?
        .as_str()
        .ok_or_else(|| error("device_filesystem_read_event_invalid"))?;
    let data = require_object(
        field_value(object, "data", "device_filesystem_read_event_invalid")?,
        "device_filesystem_read_event_invalid",
    )?;
    match event_type {
        "workspace_read.accepted" => {
            require_sequence(object, 1)?;
            require_exact_keys(
                data,
                &["expiresAt", "leaseEpoch", "leaseId"],
                "device_filesystem_read_event_invalid",
            )?;
            require_opaque_id(
                field_value(data, "leaseId", "device_lease_id_invalid")?,
                "device_lease_id_invalid",
            )?;
            require_positive(
                field_value(data, "leaseEpoch", "device_lease_epoch_invalid")?,
                "device_lease_epoch_invalid",
            )?;
            require_timestamp(
                field_value(data, "expiresAt", "device_lease_expiry_invalid")?,
                "device_lease_expiry_invalid",
            )?;
        }
        "workspace_read.completed" => {
            require_sequence(object, 2)?;
            require_exact_keys(data, &["result"], "device_filesystem_read_event_invalid")?;
            validate_result(field_value(
                data,
                "result",
                "device_filesystem_read_result_invalid",
            )?)?;
        }
        "workspace_read.failed" => {
            require_sequence(object, 2)?;
            require_exact_keys(
                data,
                &["code", "retryable"],
                "device_filesystem_read_event_invalid",
            )?;
            require_safe_code(
                field_value(data, "code", "device_failure_code_invalid")?,
                "device_failure_code_invalid",
            )?;
            if !field_value(data, "retryable", "device_failure_retryable_invalid")?.is_boolean() {
                return Err(error("device_failure_retryable_invalid"));
            }
        }
        "workspace_read.canceled" => {
            require_sequence(object, 2)?;
            require_exact_keys(
                data,
                &["reasonCode"],
                "device_filesystem_read_event_invalid",
            )?;
            require_safe_code(
                field_value(data, "reasonCode", "device_cancel_reason_invalid")?,
                "device_cancel_reason_invalid",
            )?;
        }
        "workspace_read.unknown_outcome" => {
            require_sequence(object, 2)?;
            require_exact_keys(
                data,
                &["providerReceiptId"],
                "device_filesystem_read_event_invalid",
            )?;
            let receipt = field_value(
                data,
                "providerReceiptId",
                "device_provider_receipt_id_invalid",
            )?;
            if !receipt.is_null() {
                require_opaque_id(receipt, "device_provider_receipt_id_invalid")?;
            }
        }
        _ => return Err(error("device_filesystem_read_event_type_unsupported")),
    }
    bounded_json(
        &value,
        MAX_EVENT_BYTES,
        "device_filesystem_read_event_too_large",
    )?;
    deserialize(value, "device_filesystem_read_event_invalid")
}

pub fn parse_device_filesystem_read_ack(
    value: Value,
) -> Result<DeviceFilesystemReadAck, DeviceProtocolError> {
    let object = require_object(&value, "device_filesystem_read_ack_invalid")?;
    require_exact_keys(
        object,
        &[
            "acknowledgedAt",
            "commandDigest",
            "commandKind",
            "connectionEpoch",
            "deviceId",
            "executionId",
            "incarnationId",
            "protocolVersion",
            "receiptId",
            "schemaVersion",
            "throughSequence",
            "workspaceBindingId",
        ],
        "device_filesystem_read_ack_invalid",
    )?;
    validate_envelope(object, "crewon.device-filesystem-read-ack.v0")?;
    let through = field_value(object, "throughSequence", "device_ack_sequence_invalid")?.as_u64();
    if !matches!(through, Some(1 | 2)) {
        return Err(error("device_ack_sequence_invalid"));
    }
    require_timestamp(
        field_value(object, "acknowledgedAt", "device_ack_timestamp_invalid")?,
        "device_ack_timestamp_invalid",
    )?;
    bounded_json(
        &value,
        MAX_ACK_BYTES,
        "device_filesystem_read_ack_too_large",
    )?;
    deserialize(value, "device_filesystem_read_ack_invalid")
}

fn validate_envelope(
    object: &serde_json::Map<String, Value>,
    schema: &str,
) -> Result<(), DeviceProtocolError> {
    if field_value(
        object,
        "schemaVersion",
        "device_filesystem_read_protocol_unsupported",
    )?
    .as_str()
        != Some(schema)
        || field_value(
            object,
            "protocolVersion",
            "device_filesystem_read_protocol_unsupported",
        )?
        .as_u64()
            != Some(DEVICE_PROTOCOL_VERSION)
        || field_value(
            object,
            "commandKind",
            "device_filesystem_read_protocol_unsupported",
        )?
        .as_str()
            != Some("workspaceRead")
    {
        return Err(error("device_filesystem_read_protocol_unsupported"));
    }
    for (field, code) in [
        ("deviceId", "device_id_invalid"),
        ("executionId", "device_execution_id_invalid"),
        ("receiptId", "device_receipt_id_invalid"),
        ("workspaceBindingId", "device_workspace_binding_invalid"),
        ("incarnationId", "device_workspace_incarnation_invalid"),
    ] {
        require_opaque_id(field_value(object, field, code)?, code)?;
    }
    require_positive(
        field_value(object, "connectionEpoch", "device_connection_epoch_invalid")?,
        "device_connection_epoch_invalid",
    )?;
    require_digest(
        field_value(object, "commandDigest", "device_command_digest_invalid")?,
        "device_command_digest_invalid",
    )
}

fn validate_result(value: &Value) -> Result<(), DeviceProtocolError> {
    let result = require_object(value, "device_filesystem_read_result_invalid")?;
    require_exact_keys(
        result,
        &[
            "byteLength",
            "content",
            "encoding",
            "outputDigest",
            "schemaVersion",
        ],
        "device_filesystem_read_result_invalid",
    )?;
    let content = field_value(result, "content", "device_filesystem_read_result_invalid")?
        .as_str()
        .ok_or_else(|| error("device_filesystem_read_result_invalid"))?;
    if field_value(
        result,
        "schemaVersion",
        "device_filesystem_read_result_invalid",
    )?
    .as_str()
        != Some("crewon.workspace-file-read-result.v0")
        || field_value(result, "encoding", "device_filesystem_read_result_invalid")?.as_str()
            != Some("utf8")
        || field_value(
            result,
            "byteLength",
            "device_filesystem_read_result_invalid",
        )?
        .as_u64()
            != u64::try_from(content.len()).ok()
    {
        return Err(error("device_filesystem_read_result_invalid"));
    }
    let output_digest = field_value(result, "outputDigest", "device_output_digest_invalid")?;
    require_digest(output_digest, "device_output_digest_invalid")?;
    let actual_digest = format!("sha256:{:x}", Sha256::digest(content.as_bytes()));
    if output_digest.as_str() != Some(&actual_digest) {
        return Err(error("device_output_digest_mismatch"));
    }
    bounded_json(
        value,
        crate::MAX_DEVICE_FILESYSTEM_READ_BYTES as usize,
        "device_filesystem_read_result_too_large",
    )
}

fn require_sequence(
    object: &serde_json::Map<String, Value>,
    expected: u64,
) -> Result<(), DeviceProtocolError> {
    if field_value(object, "sequence", "device_event_sequence_invalid")?.as_u64() != Some(expected)
    {
        return Err(error("device_event_sequence_invalid"));
    }
    Ok(())
}

fn require_exact_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
    code: &'static str,
) -> Result<(), DeviceProtocolError> {
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(error(code));
    }
    Ok(())
}
