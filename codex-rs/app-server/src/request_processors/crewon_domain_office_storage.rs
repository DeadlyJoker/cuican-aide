use std::io;
use std::path::Path;
use std::path::PathBuf;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_core::path_utils::write_atomically;
use crewon_protocol::ThreadId;
use serde_json::Value as JsonValue;
use tokio::fs;
use tokio::task;
use uuid::Uuid;

use super::DomainKind;
use super::OfficeRunSyncUpdate;
use super::domain_directory;
use super::domain_file_name;
use super::map_io_error;
use super::office_authority_lock;
use super::office_automation_binding;
use super::office_message;
use super::office_message_receipt;
use super::office_record_lock;
use super::office_runtime_authority;
use super::office_runtime_authority_error;
use super::office_runtime_owner_reconciliation;
use super::office_runtime_owner_registry;
use super::office_thread_id;
use super::office_workspace_identity;
use super::office_workspace_identity::OfficeWorkspaceIdentityState;
use super::office_workspace_identity::OfficeWorkspaceIdentityWrite;
use super::office_workspace_identity::OfficeWriteIntent;
use super::sha256_hex;
use super::validate_record_file_path;
use super::write_domain_record;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const OFFICE_RECORD_ID_FIELD: &str = "recordId";
const OFFICE_RECORD_REVISION_FIELD: &str = "recordRevision";
const MAX_OFFICE_RECORD_ID_CHARS: usize = 128;
pub(super) const MAX_OFFICE_RECORD_BYTES: u64 = 4 * 1024 * 1024;

#[path = "crewon_domain_office_member_id_authority.rs"]
mod office_member_id_authority;
#[path = "crewon_domain_office_record_discovery.rs"]
mod office_record_discovery;

pub(super) use office_record_discovery::find_office_record;
pub(super) use office_record_discovery::find_office_record_ignoring_unreadable;
pub(super) use office_record_discovery::list_office_records_for_scheduler;
pub(super) use office_record_discovery::read_office_record_strict;
pub(super) use office_record_discovery::validate_office_thread_ownership;

