use std::fmt;

use crewon_state::MAX_OFFICE_MIGRATION_SNAPSHOT_BYTES;
use crewon_state::MAX_OFFICE_MIGRATION_SOURCE_BYTES;
use crewon_state::office_migration_snapshot_digest;
use serde_json::Map;
use serde_json::Value as JsonValue;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

use super::DomainKind;
use super::PersistedDomainConfigRecord;
use super::office_record_identity;

const LEGACY_RECORD_ID_PREFIX: &str = "legacy-";
const MAX_RECORD_ID_BYTES: usize = 128;
const MAX_SOURCE_REVISION_BYTES: usize = 512;
const SNAPSHOT_SCHEMA: &str = "crewon.office-legacy-snapshot/v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum OfficeMigrationQuiesceState {
    Idle,
    Blocked(OfficeMigrationBlockingRun),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct OfficeMigrationBlockingRun {
    pub(super) run_id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: Option<String>,
    pub(super) manager_is_steerable: bool,
}

#[derive(Clone, Eq, PartialEq)]
pub(super) struct OfficeLegacyMigrationSnapshot {
    pub(super) record_id: String,
    pub(super) source_revision: String,
    pub(super) source_digest: String,
    pub(super) source_bytes: u64,
    pub(super) snapshot_digest: String,
    pub(super) snapshot_json: String,
    pub(super) quiesce_state: OfficeMigrationQuiesceState,
}

impl fmt::Debug for OfficeLegacyMigrationSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfficeLegacyMigrationSnapshot")
            .field("record_id", &self.record_id)
            .field("source_revision", &self.source_revision)
            .field("source", &"[REDACTED]")
            .field("source_bytes", &self.source_bytes)
            .field("snapshot", &"[REDACTED]")
            .field("quiesce_state", &self.quiesce_state)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum OfficeLegacySnapshotError {
    EmptySource,
    SourceTooLarge,
    InvalidEnvelope,
    UnsupportedVersion,
    WrongRecordKind,
    MissingWorkspace,
    InvalidRecordId,
    InvalidSourceRevision,
    InvalidActivityRuns,
    InvalidBlockingRun,
    SnapshotTooLarge,
}

pub(super) fn normalize_legacy_office_record(
    file_name: &str,
    source: &[u8],
) -> Result<OfficeLegacyMigrationSnapshot, OfficeLegacySnapshotError> {
    validate_source(source)?;
    let record: PersistedDomainConfigRecord =
        serde_json::from_slice(source).map_err(|_| OfficeLegacySnapshotError::InvalidEnvelope)?;
    if record.version != 1 {
        return Err(OfficeLegacySnapshotError::UnsupportedVersion);
    }
    if record.kind != DomainKind::Office.record_kind() {
        return Err(OfficeLegacySnapshotError::WrongRecordKind);
    }

    let mut config = record.config;
    let workspace = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or(OfficeLegacySnapshotError::MissingWorkspace)?;
    let record_id = identity_or_legacy(
        workspace,
        "recordId",
        MAX_RECORD_ID_BYTES,
        || office_record_identity::legacy_record_id(file_name),
        OfficeLegacySnapshotError::InvalidRecordId,
    )?;
    let source_revision = identity_or_legacy(
        workspace,
        "recordRevision",
        MAX_SOURCE_REVISION_BYTES,
        || format!("{LEGACY_RECORD_ID_PREFIX}{}", sha256_hex(source)),
        OfficeLegacySnapshotError::InvalidSourceRevision,
    )?;
    let quiesce_state = quiesce_state(&config)?;
    let snapshot = canonicalize(json!({
        "schema": SNAPSHOT_SCHEMA,
        "recordId": record_id,
        "recordRevision": source_revision,
        "source": {
            "version": record.version,
            "kind": record.kind,
            "savedAt": record.saved_at,
        },
        "config": config,
    }));
    let snapshot_json =
        serde_json::to_string(&snapshot).map_err(|_| OfficeLegacySnapshotError::InvalidEnvelope)?;
    if snapshot_json.len() > MAX_OFFICE_MIGRATION_SNAPSHOT_BYTES {
        return Err(OfficeLegacySnapshotError::SnapshotTooLarge);
    }

    Ok(OfficeLegacyMigrationSnapshot {
        record_id,
        source_revision,
        source_digest: format!("sha256:{}", sha256_hex(source)),
        source_bytes: source.len() as u64,
        snapshot_digest: office_migration_snapshot_digest(&snapshot_json),
        snapshot_json,
        quiesce_state,
    })
}

fn validate_source(source: &[u8]) -> Result<(), OfficeLegacySnapshotError> {
    if source.is_empty() {
        return Err(OfficeLegacySnapshotError::EmptySource);
    }
    if source.len() as u64 > MAX_OFFICE_MIGRATION_SOURCE_BYTES {
        return Err(OfficeLegacySnapshotError::SourceTooLarge);
    }
    Ok(())
}

