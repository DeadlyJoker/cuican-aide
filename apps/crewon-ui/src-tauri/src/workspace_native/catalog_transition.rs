use std::path::PathBuf;

use super::catalog::DesktopWorkspaceAuthority;
use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::PendingWorkspaceAuthority;
use super::catalog::SelectedWorkspaceAuthority;
use super::catalog::WorkspaceAuthorityIntent;
use super::catalog::WorkspaceAuthorityIntentReplay;
use super::catalog::WorkspaceAuthorityOperationReceipt;
use super::catalog::WorkspaceAuthorityOperationResolution;
use super::catalog::WorkspaceAuthorityPendingPhase;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::catalog::WorkspaceSelectionBeginResult;
use super::catalog_validation::validate_authority;
use super::catalog_values::canonical_workspace;
use super::catalog_values::random_id;
use super::catalog_values::valid_id;
use super::catalog_values::CanonicalWorkspace;
use super::WorkspaceNativeError;

impl DesktopWorkspaceAuthorityManager {
    pub(crate) fn active_authority_projection(
        &self,
    ) -> Result<DesktopWorkspaceAuthority, WorkspaceNativeError> {
        let mut active = self.authority.clone();
        active.pending = None;
        active.last_operation = None;
        validate_authority(&active)?;
        Ok(active)
    }

    pub(crate) fn committed_candidate_matches(
        &self,
        operation_id: &str,
        expected_revision: u64,
        intent: WorkspaceAuthorityIntent,
        candidate: &DesktopWorkspaceAuthority,
    ) -> Result<bool, WorkspaceNativeError> {
        let Some(receipt) = matching_receipt(&self.authority, operation_id)? else {
            return Ok(false);
        };
        Ok(self.authority.pending.is_none()
            && self.authority.schema_version == candidate.schema_version
            && self.authority.device_id == candidate.device_id
            && self.authority.device_binding_id == candidate.device_binding_id
            && self.authority.revision == candidate.revision
            && self.authority.current == candidate.current
            && receipt.expected_revision == expected_revision
            && receipt.result_revision == candidate.revision
            && receipt.candidate == candidate.current
            && receipt.intent() == intent
            && receipt.resolution == WorkspaceAuthorityOperationResolution::Committed)
    }