#[derive(Clone, Copy)]
pub(super) enum OfficeIdentityLookup<'a> {
    RecordId(&'a str),
    LegacyThreadId(&'a str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OfficeSaveIdentity {
    Existing,
    New,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OfficeManagerBindingWrite {
    LegacyInitial,
    PreserveExisting,
    ServerEnsure,
}

pub(super) async fn save_office_record(
    cwd: &str,
    config: &mut JsonValue,
    intent: OfficeWriteIntent,
) -> Result<String, JSONRPCErrorError> {
    save_office_record_with_manager_binding(
        cwd,
        config,
        intent,
        ordinary_manager_binding_write(intent),
    )
    .await
}

pub(super) async fn save_office_manager_binding(
    cwd: &str,
    config: &mut JsonValue,
) -> Result<String, JSONRPCErrorError> {
    save_office_record_with_manager_binding(
        cwd,
        config,
        OfficeWriteIntent::Update,
        OfficeManagerBindingWrite::ServerEnsure,
    )
    .await
}

async fn save_office_record_with_manager_binding(
    cwd: &str,
    config: &mut JsonValue,
    intent: OfficeWriteIntent,
    manager_binding_write: OfficeManagerBindingWrite,
) -> Result<String, JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    validate_office_thread_id(config)?;
    canonicalize_office_thread_id(config)?;
    let proposed_record_id = validate_office_record_id(config)
        .map_err(invalid_params)?
        .map(str::to_string);
    match (intent, proposed_record_id.as_ref()) {
        (OfficeWriteIntent::Create, Some(_)) => {
            return Err(invalid_params(
                "office/create cannot supply workspace.recordId",
            ));
        }
        (OfficeWriteIntent::Update, None) => {
            return Err(invalid_params(
                "workspace.recordId is required to update an Office",
            ));
        }
        (OfficeWriteIntent::LegacyMigration, Some(_)) => {
            return Err(invalid_params(
                "legacy Office migration cannot supply workspace.recordId",
            ));
        }
        _ => {}
    }
    let directory = domain_directory(cwd, DomainKind::Office)?;
    fs::create_dir_all(&directory).await.map_err(map_io_error)?;
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let target_thread_id = office_thread_id(config).map(str::to_string);
    let workspace_identity = match target_thread_id.as_deref() {
        Some(thread_id) => {
            office_workspace_identity::reconcile_under_authority(
                &authority_guard,
                &directory,
                thread_id,
            )
            .await?
        }
        None => None,
    };
    let mut runtime_authority = office_runtime_owner_registry::load(cwd, &authority_guard).await?;
    office_runtime_owner_reconciliation::reconcile_if_needed(&directory, &mut runtime_authority)
        .await?;

    let (record_id, save_identity) = match intent {
        OfficeWriteIntent::Create => {
            if let Some(thread_id) = target_thread_id.as_deref()
                && (workspace_identity.as_ref().is_some_and(|identity| {
                    identity.state() == OfficeWorkspaceIdentityState::Active
                }) || find_office_record_ignoring_unreadable(
                    &directory,
                    OfficeIdentityLookup::LegacyThreadId(thread_id),
                )
                .await?
                .is_some())
            {
                return Err(invalid_params(format!(
                    "workspace.threadId {thread_id} is already bound to another Office record"
                )));
            }
            (Uuid::now_v7().to_string(), OfficeSaveIdentity::New)
        }
        OfficeWriteIntent::Update => (
            proposed_record_id.ok_or_else(|| {
                internal_error("Update intent lost its validated Office recordId")
            })?,
            OfficeSaveIdentity::Existing,
        ),
        OfficeWriteIntent::LegacyMigration => match workspace_identity.as_ref() {
            Some(identity) if identity.state() == OfficeWorkspaceIdentityState::Active => (
                identity.record_id().to_string(),
                OfficeSaveIdentity::Existing,
            ),
            Some(_) => {
                let thread_id = target_thread_id.as_deref().ok_or_else(|| {
                    internal_error("Office workspace identity is missing its threadId")
                })?;
                return Err(invalid_params(format!(
                    "workspace.threadId {thread_id} belongs to a deleted Office generation; use office/create to create a new Office"
                )));
            }
            None => {
                let existing = match target_thread_id.as_deref() {
                    Some(thread_id) => {
                        find_office_record_ignoring_unreadable(
                            &directory,
                            OfficeIdentityLookup::LegacyThreadId(thread_id),
                        )
                        .await?
                    }
                    None => None,
                };
                match existing {
                    Some(record) => (
                        office_record_id(&record.config)
                            .ok_or_else(|| {
                                internal_error(
                                    "Office identity scan returned a record without recordId",
                                )
                            })?
                            .to_string(),
                        OfficeSaveIdentity::Existing,
                    ),
                    None => (Uuid::now_v7().to_string(), OfficeSaveIdentity::New),
                }
            }
        },
    };
    set_office_record_id(config, &record_id)?;

    let mut resolved_record = match save_identity {
        OfficeSaveIdentity::Existing => {
            find_office_record(&directory, OfficeIdentityLookup::RecordId(&record_id)).await?
        }
        OfficeSaveIdentity::New => {
            find_office_record_ignoring_unreadable(
                &directory,
                OfficeIdentityLookup::RecordId(&record_id),
            )
            .await?
        }
    };
    let source_thread_id = resolved_record
        .as_ref()
        .and_then(|record| office_thread_id(&record.config))
        .map(str::to_string);
    if let Some(source_thread_id) = source_thread_id.as_deref()
        && Some(source_thread_id) != target_thread_id.as_deref()
    {
        office_workspace_identity::reconcile_under_authority(
            &authority_guard,
            &directory,
            source_thread_id,
        )
        .await?;
        resolved_record = match save_identity {
            OfficeSaveIdentity::Existing => {
                find_office_record(&directory, OfficeIdentityLookup::RecordId(&record_id)).await?
            }
            OfficeSaveIdentity::New => {
                find_office_record_ignoring_unreadable(
                    &directory,
                    OfficeIdentityLookup::RecordId(&record_id),
                )
                .await?
            }
        };
    }
    let _identity_guard = office_record_lock::lock(&record_identity_path(&directory, &record_id))
        .await
        .map_err(map_io_error)?;

    let resolved_existing_path = resolved_record
        .as_ref()
        .map(|record| PathBuf::from(&record.file_path));
    let mut file_path = resolved_existing_path
        .clone()
        .unwrap_or_else(|| directory.join(domain_file_name(DomainKind::Office, config)));
    let mut guard = office_record_lock::lock(&file_path)
        .await
        .map_err(map_io_error)?;
    let mut latest = read_office_record_strict(&file_path).await?;
    if latest
        .as_ref()
        .is_some_and(|record| office_record_id(&record.config) != Some(record_id.as_str()))
    {
        if resolved_existing_path.is_some() {
            return Err(internal_error(
                "Office record identity changed while acquiring its mutation lock",
            ));
        }
        drop(guard);
        let digest = sha256_hex(record_id.as_bytes());
        file_path = directory.join(format!("office-{digest}.json"));
        guard = office_record_lock::lock(&file_path)
            .await
            .map_err(map_io_error)?;
        latest = read_office_record_strict(&file_path).await?;
        if latest
            .as_ref()
            .is_some_and(|record| office_record_id(&record.config) != Some(record_id.as_str()))
        {
            return Err(internal_error(
                "Office identity collision could not be resolved safely",
            ));
        }
    }
    let _record_guard = guard;
    let source_thread_id = latest
        .as_ref()
        .and_then(|record| office_thread_id(&record.config));
    validate_office_manager_binding_write(
        source_thread_id,
        target_thread_id.as_deref(),
        manager_binding_write,
    )?;
    office_automation_binding::preserve_canonical_bindings(
        latest.as_ref().map(|record| &record.config),
        config,
    )?;
    office_message::preserve_canonical_receipt_messages(
        latest.as_ref().map(|record| &record.config),
        config,
    )?;
    validate_office_record_revision(latest.as_ref(), config, save_identity, intent)?;
    office_member_id_authority::prepare_write(
        latest.as_ref().map(|record| &record.config),
        config,
        match save_identity {
            OfficeSaveIdentity::Existing => {
                office_member_id_authority::OfficeMemberIdentityWrite::PreserveExisting
            }
            OfficeSaveIdentity::New => {
                office_member_id_authority::OfficeMemberIdentityWrite::InitializeNewRecord
            }
        },
    )?;
    office_runtime_authority::validate_proposed_repair_authority(
        latest.as_ref().map(|record| &record.config),
        config,
    )
    .map_err(office_runtime_authority_error)?;
    let workspace_identity_write = OfficeWorkspaceIdentityWrite::prepare(
        &directory,
        source_thread_id,
        target_thread_id.as_deref(),
        &record_id,
        intent,
    )
    .await?;
    if let Some(thread_id) = target_thread_id.as_deref() {
        validate_office_thread_ownership(&directory, thread_id, &record_id).await?;
    }
    if let Some(latest) = latest.as_ref() {
        runtime_authority
            .register_persisted_repairs(&latest.config)
            .await?;
        office_runtime_authority::preserve_repaired_runtime_bindings(&latest.config, config)
            .map_err(office_runtime_authority_error)?;
    }
    runtime_authority.validate_config(config)?;
    set_office_record_revision(config, &Uuid::now_v7().to_string())?;
    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    write_domain_record(DomainKind::Office, &file_path, saved_at, config.clone()).await?;
    workspace_identity_write.commit().await?;
    drop(_record_guard);
    drop(_identity_guard);
    drop(authority_guard);
    if let Err(error) = office_message::sync_receipt_sidecar_if_present(cwd, config).await {
        tracing::warn!(
            cwd,
            record_id,
            error = %error.message,
            "failed to refresh non-authoritative Office message receipt sidecar"
        );
    }
    Ok(file_path.to_string_lossy().into_owned())
}

pub(super) async fn mutate_latest_office_record(
    cwd: &str,
    config: &JsonValue,
    mutate: impl FnOnce(&mut JsonValue) -> Result<bool, JSONRPCErrorError> + Send,
) -> Result<Option<OfficeRunSyncUpdate>, JSONRPCErrorError> {
    mutate_latest_office_record_with_result(cwd, config, |latest| {
        mutate(latest).map(|changed| (changed, ()))
    })
    .await
    .map(|(update, changed, ())| changed.then_some(update))
}

pub(super) async fn mutate_latest_office_record_with_result<T: Send>(
    cwd: &str,
    config: &JsonValue,
    mutate: impl FnOnce(&mut JsonValue) -> Result<(bool, T), JSONRPCErrorError> + Send,
) -> Result<(OfficeRunSyncUpdate, bool, T), JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    validate_office_thread_id(config)?;
    let record_id = validate_office_record_id(config)
        .map_err(invalid_params)?
        .ok_or_else(|| {
            invalid_params("workspace.recordId is required to mutate the latest Office")
        })?
        .to_string();
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let mut runtime_authority = office_runtime_owner_registry::load(cwd, &authority_guard).await?;
    office_runtime_owner_reconciliation::reconcile_if_needed(&directory, &mut runtime_authority)
        .await?;
    let mut record = find_office_record(&directory, OfficeIdentityLookup::RecordId(&record_id))
        .await?
        .ok_or_else(|| {
            invalid_params(
                "office record identity no longer exists; reload the Office list before retrying",
            )
        })?;
    let source_thread_id = office_thread_id(&record.config).map(str::to_string);
    if let Some(source_thread_id) = source_thread_id.as_deref() {
        office_workspace_identity::reconcile_under_authority(
            &authority_guard,
            &directory,
            source_thread_id,
        )
        .await?;
        record = find_office_record(&directory, OfficeIdentityLookup::RecordId(&record_id))
            .await?
            .ok_or_else(|| {
                invalid_params(
                    "office record identity no longer exists; reload the Office list before retrying",
                )
            })?;
    }
    let file_path = PathBuf::from(&record.file_path);
    let latest = read_office_record_strict(&file_path)
        .await?
        .ok_or_else(|| {
            invalid_params(
                "office record identity no longer exists; reload the Office list before retrying",
            )
        })?;
    if office_record_id(&latest.config) != Some(record_id.as_str()) {
        return Err(internal_error(
            "Office record identity changed before its mutation lock was acquired",
        ));
    }
    runtime_authority
        .register_persisted_repairs(&latest.config)
        .await?;
    let base_config = latest.config;
    let mut latest_config = base_config.clone();
    let (changed, result) = mutate(&mut latest_config)?;
    if !changed {
        return Ok((
            OfficeRunSyncUpdate {
                file_path: file_path.to_string_lossy().into_owned(),
                config: base_config,
            },
            false,
            result,
        ));
    }
    if !DomainKind::Office.config_matches(&latest_config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    validate_office_thread_id(&latest_config)?;
    canonicalize_office_thread_id(&mut latest_config)?;
    let mutated_record_id = validate_office_record_id(&latest_config).map_err(invalid_params)?;
    if mutated_record_id != Some(record_id.as_str()) {
        return Err(invalid_params(
            "latest Office mutation cannot change workspace.recordId",
        ));
    }
    let target_thread_id = office_thread_id(&latest_config).map(str::to_string);
    validate_office_manager_binding_write(
        source_thread_id.as_deref(),
        target_thread_id.as_deref(),
        ordinary_manager_binding_write(OfficeWriteIntent::Update),
    )?;
    if let Some(target_thread_id) = target_thread_id.as_deref()
        && Some(target_thread_id) != source_thread_id.as_deref()
    {
        office_workspace_identity::reconcile_under_authority(
            &authority_guard,
            &directory,
            target_thread_id,
        )
        .await?;
    }

    let _identity_guard = office_record_lock::lock(&record_identity_path(&directory, &record_id))
        .await
        .map_err(map_io_error)?;
    let record = find_office_record(&directory, OfficeIdentityLookup::RecordId(&record_id))
        .await?
        .ok_or_else(|| {
            invalid_params(
                "office record identity no longer exists; reload the Office list before retrying",
            )
        })?;
    if Path::new(&record.file_path) != file_path {
        return Err(internal_error(
            "Office record path changed while acquiring its mutation lock",
        ));
    }
    let _record_guard = office_record_lock::lock(&file_path)
        .await
        .map_err(map_io_error)?;
    let locked_latest = read_office_record_strict(&file_path)
        .await?
        .ok_or_else(|| {
            invalid_params(
                "office record identity no longer exists; reload the Office list before retrying",
            )
        })?;
    if locked_latest.config != base_config {
        return Err(internal_error(
            "Office record changed while the global authority lock was held",
        ));
    }
    runtime_authority.validate_config(&latest_config)?;
    let workspace_identity_write = OfficeWorkspaceIdentityWrite::prepare(
        &directory,
        source_thread_id.as_deref(),
        target_thread_id.as_deref(),
        &record_id,
        OfficeWriteIntent::Update,
    )
    .await?;
    if let Some(thread_id) = target_thread_id.as_deref() {
        validate_office_thread_ownership(&directory, thread_id, &record_id).await?;
    }
    set_office_record_revision(&mut latest_config, &Uuid::now_v7().to_string())?;
    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    write_domain_record(
        DomainKind::Office,
        &file_path,
        saved_at,
        latest_config.clone(),
    )
    .await?;
    workspace_identity_write.commit().await?;
    drop(_record_guard);
    drop(_identity_guard);
    drop(authority_guard);
    if let Err(error) = office_message::sync_receipt_sidecar_if_present(cwd, &latest_config).await {
        tracing::warn!(
            cwd,
            record_id,
            error = %error.message,
            "failed to refresh non-authoritative Office message receipt sidecar"
        );
    }
    Ok((
        OfficeRunSyncUpdate {
            file_path: file_path.to_string_lossy().into_owned(),
            config: latest_config,
        },
        true,
        result,
    ))
}

pub(super) async fn record_revision_under_authority(
    cwd: &str,
    _authority_guard: &office_authority_lock::OfficeAuthorityGuard,
    record_id: &str,
) -> Result<Option<String>, JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    find_office_record(&directory, OfficeIdentityLookup::RecordId(record_id))
        .await
        .map(|record| {
            record.and_then(|record| office_record_revision(&record.config).map(str::to_string))
        })
}

