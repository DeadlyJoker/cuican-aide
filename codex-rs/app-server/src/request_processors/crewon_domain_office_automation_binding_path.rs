use std::path::Component;
use std::path::Path;

use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use sha2::Digest as _;
use sha2::Sha256;
use tokio::fs;

use super::super::DomainKind;
use super::super::domain_directory;
use super::super::read_record;
use super::super::validate_record_file_path;
use crate::error_code::invalid_params;

const MAX_AUTOMATION_PATH_CHARS: usize = 4_096;
pub(super) const AUTOMATION_IDENTITY_PREFIX: &str = "automation-path-sha256:";

pub(super) fn validate_automation_path_text(file_path: &str) -> Result<(), String> {
    let path = Path::new(file_path);
    if file_path.is_empty()
        || file_path.chars().count() > MAX_AUTOMATION_PATH_CHARS
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || path.extension().and_then(|extension| extension.to_str()) != Some("json")
    {
        return Err(format!(
            "automationFilePath must be an absolute JSON path without parent segments and must not exceed {MAX_AUTOMATION_PATH_CHARS} characters"
        ));
    }
    Ok(())
}

pub(super) fn validate_automation_identity(identity: &str) -> Result<(), String> {
    let Some(digest) = identity.strip_prefix(AUTOMATION_IDENTITY_PREFIX) else {
        return Err("automationIdentity has an unsupported format".to_string());
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("automationIdentity has an invalid SHA-256 digest".to_string());
    }
    Ok(())
}

pub(super) async fn read_exact_automation_record(
    cwd: &str,
    requested_file_path: &str,
) -> Result<(CrewonDomainConfigRecord, String), JSONRPCErrorError> {
    validate_automation_path_text(requested_file_path).map_err(invalid_params)?;
    let directory = domain_directory(cwd, DomainKind::Automation)?;
    let file_path = validate_record_file_path(cwd, DomainKind::Automation, requested_file_path)?;
    if file_path.parent() != Some(directory.as_path()) {
        return Err(invalid_params(
            "automationFilePath must identify a direct child of the Automation config directory",
        ));
    }
    let metadata = fs::symlink_metadata(&file_path).await.map_err(|err| {
        invalid_params(format!(
            "bound Automation file is not readable at {}: {err}",
            file_path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(invalid_params(
            "automationFilePath must identify a regular non-symlink Automation config file",
        ));
    }
    let canonical_directory = fs::canonicalize(&directory).await.map_err(|err| {
        invalid_params(format!(
            "Automation config directory cannot be resolved safely: {err}"
        ))
    })?;
    let canonical_file = fs::canonicalize(&file_path).await.map_err(|err| {
        invalid_params(format!(
            "Automation config path cannot be resolved safely: {err}"
        ))
    })?;
    if canonical_file.parent() != Some(canonical_directory.as_path()) {
        return Err(invalid_params(
            "automationFilePath resolves outside the Automation config directory",
        ));
    }
    let record = read_record(DomainKind::Automation, &file_path)
        .await?
        .ok_or_else(|| {
            invalid_params(format!(
                "automationFilePath '{}' did not match a saved Automation record",
                file_path.display()
            ))
        })?;
    let digest = Sha256::digest(canonical_file.to_string_lossy().as_bytes());
    Ok((record, format!("{AUTOMATION_IDENTITY_PREFIX}{digest:x}")))
}
