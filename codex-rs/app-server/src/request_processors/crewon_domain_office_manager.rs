use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeManagerEnsureParams;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeManagerEnsureStatus;
use serde_json::Value as JsonValue;
use serde_json::json;

use super::office_storage;
use super::office_thread_id;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const MAX_OFFICE_MANAGER_ID_CHARS: usize = 128;

#[derive(Debug)]
pub(crate) struct PreparedOfficeManagerEnsure {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) existing_thread_id: Option<String>,
}

pub(super) async fn prepare(
    params: OfficeManagerEnsureParams,
) -> Result<PreparedOfficeManagerEnsure, JSONRPCErrorError> {
    validate_identity("officeRecordId", &params.office_record_id)?;
    validate_identity("expectedRecordRevision", &params.expected_record_revision)?;
    let identity = json!({
        "workspace": {
            "recordId": params.office_record_id,
        }
    });
    let expected_revision = params.expected_record_revision;
    let (update, _, ()) = office_storage::mutate_latest_office_record_with_result(
        &params.cwd,
        &identity,
        move |latest| {
            if office_storage::office_record_revision(latest) != Some(expected_revision.as_str()) {
                return Err(invalid_params(
                    "office config is stale; reload the latest Office record and retry",
                ));
            }
            Ok((false, ()))
        },
    )
    .await?;
    let existing_thread_id = office_thread_id(&update.config).map(str::to_string);
    Ok(PreparedOfficeManagerEnsure {
        cwd: params.cwd,
        config: update.config,
        existing_thread_id,
    })
}

pub(super) async fn reused(
    prepared: PreparedOfficeManagerEnsure,
    status: OfficeManagerEnsureStatus,
) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
    let prepared_thread_id = prepared.existing_thread_id.ok_or_else(|| {
        internal_error("prepared Office manager ensure lost its existing threadId")
    })?;
    let prepared_revision = office_storage::office_record_revision(&prepared.config)
        .ok_or_else(|| internal_error("prepared Office manager ensure lost its recordRevision"))?
        .to_string();
    let expected_thread_id = prepared_thread_id.clone();
    let (latest, _, ()) = office_storage::mutate_latest_office_record_with_result(
        &prepared.cwd,
        &prepared.config,
        move |config| {
            if office_storage::office_record_revision(config) != Some(prepared_revision.as_str())
                || office_thread_id(config) != Some(expected_thread_id.as_str())
            {
                return Err(invalid_params(
                    "office config is stale; reload the latest Office record and retry",
                ));
            }
            Ok((false, ()))
        },
    )
    .await?;
    Ok(OfficeManagerEnsureResponse {
        file_path: latest.file_path,
        config: latest.config,
        thread_id: prepared_thread_id,
        status,
    })
}

pub(super) async fn commit(
    mut prepared: PreparedOfficeManagerEnsure,
    replacement_thread_id: &str,
) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
    let workspace = prepared
        .config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| internal_error("canonical Office manager config has no workspace"))?;
    workspace.insert(
        "threadId".to_string(),
        JsonValue::String(replacement_thread_id.to_string()),
    );
    let file_path =
        office_storage::save_office_manager_binding(&prepared.cwd, &mut prepared.config).await?;
    Ok(OfficeManagerEnsureResponse {
        file_path,
        config: prepared.config,
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