pub(super) async fn delete_office_record(
    cwd: &str,
    requested_file_path: &str,
) -> Result<bool, JSONRPCErrorError> {
    let file_path = validate_record_file_path(cwd, DomainKind::Office, requested_file_path)?;
    let _authority_guard = office_authority_lock::lock(cwd).await?;
    let Some(initial_record) = read_office_record_strict(&file_path).await? else {
        return Ok(false);
    };
    let directory = domain_directory(cwd, DomainKind::Office)?;
    if let Some(thread_id) = office_thread_id(&initial_record.config) {
        office_workspace_identity::reconcile_under_authority(
            &_authority_guard,
            &directory,
            thread_id,
        )
        .await?;
    }
    let Some(record) = read_office_record_strict(&file_path).await? else {
        return Ok(true);
    };
    let record_id = office_record_id(&record.config)
        .ok_or_else(|| internal_error("strict Office read returned a record without recordId"))?
        .to_string();
    let _identity_guard = office_record_lock::lock(&record_identity_path(&directory, &record_id))
        .await
        .map_err(map_io_error)?;
    let _record_guard = office_record_lock::lock(&file_path)
        .await
        .map_err(map_io_error)?;
    let Some(latest) = read_office_record_strict(&file_path).await? else {
        return Ok(false);
    };
    if office_record_id(&latest.config) != Some(record_id.as_str()) {
        return Err(internal_error(
            "Office record identity changed while acquiring its deletion lock",
        ));
    }
    let workspace_identity = match office_thread_id(&latest.config) {
        Some(thread_id) => {
            let locked = office_workspace_identity::lock(&directory, thread_id).await?;
            let identity = match locked.read().await? {
                Some(identity) if identity.record_id() == record_id => identity,
                Some(identity) if identity.state() == OfficeWorkspaceIdentityState::Deleted => {
                    office_workspace_identity::OfficeWorkspaceIdentity::active(
                        locked.thread_id_hash().to_string(),
                        record_id.clone(),
                        identity.next_generation()?,
                    )?
                }
                Some(_) => {
                    return Err(internal_error(
                        "Office workspace identity points to a different record during deletion",
                    ));
                }
                None => office_workspace_identity::OfficeWorkspaceIdentity::active(
                    locked.thread_id_hash().to_string(),
                    record_id.clone(),
                    /*generation*/ 1,
                )?,
            };
            if identity.state() == OfficeWorkspaceIdentityState::Active {
                locked
                    .write(&identity.with_state(OfficeWorkspaceIdentityState::Deleting))
                    .await?;
            }
            Some((locked, identity))
        }
        None => None,
    };

    office_message_receipt::delete_for_office(cwd, &record_id).await?;
    fs::remove_file(&file_path).await.map_err(map_io_error)?;
    if let Some((locked, identity)) = workspace_identity {
        locked
            .write(&identity.with_state(OfficeWorkspaceIdentityState::Deleted))
            .await?;
    }
    Ok(true)
}