fn identity_or_legacy(
    workspace: &mut Map<String, JsonValue>,
    field: &str,
    max_bytes: usize,
    legacy: impl FnOnce() -> String,
    error: OfficeLegacySnapshotError,
) -> Result<String, OfficeLegacySnapshotError> {
    let value = match workspace.get(field) {
        Some(JsonValue::String(value)) => value.clone(),
        Some(_) => return Err(error),
        None => {
            let value = legacy();
            workspace.insert(field.to_string(), JsonValue::String(value.clone()));
            value
        }
    };
    if value.is_empty()
        || value.trim() != value
        || value.len() > max_bytes
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
    {
        return Err(error);
    }
    Ok(value)
}

fn quiesce_state(
    config: &JsonValue,
) -> Result<OfficeMigrationQuiesceState, OfficeLegacySnapshotError> {
    let workspace = config
        .get("workspace")
        .and_then(JsonValue::as_object)
        .ok_or(OfficeLegacySnapshotError::MissingWorkspace)?;
    let manager_thread_id = workspace
        .get("threadId")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty());
    let Some(activity) = workspace.get("activity") else {
        return Ok(OfficeMigrationQuiesceState::Idle);
    };
    let Some(runs) = activity.get("runs") else {
        return Ok(OfficeMigrationQuiesceState::Idle);
    };
    let runs = runs
        .as_array()
        .ok_or(OfficeLegacySnapshotError::InvalidActivityRuns)?;
    for run in runs {
        let run = run
            .as_object()
            .ok_or(OfficeLegacySnapshotError::InvalidBlockingRun)?;
        let status = run
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or("running");
        if run_status_is_terminal(status) && !run_has_active_child_dispatch(run) {
            continue;
        }
        let run_id = required_run_text(run, "id")?;
        let thread_id = run
            .get("threadId")
            .and_then(JsonValue::as_str)
            .filter(|value| !value.trim().is_empty())
            .or(manager_thread_id)
            .ok_or(OfficeLegacySnapshotError::InvalidBlockingRun)?
            .to_string();
        let turn_id = optional_run_text(run, "turnId")?;
        let canceling = run
            .get("cancelRequestedAt")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty())
            || matches!(status, "canceling" | "interrupted");
        let manager_terminal = run
            .get("managerTerminalStatus")
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        let manager_is_steerable = status == "running"
            && turn_id.is_some()
            && !canceling
            && !manager_terminal
            && manager_thread_id == Some(thread_id.as_str());
        return Ok(OfficeMigrationQuiesceState::Blocked(
            OfficeMigrationBlockingRun {
                run_id,
                thread_id,
                turn_id,
                manager_is_steerable,
            },
        ));
    }
    Ok(OfficeMigrationQuiesceState::Idle)
}

fn required_run_text(
    run: &Map<String, JsonValue>,
    field: &str,
) -> Result<String, OfficeLegacySnapshotError> {
    optional_run_text(run, field)?.ok_or(OfficeLegacySnapshotError::InvalidBlockingRun)
}

fn optional_run_text(
    run: &Map<String, JsonValue>,
    field: &str,
) -> Result<Option<String>, OfficeLegacySnapshotError> {
    match run.get(field) {
        Some(JsonValue::String(value)) if !value.trim().is_empty() && value.trim() == value => {
            Ok(Some(value.clone()))
        }
        Some(JsonValue::Null) | None => Ok(None),
        Some(_) => Err(OfficeLegacySnapshotError::InvalidBlockingRun),
    }
}

fn run_status_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

fn run_has_active_child_dispatch(run: &Map<String, JsonValue>) -> bool {
    let active = |value: &JsonValue, field: &str| {
        matches!(
            value.get(field).and_then(JsonValue::as_str),
            Some("queued" | "running" | "canceling")
        )
    };
    run.get("delegations")
        .and_then(JsonValue::as_array)
        .is_some_and(|items| items.iter().any(|item| active(item, "status")))
        || run
            .get("verificationChecks")
            .and_then(JsonValue::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| active(item, "dispatchStatus") || active(item, "automationStatus"))
            })
}

fn canonicalize(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(items) => JsonValue::Array(items.into_iter().map(canonicalize).collect()),
        JsonValue::Object(object) => {
            let mut entries: Vec<_> = object.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            let mut canonical = Map::new();
            for (key, value) in entries {
                canonical.insert(key, canonicalize(value));
            }
            JsonValue::Object(canonical)
        }
        scalar => scalar,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

#[cfg(test)]
#[path = "crewon_domain_office_migration_snapshot_tests.rs"]
mod tests;
