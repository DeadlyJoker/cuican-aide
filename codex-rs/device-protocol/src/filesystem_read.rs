use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

use crate::DeviceExecutionCommand;
use crate::DeviceProtocolError;
use crate::canonical_device_command_signing_payload;
use crate::parse_device_execution_command;

pub const DEVICE_FILESYSTEM_READ_CAPABILITY: &str = "workspace.read_file.v0";
pub const MAX_DEVICE_FILESYSTEM_READ_BYTES: u64 = 64 * 1024;
pub const MAX_DEVICE_FILESYSTEM_READ_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceFilesystemReadArguments {
    pub schema_version: String,
    pub workspace_incarnation_id: String,
    pub relative_path_segments: Vec<String>,
    pub encoding: String,
}

pub fn canonical_device_filesystem_read_command_digest(
    command: &DeviceFilesystemReadCommand,
) -> Result<String, DeviceProtocolError> {
    let payload = canonical_device_command_signing_payload(&command.command)?;
    Ok(format!("sha256:{:x}", Sha256::digest(payload.as_bytes())))
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceFilesystemReadCommand {
    pub command: DeviceExecutionCommand,
    pub arguments: DeviceFilesystemReadArguments,
}

pub fn parse_device_filesystem_read_command(
    value: Value,
) -> Result<DeviceFilesystemReadCommand, DeviceProtocolError> {
    let command = parse_device_execution_command(value)?;
    if command.capability != DEVICE_FILESYSTEM_READ_CAPABILITY
        || command.payload_ref.is_some()
        || command.authorization.approval_proof.is_some()
        || command.limits.max_output_bytes > MAX_DEVICE_FILESYSTEM_READ_BYTES
        || command.limits.timeout_ms > MAX_DEVICE_FILESYSTEM_READ_TIMEOUT_MS
    {
        return Err(DeviceProtocolError {
            code: "device_filesystem_read_command_invalid",
        });
    }
    let arguments: DeviceFilesystemReadArguments =
        serde_json::from_value(command.arguments.clone().ok_or(DeviceProtocolError {
            code: "device_filesystem_read_arguments_invalid",
        })?)
        .map_err(|_| DeviceProtocolError {
            code: "device_filesystem_read_arguments_invalid",
        })?;
    if arguments.schema_version != "crewon.device-filesystem-read-arguments.v0"
        || arguments.encoding != "utf8"
        || !opaque_id(&arguments.workspace_incarnation_id)
        || arguments.relative_path_segments.is_empty()
        || arguments.relative_path_segments.len() > 32
        || arguments
            .relative_path_segments
            .iter()
            .any(|component| !canonical_component(component))
    {
        return Err(DeviceProtocolError {
            code: "device_filesystem_read_path_invalid",
        });
    }
    Ok(DeviceFilesystemReadCommand { command, arguments })
}

fn opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn canonical_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 255
        && !value
            .bytes()
            .any(|byte| matches!(byte, 0 | b'/' | b'\\' | b':'))
}