fn validate_office_thread_id(config: &JsonValue) -> Result<(), JSONRPCErrorError> {
    if let Some(thread_id) = office_thread_id(config)
        && (thread_id.trim().is_empty() || thread_id != thread_id.trim())
    {
        return Err(invalid_params(
            "workspace.threadId must be non-empty and must not contain surrounding whitespace",
        ));
    }
    Ok(())
}

fn canonicalize_office_thread_id(config: &mut JsonValue) -> Result<(), JSONRPCErrorError> {
    let Some(thread_id) = office_thread_id(config).map(str::to_string) else {
        return Ok(());
    };
    let Ok(thread_id) = ThreadId::from_string(&thread_id) else {
        return Ok(());
    };
    let workspace = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))?;
    workspace.insert(
        "threadId".to_string(),
        JsonValue::String(thread_id.to_string()),
    );
    Ok(())
}

fn validate_office_record_revision(
    latest: Option<&CrewonDomainConfigRecord>,
    proposed: &JsonValue,
    save_identity: OfficeSaveIdentity,
    intent: OfficeWriteIntent,
) -> Result<(), JSONRPCErrorError> {
    let proposed_revision = office_record_revision(proposed);
    match (save_identity, latest) {
        (OfficeSaveIdentity::New, None) if proposed_revision.is_none() => Ok(()),
        (OfficeSaveIdentity::New, None) => Err(invalid_params(
            "new Office config cannot reuse an existing recordRevision",
        )),
        (OfficeSaveIdentity::New, Some(_)) => Err(internal_error(
            "generated Office recordId collided with an existing record",
        )),
        (OfficeSaveIdentity::Existing, None) if proposed_revision.is_some() => Err(invalid_params(
            "new Office config cannot reuse an existing recordRevision",
        )),
        (OfficeSaveIdentity::Existing, None) => Err(invalid_params(
            "office record identity no longer exists; reload the Office list before retrying",
        )),
        (OfficeSaveIdentity::Existing, Some(latest)) => {
            match (office_record_revision(&latest.config), proposed_revision) {
                (None, None) => Ok(()),
                (Some(_), None) if intent == OfficeWriteIntent::LegacyMigration => Ok(()),
                (Some(latest_revision), Some(proposed_revision))
                    if latest_revision == proposed_revision =>
                {
                    Ok(())
                }
                _ => Err(invalid_params(
                    "office config is stale; reload the latest Office record and retry",
                )),
            }
        }
    }
}

