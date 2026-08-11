use std::path::Path;

use super::WorkspaceNativeError;

const MAX_PATH_BYTES: usize = 4_096;
const MAX_DISPLAY_NAME_BYTES: usize = 255;

pub(super) struct CanonicalWorkspace {
    pub(super) trusted_path: String,
    pub(super) display_name: String,
}

pub(super) fn canonical_workspace(path: &Path) -> Result<CanonicalWorkspace, WorkspaceNativeError> {
    let supplied_metadata =
        std::fs::symlink_metadata(path).map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if supplied_metadata.file_type().is_symlink() || !supplied_metadata.is_dir() {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|_| WorkspaceNativeError::AuthorityInvalid)?;
    if !canonical.is_absolute() {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    let trusted_path = canonical
        .to_str()
        .filter(|value| valid_text(value, MAX_PATH_BYTES))
        .ok_or(WorkspaceNativeError::AuthorityInvalid)?
        .to_string();
    let display_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.contains('/')
                && !value.contains('\\')
                && !value.to_ascii_lowercase().starts_with("file:")
                && !value.to_ascii_lowercase().starts_with("http:")
                && !value.to_ascii_lowercase().starts_with("https:")
        })
        .ok_or(WorkspaceNativeError::AuthorityInvalid)?
        .to_string();
    if !valid_text(&display_name, MAX_DISPLAY_NAME_BYTES) {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    Ok(CanonicalWorkspace {
        trusted_path,
        display_name,
    })
}

pub(super) fn random_id(prefix: &str) -> Result<String, WorkspaceNativeError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| WorkspaceNativeError::AuthorityUnavailable)?;
    Ok(format!("{prefix}-{}", hex::encode(bytes)))
}

pub(crate) fn valid_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.len() <= 512
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= maximum_bytes && !value.chars().any(char::is_control)
}
