fn candidate_authority(
    authority: &DesktopWorkspaceAuthority,
    mutation: WorkspaceAuthorityMutation,
) -> Result<(Option<SelectedWorkspaceAuthority>, u64), WorkspaceNativeError> {
    let revision = next_revision(authority.revision)?;
    match mutation {
        WorkspaceAuthorityMutation::Select(candidate) => {
            if let Some(current) = authority
                .current
                .as_ref()
                .filter(|current| current.trusted_path == candidate.trusted_path)
            {
                let mut selected = current.clone();
                selected.revision = revision;
                return Ok((Some(selected), revision));
            }
            Ok((
                Some(SelectedWorkspaceAuthority {
                    trusted_path: candidate.trusted_path,
                    workspace_binding_id: random_id("desktop-workspace")?,
                    incarnation_id: random_id("desktop-incarnation")?,
                    workspace_runtime_binding_id: random_id("desktop-workspace-runtime")?,
                    display_name: candidate.display_name,
                    revision,
                }),
                revision,
            ))
        }
        WorkspaceAuthorityMutation::Clear if authority.current.is_some() => Ok((None, revision)),
        WorkspaceAuthorityMutation::Clear => Err(WorkspaceNativeError::AuthorityConflict),
    }
}

fn replay_prepare(
    authority: &DesktopWorkspaceAuthority,
    operation_id: &str,
    expected_revision: u64,
    mutation: &WorkspaceAuthorityMutation,
) -> Result<Option<WorkspaceAuthorityPrepareResult>, WorkspaceNativeError> {
    if let Some(pending) = authority
        .pending
        .as_ref()
        .filter(|pending| pending.operation_id == operation_id)
    {
        if pending.phase() != WorkspaceAuthorityPendingPhase::Prepared
            || pending.expected_revision != expected_revision
            || !candidate_matches(&pending.candidate, mutation)
        {
            return Err(WorkspaceNativeError::AuthorityConflict);
        }
        return Ok(Some(WorkspaceAuthorityPrepareResult::Pending(
            pending.clone(),
        )));
    }
    if let Some(receipt) = matching_receipt(authority, operation_id)? {
        if receipt.expected_revision != expected_revision
            || receipt.intent() != mutation.intent()
            || !candidate_matches(&receipt.candidate, mutation)
        {
            return Err(WorkspaceNativeError::AuthorityConflict);
        }
        return match receipt.resolution {
            WorkspaceAuthorityOperationResolution::Committed => Ok(Some(
                WorkspaceAuthorityPrepareResult::Committed(receipt.candidate.clone()),
            )),
            WorkspaceAuthorityOperationResolution::Aborted => {
                Ok(Some(WorkspaceAuthorityPrepareResult::Aborted))
            }
            WorkspaceAuthorityOperationResolution::UserCanceled => {
                Err(WorkspaceNativeError::AuthorityConflict)
            }
            WorkspaceAuthorityOperationResolution::LegacyNoOp => {
                Err(WorkspaceNativeError::AuthorityConflict)
            }
        };
    }
    Ok(None)
}

fn prepared_pending(
    authority: &DesktopWorkspaceAuthority,
    operation_id: &str,
) -> Result<PendingWorkspaceAuthority, WorkspaceNativeError> {
    authority
        .pending
        .as_ref()
        .filter(|pending| {
            pending.operation_id == operation_id
                && pending.phase() == WorkspaceAuthorityPendingPhase::Prepared
        })
        .cloned()
        .ok_or(WorkspaceNativeError::AuthorityConflict)
}

fn matching_receipt<'a>(
    authority: &'a DesktopWorkspaceAuthority,
    operation_id: &str,
) -> Result<Option<&'a WorkspaceAuthorityOperationReceipt>, WorkspaceNativeError> {
    if !valid_id(operation_id) {
        return Err(WorkspaceNativeError::AuthorityInvalid);
    }
    if authority
        .pending
        .as_ref()
        .is_some_and(|pending| pending.operation_id != operation_id)
    {
        return Ok(None);
    }
    Ok(authority
        .last_operation
        .as_ref()
        .filter(|receipt| receipt.operation_id == operation_id))
}

fn receipt(
    pending: &PendingWorkspaceAuthority,
    resolution: WorkspaceAuthorityOperationResolution,
) -> WorkspaceAuthorityOperationReceipt {
    WorkspaceAuthorityOperationReceipt {
        operation_id: pending.operation_id.clone(),
        expected_revision: pending.expected_revision,
        result_revision: pending.result_revision,
        candidate: pending.candidate.clone(),
        resolution,
        intent: pending.intent(),
    }
}

fn candidate_matches(
    candidate: &Option<SelectedWorkspaceAuthority>,
    mutation: &WorkspaceAuthorityMutation,
) -> bool {
    match (candidate, mutation) {
        (Some(candidate), WorkspaceAuthorityMutation::Select(selected)) => {
            candidate.trusted_path == selected.trusted_path
        }
        (None, WorkspaceAuthorityMutation::Clear) => true,
        (Some(_), WorkspaceAuthorityMutation::Clear)
        | (None, WorkspaceAuthorityMutation::Select(_)) => false,
    }
}

fn next_revision(revision: u64) -> Result<u64, WorkspaceNativeError> {
    revision
        .checked_add(1)
        .filter(|revision| *revision <= super::catalog::MAX_SAFE_REVISION)
        .ok_or(WorkspaceNativeError::AuthorityInvalid)
}
