use crewon_app_server_protocol::JSONRPCErrorError;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use uuid::Uuid;

use crate::error_code::invalid_params;

const OFFICE_RECORD_ID_FIELD: &str = "recordId";
const OFFICE_RECORD_REVISION_FIELD: &str = "recordRevision";
const LEGACY_RECORD_ID_PREFIX: &str = "legacy-";
const MAX_RECORD_ID_BYTES: usize = 128;

pub(super) fn assign_new(config: &mut JsonValue) -> Result<(), JSONRPCErrorError> {
    let workspace = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))?;
    workspace.insert(
        OFFICE_RECORD_ID_FIELD.to_string(),
        JsonValue::String(Uuid::now_v7().to_string()),
    );
    workspace.insert(
        OFFICE_RECORD_REVISION_FIELD.to_string(),
        JsonValue::String(Uuid::now_v7().to_string()),
    );
    Ok(())
}

pub(super) fn record_id(config: &JsonValue) -> Option<&str> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get(OFFICE_RECORD_ID_FIELD))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|record_id| !record_id.is_empty())
}

pub(super) fn authority_record_id(
    config: &JsonValue,
    file_path: &Path,
) -> Result<String, JSONRPCErrorError> {
    let workspace = config
        .get("workspace")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| invalid_params("office config is missing workspace"))?;
    match workspace.get(OFFICE_RECORD_ID_FIELD) {
        Some(JsonValue::String(record_id)) => {
            validate_authority_record_id(record_id)?;
            Ok(record_id.clone())
        }
        Some(_) => Err(invalid_params("office recordId must be a string")),
        None => {
            let file_name = file_path
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid_params("office record path is invalid"))?;
            Ok(legacy_record_id(file_name))
        }
    }
}

pub(super) fn legacy_record_id(file_name: &str) -> String {
    let digest = Sha256::digest(file_name.as_bytes());
    format!("{LEGACY_RECORD_ID_PREFIX}{digest:x}")
}

fn validate_authority_record_id(record_id: &str) -> Result<(), JSONRPCErrorError> {
    if record_id.is_empty()
        || record_id.trim() != record_id
        || record_id.len() > MAX_RECORD_ID_BYTES
        || record_id.chars().any(char::is_whitespace)
        || record_id.chars().any(char::is_control)
    {
        return Err(invalid_params("office recordId is invalid"));
    }
    Ok(())
}
