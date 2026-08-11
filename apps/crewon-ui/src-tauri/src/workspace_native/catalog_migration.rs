use serde::Deserialize;

use super::catalog::DesktopWorkspaceAuthority;
use super::catalog::PendingWorkspaceAuthority;
use super::catalog::SelectedWorkspaceAuthority;
use super::catalog::WorkspaceAuthorityIntent;
use super::catalog::WorkspaceAuthorityOperationReceipt;
use super::catalog::WorkspaceAuthorityOperationResolution;
use super::catalog::WorkspaceAuthorityPendingPhase;
use super::catalog::AUTHORITY_SCHEMA;
use super::WorkspaceNativeError;

const LEGACY_AUTHORITY_SCHEMA: &str = "crewon.desktop-workspace-authority.v0";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyAuthority {
    schema_version: String,
    device_id: String,
    device_binding_id: String,
    revision: u64,
    current: Option<SelectedWorkspaceAuthority>,
    pending: Option<LegacyPending>,
    last_operation: Option<LegacyReceipt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPending {
    operation_id: String,
    expected_revision: u64,
    result_revision: u64,
    candidate: Option<SelectedWorkspaceAuthority>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LegacyResolution {
    Committed,
    Aborted,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyReceipt {
    operation_id: String,
    expected_revision: u64,
    result_revision: u64,
    candidate: Option<SelectedWorkspaceAuthority>,
    resolution: LegacyResolution,
}

pub(super) fn decode_authority(
    value: serde_json::Value,
) -> Result<(DesktopWorkspaceAuthority, bool), WorkspaceNativeError> {
    let schema = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or(WorkspaceNativeError::AuthorityInvalid)?;
    match schema {
        AUTHORITY_SCHEMA => serde_json::from_value(value)
            .map(|authority| (authority, false))
            .map_err(|_| WorkspaceNativeError::AuthorityInvalid),
        LEGACY_AUTHORITY_SCHEMA => migrate_legacy(
            serde_json::from_value(value).map_err(|_| WorkspaceNativeError::AuthorityInvalid)?,
        ),
        _ => Err(WorkspaceNativeError::AuthorityInvalid),
    }
}

fn migrate_legacy(
    legacy: LegacyAuthority,
) -> Result<(DesktopWorkspaceAuthority, bool), WorkspaceNativeError> {
    if legacy.schema_version != LEGACY_AUTHORITY_SCHEMA {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    let (pending, pending_receipt) = match legacy.pending {
        Some(pending)
            if pending.result_revision == pending.expected_revision
                && pending.candidate == legacy.current =>
        {
            let intent = inferred_intent(&pending.candidate);
            (
                None,
                Some(WorkspaceAuthorityOperationReceipt {
                    operation_id: pending.operation_id,
                    expected_revision: pending.expected_revision,
                    result_revision: pending.result_revision,
                    candidate: pending.candidate,
                    resolution: WorkspaceAuthorityOperationResolution::LegacyNoOp,
                    intent,
                }),
            )
        }
        Some(pending) => {
            let intent = inferred_intent(&pending.candidate);
            (
                Some(PendingWorkspaceAuthority {
                    operation_id: pending.operation_id,
                    expected_revision: pending.expected_revision,
                    result_revision: pending.result_revision,
                    candidate: pending.candidate,
                    intent,
                    phase: WorkspaceAuthorityPendingPhase::Prepared,
                }),
                None,
            )
        }
        None => (None, None),
    };
    let migrated_receipt = legacy
        .last_operation
        .map(|receipt| migrate_receipt(receipt, legacy.revision, &legacy.current))
        .transpose()?;
    let last_operation = pending_receipt.or(migrated_receipt);
    Ok((
        DesktopWorkspaceAuthority {
            schema_version: AUTHORITY_SCHEMA.to_string(),
            device_id: legacy.device_id,
            device_binding_id: legacy.device_binding_id,
            revision: legacy.revision,
            current: legacy.current,
            pending,
            last_operation,
        },
        true,
    ))
}

fn migrate_receipt(
    receipt: LegacyReceipt,
    authority_revision: u64,
    current: &Option<SelectedWorkspaceAuthority>,
) -> Result<WorkspaceAuthorityOperationReceipt, WorkspaceNativeError> {
    let legacy_no_op = receipt.result_revision == receipt.expected_revision
        && authority_revision == receipt.expected_revision
        && &receipt.candidate == current;
    let intent = match (&receipt.candidate, receipt.resolution) {
        (Some(_), _) => WorkspaceAuthorityIntent::Select,
        (None, LegacyResolution::Committed) => WorkspaceAuthorityIntent::Clear,
        (None, LegacyResolution::Aborted) if legacy_no_op => WorkspaceAuthorityIntent::Clear,
        (None, LegacyResolution::Aborted)
            if receipt.result_revision > receipt.expected_revision =>
        {
            WorkspaceAuthorityIntent::Clear
        }
        (None, LegacyResolution::Aborted) => {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
    };
    let resolution = match receipt.resolution {
        LegacyResolution::Committed | LegacyResolution::Aborted if legacy_no_op => {
            WorkspaceAuthorityOperationResolution::LegacyNoOp
        }
        LegacyResolution::Committed => WorkspaceAuthorityOperationResolution::Committed,
        LegacyResolution::Aborted => WorkspaceAuthorityOperationResolution::Aborted,
    };
    Ok(WorkspaceAuthorityOperationReceipt {
        operation_id: receipt.operation_id,
        expected_revision: receipt.expected_revision,
        result_revision: receipt.result_revision,
        candidate: receipt.candidate,
        resolution,
        intent,
    })
}

fn inferred_intent(candidate: &Option<SelectedWorkspaceAuthority>) -> WorkspaceAuthorityIntent {
    if candidate.is_some() {
        WorkspaceAuthorityIntent::Select
    } else {
        WorkspaceAuthorityIntent::Clear
    }
}
