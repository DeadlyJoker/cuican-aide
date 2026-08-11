use std::collections::HashSet;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use ed25519_dalek::Signature;
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Value;
use thiserror::Error;

mod filesystem_read;
mod workspace_list_command;
mod workspace_list_event;
mod workspace_list_result;

pub use filesystem_read::DEVICE_FILESYSTEM_READ_CAPABILITY;
pub use filesystem_read::DeviceFilesystemReadArguments;
pub use filesystem_read::DeviceFilesystemReadCommand;
pub use filesystem_read::MAX_DEVICE_FILESYSTEM_READ_BYTES;
pub use filesystem_read::MAX_DEVICE_FILESYSTEM_READ_TIMEOUT_MS;
pub use filesystem_read::parse_device_filesystem_read_command;
pub use workspace_list_command::DeviceWorkspaceListCommand;
pub use workspace_list_command::DeviceWorkspaceListLimits;
pub use workspace_list_command::canonical_device_workspace_list_command_signing_payload;
pub use workspace_list_command::parse_device_workspace_list_command;
pub use workspace_list_command::verify_device_workspace_list_command_authorization;
pub use workspace_list_event::DeviceWorkspaceListAcceptedData;
pub use workspace_list_event::DeviceWorkspaceListAck;
pub use workspace_list_event::DeviceWorkspaceListCanceledData;
pub use workspace_list_event::DeviceWorkspaceListCompletedData;
pub use workspace_list_event::DeviceWorkspaceListEvent;
pub use workspace_list_event::DeviceWorkspaceListEventEnvelope;
pub use workspace_list_event::DeviceWorkspaceListFailedData;
pub use workspace_list_event::DeviceWorkspaceListUnknownOutcomeData;
pub use workspace_list_event::parse_device_workspace_list_ack;
pub use workspace_list_event::parse_device_workspace_list_event;
pub use workspace_list_result::DeviceWorkspaceListEntry;
pub use workspace_list_result::DeviceWorkspaceListEntryKind;
pub use workspace_list_result::DeviceWorkspaceListResult;

