use std::fmt;
use std::path::Path;
use std::path::PathBuf;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_rollout::state_db::StateDbHandle;
use crewon_state::OfficeLegacyWriteStatus;
use crewon_state::OfficeMigrationPhase;
use serde_json::Value as JsonValue;
use serde_json::json;

use super::CrewonDomainConfigRecord;
use super::DomainKind;
use super::MAX_LIST_LIMIT;
use super::create_record;
use super::delete_record;
use super::domain_directory;
use super::domain_file_name;
use super::invalid_params;
use super::list_records;
use super::office_authority_lock;
use super::office_record_identity;
use super::read_record;
use super::update_record;
use super::validate_record_file_path;
use super::write_domain_record;
use crate::error_code::internal_error;
use crate::request_processors::crewon_domain_office_server_owned_fields;
use crate::request_processors::crewon_domain_office_server_owned_fields::OfficeServerOwnedFieldsError;

#[derive(Clone)]
pub(super) struct OfficeLegacyRecordMutator {
    migration_state: OfficeMigrationState,
}

pub(super) struct OfficeLegacyMutationGuard {
    _authority: office_authority_lock::OfficeAuthorityGuard,
}

pub(crate) struct OfficeDispatchPermit {
    _authority: OfficeLegacyMutationGuard,
    record_id: String,
    action: OfficeDispatchAction,
    dispatch_lease_id: String,
}

pub(crate) enum OfficeDispatchAction {
    Run {
        run_id: String,
    },
    Delegation {
        run_id: String,
        delegation_id: String,
    },
    Verification {
        run_id: String,
        verification_check_id: String,
    },
}

impl fmt::Debug for OfficeDispatchPermit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfficeDispatchPermit")
            .field("record_id", &self.record_id)
            .field("action", &self.action.label())
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
enum OfficeMigrationState {
    Enforced(StateDbHandle),
    Unavailable,
    #[cfg(test)]
    LegacyUnfenced,
}

#[derive(Clone, Copy)]
enum OfficeLegacyMutationClass {
    NewWork,
    DrainExisting,
}

impl OfficeLegacyRecordMutator {
    #[cfg(test)]
    pub(super) fn legacy_unfenced() -> Self {
        Self {
            migration_state: OfficeMigrationState::LegacyUnfenced,
        }
    }

    pub(super) fn migration_unavailable() -> Self {
        Self {
            migration_state: OfficeMigrationState::Unavailable,
        }
    }

    pub(super) fn with_migration_state(migration_state: StateDbHandle) -> Self {
        Self {
            migration_state: OfficeMigrationState::Enforced(migration_state),
        }
    }

    pub(super) async fn save(
        &self,
        cwd: &str,
        config: JsonValue,
    ) -> Result<String, JSONRPCErrorError> {
        if !DomainKind::Office.config_matches(&config) {
            return Err(invalid_params("office config is missing required fields"));
        }
        let _authority = office_authority_lock::lock(cwd).await?;
        let target = resolve_save_target(cwd, &config).await?;
        self.ensure_permitted(target.record_id(), OfficeLegacyMutationClass::NewWork)
            .await?;
        match &target {
            OfficeSaveTarget::Existing { file_path, .. } => {
                let latest = resolved_target_config(&target, &config).await?;
                let config =
                    crewon_domain_office_server_owned_fields::merge_office_server_owned_fields(
                        &latest, config,
                    )
                    .map_err(map_server_owned_fields_error)?;
                update_record(
                    DomainKind::Office,
                    cwd,
                    &file_path.to_string_lossy(),
                    config,
                )
                .await
            }
            OfficeSaveTarget::New { file_path, .. } => {
                crewon_domain_office_server_owned_fields::reject_office_dispatch_receipt_injection(
                    &config,
                )
                .map_err(map_server_owned_fields_error)?;
                save_new_record(file_path, config).await
            }
        }
    }

    pub(super) async fn create(
        &self,
        cwd: &str,
        config: JsonValue,
    ) -> Result<String, JSONRPCErrorError> {
        if office_record_identity::record_id(&config).is_none() {
            return Err(invalid_params(
                "office create requires a server-assigned recordId",
            ));
        }
        let _authority = office_authority_lock::lock(cwd).await?;
        let directory = domain_directory(cwd, DomainKind::Office)?;
        let file_path = directory.join(domain_file_name(DomainKind::Office, &config));
        let record_id = office_record_identity::authority_record_id(&config, &file_path)?;
        self.ensure_permitted(&record_id, OfficeLegacyMutationClass::NewWork)
            .await?;
        create_record(DomainKind::Office, cwd, config).await
    }