pub(super) fn office_record_id(config: &JsonValue) -> Option<&str> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get(OFFICE_RECORD_ID_FIELD))
        .and_then(JsonValue::as_str)
}

fn validate_office_record_id(config: &JsonValue) -> Result<Option<&str>, String> {
    let Some(value) = config
        .get("workspace")
        .and_then(|workspace| workspace.get(OFFICE_RECORD_ID_FIELD))
    else {
        return Ok(None);
    };
    let Some(record_id) = value.as_str() else {
        return Err("workspace.recordId must be a string".to_string());
    };
    if record_id.is_empty()
        || record_id != record_id.trim()
        || record_id.chars().any(char::is_whitespace)
    {
        return Err(
            "workspace.recordId must be non-empty and must not contain whitespace".to_string(),
        );
    }
    if record_id.chars().count() > MAX_OFFICE_RECORD_ID_CHARS {
        return Err(format!(
            "workspace.recordId must not exceed {MAX_OFFICE_RECORD_ID_CHARS} characters"
        ));
    }
    Ok(Some(record_id))
}

fn set_office_record_id(config: &mut JsonValue, record_id: &str) -> Result<(), JSONRPCErrorError> {
    let workspace = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))?;
    workspace.insert(
        OFFICE_RECORD_ID_FIELD.to_string(),
        JsonValue::String(record_id.to_string()),
    );
    Ok(())
}

