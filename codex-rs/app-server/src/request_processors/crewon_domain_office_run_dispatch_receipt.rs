use std::future::Future;

use super::*;
use crate::request_processors::crewon_domain_office_dispatch_receipt;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceipt;
use crate::request_processors::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken;

pub(crate) async fn reserve_delegation_starting(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    token: OfficeDispatchReceiptToken<'_>,
) -> Result<(JsonValue, OfficeDispatchReceipt), JSONRPCErrorError> {
    reserve_delegation_starting_with_writer(
        cwd,
        config,
        run_id,
        delegation_id,
        token,
        |cwd, config| async move { save_record(DomainKind::Office, &cwd, config).await },
    )
    .await
}

async fn reserve_delegation_starting_with_writer<WriteRecord, WriteFuture>(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    token: OfficeDispatchReceiptToken<'_>,
    write_record: WriteRecord,
) -> Result<(JsonValue, OfficeDispatchReceipt), JSONRPCErrorError>
where
    WriteRecord: FnOnce(String, JsonValue) -> WriteFuture,
    WriteFuture: Future<Output = Result<String, JSONRPCErrorError>>,
{
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    let delegation = delegation_mut(&mut config, run_id, delegation_id)?;
    let receipt =
        crewon_domain_office_dispatch_receipt::reserve_starting(delegation, token, &timestamp())
            .map_err(map_receipt_error)?;
    write_record(cwd.to_string(), config.clone()).await?;
    Ok((config, receipt))
}

pub(crate) async fn commit_delegation_admitted(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    token: OfficeDispatchReceiptToken<'_>,
    turn_id: &str,
    state: crewon_core::UserInputOnceState,
) -> Result<(String, JsonValue, OfficeDispatchReceipt), JSONRPCErrorError> {
    commit_delegation_admitted_with_writer(
        cwd,
        config,
        run_id,
        delegation_id,
        token,
        turn_id,
        state,
        |cwd, config| async move { save_record(DomainKind::Office, &cwd, config).await },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn quarantine_delegation_execution_unknown(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    token: OfficeDispatchReceiptToken<'_>,
    turn_id: &str,
    state: crewon_core::UserInputOnceState,
    message: &str,
) -> Result<(String, JsonValue, OfficeDispatchReceipt), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    let delegation = delegation_mut(&mut config, run_id, delegation_id)?;
    let receipt = crewon_domain_office_dispatch_receipt::mark_execution_unknown(
        delegation,
        token,
        turn_id,
        state.into(),
        message,
        &timestamp(),
    )
    .map_err(map_receipt_error)?;
    if let Some(object) = delegation.as_object_mut() {
        clear_child_dispatch_lease(object);
    }
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    Ok((file_path, config, receipt))
}

#[allow(clippy::too_many_arguments)]
async fn commit_delegation_admitted_with_writer<WriteRecord, WriteFuture>(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    token: OfficeDispatchReceiptToken<'_>,
    turn_id: &str,
    state: crewon_core::UserInputOnceState,
    write_record: WriteRecord,
) -> Result<(String, JsonValue, OfficeDispatchReceipt), JSONRPCErrorError>
where
    WriteRecord: FnOnce(String, JsonValue) -> WriteFuture,
    WriteFuture: Future<Output = Result<String, JSONRPCErrorError>>,
{
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    let delegation = delegation_mut(&mut config, run_id, delegation_id)?;
    let receipt = crewon_domain_office_dispatch_receipt::mark_admitted(
        delegation,
        token,
        turn_id,
        state,
        &timestamp(),
    )
    .map_err(map_receipt_error)?;
    if let Some(object) = delegation.as_object_mut() {
        clear_child_dispatch_lease(object);
    }
    let file_path = write_record(cwd.to_string(), config.clone()).await?;
    Ok((file_path, config, receipt))
}

pub(crate) async fn fail_delegation_starting(
    cwd: &str,
    config: JsonValue,
    run_id: &str,
    delegation_id: &str,
    token: OfficeDispatchReceiptToken<'_>,
    message: &str,
) -> Result<(String, JsonValue), JSONRPCErrorError> {
    let _lock = acquire_run_index_lock(cwd).await?;
    let mut config = latest_sync_config(cwd, config, Some(run_id), "").await?;
    {
        let delegation = delegation_mut(&mut config, run_id, delegation_id)?;
        crewon_domain_office_dispatch_receipt::mark_starting_failed(
            delegation,
            token,
            message,
            &timestamp(),
        )
        .map_err(map_receipt_error)?;
    }
    update_delegation_status(
        &mut config,
        run_id,
        delegation_id,
        "failed",
        /*turn_id*/ None,
        Some(message),
    )?;
    let file_path = save_record(DomainKind::Office, cwd, config.clone()).await?;
    Ok((file_path, config))
}

fn delegation_mut<'a>(
    config: &'a mut JsonValue,
    run_id: &str,
    delegation_id: &str,
) -> Result<&'a mut JsonValue, JSONRPCErrorError> {
    let runs = config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("workspace.activity.runs must be an array"))?;
    let run = runs
        .iter_mut()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
        .ok_or_else(|| invalid_params("Office dispatch run no longer exists"))?;
    run.get_mut("delegations")
        .and_then(JsonValue::as_array_mut)
        .and_then(|delegations| {
            delegations.iter_mut().find(|delegation| {
                delegation.get("id").and_then(JsonValue::as_str) == Some(delegation_id)
            })
        })
        .ok_or_else(|| invalid_params("Office delegation no longer exists"))
}

fn map_receipt_error(
    error: crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptError,
) -> JSONRPCErrorError {
    match error {
        crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptError::Conflict => {
            invalid_params("Office dispatch receipt identity conflicts with persisted state")
        }
        crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptError::InvalidDelegation
        | crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptError::InvalidReceipt
        | crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptError::InvalidTransition => {
            invalid_params("Office dispatch receipt state is invalid")
        }
    }
}

#[cfg(test)]
#[path = "crewon_domain_office_run_dispatch_receipt_tests.rs"]
mod tests;
