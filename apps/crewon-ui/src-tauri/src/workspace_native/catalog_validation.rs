use std::path::Path;

use super::catalog::DesktopWorkspaceAuthority;
use super::catalog::PendingWorkspaceAuthority;
use super::catalog::SelectedWorkspaceAuthority;
use super::catalog::WorkspaceAuthorityIntent;
use super::catalog::WorkspaceAuthorityOperationReceipt;
use super::catalog::WorkspaceAuthorityOperationResolution;
use super::catalog::WorkspaceAuthorityPendingPhase;
use super::catalog::AUTHORITY_SCHEMA;
use super::catalog::MAX_SAFE_REVISION;
use super::catalog_values::canonical_workspace;
use super::catalog_values::valid_id;
use super::WorkspaceNativeError;

pub(super) fn validate_authority(
    authority: &DesktopWorkspaceAuthority,
) -> Result<(), WorkspaceNativeError> {
    if authority.schema_version != AUTHORITY_SCHEMA
        || !valid_id(&authority.device_id)
        || !valid_id(&authority.device_binding_id)
        || authority.revision > MAX_SAFE_REVISION
    {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    if let Some(current) = &authority.current {
        validate_active_workspace(current)?;
        if current.revision != authority.revision {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
    }
    if let Some(pending) = &authority.pending {
        validate_pending(authority, pending)?;
    }
    if let Some(receipt) = &authority.last_operation {
        validate_receipt(authority, receipt)?;
        if authority
            .pending
            .as_ref()
            .is_some_and(|pending| pending.operation_id == receipt.operation_id)
        {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
    }
    Ok(())
}

fn validate_pending(
    authority: &DesktopWorkspaceAuthority,
    pending: &PendingWorkspaceAuthority,
) -> Result<(), WorkspaceNativeError> {
    if let Some(candidate) = &pending.candidate {
        validate_workspace_snapshot(candidate)?;
        if candidate.revision != pending.result_revision {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
    }
    if !valid_id(&pending.operation_id) || pending.expected_revision != authority.current_revision()
    {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    match pending.phase() {
        WorkspaceAuthorityPendingPhase::SelectAwaitingDialog => {
            if pending.intent() != WorkspaceAuthorityIntent::Select
                || pending.result_revision != pending.expected_revision
                || pending.candidate != authority.current
            {
                return Err(WorkspaceNativeError::AuthorityInvalid);
            }
        }
        WorkspaceAuthorityPendingPhase::Prepared => {
            if pending.result_revision != pending.expected_revision.saturating_add(1)
                || !intent_candidate_matches(pending.intent(), &pending.candidate)
                || pending.candidate == authority.current
            {
                return Err(WorkspaceNativeError::AuthorityInvalid);
            }
        }
    }
    Ok(())
}

fn validate_receipt(
    authority: &DesktopWorkspaceAuthority,
    receipt: &WorkspaceAuthorityOperationReceipt,
) -> Result<(), WorkspaceNativeError> {
    if let Some(candidate) = &receipt.candidate {
        validate_workspace_snapshot(candidate)?;
        if candidate.revision != receipt.result_revision {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
    }
    if !valid_id(&receipt.operation_id) {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    match receipt.resolution {
        WorkspaceAuthorityOperationResolution::Committed => {
            if receipt.result_revision != receipt.expected_revision.saturating_add(1)
                || !intent_candidate_matches(receipt.intent(), &receipt.candidate)
                || authority.current != receipt.candidate
                || authority.revision != receipt.result_revision
            {
                return Err(WorkspaceNativeError::AuthorityInvalid);
            }
        }
        WorkspaceAuthorityOperationResolution::UserCanceled => {
            if receipt.intent() != WorkspaceAuthorityIntent::Select
                || receipt.result_revision != receipt.expected_revision
                || authority.current_revision() != receipt.expected_revision
                || authority.current != receipt.candidate
            {
                return Err(WorkspaceNativeError::AuthorityInvalid);
            }
        }
        WorkspaceAuthorityOperationResolution::Aborted => {
            if authority.current_revision() != receipt.expected_revision
                || receipt.result_revision != receipt.expected_revision.saturating_add(1)
                || !intent_candidate_matches(receipt.intent(), &receipt.candidate)
                || receipt.candidate == authority.current
            {
                return Err(WorkspaceNativeError::AuthorityInvalid);
            }
        }
        WorkspaceAuthorityOperationResolution::LegacyNoOp => {
            if receipt.result_revision != receipt.expected_revision
                || authority.revision != receipt.expected_revision
                || authority.current != receipt.candidate
                || !intent_candidate_matches(receipt.intent(), &receipt.candidate)
            {
                return Err(WorkspaceNativeError::AuthorityInvalid);
            }
        }
    }
    Ok(())
}

fn intent_candidate_matches(
    intent: WorkspaceAuthorityIntent,
    candidate: &Option<SelectedWorkspaceAuthority>,
) -> bool {
    match intent {
        WorkspaceAuthorityIntent::Select => candidate.is_some(),
        WorkspaceAuthorityIntent::Clear => candidate.is_none(),
    }
}

fn validate_active_workspace(
    workspace: &SelectedWorkspaceAuthority,
) -> Result<(), WorkspaceNativeError> {
    validate_workspace_snapshot(workspace)?;
    let canonical = canonical_workspace(Path::new(&workspace.trusted_path))?;
    if canonical.trusted_path != workspace.trusted_path
        || canonical.display_name != workspace.display_name
    {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    Ok(())
}

fn validate_workspace_snapshot(
    workspace: &SelectedWorkspaceAuthority,
) -> Result<(), WorkspaceNativeError> {
    if !valid_id(&workspace.workspace_binding_id)
        || !valid_id(&workspace.incarnation_id)
        || !valid_id(&workspace.workspace_runtime_binding_id)
        || workspace.revision == 0
        || workspace.revision > MAX_SAFE_REVISION
        || workspace.trusted_path.is_empty()
        || workspace.trusted_path.len() > 4_096
        || workspace.trusted_path.chars().any(char::is_control)
        || !Path::new(&workspace.trusted_path).is_absolute()
        || workspace.display_name.is_empty()
        || workspace.display_name.len() > 255
        || workspace.display_name.chars().any(char::is_control)
        || workspace.display_name.contains('/')
        || workspace.display_name.contains('\\')
        || workspace
            .display_name
            .to_ascii_lowercase()
            .starts_with("file:")
        || workspace
            .display_name
            .to_ascii_lowercase()
            .starts_with("http:")
        || workspace
            .display_name
            .to_ascii_lowercase()
            .starts_with("https:")
    {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    Ok(())
}