pub(super) fn office_record_revision(config: &JsonValue) -> Option<&str> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get(OFFICE_RECORD_REVISION_FIELD))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|revision| !revision.is_empty())
}

fn validate_office_manager_binding_write(
    source_thread_id: Option<&str>,
    target_thread_id: Option<&str>,
    write: OfficeManagerBindingWrite,
) -> Result<(), JSONRPCErrorError> {
    if source_thread_id == target_thread_id {
        return Ok(());
    }
    let target_is_runtime = target_thread_id.is_some_and(is_runtime_thread_id);
    match write {
        OfficeManagerBindingWrite::LegacyInitial if source_thread_id.is_none() => Ok(()),
        OfficeManagerBindingWrite::LegacyInitial => Err(invalid_params(
            "office config is stale; reload the latest Office record and retry",
        )),
        OfficeManagerBindingWrite::PreserveExisting => Err(invalid_params(
            "Office manager thread bindings are server-owned; use office/manager/ensure",
        )),
        OfficeManagerBindingWrite::ServerEnsure
            if source_thread_id.is_none() && target_is_runtime =>
        {
            Ok(())
        }
        OfficeManagerBindingWrite::ServerEnsure
            if source_thread_id.is_some() && target_is_runtime =>
        {
            Err(invalid_params(
                "office config is stale; reload the latest Office record and retry",
            ))
        }
        OfficeManagerBindingWrite::ServerEnsure => Err(internal_error(
            "server-owned Office manager ensure attempted an invalid thread binding transition",
        )),
    }
}

