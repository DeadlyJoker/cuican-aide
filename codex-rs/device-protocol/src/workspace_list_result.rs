use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

use super::DeviceProtocolError;
use super::bounded_json;
use super::error;
use super::field_value;
use super::require_digest;
use super::require_object;
use super::require_opaque_id;

const MAX_ENTRIES: usize = 200;
const MAX_NAME_BYTES: usize = 255;
const MAX_RESULT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListResult {
    pub schema_version: String,
    pub execution_id: String,
    pub action_digest: String,
    pub command_digest: String,
    pub entries: Vec<DeviceWorkspaceListEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListEntry {
    pub name: String,
    pub kind: DeviceWorkspaceListEntryKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceWorkspaceListEntryKind {
    File,
    Directory,
}

pub(super) fn validate_workspace_list_result(
    value: &Value,
    expected_execution_id: &Value,
    expected_action_digest: &Value,
    expected_command_digest: &Value,
) -> Result<(), DeviceProtocolError> {
    let result = require_object(value, "device_workspace_result_invalid")?;
    exact_workspace_keys(
        result,
        &[
            "actionDigest",
            "commandDigest",
            "entries",
            "executionId",
            "schemaVersion",
            "truncated",
        ],
    )?;
    if field_value(result, "schemaVersion", "device_workspace_result_invalid")?.as_str()
        != Some("crewon.workspace-list-result.v0")
        || !field_value(result, "truncated", "device_workspace_result_invalid")?.is_boolean()
    {
        return Err(error("device_workspace_result_invalid"));
    }
    for (field, code) in [
        ("executionId", "device_execution_id_invalid"),
        ("actionDigest", "device_action_digest_invalid"),
        ("commandDigest", "device_command_digest_invalid"),
    ] {
        if field == "executionId" {
            require_opaque_id(field_value(result, field, code)?, code)?;
        } else {
            require_digest(field_value(result, field, code)?, code)?;
        }
    }
    if field_value(result, "executionId", "device_execution_id_invalid")?
        != expected_execution_id
        || field_value(result, "actionDigest", "device_action_digest_invalid")?
            != expected_action_digest
        || field_value(result, "commandDigest", "device_command_digest_invalid")?
            != expected_command_digest
    {
        return Err(error("device_workspace_result_identity_mismatch"));
    }
    let entries = field_value(result, "entries", "device_workspace_result_invalid")?
        .as_array()
        .ok_or_else(|| error("device_workspace_result_invalid"))?;
    if entries.len() > MAX_ENTRIES {
        return Err(error("device_workspace_result_invalid"));
    }
    let mut prior_name: Option<&[u8]> = None;
    for entry in entries {
        let entry = require_object(entry, "device_workspace_result_invalid")?;
        exact_workspace_keys(entry, &["kind", "name"])?;
        if !matches!(
            field_value(entry, "kind", "device_workspace_result_invalid")?.as_str(),
            Some("file" | "directory")
        ) {
            return Err(error("device_workspace_result_invalid"));
        }
        let name = field_value(entry, "name", "device_workspace_result_invalid")?
            .as_str()
            .ok_or_else(|| error("device_workspace_result_invalid"))?;
        validate_workspace_entry_name(name)?;
        if prior_name.is_some_and(|prior| prior >= name.as_bytes()) {
            return Err(error("device_workspace_result_invalid"));
        }
        prior_name = Some(name.as_bytes());
    }
    bounded_json(value, MAX_RESULT_BYTES, "device_workspace_result_too_large")
}

fn validate_workspace_entry_name(name: &str) -> Result<(), DeviceProtocolError> {
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || matches!(name, "." | "..")
        || name.contains(['/', '\\'])
        || name.chars().any(is_unsafe_name_character)
    {
        return Err(error("device_workspace_entry_name_invalid"));
    }
    Ok(())
}

fn is_unsafe_name_character(character: char) -> bool {
    character.is_control()
        || matches!(character, '\u{2028}' | '\u{2029}')
        || matches!(
            character as u32,
            0x00ad
                | 0x061c
                | 0x06dd
                | 0x070f
                | 0x08e2
                | 0x180e
                | 0xfeff
                | 0x110bd
                | 0x110cd
                | 0xe0001
        )
        || matches!(
            character as u32,
            0x0600..=0x0605
                | 0x0890..=0x0891
                | 0x200b..=0x200f
                | 0x202a..=0x202e
                | 0x2060..=0x2064
                | 0x2066..=0x206f
                | 0xfff9..=0xfffb
                | 0x13430..=0x1343f
                | 0x1bca0..=0x1bca3
                | 0x1d173..=0x1d17a
                | 0xe0020..=0xe007f
        )
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
