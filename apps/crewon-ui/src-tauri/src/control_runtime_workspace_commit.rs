use super::workspace_wire::DesktopWorkspaceError;
use super::RuntimePaths;
use crate::workspace_native::DesktopWorkspaceAuthority;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::WorkspaceAuthorityIntent;
use crate::workspace_native::WorkspaceAuthorityIntentReplay;

pub(super) fn commit_or_reload(
    paths: &RuntimePaths,
    manager: &mut DesktopWorkspaceAuthorityManager,
    operation_id: &str,
    expected_revision: u64,
    intent: WorkspaceAuthorityIntent,
    candidate: &DesktopWorkspaceAuthority,
) -> Result<bool, DesktopWorkspaceError> {
    match manager.commit(operation_id) {
        Ok(_) => manager
            .committed_candidate_matches(operation_id, expected_revision, intent, candidate)
            .map_err(DesktopWorkspaceError::from_native),
        Err(_) => {
            let shadow =
                DesktopWorkspaceAuthorityManager::open_durable(paths.workspace_authority.clone())
                    .map_err(DesktopWorkspaceError::from_native)?;
            if shadow
                .committed_candidate_matches(operation_id, expected_revision, intent, candidate)
                .map_err(DesktopWorkspaceError::from_native)?
            {
                *manager = shadow;
                return Ok(true);
            }
            match shadow
                .replay_intent(operation_id, expected_revision, intent)
                .map_err(DesktopWorkspaceError::from_native)?
            {
                Some(WorkspaceAuthorityIntentReplay::Pending) => Ok(false),
                Some(WorkspaceAuthorityIntentReplay::Committed(_)) => {
                    Err(DesktopWorkspaceError::aborted())
                }
                Some(WorkspaceAuthorityIntentReplay::UserCanceled)
                | Some(WorkspaceAuthorityIntentReplay::Aborted)
                | Some(WorkspaceAuthorityIntentReplay::LegacyNoOp)
                | None => Err(DesktopWorkspaceError::aborted()),
            }
        }
    }
}