fn ordinary_manager_binding_write(intent: OfficeWriteIntent) -> OfficeManagerBindingWrite {
    match intent {
        OfficeWriteIntent::Create | OfficeWriteIntent::LegacyMigration => {
            OfficeManagerBindingWrite::LegacyInitial
        }
        OfficeWriteIntent::Update => OfficeManagerBindingWrite::PreserveExisting,
    }
}

fn is_runtime_thread_id(thread_id: &str) -> bool {
    ThreadId::from_string(thread_id).is_ok()
}

fn set_office_record_revision(
    config: &mut JsonValue,
    revision: &str,
) -> Result<(), JSONRPCErrorError> {
    let workspace = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| invalid_params("office config is missing workspace"))?;
    workspace.insert(
        OFFICE_RECORD_REVISION_FIELD.to_string(),
        JsonValue::String(revision.to_string()),
    );
    Ok(())
}

pub(super) fn record_identity_path(directory: &Path, record_id: &str) -> PathBuf {
    let digest = sha256_hex(record_id.as_bytes());
    directory.join(format!(".record-{digest}.identity"))
}

pub(super) fn legacy_thread_identity_path(directory: &Path, thread_id: &str) -> PathBuf {
    let digest = sha256_hex(thread_id.as_bytes());
    directory.join(format!(".workspace-{digest}.identity"))
}

pub(super) async fn write_atomically_preserving_permissions(
    file_path: &Path,
    contents: String,
) -> Result<(), JSONRPCErrorError> {
    let file_path = file_path.to_path_buf();
    task::spawn_blocking(move || {
        let permissions = std::fs::metadata(&file_path)
            .ok()
            .map(|metadata| metadata.permissions());
        write_atomically(&file_path, &contents)?;
        if let Some(permissions) = permissions
            && let Err(err) = std::fs::set_permissions(&file_path, permissions)
        {
            tracing::warn!(
                path = %file_path.display(),
                %err,
                "Office record committed but its previous permissions could not be restored"
            );
        }
        Ok::<_, io::Error>(())
    })
    .await
    .map_err(|err| internal_error(format!("domain config persistence task failed: {err}")))?
    .map_err(map_io_error)
}

#[cfg(test)]
#[path = "crewon_domain_office_scheduler_list_tests.rs"]
mod scheduler_list_tests;

#[cfg(test)]
#[path = "crewon_domain_office_storage_tests.rs"]
mod tests;
