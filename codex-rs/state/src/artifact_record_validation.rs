use crate::ArtifactPayloadRecord;
use crate::ArtifactPayloadSensitivity;
use crate::ArtifactRecordError;
use crate::ArtifactRecordErrorKind;
use crate::ArtifactRetentionKind;
use crate::MAX_ARTIFACT_RECORD_JSON_BYTES;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;

const MAX_RECORD_ID_BYTES: usize = 512;
const MAX_RECORD_TYPE_BYTES: usize = 128;
const MAX_METADATA_DEPTH: usize = 32;
const MAX_METADATA_NODES: usize = 4_096;

pub(crate) fn digest_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{digest:x}")
}

pub(crate) fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.artifact-state.v1\0");
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("sha256:{:x}", hasher.finalize())
}

pub(crate) fn validate_json(
    json: &str,
    field: &'static str,
    allowed_fields: &[&str],
) -> Result<(), ArtifactRecordError> {
    if json.len() > MAX_ARTIFACT_RECORD_JSON_BYTES {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::TooLong,
        ));
    }
    let value = json_value(json, field)?;
    let object = value
        .as_object()
        .ok_or_else(|| ArtifactRecordError::new(field, ArtifactRecordErrorKind::InvalidJson))?;
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = allowed_fields.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::InconsistentFields,
        ));
    }
    let mut nodes = 0;
    validate_metadata_value(&value, field, /*depth*/ 0, &mut nodes)
}

pub(crate) fn json_value(json: &str, field: &'static str) -> Result<Value, ArtifactRecordError> {
    serde_json::from_str(json)
        .map_err(|_| ArtifactRecordError::new(field, ArtifactRecordErrorKind::InvalidJson))
}

fn validate_metadata_value(
    value: &Value,
    field: &'static str,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), ArtifactRecordError> {
    if depth > MAX_METADATA_DEPTH {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::TooLong,
        ));
    }
    *nodes += 1;
    if *nodes > MAX_METADATA_NODES {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::TooLong,
        ));
    }
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if sensitive_key(key) {
                    return Err(ArtifactRecordError::new(
                        field,
                        ArtifactRecordErrorKind::SensitiveMetadata,
                    ));
                }
                validate_metadata_value(child, field, depth + 1, nodes)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_metadata_value(item, field, depth + 1, nodes)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn sensitive_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "arguments"
            | "body"
            | "content"
            | "credential"
            | "metadata"
            | "path"
            | "raw"
            | "result"
            | "secret"
            | "text"
            | "url"
    )
}

pub(crate) fn validate_id(value: &str, field: &'static str) -> Result<(), ArtifactRecordError> {
    if value.trim().is_empty() {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::Empty,
        ));
    }
    if value.len() > MAX_RECORD_ID_BYTES || value.chars().any(char::is_control) {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::TooLong,
        ));
    }
    Ok(())
}

pub(crate) fn validate_type(value: &str, field: &'static str) -> Result<(), ArtifactRecordError> {
    validate_id(value, field)?;
    if value.len() > MAX_RECORD_TYPE_BYTES {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::TooLong,
        ));
    }
    Ok(())
}

pub(crate) fn validate_time(value: i64, field: &'static str) -> Result<(), ArtifactRecordError> {
    if value < 0 {
        return Err(ArtifactRecordError::new(
            field,
            ArtifactRecordErrorKind::OutOfRange,
        ));
    }
    Ok(())
}

pub(crate) fn validate_digest(value: &str) -> Result<(), ArtifactRecordError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(ArtifactRecordError::new(
            "payload.sha256",
            ArtifactRecordErrorKind::InvalidDigest,
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ArtifactRecordError::new(
            "payload.sha256",
            ArtifactRecordErrorKind::InvalidDigest,
        ));
    }
    Ok(())
}

pub(crate) fn manifest_sensitivity(sensitivity: ArtifactPayloadSensitivity) -> &'static str {
    match sensitivity {
        ArtifactPayloadSensitivity::Public => "public",
        ArtifactPayloadSensitivity::Internal => "internal",
        ArtifactPayloadSensitivity::WorkspaceSensitive => "workspaceSensitive",
    }
}

pub(crate) fn retention_matches_manifest(
    payload: &ArtifactPayloadRecord,
    manifest: &Value,
) -> bool {
    let retention_type = manifest.pointer("/retention/type").and_then(Value::as_str);
    let expires_at = manifest
        .pointer("/retention/expiresAt")
        .and_then(Value::as_i64);
    match payload.retention_kind {
        ArtifactRetentionKind::Session => {
            retention_type == Some("session") && expires_at == payload.expires_at
        }
        ArtifactRetentionKind::Task => {
            retention_type == Some("task") && expires_at == payload.expires_at
        }
        ArtifactRetentionKind::UserManaged => {
            retention_type == Some("userManaged") && expires_at.is_none()
        }
        ArtifactRetentionKind::Compliance => {
            retention_type == Some("compliance") && expires_at == payload.expires_at
        }
    }
}
