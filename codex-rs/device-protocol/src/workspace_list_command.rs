use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use ed25519_dalek::Signature;
use ed25519_dalek::VerifyingKey;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use super::DEVICE_PROTOCOL_VERSION;
use super::DeviceCommandAuthorization;
use super::DeviceProtocolError;
use super::DeviceTraceContext;
use super::MAX_DEVICE_COMMAND_BYTES;
use super::bounded_json;
use super::deserialize;
use super::error;
use super::exact_keys;
use super::field_value;
use super::require_digest;
use super::require_object;
use super::require_opaque_id;
use super::require_positive;
use super::require_positive_at_most;
use super::require_timestamp;
use super::sort_json;
use super::validate_authorization;
use super::validate_trace_context;

const MAX_ENTRIES: u64 = 200;
const MAX_NAME_BYTES: u64 = 255;
const MAX_OUTPUT_BYTES: u64 = 64 * 1024;
const MAX_SCANNED_ENTRIES: u64 = 10_000;
const MAX_SCANNED_NAME_BYTES: u64 = 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListLimits {
    pub depth: u64,
    pub max_entries: u64,
    pub max_name_bytes: u64,
    pub max_output_bytes: u64,
    pub max_scanned_entries: u64,
    pub max_scanned_name_bytes: u64,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListCommand {
    pub schema_version: String,
    pub protocol_version: u64,
    pub command_kind: String,
    pub device_id: String,
    pub execution_id: String,
    pub lease_id: String,
    pub lease_epoch: u64,
    pub expires_at: String,
    pub workspace_binding_id: String,
    pub incarnation_id: String,
    pub device_binding_id: String,
    pub runtime_binding_id: String,
    pub policy_snapshot_id: String,
    pub operation: String,
    pub limits: DeviceWorkspaceListLimits,
    pub action_digest: String,
    pub command_digest: String,
    pub idempotency_key: String,
    pub trace_context: DeviceTraceContext,
    pub authorization: DeviceCommandAuthorization,
}

pub fn parse_device_workspace_list_command(
    value: Value,
) -> Result<DeviceWorkspaceListCommand, DeviceProtocolError> {
    let object = require_object(&value, "device_workspace_command_invalid")?;
    exact_keys(
        object,
        &[
            "actionDigest",
            "authorization",
            "commandDigest",
            "commandKind",
            "deviceBindingId",
            "deviceId",
            "executionId",
            "expiresAt",
            "idempotencyKey",
            "incarnationId",
            "leaseEpoch",
            "leaseId",
            "limits",
            "operation",
            "policySnapshotId",
            "protocolVersion",
            "runtimeBindingId",
            "schemaVersion",
            "traceContext",
            "workspaceBindingId",
        ],
    )?;
    if field_value(
        object,
        "schemaVersion",
        "device_workspace_protocol_unsupported",
    )?
    .as_str()
        != Some("crewon.device-workspace-list-command.v0")
        || field_value(
            object,
            "protocolVersion",
            "device_workspace_protocol_unsupported",
        )?
        .as_u64()
            != Some(DEVICE_PROTOCOL_VERSION)
        || field_value(
            object,
            "commandKind",
            "device_workspace_protocol_unsupported",
        )?
        .as_str()
            != Some("workspaceList")
        || field_value(object, "operation", "device_workspace_protocol_unsupported")?.as_str()
            != Some("listTopLevel")
    {
        return Err(error("device_workspace_protocol_unsupported"));
    }
    for (field, code) in [
        ("deviceId", "device_id_invalid"),
        ("executionId", "device_execution_id_invalid"),
        ("leaseId", "device_lease_id_invalid"),
        ("workspaceBindingId", "device_workspace_binding_invalid"),
        ("incarnationId", "device_workspace_incarnation_invalid"),
        ("deviceBindingId", "device_binding_id_invalid"),
        ("runtimeBindingId", "device_runtime_binding_id_invalid"),
        ("policySnapshotId", "device_policy_snapshot_id_invalid"),
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
    require_digest(
        field_value(object, "actionDigest", "device_action_digest_invalid")?,
        "device_action_digest_invalid",
    )?;
    require_digest(
        field_value(object, "commandDigest", "device_command_digest_invalid")?,
        "device_command_digest_invalid",
    )?;
    validate_workspace_list_limits(field_value(
        object,
        "limits",
        "device_workspace_limits_invalid",
    )?)?;
    validate_trace_context(field_value(
        object,
        "traceContext",
        "device_trace_context_invalid",
    )?)?;
    let authorization = field_value(object, "authorization", "device_authorization_invalid")?;
    let authorization_object = require_object(authorization, "device_authorization_invalid")?;
    exact_keys(
        authorization_object,
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
        authorization_object,
        "approvalProof",
        "device_approval_proof_forbidden",
    )?
    .is_null()
    {
        validate_authorization(
            authorization,
            field_value(object, "actionDigest", "device_action_digest_invalid")?,
            field_value(object, "expiresAt", "device_lease_expiry_invalid")?,
        )?;
    } else {
        return Err(error("device_approval_proof_forbidden"));
    }
    bounded_json(&value, MAX_DEVICE_COMMAND_BYTES, "device_command_too_large")?;
    deserialize(value, "device_workspace_command_invalid")
}

pub fn canonical_device_workspace_list_command_signing_payload(
    command: &DeviceWorkspaceListCommand,
) -> Result<String, DeviceProtocolError> {
    let command =
        serde_json::to_value(command).map_err(|_| error("device_authorization_payload_invalid"))?;
    let command = parse_device_workspace_list_command(command)?;
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
        "schemaVersion": "crewon.device-workspace-list-command-signature-payload.v0",
        "command": command,
        "authorization": authorization,
    });
    serde_json::to_string(&sort_json(payload))
        .map_err(|_| error("device_authorization_payload_invalid"))
}

