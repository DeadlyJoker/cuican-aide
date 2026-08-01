use std::collections::BTreeMap;

use serde_json::Map;
use serde_json::Value as JsonValue;

const SERVER_OWNED_DURABLE_DELEGATION_FIELDS: &[&str] = &[
    "dispatchReceipt",
    "turnId",
    "threadId",
    "target",
    "dispatchMethod",
    "dispatchLeaseId",
    "dispatchLeaseStartedAt",
    "dispatchLeaseExpiresAt",
    "status",
    "error",
    "updatedAt",
    "completedAt",
    "cancelRequestedAt",
    "resultPreview",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeServerOwnedFieldsError {
    Conflict,
    InvalidCallerShape,
    InvalidCanonicalShape,
}

#[derive(Clone, Copy)]
enum ConfigAuthority {
    Latest,
    Caller,
}

#[derive(Clone)]
struct DelegationSnapshot {
    run_index: usize,
    delegation_index: usize,
    fields: Map<String, JsonValue>,
}

/// Preserves server-owned durable delegation state while accepting unrelated caller edits.
///
/// A durable receipt is immutable client-visible authority. Callers must round-trip the exact
/// receipt they read and cannot create, remove, move, or modify one. Once a receipt exists, the
/// surrounding delegation runtime fields are copied from the latest canonical record so a stale
/// business edit cannot roll execution state backward.
pub(crate) fn merge_office_server_owned_fields(
    latest: &JsonValue,
    caller: JsonValue,
) -> Result<JsonValue, OfficeServerOwnedFieldsError> {
    let latest_delegations = delegation_snapshots(latest, ConfigAuthority::Latest)?;
    let caller_delegations = delegation_snapshots(&caller, ConfigAuthority::Caller)?;

    for (identity, caller_delegation) in &caller_delegations {
        if caller_delegation.fields.contains_key("dispatchReceipt")
            && latest_delegations
                .get(identity)
                .is_none_or(|latest| !latest.fields.contains_key("dispatchReceipt"))
        {
            return Err(OfficeServerOwnedFieldsError::Conflict);
        }
    }

    let mut merged = caller;
    for (identity, latest_delegation) in latest_delegations {
        let Some(latest_receipt) = latest_delegation.fields.get("dispatchReceipt") else {
            continue;
        };
        let caller_delegation = caller_delegations
            .get(&identity)
            .ok_or(OfficeServerOwnedFieldsError::Conflict)?;
        if caller_delegation.fields.get("dispatchReceipt") != Some(latest_receipt) {
            return Err(OfficeServerOwnedFieldsError::Conflict);
        }

        let merged_delegation = delegation_object_mut(
            &mut merged,
            caller_delegation.run_index,
            caller_delegation.delegation_index,
        )?;
        for field in SERVER_OWNED_DURABLE_DELEGATION_FIELDS {
            match latest_delegation.fields.get(*field) {
                Some(value) => {
                    merged_delegation.insert((*field).to_string(), value.clone());
                }
                None => {
                    merged_delegation.remove(*field);
                }
            }
        }
    }
    Ok(merged)
}

pub(crate) fn reject_office_dispatch_receipt_injection(
    caller: &JsonValue,
) -> Result<(), OfficeServerOwnedFieldsError> {
    let caller_delegations = delegation_snapshots(caller, ConfigAuthority::Caller)?;
    if caller_delegations
        .values()
        .any(|delegation| delegation.fields.contains_key("dispatchReceipt"))
    {
        return Err(OfficeServerOwnedFieldsError::Conflict);
    }
    Ok(())
}

fn delegation_snapshots(
    config: &JsonValue,
    authority: ConfigAuthority,
) -> Result<BTreeMap<(String, String), DelegationSnapshot>, OfficeServerOwnedFieldsError> {
    let workspace = config
        .get("workspace")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| shape_error(authority))?;
    let Some(activity) = workspace.get("activity") else {
        return Ok(BTreeMap::new());
    };
    let activity = activity.as_object().ok_or_else(|| shape_error(authority))?;
    let Some(runs) = activity.get("runs") else {
        return Ok(BTreeMap::new());
    };
    let runs = runs.as_array().ok_or_else(|| shape_error(authority))?;

    let mut run_ids = BTreeMap::new();
    let mut delegations = BTreeMap::new();
    for (run_index, run) in runs.iter().enumerate() {
        let run = run.as_object().ok_or_else(|| shape_error(authority))?;
        let run_id = required_identity(run, "id", authority)?;
        if run_ids.insert(run_id.clone(), ()).is_some() {
            return Err(shape_error(authority));
        }
        let Some(run_delegations) = run.get("delegations") else {
            continue;
        };
        let run_delegations = run_delegations
            .as_array()
            .ok_or_else(|| shape_error(authority))?;
        for (delegation_index, delegation) in run_delegations.iter().enumerate() {
            let delegation = delegation
                .as_object()
                .ok_or_else(|| shape_error(authority))?;
            let delegation_id = required_identity(delegation, "id", authority)?;
            validate_receipt_container_identity(delegation, &run_id, &delegation_id, authority)?;
            let identity = (run_id.clone(), delegation_id);
            if delegations
                .insert(
                    identity,
                    DelegationSnapshot {
                        run_index,
                        delegation_index,
                        fields: delegation.clone(),
                    },
                )
                .is_some()
            {
                return Err(shape_error(authority));
            }
        }
    }
    Ok(delegations)
}

fn required_identity(
    object: &Map<String, JsonValue>,
    field: &str,
    authority: ConfigAuthority,
) -> Result<String, OfficeServerOwnedFieldsError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty() && *value == value.trim())
        .map(str::to_string)
        .ok_or_else(|| shape_error(authority))
}

fn validate_receipt_container_identity(
    delegation: &Map<String, JsonValue>,
    run_id: &str,
    delegation_id: &str,
    authority: ConfigAuthority,
) -> Result<(), OfficeServerOwnedFieldsError> {
    let Some(receipt) = delegation.get("dispatchReceipt") else {
        return Ok(());
    };
    let error = match authority {
        ConfigAuthority::Latest => OfficeServerOwnedFieldsError::InvalidCanonicalShape,
        ConfigAuthority::Caller => OfficeServerOwnedFieldsError::Conflict,
    };
    let receipt = receipt.as_object().ok_or(error)?;
    if receipt.get("runId").and_then(JsonValue::as_str) != Some(run_id)
        || receipt.get("delegationId").and_then(JsonValue::as_str) != Some(delegation_id)
    {
        return Err(error);
    }
    Ok(())
}

fn delegation_object_mut(
    config: &mut JsonValue,
    run_index: usize,
    delegation_index: usize,
) -> Result<&mut Map<String, JsonValue>, OfficeServerOwnedFieldsError> {
    config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("runs"))
        .and_then(JsonValue::as_array_mut)
        .and_then(|runs| runs.get_mut(run_index))
        .and_then(|run| run.get_mut("delegations"))
        .and_then(JsonValue::as_array_mut)
        .and_then(|delegations| delegations.get_mut(delegation_index))
        .and_then(JsonValue::as_object_mut)
        .ok_or(OfficeServerOwnedFieldsError::InvalidCallerShape)
}

fn shape_error(authority: ConfigAuthority) -> OfficeServerOwnedFieldsError {
    match authority {
        ConfigAuthority::Latest => OfficeServerOwnedFieldsError::InvalidCanonicalShape,
        ConfigAuthority::Caller => OfficeServerOwnedFieldsError::InvalidCallerShape,
    }
}

#[cfg(test)]
#[path = "crewon_domain_office_server_owned_fields_tests.rs"]
mod tests;