    pub(super) async fn manager_record_at_revision(
        &self,
        cwd: &str,
        record_id: &str,
        expected_revision: &str,
    ) -> Result<CrewonDomainConfigRecord, JSONRPCErrorError> {
        let authority = self.lock_authority(cwd).await?;
        let record = office_record_by_id(cwd, record_id).await?;
        authority
            .ensure_config_writable(self, cwd, &record.config)
            .await?;
        ensure_record_revision(&record.config, expected_revision)?;
        Ok(record)
    }

    pub(super) async fn bind_manager_thread_at_revision(
        &self,
        cwd: &str,
        record_id: &str,
        expected_revision: &str,
        thread_id: &str,
    ) -> Result<CrewonDomainConfigRecord, JSONRPCErrorError> {
        let authority = self.lock_authority(cwd).await?;
        let mut record = office_record_by_id(cwd, record_id).await?;
        authority
            .ensure_config_writable(self, cwd, &record.config)
            .await?;
        ensure_record_revision(&record.config, expected_revision)?;
        let workspace = record
            .config
            .get_mut("workspace")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| invalid_params("office config is missing workspace"))?;
        if workspace
            .get("threadId")
            .and_then(JsonValue::as_str)
            .is_some_and(|existing| !existing.trim().is_empty())
        {
            return Err(invalid_params(
                "office config is stale; reload the latest Office record and retry",
            ));
        }
        workspace.insert(
            "threadId".to_string(),
            JsonValue::String(thread_id.to_string()),
        );
        workspace.insert(
            "recordRevision".to_string(),
            JsonValue::String(uuid::Uuid::now_v7().to_string()),
        );
        let file_path = update_record(
            DomainKind::Office,
            cwd,
            &record.file_path,
            record.config.clone(),
        )
        .await?;
        record.file_path = file_path;
        Ok(record)
    }

    pub(super) async fn delete(
        &self,
        cwd: &str,
        file_path: &str,
    ) -> Result<bool, JSONRPCErrorError> {
        let _authority = office_authority_lock::lock(cwd).await?;
        let file_path = validate_record_file_path(cwd, DomainKind::Office, file_path)?;
        let Some(record) = read_record(DomainKind::Office, &file_path).await? else {
            return Ok(false);
        };
        let record_id = office_record_identity::authority_record_id(&record.config, &file_path)?;
        self.ensure_permitted(&record_id, OfficeLegacyMutationClass::NewWork)
            .await?;
        delete_record(DomainKind::Office, cwd, &file_path.to_string_lossy()).await
    }

    pub(super) async fn lock_resolved_config_mutation(
        &self,
        cwd: &str,
        config: &JsonValue,
    ) -> Result<(OfficeLegacyMutationGuard, JsonValue), JSONRPCErrorError> {
        self.lock_resolved_config(cwd, config, OfficeLegacyMutationClass::NewWork)
            .await
    }

    pub(super) async fn lock_resolved_config_drain(
        &self,
        cwd: &str,
        config: &JsonValue,
    ) -> Result<(OfficeLegacyMutationGuard, JsonValue), JSONRPCErrorError> {
        self.lock_resolved_config(cwd, config, OfficeLegacyMutationClass::DrainExisting)
            .await
    }

    pub(super) async fn lock_authority(
        &self,
        cwd: &str,
    ) -> Result<OfficeLegacyMutationGuard, JSONRPCErrorError> {
        Ok(OfficeLegacyMutationGuard {
            _authority: office_authority_lock::lock(cwd).await?,
        })
    }

    async fn lock_resolved_config(
        &self,
        cwd: &str,
        config: &JsonValue,
        mutation_class: OfficeLegacyMutationClass,
    ) -> Result<(OfficeLegacyMutationGuard, JsonValue), JSONRPCErrorError> {
        if !DomainKind::Office.config_matches(config) {
            return Err(invalid_params("office config is missing required fields"));
        }
        let authority = self.lock_authority(cwd).await?;
        let target = resolve_save_target(cwd, config).await?;
        self.ensure_permitted(target.record_id(), mutation_class)
            .await?;
        let resolved = match &target {
            OfficeSaveTarget::Existing { file_path, .. } => read_record(
                DomainKind::Office,
                file_path,
            )
            .await?
            .ok_or_else(|| {
                invalid_params(
                    "office record identity no longer exists; reload the Office list before retrying",
                )
            })?
            .config,
            OfficeSaveTarget::New { .. } => config.clone(),
        };
        Ok((authority, resolved))
    }

    async fn ensure_permitted(
        &self,
        record_id: &str,
        mutation_class: OfficeLegacyMutationClass,
    ) -> Result<(), JSONRPCErrorError> {
        let state = match &self.migration_state {
            OfficeMigrationState::Enforced(state) => state,
            OfficeMigrationState::Unavailable => {
                return Err(internal_error("Office migration fence is unavailable"));
            }
            #[cfg(test)]
            OfficeMigrationState::LegacyUnfenced => return Ok(()),
        };
        match state
            .office_legacy_write_status(record_id)
            .await
            .map_err(|_| internal_error("Office migration fence is unavailable"))?
        {
            OfficeLegacyWriteStatus::Writable => Ok(()),
            OfficeLegacyWriteStatus::Fenced {
                phase: OfficeMigrationPhase::Quiescing,
                ..
            } if matches!(mutation_class, OfficeLegacyMutationClass::DrainExisting) => Ok(()),
            OfficeLegacyWriteStatus::Fenced {
                phase,
                journal_revision,
            } => Err(migration_fenced_error(phase, journal_revision)),
        }
    }
}