    pub(crate) fn replay_intent(
        &self,
        operation_id: &str,
        expected_revision: u64,
        intent: WorkspaceAuthorityIntent,
    ) -> Result<Option<WorkspaceAuthorityIntentReplay>, WorkspaceNativeError> {
        if !valid_id(operation_id) {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
        if let Some(pending) = self
            .authority
            .pending
            .as_ref()
            .filter(|pending| pending.operation_id == operation_id)
        {
            if pending.expected_revision != expected_revision || pending.intent() != intent {
                return Err(WorkspaceNativeError::AuthorityConflict);
            }
            return Ok(Some(WorkspaceAuthorityIntentReplay::Pending));
        }
        let Some(receipt) = self
            .authority
            .last_operation
            .as_ref()
            .filter(|receipt| receipt.operation_id == operation_id)
        else {
            return Ok(None);
        };
        if receipt.expected_revision != expected_revision || receipt.intent() != intent {
            return Err(WorkspaceNativeError::AuthorityConflict);
        }
        match (intent, receipt.resolution) {
            (
                WorkspaceAuthorityIntent::Select,
                WorkspaceAuthorityOperationResolution::Committed,
            ) if receipt.candidate.is_some() => Ok(Some(
                WorkspaceAuthorityIntentReplay::Committed(receipt.candidate.clone()),
            )),
            (WorkspaceAuthorityIntent::Clear, WorkspaceAuthorityOperationResolution::Committed)
                if receipt.candidate.is_none() =>
            {
                Ok(Some(WorkspaceAuthorityIntentReplay::Committed(None)))
            }
            (
                WorkspaceAuthorityIntent::Select,
                WorkspaceAuthorityOperationResolution::UserCanceled,
            ) if receipt.candidate == self.authority.current => {
                Ok(Some(WorkspaceAuthorityIntentReplay::UserCanceled))
            }
            (WorkspaceAuthorityIntent::Select, WorkspaceAuthorityOperationResolution::Aborted)
                if receipt.candidate.is_some() =>
            {
                Ok(Some(WorkspaceAuthorityIntentReplay::Aborted))
            }
            (WorkspaceAuthorityIntent::Clear, WorkspaceAuthorityOperationResolution::Aborted)
                if receipt.candidate.is_none() =>
            {
                Ok(Some(WorkspaceAuthorityIntentReplay::Aborted))
            }
            (_, WorkspaceAuthorityOperationResolution::LegacyNoOp) => {
                Ok(Some(WorkspaceAuthorityIntentReplay::LegacyNoOp))
            }
            (WorkspaceAuthorityIntent::Select, _) | (WorkspaceAuthorityIntent::Clear, _) => {
                Err(WorkspaceNativeError::AuthorityConflict)
            }
        }
    }

    pub(crate) fn begin_selection_intent(
        &mut self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<WorkspaceSelectionBeginResult, WorkspaceNativeError> {
        if let Some(replay) = self.replay_intent(
            operation_id,
            expected_revision,
            WorkspaceAuthorityIntent::Select,
        )? {
            if replay == WorkspaceAuthorityIntentReplay::Pending
                && self.authority.pending.as_ref().is_some_and(|pending| {
                    pending.phase() == WorkspaceAuthorityPendingPhase::SelectAwaitingDialog
                })
            {
                return Ok(WorkspaceSelectionBeginResult::Awaiting);
            }
            return Ok(WorkspaceSelectionBeginResult::Replayed(replay));
        }
        if self.authority.pending.is_some() || self.authority.revision != expected_revision {
            return Err(WorkspaceNativeError::AuthorityConflict);
        }
        if self.authority.revision >= super::catalog::MAX_SAFE_REVISION {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
        let pending = PendingWorkspaceAuthority {
            operation_id: operation_id.to_string(),
            expected_revision,
            result_revision: expected_revision,
            candidate: self.authority.current.clone(),
            intent: WorkspaceAuthorityIntent::Select,
            phase: WorkspaceAuthorityPendingPhase::SelectAwaitingDialog,
        };
        let mut next = self.authority.clone();
        next.pending = Some(pending);
        validate_authority(&next)?;
        self.persist(next)?;
        Ok(WorkspaceSelectionBeginResult::Fresh)
    }

    pub(crate) fn prepare_awaiting_selection(
        &mut self,
        operation_id: &str,
        expected_revision: u64,
        candidate_path: PathBuf,
    ) -> Result<PendingWorkspaceAuthority, WorkspaceNativeError> {
        let selected = canonical_workspace(&candidate_path)?;
        let pending = self
            .authority
            .pending
            .as_ref()
            .filter(|pending| {
                pending.operation_id == operation_id
                    && pending.expected_revision == expected_revision
                    && pending.intent() == WorkspaceAuthorityIntent::Select
                    && pending.phase() == WorkspaceAuthorityPendingPhase::SelectAwaitingDialog
            })
            .ok_or(WorkspaceNativeError::AuthorityConflict)?;
        if pending.result_revision != expected_revision
            || pending.candidate != self.authority.current
        {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
        let (candidate, result_revision) = candidate_authority(
            &self.authority,
            WorkspaceAuthorityMutation::Select(selected),
        )?;
        let prepared = PendingWorkspaceAuthority {
            operation_id: operation_id.to_string(),
            expected_revision,
            result_revision,
            candidate,
            intent: WorkspaceAuthorityIntent::Select,
            phase: WorkspaceAuthorityPendingPhase::Prepared,
        };
        let mut next = self.authority.clone();
        next.pending = Some(prepared.clone());
        validate_authority(&next)?;
        self.persist(next)?;
        Ok(prepared)
    }

    pub(crate) fn record_selection_canceled(
        &mut self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<(), WorkspaceNativeError> {
        if let Some(pending) = self.authority.pending.as_ref() {
            if pending.operation_id != operation_id
                || pending.expected_revision != expected_revision
                || pending.intent() != WorkspaceAuthorityIntent::Select
                || pending.phase() != WorkspaceAuthorityPendingPhase::SelectAwaitingDialog
            {
                return Err(WorkspaceNativeError::AuthorityConflict);
            }
            let canceled = pending.clone();
            let mut next = self.authority.clone();
            next.pending = None;
            next.last_operation = Some(receipt(
                &canceled,
                WorkspaceAuthorityOperationResolution::UserCanceled,
            ));
            validate_authority(&next)?;
            return self.persist(next);
        }
        match self.replay_intent(
            operation_id,
            expected_revision,
            WorkspaceAuthorityIntent::Select,
        )? {
            Some(WorkspaceAuthorityIntentReplay::UserCanceled) => Ok(()),
            Some(WorkspaceAuthorityIntentReplay::Pending)
            | Some(WorkspaceAuthorityIntentReplay::Committed(_))
            | Some(WorkspaceAuthorityIntentReplay::Aborted)
            | Some(WorkspaceAuthorityIntentReplay::LegacyNoOp)
            | None => Err(WorkspaceNativeError::AuthorityConflict),
        }
    }

    pub(crate) fn recover_orphaned_pending(&mut self) -> Result<(), WorkspaceNativeError> {
        let Some(pending) = self.authority.pending.clone() else {
            return Ok(());
        };
        if pending.phase() == WorkspaceAuthorityPendingPhase::SelectAwaitingDialog {
            self.record_selection_canceled(&pending.operation_id, pending.expected_revision)
        } else {
            self.abort(&pending.operation_id)
        }
    }

    pub(crate) fn pending_candidate_authority(
        &self,
        operation_id: &str,
    ) -> Result<DesktopWorkspaceAuthority, WorkspaceNativeError> {
        let pending = self
            .authority
            .pending
            .as_ref()
            .filter(|pending| pending.operation_id == operation_id)
            .ok_or(WorkspaceNativeError::AuthorityConflict)?;
        if pending.phase() != WorkspaceAuthorityPendingPhase::Prepared {
            return Err(WorkspaceNativeError::AuthorityConflict);
        }
        let mut candidate = self.authority.clone();
        candidate.revision = pending.result_revision;
        candidate.current = pending.candidate.clone();
        candidate.pending = None;
        candidate.last_operation = None;
        validate_authority(&candidate)?;
        Ok(candidate)
    }

    pub(crate) fn prepare(
        &mut self,
        operation_id: &str,
        expected_revision: u64,
        candidate_path: PathBuf,
    ) -> Result<WorkspaceAuthorityPrepareResult, WorkspaceNativeError> {
        self.prepare_mutation(
            operation_id,
            expected_revision,
            WorkspaceAuthorityMutation::Select(canonical_workspace(&candidate_path)?),
        )
    }

    pub(crate) fn prepare_clear(
        &mut self,
        operation_id: &str,
        expected_revision: u64,
    ) -> Result<WorkspaceAuthorityPrepareResult, WorkspaceNativeError> {
        self.prepare_mutation(
            operation_id,
            expected_revision,
            WorkspaceAuthorityMutation::Clear,
        )
    }

    fn prepare_mutation(
        &mut self,
        operation_id: &str,
        expected_revision: u64,
        mutation: WorkspaceAuthorityMutation,
    ) -> Result<WorkspaceAuthorityPrepareResult, WorkspaceNativeError> {
        if !valid_id(operation_id) {
            return Err(WorkspaceNativeError::AuthorityInvalid);
        }
        if let Some(result) =
            replay_prepare(&self.authority, operation_id, expected_revision, &mutation)?
        {
            return Ok(result);
        }
        if self.authority.pending.is_some() || self.authority.revision != expected_revision {
            return Err(WorkspaceNativeError::AuthorityConflict);
        }
        let intent = mutation.intent();
        let (candidate, result_revision) = candidate_authority(&self.authority, mutation)?;
        let pending = PendingWorkspaceAuthority {
            operation_id: operation_id.to_string(),
            expected_revision,
            result_revision,
            candidate,
            intent,
            phase: WorkspaceAuthorityPendingPhase::Prepared,
        };
        let mut next = self.authority.clone();
        next.pending = Some(pending.clone());
        validate_authority(&next)?;
        self.persist(next)?;
        Ok(WorkspaceAuthorityPrepareResult::Pending(pending))
    }

    pub(crate) fn commit(
        &mut self,
        operation_id: &str,
    ) -> Result<Option<SelectedWorkspaceAuthority>, WorkspaceNativeError> {
        if let Some(receipt) = matching_receipt(&self.authority, operation_id)? {
            return match receipt.resolution {
                WorkspaceAuthorityOperationResolution::Committed => Ok(receipt.candidate.clone()),
                WorkspaceAuthorityOperationResolution::UserCanceled
                | WorkspaceAuthorityOperationResolution::Aborted
                | WorkspaceAuthorityOperationResolution::LegacyNoOp => {
                    Err(WorkspaceNativeError::AuthorityConflict)
                }
            };
        }
        let pending = prepared_pending(&self.authority, operation_id)?;
        let mut next = self.authority.clone();
        next.revision = pending.result_revision;
        next.current = pending.candidate.clone();
        next.pending = None;
        next.last_operation = Some(receipt(
            &pending,
            WorkspaceAuthorityOperationResolution::Committed,
        ));
        validate_authority(&next)?;
        self.persist(next)?;
        Ok(pending.candidate)
    }

    pub(crate) fn abort(&mut self, operation_id: &str) -> Result<(), WorkspaceNativeError> {
        if let Some(receipt) = matching_receipt(&self.authority, operation_id)? {
            return match receipt.resolution {
                WorkspaceAuthorityOperationResolution::Aborted => Ok(()),
                WorkspaceAuthorityOperationResolution::Committed
                | WorkspaceAuthorityOperationResolution::UserCanceled
                | WorkspaceAuthorityOperationResolution::LegacyNoOp => {
                    Err(WorkspaceNativeError::AuthorityConflict)
                }
            };
        }
        let pending = prepared_pending(&self.authority, operation_id)?;
        let mut next = self.authority.clone();
        next.pending = None;
        next.last_operation = Some(receipt(
            &pending,
            WorkspaceAuthorityOperationResolution::Aborted,
        ));
        validate_authority(&next)?;
        self.persist(next)
    }
}

include!("catalog_transition_values.rs");
include!("catalog_transition_helpers.rs");