pub const DEVICE_PROTOCOL_VERSION: u64 = 1;
pub const MAX_DEVICE_COMMAND_BYTES: usize = 128 * 1024;
pub const MAX_DEVICE_EVENT_BYTES: usize = 64 * 1024;

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 40_000;
const MAX_CAPABILITIES: usize = 256;
const MAX_ACKNOWLEDGED_EXECUTIONS: usize = 256;
const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{code}")]
pub struct DeviceProtocolError {
    pub code: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTraceContext {
    pub traceparent: Option<String>,
    pub tracestate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExecutionLimits {
    pub timeout_ms: u64,
    pub max_output_bytes: u64,
    pub max_artifact_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExecutionCommand {
    pub schema_version: String,
    pub protocol_version: u64,
    pub device_id: String,
    pub lease_id: String,
    pub lease_epoch: u64,
    pub expires_at: String,
    pub run_id: String,
    pub step_id: String,
    pub attempt_id: String,
    pub execution_id: String,
    pub workspace_binding_id: String,
    pub capability: String,
    pub action_digest: String,
    pub arguments: Option<Value>,
    pub payload_ref: Option<String>,
    pub limits: DeviceExecutionLimits,
    pub idempotency_key: String,
    pub trace_context: DeviceTraceContext,
    pub authorization: DeviceCommandAuthorization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCommandApprovalProof {
    pub schema_version: String,
    pub approval_id: String,
    pub approval_revision: u64,
    pub action_digest: String,
    pub policy_snapshot_id: String,
    pub decided_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCommandAuthorization {
    pub schema_version: String,
    pub scheme: String,
    pub key_id: String,
    pub issued_at: String,
    pub expires_at: String,
    pub approval_proof: Option<DeviceCommandApprovalProof>,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExecutionEventEnvelope {
    pub schema_version: String,
    pub protocol_version: u64,
    pub device_id: String,
    pub execution_id: String,
    pub receipt_id: String,
    pub sequence: u64,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAcceptedData {
    pub lease_epoch: u64,
    pub action_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOutputData {
    pub channel: DeviceOutputChannel,
    pub chunk: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceOutputChannel {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCompletedData {
    pub output: Option<String>,
    pub artifact_ref: Option<String>,
    pub output_digest: String,
    pub stdout_digest: String,
    pub stderr_digest: String,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFailedData {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCanceledData {
    pub reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUnknownOutcomeData {
    pub provider_receipt_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DeviceExecutionEvent {
    #[serde(rename = "execution.accepted")]
    Accepted {
        #[serde(flatten)]
        envelope: DeviceExecutionEventEnvelope,
        data: DeviceAcceptedData,
    },
    #[serde(rename = "execution.output")]
    Output {
        #[serde(flatten)]
        envelope: DeviceExecutionEventEnvelope,
        data: DeviceOutputData,
    },
    #[serde(rename = "execution.completed")]
    Completed {
        #[serde(flatten)]
        envelope: DeviceExecutionEventEnvelope,
        data: DeviceCompletedData,
    },
    #[serde(rename = "execution.failed")]
    Failed {
        #[serde(flatten)]
        envelope: DeviceExecutionEventEnvelope,
        data: DeviceFailedData,
    },
    #[serde(rename = "execution.canceled")]
    Canceled {
        #[serde(flatten)]
        envelope: DeviceExecutionEventEnvelope,
        data: DeviceCanceledData,
    },
    #[serde(rename = "execution.unknown_outcome")]
    UnknownOutcome {
        #[serde(flatten)]
        envelope: DeviceExecutionEventEnvelope,
        data: DeviceUnknownOutcomeData,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExecutionAck {
    pub schema_version: String,
    pub protocol_version: u64,
    pub device_id: String,
    pub execution_id: String,
    pub through_sequence: u64,
    pub acknowledged_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceExecutionCancel {
    pub schema_version: String,
    pub protocol_version: u64,
    pub device_id: String,
    pub execution_id: String,
    pub lease_id: String,
    pub lease_epoch: u64,
    pub reason_code: String,
    pub requested_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAcknowledgedExecution {
    pub execution_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHello {
    pub schema_version: String,
    pub supported_protocol_versions: Vec<u64>,
    pub device_id: String,
    pub connection_id: String,
    pub capabilities: Vec<String>,
    pub last_acknowledged: Vec<DeviceAcknowledgedExecution>,
    pub sent_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceGatewayWelcome {
    pub schema_version: String,
    pub protocol_version: u64,
    pub device_id: String,
    pub connection_id: String,
    pub gateway_id: String,
    pub connection_epoch: u64,
    pub lease_expires_at: String,
    pub sent_at: String,
}

pub fn parse_device_execution_command(
    value: Value,
) -> Result<DeviceExecutionCommand, DeviceProtocolError> {
    let object = require_object(&value, "device_command_invalid")?;
    exact_keys(
        object,
        &[
            "actionDigest",
            "arguments",
            "attemptId",
            "authorization",
            "capability",
            "deviceId",
            "executionId",
            "expiresAt",
            "idempotencyKey",
            "leaseEpoch",
            "leaseId",
            "limits",
            "payloadRef",
            "protocolVersion",
            "runId",
            "schemaVersion",
            "stepId",
            "traceContext",
            "workspaceBindingId",
        ],
    )?;
    require_protocol(object, "crewon.device-command.v0")?;
    for (field, code) in [
        ("deviceId", "device_id_invalid"),
        ("leaseId", "device_lease_id_invalid"),
        ("runId", "device_run_id_invalid"),
        ("stepId", "device_step_id_invalid"),
        ("attemptId", "device_attempt_id_invalid"),
        ("executionId", "device_execution_id_invalid"),
        ("workspaceBindingId", "device_workspace_binding_invalid"),
        ("idempotencyKey", "device_idempotency_key_invalid"),
    ] {
        require_opaque_id(field_value(object, field, code)?, code)?;
    }
    require_positive(
        field_value(object, "leaseEpoch", "device_lease_epoch_invalid")?,
        "device_lease_epoch_invalid",
    )?;
    require_timestamp(
        field_value(object, "expiresAt", "device_lease_expiry_invalid")?,
        "device_lease_expiry_invalid",
    )?;
    require_capability(field_value(
        object,
        "capability",
        "device_capability_invalid",
    )?)?;
    require_digest(
        field_value(object, "actionDigest", "device_action_digest_invalid")?,
        "device_action_digest_invalid",
    )?;
    let arguments = field_value(object, "arguments", "device_arguments_invalid")?;
    let payload = field_value(object, "payloadRef", "device_payload_ref_invalid")?;
    if arguments.is_null() == payload.is_null() {
        return Err(error("device_payload_choice_invalid"));
    }
    if !arguments.is_null() {
        bounded_json(arguments, MAX_ARGUMENT_BYTES, "device_arguments_invalid")?;
    } else {
        require_opaque_id(payload, "device_payload_ref_invalid")?;
    }
    validate_limits(field_value(object, "limits", "device_limits_invalid")?)?;
    validate_trace_context(field_value(
        object,
        "traceContext",
        "device_trace_context_invalid",
    )?)?;
    validate_authorization(
        field_value(object, "authorization", "device_authorization_invalid")?,
        field_value(object, "actionDigest", "device_action_digest_invalid")?,
        field_value(object, "expiresAt", "device_lease_expiry_invalid")?,
    )?;
    bounded_json(&value, MAX_DEVICE_COMMAND_BYTES, "device_command_too_large")?;
    deserialize(value, "device_command_invalid")
}

pub fn canonical_device_command_signing_payload(
    command: &DeviceExecutionCommand,
) -> Result<String, DeviceProtocolError> {
    let mut command =
        serde_json::to_value(command).map_err(|_| error("device_authorization_payload_invalid"))?;
    let command_object = command
        .as_object_mut()
        .ok_or_else(|| error("device_authorization_payload_invalid"))?;
    let mut authorization = command_object
        .remove("authorization")
        .ok_or_else(|| error("device_authorization_payload_invalid"))?;
    authorization
        .as_object_mut()
        .ok_or_else(|| error("device_authorization_payload_invalid"))?
        .remove("signature")
        .ok_or_else(|| error("device_authorization_payload_invalid"))?;
    let payload = serde_json::json!({
        "schemaVersion": "crewon.device-command-signature-payload.v0",
        "command": command,
        "authorization": authorization,
    });
    serde_json::to_string(&sort_json(payload))
        .map_err(|_| error("device_authorization_payload_invalid"))
}

pub fn verify_device_command_authorization(
    command: &DeviceExecutionCommand,
    trusted_key_id: &str,
    verifying_key: &VerifyingKey,
    now: DateTime<Utc>,
    max_clock_skew: Duration,
) -> Result<(), DeviceProtocolError> {
    let skew_millis = max_clock_skew.num_milliseconds();
    if !(0..=3_600_000).contains(&skew_millis) {
        return Err(error("device_authorization_clock_skew_invalid"));
    }
    if command.authorization.key_id != trusted_key_id {
        return Err(error("device_authorization_key_unknown"));
    }
    let issued_at = DateTime::parse_from_rfc3339(&command.authorization.issued_at)
        .map_err(|_| error("device_authorization_timestamp_invalid"))?;
    let expires_at = DateTime::parse_from_rfc3339(&command.authorization.expires_at)
        .map_err(|_| error("device_authorization_expiry_invalid"))?;
    if issued_at.timestamp_millis() > now.timestamp_millis() + skew_millis
        || expires_at.timestamp_millis() < now.timestamp_millis()
    {
        return Err(error("device_authorization_expired"));
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&command.authorization.signature)
        .map_err(|_| error("device_authorization_signature_invalid"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| error("device_authorization_signature_invalid"))?;
    let payload = canonical_device_command_signing_payload(command)?;
    verifying_key
        .verify_strict(payload.as_bytes(), &signature)
        .map_err(|_| error("device_authorization_signature_invalid"))
}

pub fn parse_device_execution_event(
    value: Value,
) -> Result<DeviceExecutionEvent, DeviceProtocolError> {
    let object = require_object(&value, "device_event_invalid")?;
    exact_keys(
        object,
        &[
            "data",
            "deviceId",
            "executionId",
            "observedAt",
            "protocolVersion",
            "receiptId",
            "schemaVersion",
            "sequence",
            "type",
        ],
    )?;
    require_protocol(object, "crewon.device-event.v0")?;
    for (field, code) in [
        ("deviceId", "device_id_invalid"),
        ("executionId", "device_execution_id_invalid"),
        ("receiptId", "device_receipt_id_invalid"),
    ] {
        require_opaque_id(field_value(object, field, code)?, code)?;
    }
    require_positive(
        field_value(object, "sequence", "device_event_sequence_invalid")?,
        "device_event_sequence_invalid",
    )?;
    require_timestamp(
        field_value(object, "observedAt", "device_event_timestamp_invalid")?,
        "device_event_timestamp_invalid",
    )?;
    let data = require_object(
        field_value(object, "data", "device_event_data_invalid")?,
        "device_event_data_invalid",
    )?;
    match field_value(object, "type", "device_event_type_unsupported")?.as_str() {
        Some("execution.accepted") => {
            exact_keys(data, &["actionDigest", "leaseEpoch"])?;
            require_positive(
                field_value(data, "leaseEpoch", "device_lease_epoch_invalid")?,
                "device_lease_epoch_invalid",
            )?;
            require_digest(
                field_value(data, "actionDigest", "device_action_digest_invalid")?,
                "device_action_digest_invalid",
            )?;
        }
        Some("execution.output") => {
            exact_keys(data, &["channel", "chunk"])?;
            if !matches!(
                field_value(data, "channel", "device_output_channel_invalid")?.as_str(),
                Some("stdout" | "stderr")
            ) {
                return Err(error("device_output_channel_invalid"));
            }
            require_bounded_string(
                field_value(data, "chunk", "device_output_chunk_invalid")?,
                MAX_OUTPUT_CHUNK_BYTES,
                "device_output_chunk_invalid",
            )?;
        }
        Some("execution.completed") => validate_completed_data(data)?,
        Some("execution.failed") => {
            exact_keys(data, &["code", "retryable"])?;
            require_safe_code(
                field_value(data, "code", "device_failure_code_invalid")?,
                "device_failure_code_invalid",
            )?;
            if !field_value(data, "retryable", "device_failure_retryable_invalid")?.is_boolean() {
                return Err(error("device_failure_retryable_invalid"));
            }
        }
        Some("execution.canceled") => {
            exact_keys(data, &["reasonCode"])?;
            require_safe_code(
                field_value(data, "reasonCode", "device_cancel_reason_invalid")?,
                "device_cancel_reason_invalid",
            )?;
        }
        Some("execution.unknown_outcome") => {
            exact_keys(data, &["providerReceiptId"])?;
            require_nullable_opaque_id(
                field_value(
                    data,
                    "providerReceiptId",
                    "device_provider_receipt_id_invalid",
                )?,
                "device_provider_receipt_id_invalid",
            )?;
        }
        _ => return Err(error("device_event_type_unsupported")),
    }
    bounded_json(&value, MAX_DEVICE_EVENT_BYTES, "device_event_too_large")?;
    deserialize(value, "device_event_invalid")
}

pub fn parse_device_execution_ack(value: Value) -> Result<DeviceExecutionAck, DeviceProtocolError> {
    let object = require_object(&value, "device_ack_invalid")?;
    exact_keys(
        object,
        &[
            "acknowledgedAt",
            "deviceId",
            "executionId",
            "protocolVersion",
            "schemaVersion",
            "throughSequence",
        ],
    )?;
    require_protocol(object, "crewon.device-ack.v0")?;
    require_opaque_id(
        field_value(object, "deviceId", "device_id_invalid")?,
        "device_id_invalid",
    )?;
    require_opaque_id(
        field_value(object, "executionId", "device_execution_id_invalid")?,
        "device_execution_id_invalid",
    )?;
    require_positive(
        field_value(object, "throughSequence", "device_ack_sequence_invalid")?,
        "device_ack_sequence_invalid",
    )?;
    require_timestamp(
        field_value(object, "acknowledgedAt", "device_ack_timestamp_invalid")?,
        "device_ack_timestamp_invalid",
    )?;
    deserialize(value, "device_ack_invalid")
}

pub fn parse_device_execution_cancel(
    value: Value,
) -> Result<DeviceExecutionCancel, DeviceProtocolError> {
    let object = require_object(&value, "device_cancel_invalid")?;
    exact_keys(
        object,
        &[
            "deviceId",
            "executionId",
            "leaseEpoch",
            "leaseId",
            "protocolVersion",
            "reasonCode",
            "requestedAt",
            "schemaVersion",
        ],
    )?;
    require_protocol(object, "crewon.device-cancel.v0")?;
    require_opaque_id(
        field_value(object, "deviceId", "device_id_invalid")?,
        "device_id_invalid",
    )?;
    require_opaque_id(
        field_value(object, "executionId", "device_execution_id_invalid")?,
        "device_execution_id_invalid",
    )?;
    require_opaque_id(
        field_value(object, "leaseId", "device_lease_id_invalid")?,
        "device_lease_id_invalid",
    )?;
    require_positive(
        field_value(object, "leaseEpoch", "device_lease_epoch_invalid")?,
        "device_lease_epoch_invalid",
    )?;
    require_safe_code(
        field_value(object, "reasonCode", "device_cancel_reason_invalid")?,
        "device_cancel_reason_invalid",
    )?;
    require_timestamp(
        field_value(object, "requestedAt", "device_cancel_timestamp_invalid")?,
        "device_cancel_timestamp_invalid",
    )?;
    bounded_json(&value, MAX_DEVICE_EVENT_BYTES, "device_cancel_too_large")?;
    deserialize(value, "device_cancel_invalid")
}

pub fn parse_device_hello(value: Value) -> Result<DeviceHello, DeviceProtocolError> {
    let object = require_object(&value, "device_hello_invalid")?;
    exact_keys(
        object,
        &[
            "capabilities",
            "connectionId",
            "deviceId",
            "lastAcknowledged",
            "schemaVersion",
            "sentAt",
            "supportedProtocolVersions",
        ],
    )?;
    if field_value(object, "schemaVersion", "device_protocol_unsupported")?.as_str()
        != Some("crewon.device-hello.v0")
    {
        return Err(error("device_protocol_unsupported"));
    }
    let versions = field_value(
        object,
        "supportedProtocolVersions",
        "device_protocol_unsupported",
    )?
    .as_array()
    .ok_or_else(|| error("device_protocol_unsupported"))?;
    if versions.len() != 1 || versions[0].as_u64() != Some(DEVICE_PROTOCOL_VERSION) {
        return Err(error("device_protocol_unsupported"));
    }
    require_opaque_id(
        field_value(object, "deviceId", "device_id_invalid")?,
        "device_id_invalid",
    )?;
    require_opaque_id(
        field_value(object, "connectionId", "device_connection_id_invalid")?,
        "device_connection_id_invalid",
    )?;
    let capabilities = field_value(object, "capabilities", "device_capabilities_invalid")?
        .as_array()
        .ok_or_else(|| error("device_capabilities_invalid"))?;
    if capabilities.len() > MAX_CAPABILITIES {
        return Err(error("device_capabilities_invalid"));
    }
    let mut unique_capabilities = HashSet::new();
    for capability in capabilities {
        require_capability(capability)?;
        if !unique_capabilities.insert(capability.as_str().unwrap_or_default()) {
            return Err(error("device_capabilities_invalid"));
        }
    }
    let acknowledged = field_value(object, "lastAcknowledged", "device_acknowledged_invalid")?
        .as_array()
        .ok_or_else(|| error("device_acknowledged_invalid"))?;
    if acknowledged.len() > MAX_ACKNOWLEDGED_EXECUTIONS {
        return Err(error("device_acknowledged_invalid"));
    }
    let mut executions = HashSet::new();
    for item in acknowledged {
        let item = require_object(item, "device_acknowledged_invalid")?;
        exact_keys(item, &["executionId", "sequence"])?;
        let execution_id = field_value(item, "executionId", "device_execution_id_invalid")?;
        require_opaque_id(execution_id, "device_execution_id_invalid")?;
        require_non_negative(
            field_value(item, "sequence", "device_ack_sequence_invalid")?,
            "device_ack_sequence_invalid",
        )?;
        if !executions.insert(execution_id.as_str().unwrap_or_default()) {
            return Err(error("device_acknowledged_invalid"));
        }
    }
    require_timestamp(
        field_value(object, "sentAt", "device_hello_timestamp_invalid")?,
        "device_hello_timestamp_invalid",
    )?;
    bounded_json(&value, MAX_DEVICE_EVENT_BYTES, "device_hello_too_large")?;
    deserialize(value, "device_hello_invalid")
}

pub fn parse_device_gateway_welcome(
    value: Value,
) -> Result<DeviceGatewayWelcome, DeviceProtocolError> {
    let object = require_object(&value, "device_welcome_invalid")?;
    exact_keys(
        object,
        &[
            "connectionEpoch",
            "connectionId",
            "deviceId",
            "gatewayId",
            "leaseExpiresAt",
            "protocolVersion",
            "schemaVersion",
            "sentAt",
        ],
    )?;
    require_protocol(object, "crewon.device-welcome.v0")?;
    require_opaque_id(
        field_value(object, "deviceId", "device_id_invalid")?,
        "device_id_invalid",
    )?;
    require_opaque_id(
        field_value(object, "connectionId", "device_connection_id_invalid")?,
        "device_connection_id_invalid",
    )?;
    require_opaque_id(
        field_value(object, "gatewayId", "device_gateway_id_invalid")?,
        "device_gateway_id_invalid",
    )?;
    require_positive(
        field_value(object, "connectionEpoch", "device_connection_epoch_invalid")?,
        "device_connection_epoch_invalid",
    )?;
    require_timestamp(
        field_value(object, "leaseExpiresAt", "device_connection_lease_invalid")?,
        "device_connection_lease_invalid",
    )?;
    require_timestamp(
        field_value(object, "sentAt", "device_welcome_timestamp_invalid")?,
        "device_welcome_timestamp_invalid",
    )?;
    bounded_json(&value, MAX_DEVICE_EVENT_BYTES, "device_welcome_too_large")?;
    deserialize(value, "device_welcome_invalid")
}

fn validate_completed_data(data: &Map<String, Value>) -> Result<(), DeviceProtocolError> {
    exact_keys(
        data,
        &[
            "artifactRef",
            "exitCode",
            "exitSignal",
            "output",
            "outputDigest",
            "stderrDigest",
            "stdoutDigest",
        ],
    )?;
    require_nullable_bounded_string(
        field_value(data, "output", "device_output_invalid")?,
        MAX_TERMINAL_OUTPUT_BYTES,
        "device_output_invalid",
    )?;
    require_nullable_opaque_id(
        field_value(data, "artifactRef", "device_artifact_ref_invalid")?,
        "device_artifact_ref_invalid",
    )?;
    for field in ["outputDigest", "stdoutDigest", "stderrDigest"] {
        require_digest(
            field_value(data, field, "device_output_digest_invalid")?,
            "device_output_digest_invalid",
        )?;
    }
    let exit_code = field_value(data, "exitCode", "device_exit_code_invalid")?;
    if !exit_code.is_null()
        && exit_code
            .as_i64()
            .and_then(|value| i32::try_from(value).ok())
            .is_none()
    {
        return Err(error("device_exit_code_invalid"));
    }
    let exit_signal = field_value(data, "exitSignal", "device_exit_signal_invalid")?;
    if !exit_signal.is_null() {
        require_safe_code(exit_signal, "device_exit_signal_invalid")?;
    }
    Ok(())
}

fn validate_limits(value: &Value) -> Result<(), DeviceProtocolError> {
    let limits = require_object(value, "device_limits_invalid")?;
    exact_keys(limits, &["maxArtifactBytes", "maxOutputBytes", "timeoutMs"])?;
    require_positive_at_most(
        field_value(limits, "timeoutMs", "device_timeout_invalid")?,
        MAX_TIMEOUT_MS,
        "device_timeout_invalid",
    )?;
    require_positive_at_most(
        field_value(limits, "maxOutputBytes", "device_output_limit_invalid")?,
        MAX_OUTPUT_BYTES,
        "device_output_limit_invalid",
    )?;
    require_positive_at_most(
        field_value(limits, "maxArtifactBytes", "device_artifact_limit_invalid")?,
        MAX_ARTIFACT_BYTES,
        "device_artifact_limit_invalid",
    )?;
    Ok(())
}

fn validate_trace_context(value: &Value) -> Result<(), DeviceProtocolError> {
    let trace = require_object(value, "device_trace_context_invalid")?;
    exact_keys(trace, &["traceparent", "tracestate"])?;
    let traceparent = field_value(trace, "traceparent", "device_traceparent_invalid")?;
    if !traceparent.is_null() && !traceparent.as_str().is_some_and(valid_traceparent) {
        return Err(error("device_traceparent_invalid"));
    }
    let tracestate = field_value(trace, "tracestate", "device_tracestate_invalid")?;
    if !tracestate.is_null()
        && !tracestate.as_str().is_some_and(|value| {
            value.encode_utf16().count() <= 512 && !value.contains(['\r', '\n'])
        })
    {
        return Err(error("device_tracestate_invalid"));
    }
    Ok(())
}

fn validate_authorization(
    value: &Value,
    action_digest: &Value,
    command_expires_at: &Value,
) -> Result<(), DeviceProtocolError> {
    let authorization = require_object(value, "device_authorization_invalid")?;
    exact_keys(
        authorization,
        &[
            "approvalProof",
            "expiresAt",
            "issuedAt",
            "keyId",
            "schemaVersion",
            "scheme",
            "signature",
        ],
    )?;
    if field_value(
        authorization,
        "schemaVersion",
        "device_authorization_invalid",
    )?
    .as_str()
        != Some("crewon.device-authorization.v0")
        || field_value(authorization, "scheme", "device_authorization_invalid")?.as_str()
            != Some("ed25519")
    {
        return Err(error("device_authorization_invalid"));
    }
    require_opaque_id(
        field_value(authorization, "keyId", "device_authorization_key_invalid")?,
        "device_authorization_key_invalid",
    )?;
    let issued_at = field_value(
        authorization,
        "issuedAt",
        "device_authorization_timestamp_invalid",
    )?;
    let expires_at = field_value(
        authorization,
        "expiresAt",
        "device_authorization_expiry_invalid",
    )?;
    require_timestamp(issued_at, "device_authorization_timestamp_invalid")?;
    require_timestamp(expires_at, "device_authorization_expiry_invalid")?;
    if timestamp_millis(expires_at)? <= timestamp_millis(issued_at)?
        || timestamp_millis(expires_at)? > timestamp_millis(command_expires_at)?
    {
        return Err(error("device_authorization_expiry_invalid"));
    }
    if !field_value(
        authorization,
        "signature",
        "device_authorization_signature_invalid",
    )?
    .as_str()
    .is_some_and(|signature| {
        signature.len() == 86
            && signature
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        return Err(error("device_authorization_signature_invalid"));
    }
    let proof = field_value(
        authorization,
        "approvalProof",
        "device_approval_proof_invalid",
    )?;
    if proof.is_null() {
        return Ok(());
    }
    let proof = require_object(proof, "device_approval_proof_invalid")?;
    exact_keys(
        proof,
        &[
            "actionDigest",
            "approvalId",
            "approvalRevision",
            "decidedAt",
            "policySnapshotId",
            "schemaVersion",
        ],
    )?;
    if field_value(proof, "schemaVersion", "device_approval_proof_invalid")?.as_str()
        != Some("crewon.device-approval-proof.v0")
        || field_value(proof, "actionDigest", "device_approval_proof_invalid")? != action_digest
        || !field_value(proof, "approvalRevision", "device_approval_proof_invalid")?
            .as_u64()
            .is_some_and(|revision| (2..=JS_MAX_SAFE_INTEGER).contains(&revision))
    {
        return Err(error("device_approval_proof_invalid"));
    }
    require_opaque_id(
        field_value(proof, "approvalId", "device_approval_proof_invalid")?,
        "device_approval_proof_invalid",
    )?;
    require_opaque_id(
        field_value(proof, "policySnapshotId", "device_approval_proof_invalid")?,
        "device_approval_proof_invalid",
    )?;
    let decided_at = field_value(proof, "decidedAt", "device_approval_proof_invalid")?;
    require_timestamp(decided_at, "device_approval_proof_invalid")?;
    if timestamp_millis(decided_at)? > timestamp_millis(issued_at)? {
        return Err(error("device_approval_proof_invalid"));
    }
    Ok(())
}

fn require_protocol(object: &Map<String, Value>, schema: &str) -> Result<(), DeviceProtocolError> {
    if field_value(object, "schemaVersion", "device_protocol_unsupported")?.as_str() != Some(schema)
        || field_value(object, "protocolVersion", "device_protocol_unsupported")?.as_u64()
            != Some(DEVICE_PROTOCOL_VERSION)
    {
        return Err(error("device_protocol_unsupported"));
    }
    Ok(())
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str]) -> Result<(), DeviceProtocolError> {
    if object.len() != expected.len() || expected.iter().any(|field| !object.contains_key(*field)) {
        return Err(error("device_fields_invalid"));
    }
    Ok(())
}

fn require_object<'a>(
    value: &'a Value,
    code: &'static str,
) -> Result<&'a Map<String, Value>, DeviceProtocolError> {
    value.as_object().ok_or_else(|| error(code))
}

fn field_value<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    code: &'static str,
) -> Result<&'a Value, DeviceProtocolError> {
    object.get(field).ok_or_else(|| error(code))
}

fn require_opaque_id(value: &Value, code: &'static str) -> Result<(), DeviceProtocolError> {
    if !value.as_str().is_some_and(|value| {
        !value.is_empty()
            && value.len() <= 512
            && value.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphanumeric()
                    || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
            })
    }) {
        return Err(error(code));
    }
    Ok(())
}

fn require_nullable_opaque_id(
    value: &Value,
    code: &'static str,
) -> Result<(), DeviceProtocolError> {
    if value.is_null() {
        Ok(())
    } else {
        require_opaque_id(value, code)
    }
}

fn require_capability(value: &Value) -> Result<(), DeviceProtocolError> {
    if !value.as_str().is_some_and(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value.as_bytes()[0].is_ascii_lowercase()
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
            && !value
                .as_bytes()
                .windows(2)
                .any(|pair| is_separator(pair[0]) && is_separator(pair[1]))
            && !is_separator(*value.as_bytes().last().unwrap_or(&b'.'))
            && value.bytes().filter(|byte| is_separator(*byte)).count() <= 15
    }) {
        return Err(error("device_capability_invalid"));
    }
    Ok(())
}

fn require_digest(value: &Value, code: &'static str) -> Result<(), DeviceProtocolError> {
    if !value.as_str().is_some_and(|value| {
        value.len() == 71 && value.starts_with("sha256:") && value[7..].bytes().all(is_lower_hex)
    }) {
        return Err(error(code));
    }
    Ok(())
}

fn require_safe_code(value: &Value, code: &'static str) -> Result<(), DeviceProtocolError> {
    if !value.as_str().is_some_and(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
    }) {
        return Err(error(code));
    }
    Ok(())
}

fn require_bounded_string(
    value: &Value,
    max_bytes: usize,
    code: &'static str,
) -> Result<(), DeviceProtocolError> {
    if value.as_str().is_none_or(|value| value.len() > max_bytes) {
        return Err(error(code));
    }
    Ok(())
}

fn require_nullable_bounded_string(
    value: &Value,
    max_bytes: usize,
    code: &'static str,
) -> Result<(), DeviceProtocolError> {
    if value.is_null() {
        Ok(())
    } else {
        require_bounded_string(value, max_bytes, code)
    }
}

fn require_positive(value: &Value, code: &'static str) -> Result<(), DeviceProtocolError> {
    require_positive_at_most(value, JS_MAX_SAFE_INTEGER, code)
}

fn require_non_negative(value: &Value, code: &'static str) -> Result<(), DeviceProtocolError> {
    if value
        .as_u64()
        .is_none_or(|value| value > JS_MAX_SAFE_INTEGER)
    {
        return Err(error(code));
    }
    Ok(())
}

fn require_positive_at_most(
    value: &Value,
    maximum: u64,
    code: &'static str,
) -> Result<(), DeviceProtocolError> {
    if !value
        .as_u64()
        .is_some_and(|value| value >= 1 && value <= maximum)
    {
        return Err(error(code));
    }
    Ok(())
}

fn require_timestamp(value: &Value, code: &'static str) -> Result<(), DeviceProtocolError> {
    if !value.as_str().is_some_and(|value| {
        valid_timestamp_shape(value) && DateTime::parse_from_rfc3339(value).is_ok()
    }) {
        return Err(error(code));
    }
    Ok(())
}

fn bounded_json(
    value: &Value,
    max_bytes: usize,
    code: &'static str,
) -> Result<(), DeviceProtocolError> {
    if json_depth_exceeded(value, 0)
        || serde_json::to_vec(value).map_err(|_| error(code))?.len() > max_bytes
    {
        return Err(error(code));
    }
    Ok(())
}

fn json_depth_exceeded(value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return true;
    }
    match value {
        Value::Array(items) => items
            .iter()
            .any(|item| json_depth_exceeded(item, depth + 1)),
        Value::Object(object) => object
            .values()
            .any(|item| json_depth_exceeded(item, depth + 1)),
        _ => false,
    }
}

fn valid_traceparent(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    parts.len() == 4
        && [2, 32, 16, 2]
            .into_iter()
            .zip(parts)
            .all(|(length, part)| part.len() == length && part.bytes().all(is_lower_hex))
}

fn valid_timestamp_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes.last() != Some(&b'Z')
    {
        return false;
    }
    let fixed_digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
    if fixed_digits
        .into_iter()
        .any(|index| !bytes[index].is_ascii_digit())
    {
        return false;
    }
    bytes.len() == 20
        || (bytes[19] == b'.'
            && bytes.len() > 21
            && bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit))
}

fn timestamp_millis(value: &Value) -> Result<i64, DeviceProtocolError> {
    DateTime::parse_from_rfc3339(
        value
            .as_str()
            .ok_or_else(|| error("device_authorization_timestamp_invalid"))?,
    )
    .map(|timestamp| timestamp.timestamp_millis())
    .map_err(|_| error("device_authorization_timestamp_invalid"))
}

fn sort_json(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(sort_json).collect()),
        Value::Object(object) => {
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, sort_json(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

fn deserialize<T: DeserializeOwned>(
    value: Value,
    code: &'static str,
) -> Result<T, DeviceProtocolError> {
    serde_json::from_value(value).map_err(|_| error(code))
}

fn is_separator(byte: u8) -> bool {
    matches!(byte, b'.' | b'_' | b':' | b'-')
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn error(code: &'static str) -> DeviceProtocolError {
    DeviceProtocolError { code }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