async fn office_record_by_id(
    cwd: &str,
    record_id: &str,
) -> Result<CrewonDomainConfigRecord, JSONRPCErrorError> {
    let (records, _) = list_records(
        DomainKind::Office,
        cwd,
        /*cursor*/ None,
        Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    records
        .into_iter()
        .find(|record| office_record_identity::record_id(&record.config) == Some(record_id))
        .ok_or_else(|| {
            invalid_params(
                "office record identity no longer exists; reload the Office list before retrying",
            )
        })
}

fn ensure_record_revision(
    config: &JsonValue,
    expected_revision: &str,
) -> Result<(), JSONRPCErrorError> {
    let current = config
        .get("workspace")
        .and_then(|workspace| workspace.get("recordRevision"))
        .and_then(JsonValue::as_str);
    if current != Some(expected_revision) {
        return Err(invalid_params(
            "office config is stale; reload the latest Office record and retry",
        ));
    }
    Ok(())
}

fn map_server_owned_fields_error(error: OfficeServerOwnedFieldsError) -> JSONRPCErrorError {
    match error {
        OfficeServerOwnedFieldsError::Conflict => invalid_params(
            "Office server-owned dispatch state changed; reload the Office before saving",
        ),
        OfficeServerOwnedFieldsError::InvalidCallerShape => {
            invalid_params("Office run or delegation identity is invalid")
        }
        OfficeServerOwnedFieldsError::InvalidCanonicalShape => internal_error(
            "canonical Office server-owned dispatch state is corrupt and cannot be overwritten",
        ),
    }
}

impl OfficeLegacyMutationGuard {
    async fn ensure_config_permitted(
        &self,
        mutator: &OfficeLegacyRecordMutator,
        cwd: &str,
        config: &JsonValue,
        mutation_class: OfficeLegacyMutationClass,
    ) -> Result<(), JSONRPCErrorError> {
        let target = resolve_save_target(cwd, config).await?;
        mutator
            .ensure_permitted(target.record_id(), mutation_class)
            .await
    }

    pub(super) async fn ensure_config_writable(
        &self,
        mutator: &OfficeLegacyRecordMutator,
        cwd: &str,
        config: &JsonValue,
    ) -> Result<(), JSONRPCErrorError> {
        self.ensure_config_permitted(mutator, cwd, config, OfficeLegacyMutationClass::NewWork)
            .await
    }

    pub(super) async fn ensure_config_drainable(
        &self,
        mutator: &OfficeLegacyRecordMutator,
        cwd: &str,
        config: &JsonValue,
    ) -> Result<(), JSONRPCErrorError> {
        self.ensure_config_permitted(
            mutator,
            cwd,
            config,
            OfficeLegacyMutationClass::DrainExisting,
        )
        .await
    }

    pub(super) async fn into_dispatch_permit(
        self,
        mutator: &OfficeLegacyRecordMutator,
        cwd: &str,
        config: &JsonValue,
        action: OfficeDispatchAction,
    ) -> Result<OfficeDispatchPermit, JSONRPCErrorError> {
        let target = resolve_save_target(cwd, config).await?;
        mutator
            .ensure_permitted(target.record_id(), OfficeLegacyMutationClass::NewWork)
            .await?;
        let dispatch_lease_id = action.dispatch_lease_id(config)?.to_string();
        Ok(OfficeDispatchPermit {
            _authority: self,
            record_id: target.record_id().to_string(),
            action,
            dispatch_lease_id,
        })
    }
}

impl OfficeDispatchPermit {
    pub(super) fn record_id(&self) -> &str {
        &self.record_id
    }

    pub(super) async fn ensure_config_identity(
        &self,
        cwd: &str,
        config: &JsonValue,
    ) -> Result<(), JSONRPCErrorError> {
        let target = resolve_save_target(cwd, config).await?;
        if target.record_id() != self.record_id {
            return Err(invalid_params(
                "Office dispatch permit does not match the current record identity",
            ));
        }
        let current = resolved_target_config(&target, config).await?;
        if self.action.dispatch_lease_id(&current)? != self.dispatch_lease_id {
            return Err(invalid_params(
                "Office dispatch permit no longer matches the queued action",
            ));
        }
        Ok(())
    }
}

impl OfficeDispatchAction {
    fn label(&self) -> &'static str {
        match self {
            Self::Run { .. } => "run",
            Self::Delegation { .. } => "delegation",
            Self::Verification { .. } => "verification",
        }
    }

    fn dispatch_lease_id<'a>(&self, config: &'a JsonValue) -> Result<&'a str, JSONRPCErrorError> {
        let run_id = match self {
            Self::Run { run_id }
            | Self::Delegation { run_id, .. }
            | Self::Verification { run_id, .. } => run_id,
        };
        let run = config
            .get("workspace")
            .and_then(|workspace| workspace.get("activity"))
            .and_then(|activity| activity.get("runs"))
            .and_then(JsonValue::as_array)
            .and_then(|runs| {
                runs.iter()
                    .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
            })
            .ok_or_else(|| invalid_params("Office dispatch run no longer exists"))?;
        let action = match self {
            Self::Run { .. } => run,
            Self::Delegation { delegation_id, .. } => run
                .get("delegations")
                .and_then(JsonValue::as_array)
                .and_then(|delegations| {
                    delegations.iter().find(|delegation| {
                        delegation.get("id").and_then(JsonValue::as_str) == Some(delegation_id)
                    })
                })
                .ok_or_else(|| invalid_params("Office delegation no longer exists"))?,
            Self::Verification {
                verification_check_id,
                ..
            } => run
                .get("verificationChecks")
                .and_then(JsonValue::as_array)
                .and_then(|checks| {
                    checks.iter().find(|check| {
                        check.get("id").and_then(JsonValue::as_str) == Some(verification_check_id)
                            || check.get("itemId").and_then(JsonValue::as_str)
                                == Some(verification_check_id)
                            || check.get("checkId").and_then(JsonValue::as_str)
                                == Some(verification_check_id)
                    })
                })
                .ok_or_else(|| invalid_params("Office verification check no longer exists"))?,
        };
        action
            .get("dispatchLeaseId")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|lease_id| !lease_id.is_empty())
            .ok_or_else(|| invalid_params("Office dispatch lease is missing"))
    }
}

