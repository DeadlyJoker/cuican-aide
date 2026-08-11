use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

use super::DEVICE_PROTOCOL_VERSION;
use super::DeviceProtocolError;
use super::bounded_json;
use super::deserialize;
use super::error;
use super::field_value;
use super::require_digest;
use super::require_object;
use super::require_opaque_id;
use super::require_positive;
use super::require_safe_code;
use super::require_timestamp;
use super::workspace_list_result::DeviceWorkspaceListResult;
use super::workspace_list_result::validate_workspace_list_result;

const MAX_EVENT_BYTES: usize = 96 * 1024;
const MAX_ACK_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListEventEnvelope {
    pub schema_version: String,
    pub protocol_version: u64,
    pub command_kind: String,
    pub device_id: String,
    pub execution_id: String,
    pub receipt_id: String,
    pub connection_epoch: u64,
    pub workspace_binding_id: String,
    pub incarnation_id: String,
    pub device_binding_id: String,
    pub runtime_binding_id: String,
    pub action_digest: String,
    pub command_digest: String,
    pub sequence: u64,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListAcceptedData {
    pub lease_id: String,
    pub lease_epoch: u64,
    pub expires_at: String,
    pub policy_snapshot_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListCompletedData {
    pub result: DeviceWorkspaceListResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListFailedData {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListCanceledData {
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListUnknownOutcomeData {
    pub provider_receipt_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DeviceWorkspaceListEvent {
    #[serde(rename = "workspace_list.accepted")]
    Accepted {
        #[serde(flatten)]
        envelope: DeviceWorkspaceListEventEnvelope,
        data: DeviceWorkspaceListAcceptedData,
    },
    #[serde(rename = "workspace_list.completed")]
    Completed {
        #[serde(flatten)]
        envelope: DeviceWorkspaceListEventEnvelope,
        data: DeviceWorkspaceListCompletedData,
    },
    #[serde(rename = "workspace_list.failed")]
    Failed {
        #[serde(flatten)]
        envelope: DeviceWorkspaceListEventEnvelope,
        data: DeviceWorkspaceListFailedData,
    },
    #[serde(rename = "workspace_list.canceled")]
    Canceled {
        #[serde(flatten)]
        envelope: DeviceWorkspaceListEventEnvelope,
        data: DeviceWorkspaceListCanceledData,
    },
    #[serde(rename = "workspace_list.unknown_outcome")]
    UnknownOutcome {
        #[serde(flatten)]
        envelope: DeviceWorkspaceListEventEnvelope,
        data: DeviceWorkspaceListUnknownOutcomeData,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListAck {
    pub schema_version: String,
    pub protocol_version: u64,
    pub command_kind: String,
    pub device_id: String,
    pub execution_id: String,
    pub receipt_id: String,
    pub connection_epoch: u64,
    pub workspace_binding_id: String,
    pub incarnation_id: String,
    pub device_binding_id: String,
    pub runtime_binding_id: String,
    pub action_digest: String,
    pub command_digest: String,
    pub through_sequence: u64,
    pub acknowledged_at: String,
}

pub fn parse_device_workspace_list_event(
    value: Value,
) -> Result<DeviceWorkspaceListEvent, DeviceProtocolError> {
    let object = require_object(&value, "device_workspace_event_invalid")?;
    exact_workspace_keys(
        object,
        &[
            "actionDigest",
            "commandDigest",
            "commandKind",
            "connectionEpoch",
            "data",
            "deviceBindingId",
            "deviceId",
            "executionId",
            "incarnationId",
            "observedAt",
            "protocolVersion",
            "receiptId",
            "runtimeBindingId",
            "schemaVersion",
            "sequence",
            "type",
            "workspaceBindingId",
        ],
    )?;
    require_workspace_protocol(
        object,
        "crewon.device-workspace-list-event.v0",
        "device_workspace_event_protocol_unsupported",
    )?;
    for (field, code) in [
        ("deviceId", "device_id_invalid"),
        ("executionId", "device_execution_id_invalid"),
        ("receiptId", "device_receipt_id_invalid"),
        ("workspaceBindingId", "device_workspace_binding_invalid"),
        ("incarnationId", "device_workspace_incarnation_invalid"),
        ("deviceBindingId", "device_binding_id_invalid"),
        ("runtimeBindingId", "device_runtime_binding_id_invalid"),
    ] {
        require_opaque_id(field_value(object, field, code)?, code)?;
    }
    require_positive(
        field_value(object, "connectionEpoch", "device_connection_epoch_invalid")?,
        "device_connection_epoch_invalid",
    )?;
    require_positive(
        field_value(object, "sequence", "device_event_sequence_invalid")?,
        "device_event_sequence_invalid",
    )?;
    require_timestamp(
        field_value(object, "observedAt", "device_event_timestamp_invalid")?,
        "device_event_timestamp_invalid",
    )?;
    require_digest(
        field_value(object, "actionDigest", "device_action_digest_invalid")?,
        "device_action_digest_invalid",
    )?;
    require_digest(
        field_value(object, "commandDigest", "device_command_digest_invalid")?,
        "device_command_digest_invalid",
    )?;
    let data = require_object(
        field_value(object, "data", "device_workspace_event_data_invalid")?,
        "device_workspace_event_data_invalid",
    )?;
    match field_value(object, "type", "device_workspace_event_type_unsupported")?.as_str() {
        Some("workspace_list.accepted") => {
            require_sequence(object, 1)?;
            exact_workspace_keys(
                data,
                &["expiresAt", "leaseEpoch", "leaseId", "policySnapshotId"],
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
            require_opaque_id(
                field_value(
                    data,
                    "policySnapshotId",
                    "device_policy_snapshot_id_invalid",
                )?,
                "device_policy_snapshot_id_invalid",
            )?;
        }
        Some("workspace_list.completed") => {
            require_sequence(object, 2)?;
            exact_workspace_keys(data, &["result"])?;
            validate_workspace_list_result(
                field_value(data, "result", "device_workspace_result_invalid")?,
                field_value(object, "executionId", "device_execution_id_invalid")?,
                field_value(object, "actionDigest", "device_action_digest_invalid")?,
                field_value(object, "commandDigest", "device_command_digest_invalid")?,
            )?;
        }
        Some("workspace_list.failed") => {
            require_sequence(object, 2)?;
            exact_workspace_keys(data, &["code", "retryable"])?;
            require_safe_code(
                field_value(data, "code", "device_failure_code_invalid")?,
                "device_failure_code_invalid",
            )?;
            if !field_value(data, "retryable", "device_failure_retryable_invalid")?.is_boolean() {
                return Err(error("device_failure_retryable_invalid"));
            }
        }
        Some("workspace_list.canceled") => {
            require_sequence(object, 2)?;
            exact_workspace_keys(data, &["reasonCode"])?;
            require_safe_code(
                field_value(data, "reasonCode", "device_cancel_reason_invalid")?,
                "device_cancel_reason_invalid",
            )?;
        }
        Some("workspace_list.unknown_outcome") => {
            require_sequence(object, 2)?;
            exact_workspace_keys(data, &["providerReceiptId"])?;
            let receipt = field_value(
                data,
                "providerReceiptId",
                "device_provider_receipt_id_invalid",
            )?;
            if !receipt.is_null() {
                require_opaque_id(receipt, "device_provider_receipt_id_invalid")?;
            }
        }
        _ => return Err(error("device_workspace_event_type_unsupported")),
    }
    bounded_json(&value, MAX_EVENT_BYTES, "device_workspace_event_too_large")?;
    deserialize(value, "device_workspace_event_invalid")
}

pub fn parse_device_workspace_list_ack(
    value: Value,
) -> Result<DeviceWorkspaceListAck, DeviceProtocolError> {
    let object = require_object(&value, "device_workspace_ack_invalid")?;
    exact_workspace_keys(
        object,
        &[
            "acknowledgedAt",
            "actionDigest",
            "commandDigest",
            "commandKind",
            "connectionEpoch",
            "deviceBindingId",
            "deviceId",
            "executionId",
            "incarnationId",
            "protocolVersion",
            "receiptId",
            "runtimeBindingId",
            "schemaVersion",
            "throughSequence",
            "workspaceBindingId",
        ],
    )?;
    require_workspace_protocol(
        object,
        "crewon.device-workspace-list-ack.v0",
        "device_workspace_ack_protocol_unsupported",
    )?;
    for (field, code) in [
        ("deviceId", "device_id_invalid"),
        ("executionId", "device_execution_id_invalid"),
        ("receiptId", "device_receipt_id_invalid"),
        ("workspaceBindingId", "device_workspace_binding_invalid"),
        ("incarnationId", "device_workspace_incarnation_invalid"),
        ("deviceBindingId", "device_binding_id_invalid"),
        ("runtimeBindingId", "device_runtime_binding_id_invalid"),
    ] {
        require_opaque_id(field_value(object, field, code)?, code)?;
    }
    require_positive(
        field_value(object, "connectionEpoch", "device_connection_epoch_invalid")?,
        "device_connection_epoch_invalid",
    )?;
    require_positive(
        field_value(object, "throughSequence", "device_ack_sequence_invalid")?,
        "device_ack_sequence_invalid",
    )?;
    if field_value(object, "throughSequence", "device_ack_sequence_invalid")?
        .as_u64()
        .is_none_or(|sequence| sequence > 2)
    {
        return Err(error("device_ack_sequence_invalid"));
    }
    require_timestamp(
        field_value(object, "acknowledgedAt", "device_ack_timestamp_invalid")?,
        "device_ack_timestamp_invalid",
    )?;
    require_digest(
        field_value(object, "actionDigest", "device_action_digest_invalid")?,
        "device_action_digest_invalid",
    )?;
    require_digest(
        field_value(object, "commandDigest", "device_command_digest_invalid")?,
        "device_command_digest_invalid",
    )?;
    bounded_json(&value, MAX_ACK_BYTES, "device_workspace_ack_too_large")?;
    deserialize(value, "device_workspace_ack_invalid")
}

fn require_workspace_protocol(
    object: &Map<String, Value>,
    schema: &str,
    code: &'static str,
) -> Result<(), DeviceProtocolError> {
    if field_value(object, "schemaVersion", code)?.as_str() != Some(schema)
        || field_value(object, "protocolVersion", code)?.as_u64() != Some(DEVICE_PROTOCOL_VERSION)
        || field_value(object, "commandKind", code)?.as_str() != Some("workspaceList")
    {
        return Err(error(code));
    }
    Ok(())
}

fn require_sequence(object: &Map<String, Value>, expected: u64) -> Result<(), DeviceProtocolError> {
    if field_value(object, "sequence", "device_event_sequence_invalid")?.as_u64() != Some(expected)
    {
        return Err(error("device_event_sequence_invalid"));
    }
    Ok(())
}

fn exact_workspace_keys(
    object: &Map<String, Value>,
    expected: &[&str],
) -> Result<(), DeviceProtocolError> {
    if object.len() != expected.len() || expected.iter().any(|field| !object.contains_key(*field)) {
        return Err(error("device_workspace_fields_invalid"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "workspace_list_event_tests.rs"]
mod tests;