pub fn verify_device_workspace_list_command_authorization(
    command: &DeviceWorkspaceListCommand,
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
    let payload = canonical_device_workspace_list_command_signing_payload(command)?;
    verifying_key
        .verify_strict(payload.as_bytes(), &signature)
        .map_err(|_| error("device_authorization_signature_invalid"))
}

fn validate_workspace_list_limits(value: &Value) -> Result<(), DeviceProtocolError> {
    let limits = require_object(value, "device_workspace_limits_invalid")?;
    exact_keys(
        limits,
        &[
            "depth",
            "maxEntries",
            "maxNameBytes",
            "maxOutputBytes",
            "maxScannedEntries",
            "maxScannedNameBytes",
            "timeoutMs",
        ],
    )?;
    if field_value(limits, "depth", "device_workspace_depth_invalid")?.as_u64() != Some(0) {
        return Err(error("device_workspace_depth_invalid"));
    }
    for (field, maximum) in [
        ("maxEntries", MAX_ENTRIES),
        ("maxNameBytes", MAX_NAME_BYTES),
        ("maxOutputBytes", MAX_OUTPUT_BYTES),
        ("maxScannedEntries", MAX_SCANNED_ENTRIES),
        ("maxScannedNameBytes", MAX_SCANNED_NAME_BYTES),
        ("timeoutMs", MAX_TIMEOUT_MS),
    ] {
        require_positive_at_most(
            field_value(limits, field, "device_workspace_limits_invalid")?,
            maximum,
            "device_workspace_limits_invalid",
        )?;
    }
    let max_entries = field_value(limits, "maxEntries", "device_workspace_limits_invalid")?
        .as_u64()
        .ok_or_else(|| error("device_workspace_limits_invalid"))?;
    let max_name_bytes = field_value(limits, "maxNameBytes", "device_workspace_limits_invalid")?
        .as_u64()
        .ok_or_else(|| error("device_workspace_limits_invalid"))?;
    if field_value(
        limits,
        "maxScannedEntries",
        "device_workspace_limits_invalid",
    )?
    .as_u64()
    .is_none_or(|value| value < max_entries)
        || field_value(
            limits,
            "maxScannedNameBytes",
            "device_workspace_limits_invalid",
        )?
        .as_u64()
        .is_none_or(|value| value < max_name_bytes)
    {
        return Err(error("device_workspace_limits_invalid"));
    }
    Ok(())
}
