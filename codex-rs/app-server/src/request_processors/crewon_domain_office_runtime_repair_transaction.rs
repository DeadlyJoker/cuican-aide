use std::future::Future;
use std::path::PathBuf;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use serde_json::Value as JsonValue;

use super::DomainKind;
use super::OfficeRunSyncUpdate;
use super::OfficeRuntimeRepairMutation;
use super::domain_directory;
use super::map_io_error;
use super::office_authority_lock;
use super::office_record_lock;
use super::office_runtime_owner_reconciliation;
use super::office_runtime_owner_registry;
use super::office_storage;
use super::office_thread_id;
use super::read_record;
use super::validate_record_file_path;
use super::write_domain_record;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

pub(super) async fn apply(
    cwd: &str,
    repair: OfficeRuntimeRepairMutation<'_>,
    mutate: impl FnOnce(&mut JsonValue) -> bool + Send,
) -> Result<Option<OfficeRunSyncUpdate>, JSONRPCErrorError> {
    let agent_id = repair.agent_id;
    let replacement_thread_id = repair.replacement_thread_id;
    apply_server_mutation_with_writer(
        cwd,
        repair,
        move |config| {
            if !mutate(config) {
                return Ok(OfficeRuntimeMutation::Unchanged);
            }
            Ok(OfficeRuntimeMutation::BindReplacement {
                member_id: repaired_member_id(config, agent_id, replacement_thread_id)?,
            })
        },
        |file_path, saved_at, config| async move {
            write_domain_record(DomainKind::Office, &file_path, saved_at, config).await
        },
    )
    .await
}

pub(super) enum OfficeRuntimeMutation {
    Unchanged,
    Updated,
    BindReplacement { member_id: Option<String> },
}

pub(super) async fn apply_server_mutation(
    cwd: &str,
    repair: OfficeRuntimeRepairMutation<'_>,
    mutate: impl FnOnce(&mut JsonValue) -> Result<OfficeRuntimeMutation, JSONRPCErrorError> + Send,
) -> Result<Option<OfficeRunSyncUpdate>, JSONRPCErrorError> {
    apply_server_mutation_with_writer(
        cwd,
        repair,
        mutate,
        |file_path, saved_at, config| async move {
            write_domain_record(DomainKind::Office, &file_path, saved_at, config).await
        },
    )
    .await
}

