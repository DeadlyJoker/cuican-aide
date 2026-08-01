use super::office_thread_id;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeManagerEnsureParams;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeManagerEnsureStatus;
use serde_json::Value as JsonValue;

const MAX_OFFICE_MANAGER_ID_CHARS: usize = 128;

#[derive(Debug)]
pub(crate) struct PreparedOfficeManagerEnsure {
    pub(crate) cwd: String,
    pub(crate) office_record_id: String,
    pub(crate) config: JsonValue,
    pub(crate) existing_thread_id: Option<String>,
}

pub(super) async fn prepare(
    records: &super::office_legacy_record_mutation::OfficeLegacyRecordMutator,
    params: OfficeManagerEnsureParams,
) -> Result<PreparedOfficeManagerEnsure, JSONRPCErrorError> {
    validate_identity("officeRecordId", &params.office_record_id)?;
    validate_identity("expectedRecordRevision", &params.expected_record_revision)?;
    let record = records
        .manager_record_at_revision(
            &params.cwd,
            &params.office_record_id,
            &params.expected_record_revision,
        )
        .await?;
    let existing_thread_id = office_thread_id(&record.config).map(str::to_string);
    Ok(PreparedOfficeManagerEnsure {
        cwd: params.cwd,
        office_record_id: params.office_record_id,
        config: record.config,
        existing_thread_id,
    })
}

pub(super) async fn reused(
    records: &super::office_legacy_record_mutation::OfficeLegacyRecordMutator,
    prepared: PreparedOfficeManagerEnsure,
    status: OfficeManagerEnsureStatus,
) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
    let prepared_thread_id = prepared.existing_thread_id.ok_or_else(|| {
        internal_error("prepared Office manager ensure lost its existing threadId")
    })?;
    let prepared_revision = prepared
        .config
        .get("workspace")
        .and_then(|workspace| workspace.get("recordRevision"))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| internal_error("prepared Office manager ensure lost its recordRevision"))?
        .to_string();
    let latest = records
        .manager_record_at_revision(
            &prepared.cwd,
            &prepared.office_record_id,
            &prepared_revision,
        )
        .await?;
    if office_thread_id(&latest.config) != Some(prepared_thread_id.as_str()) {
        return Err(invalid_params(
            "office config is stale; reload the latest Office record and retry",
        ));
    }
    Ok(OfficeManagerEnsureResponse {
        file_path: latest.file_path,
        config: latest.config,
        thread_id: prepared_thread_id,
        status,
    })
}

pub(super) async fn commit(
    records: &super::office_legacy_record_mutation::OfficeLegacyRecordMutator,
    prepared: PreparedOfficeManagerEnsure,
    replacement_thread_id: &str,
) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
    let prepared_revision = prepared
        .config
        .get("workspace")
        .and_then(|workspace| workspace.get("recordRevision"))
        .and_then(JsonValue::as_str)
        .ok_or_else(|| internal_error("prepared Office manager ensure lost its recordRevision"))?;
    let record = records
        .bind_manager_thread_at_revision(
            &prepared.cwd,
            &prepared.office_record_id,
            prepared_revision,
            replacement_thread_id,
        )
        .await?;
    Ok(OfficeManagerEnsureResponse {
        file_path: record.file_path,
        config: record.config,
        thread_id: replacement_thread_id.to_string(),
        status: OfficeManagerEnsureStatus::Created,
    })
}

fn validate_identity(label: &str, value: &str) -> Result<(), JSONRPCErrorError> {
    if value.is_empty()
        || value != value.trim()
        || value.chars().any(char::is_whitespace)
        || value.chars().count() > MAX_OFFICE_MANAGER_ID_CHARS
    {
        return Err(invalid_params(format!(
            "{label} must be non-empty, contain no whitespace, and not exceed {MAX_OFFICE_MANAGER_ID_CHARS} characters"
        )));
    }
    Ok(())
}