enum OfficeSaveTarget {
    Existing {
        file_path: PathBuf,
        record_id: String,
    },
    New {
        file_path: PathBuf,
        record_id: String,
    },
}

impl OfficeSaveTarget {
    fn record_id(&self) -> &str {
        match self {
            Self::Existing { record_id, .. } | Self::New { record_id, .. } => record_id,
        }
    }
}

async fn resolved_target_config(
    target: &OfficeSaveTarget,
    fallback: &JsonValue,
) -> Result<JsonValue, JSONRPCErrorError> {
    match target {
        OfficeSaveTarget::Existing { file_path, .. } => read_record(DomainKind::Office, file_path)
            .await?
            .ok_or_else(|| {
                invalid_params(
                    "office record identity no longer exists; reload the Office list before retrying",
                )
            })
            .map(|record| record.config),
        OfficeSaveTarget::New { .. } => Ok(fallback.clone()),
    }
}

async fn resolve_save_target(
    cwd: &str,
    config: &JsonValue,
) -> Result<OfficeSaveTarget, JSONRPCErrorError> {
    let (records, _) = list_records(
        DomainKind::Office,
        cwd,
        /*cursor*/ None,
        Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    let existing = if let Some(record_id) = office_record_identity::record_id(config) {
        records
            .into_iter()
            .find(|record| office_record_identity::record_id(&record.config) == Some(record_id))
            .ok_or_else(|| {
                invalid_params(
                    "office record identity no longer exists; reload the Office list before retrying",
                )
            })?
    } else {
        let legacy_records = records
            .into_iter()
            .filter(|record| office_record_identity::record_id(&record.config).is_none())
            .collect::<Vec<_>>();
        let mut matches = legacy_records.iter().filter(|record| {
            DomainKind::Office.thread_id(config).is_some()
                && DomainKind::Office.thread_id(&record.config)
                    == DomainKind::Office.thread_id(config)
        });
        let mut existing = matches.next();
        if matches.next().is_some() {
            return Err(ambiguous_legacy_identity());
        }
        if existing.is_none()
            && let Some(title) = DomainKind::Office.title(config)
        {
            let mut title_matches = legacy_records
                .iter()
                .filter(|record| DomainKind::Office.title(&record.config) == Some(title));
            existing = title_matches.next();
            if title_matches.next().is_some() {
                return Err(ambiguous_legacy_identity());
            }
        }
        let Some(existing) = existing else {
            if !legacy_records.is_empty() {
                return Err(invalid_params(
                    "legacy Office identity cannot be resolved; reload and assign a recordId before saving",
                ));
            }
            let directory = domain_directory(cwd, DomainKind::Office)?;
            let file_path = directory.join(domain_file_name(DomainKind::Office, config));
            let record_id = office_record_identity::authority_record_id(config, &file_path)?;
            return Ok(OfficeSaveTarget::New {
                file_path,
                record_id,
            });
        };
        existing.clone()
    };
    existing_save_target(config, existing)
}

fn existing_save_target(
    config: &JsonValue,
    existing: CrewonDomainConfigRecord,
) -> Result<OfficeSaveTarget, JSONRPCErrorError> {
    let file_path = PathBuf::from(&existing.file_path);
    let current_id = office_record_identity::authority_record_id(&existing.config, &file_path)?;
    let proposed_id = office_record_identity::authority_record_id(config, &file_path)?;
    if current_id != proposed_id {
        return Err(invalid_params("office recordId cannot be changed"));
    }
    Ok(OfficeSaveTarget::Existing {
        file_path,
        record_id: current_id,
    })
}

fn ambiguous_legacy_identity() -> JSONRPCErrorError {
    invalid_params(
        "legacy Office identity is ambiguous; reload and assign a recordId before saving",
    )
}

async fn save_new_record(file_path: &Path, config: JsonValue) -> Result<String, JSONRPCErrorError> {
    let directory = file_path
        .parent()
        .ok_or_else(|| invalid_params("office record path is invalid"))?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(super::map_io_error)?;
    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    write_domain_record(DomainKind::Office, file_path, saved_at, config).await?;
    Ok(file_path.to_string_lossy().into_owned())
}

fn migration_fenced_error(phase: OfficeMigrationPhase, journal_revision: u64) -> JSONRPCErrorError {
    let mut error = invalid_params("Office is migrating and cannot be modified");
    error.data = Some(json!({
        "type": "officeMigrationFenced",
        "phase": phase_name(phase),
        "journalRevision": journal_revision,
    }));
    error
}

fn phase_name(phase: OfficeMigrationPhase) -> &'static str {
    match phase {
        OfficeMigrationPhase::Quiescing => "quiescing",
        OfficeMigrationPhase::Importing => "importing",
        OfficeMigrationPhase::Imported => "imported",
        OfficeMigrationPhase::Active => "active",
    }
}

#[cfg(test)]
#[path = "crewon_domain_office_legacy_record_mutation_tests.rs"]
mod tests;