async fn apply_server_mutation_with_writer<WriteRecord, WriteFuture>(
    cwd: &str,
    repair: OfficeRuntimeRepairMutation<'_>,
    mutate: impl FnOnce(&mut JsonValue) -> Result<OfficeRuntimeMutation, JSONRPCErrorError> + Send,
    write_record: WriteRecord,
) -> Result<Option<OfficeRunSyncUpdate>, JSONRPCErrorError>
where
    WriteRecord: FnOnce(PathBuf, String, JsonValue) -> WriteFuture,
    WriteFuture: Future<Output = Result<(), JSONRPCErrorError>>,
{
    let file_path = validate_record_file_path(cwd, DomainKind::Office, repair.file_path)?;
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let mut runtime_owners = office_runtime_owner_registry::load(cwd, &authority_guard).await?;
    office_runtime_owner_reconciliation::reconcile_if_needed(&directory, &mut runtime_owners)
        .await?;
    let discovered = read_record(DomainKind::Office, &file_path)
        .await?
        .ok_or_else(|| invalid_params("office config file does not match the requested kind"))?;
    let record_id = office_storage::office_record_id(&discovered.config)
        .ok_or_else(|| internal_error("strict Office read returned a record without recordId"))?
        .to_string();
    let _identity_guard = office_record_lock::lock(&office_storage::record_identity_path(
        &directory, &record_id,
    ))
    .await
    .map_err(map_io_error)?;
    let _record_guard = office_record_lock::lock(&file_path)
        .await
        .map_err(map_io_error)?;
    let latest = read_record(DomainKind::Office, &file_path)
        .await?
        .ok_or_else(|| invalid_params("office config file does not match the requested kind"))?;
    if office_storage::office_record_id(&latest.config) != Some(record_id.as_str()) {
        return Err(internal_error(
            "Office record identity changed while acquiring its repair lock",
        ));
    }
    let manager_thread_id = office_thread_id(&latest.config).map(str::to_string);
    let _thread_identity_guard = match manager_thread_id.as_deref() {
        Some(thread_id) => {
            let guard = office_record_lock::lock(&office_storage::legacy_thread_identity_path(
                &directory, thread_id,
            ))
            .await
            .map_err(map_io_error)?;
            office_storage::validate_office_thread_ownership(&directory, thread_id, &record_id)
                .await?;
            Some(guard)
        }
        None => None,
    };
    runtime_owners
        .register_persisted_repairs(&latest.config)
        .await?;

    let mut config = latest.config;
    let mutation = mutate(&mut config)?;
    if matches!(mutation, OfficeRuntimeMutation::Unchanged) {
        return Ok(None);
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    if office_storage::office_record_id(&config) != Some(record_id.as_str()) {
        return Err(invalid_params(
            "Office runtime repair cannot change workspace.recordId",
        ));
    }
    if office_thread_id(&config) != manager_thread_id.as_deref() {
        return Err(invalid_params(
            "Office runtime repair cannot change workspace.threadId",
        ));
    }
    let claim = match mutation {
        OfficeRuntimeMutation::BindReplacement { member_id } => Some(
            runtime_owners
                .claim_member_pending(
                    repair.replacement_thread_id,
                    &record_id,
                    member_id.as_deref(),
                    repair.agent_id,
                    repair.source_thread_id,
                )
                .await?,
        ),
        OfficeRuntimeMutation::Updated => None,
        OfficeRuntimeMutation::Unchanged => unreachable!("handled above"),
    };
    if let Err(error) = runtime_owners.validate_config(&config) {
        if let Some(claim) = claim.as_ref() {
            remove_failed_claim(&mut runtime_owners, claim).await;
        }
        return Err(error);
    }

    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    if let Err(error) = write_record(file_path.clone(), saved_at, config.clone()).await {
        if let Some(claim) = claim.as_ref() {
            remove_failed_claim(&mut runtime_owners, claim).await;
        }
        return Err(error);
    }
    if let Some(claim) = claim.as_ref()
        && let Err(error) = runtime_owners.activate(claim).await
    {
        tracing::warn!(
            runtime_thread_id = repair.replacement_thread_id,
            record_id,
            agent_id = repair.agent_id,
            error = %error.message,
            "Office runtime repair committed with a pending owner claim; a later save will activate it"
        );
    }
    Ok(Some(OfficeRunSyncUpdate {
        file_path: file_path.to_string_lossy().into_owned(),
        config,
    }))
}

fn repaired_member_id(
    config: &JsonValue,
    agent_id: &str,
    replacement_thread_id: &str,
) -> Result<Option<String>, JSONRPCErrorError> {
    let matching = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|member| {
            member.get("agentId").and_then(JsonValue::as_str) == Some(agent_id)
                && member
                    .get("runtime")
                    .and_then(|runtime| runtime.get("threadId"))
                    .and_then(JsonValue::as_str)
                    == Some(replacement_thread_id)
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err(invalid_params(
            "Office runtime repair must resolve to one exact workspace member",
        ));
    }
    Ok(matching[0]
        .get("memberId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|member_id| !member_id.is_empty())
        .map(str::to_string))
}

async fn remove_failed_claim(
    runtime_owners: &mut office_runtime_owner_registry::OfficeRuntimeOwnerRegistryGuard<'_>,
    claim: &office_runtime_owner_registry::PendingRuntimeOwnerClaim,
) {
    if let Err(error) = runtime_owners.remove_pending(claim).await {
        tracing::warn!(
            error = %error.message,
            "failed to remove an uncommitted Office runtime owner claim"
        );
    }
}

#[cfg(test)]
#[path = "crewon_domain_office_runtime_repair_transaction_tests.rs"]
mod tests;
