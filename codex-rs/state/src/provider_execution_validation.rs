use sha2::Digest;
use sha2::Sha256;

use crate::ProviderExecutionRecordError;
use crate::ProviderExecutionRecordErrorKind;
use crate::provider_execution_records::error;

const MAX_ID_BYTES: usize = 512;
const MAX_TYPE_BYTES: usize = 128;
const MAX_CURSOR_BYTES: usize = 512;

pub(crate) fn validate_id(
    value: &str,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    validate_text(value, field, MAX_ID_BYTES)
}

pub(crate) fn validate_type(
    value: &str,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    validate_text(value, field, MAX_TYPE_BYTES)
}

pub(crate) fn validate_cursor(
    value: &str,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    validate_text(value, field, MAX_CURSOR_BYTES)
}

pub(crate) fn validate_optional_cursor(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    value.map_or(Ok(()), |value| validate_cursor(value, field))
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProviderExecutionRecordError> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(error(field, ProviderExecutionRecordErrorKind::Empty));
    }
    if value.len() > max_bytes {
        return Err(error(field, ProviderExecutionRecordErrorKind::TooLong));
    }
    Ok(())
}

pub(crate) fn validate_revision(
    value: u64,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    if value == 0 || i64::try_from(value).is_err() {
        return Err(error(field, ProviderExecutionRecordErrorKind::OutOfRange));
    }
    Ok(())
}

pub(crate) fn validate_optional_revision(
    value: Option<u64>,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    value.map_or(Ok(()), |value| validate_revision(value, field))
}

pub(crate) fn validate_time(
    value: i64,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    if value < 0 {
        return Err(error(field, ProviderExecutionRecordErrorKind::OutOfRange));
    }
    Ok(())
}

pub(crate) fn validate_hash(
    value: &str,
    field: &'static str,
) -> Result<(), ProviderExecutionRecordError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(error(field, ProviderExecutionRecordErrorKind::InvalidHash));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(field, ProviderExecutionRecordErrorKind::InvalidHash));
    }
    Ok(())
}

pub(crate) fn digest_parts(domain: &[u8], parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("sha256:{:x}", hasher.finalize())
}
