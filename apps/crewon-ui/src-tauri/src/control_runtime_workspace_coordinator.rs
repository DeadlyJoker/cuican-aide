use std::path::PathBuf;

use tauri::AppHandle;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use super::prepare_paths;
use super::workspace_status::open_authority;
use super::workspace_status::project_status;
use super::workspace_switch::switch_workspace_runtime;
use super::workspace_wire::DesktopWorkspaceClearOutcome;
use super::workspace_wire::DesktopWorkspaceClearResponse;
use super::workspace_wire::DesktopWorkspaceError;
use super::workspace_wire::DesktopWorkspaceMutationRequest;
use super::workspace_wire::DesktopWorkspaceSelectOutcome;
use super::workspace_wire::DesktopWorkspaceSelectResponse;
use super::ControlRuntimeSupervisor;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::WorkspaceAuthorityIntent;
use crate::workspace_native::WorkspaceAuthorityIntentReplay;
use crate::workspace_native::WorkspaceAuthorityPrepareResult;
use crate::workspace_native::WorkspaceSelectionBeginResult;

enum SelectionIntentOutcome {
    Prepared,
    UserCanceled,
    ReplayedCommitted,
}

#[tauri::command]
pub(crate) fn desktop_workspace_select_and_register(
    app: AppHandle,
    supervisor: State<'_, ControlRuntimeSupervisor>,
    request: Option<serde_json::Value>,
) -> Result<DesktopWorkspaceSelectResponse, DesktopWorkspaceError> {
    let request = DesktopWorkspaceMutationRequest::parse(request)?;
    supervisor.require_workspace_authority_lease()?;
    supervisor.require_no_failed_process_quarantine()?;
    let _reload = supervisor
        .reload
        .lock()
        .map_err(|_| DesktopWorkspaceError::unavailable())?;
    let paths = prepare_paths(&app)
        .map_err(|_| DesktopWorkspaceError::internal_not_sent("desktop_workspace_paths_invalid"))?;
    let mut manager = open_authority(&app)?;
    let outcome = prepare_selection_intent(&mut manager, &request, || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|path| path.into_path())
            .transpose()
            .map_err(|_| DesktopWorkspaceError::request_invalid())
    })?;
    match outcome {
        SelectionIntentOutcome::UserCanceled => Ok(DesktopWorkspaceSelectResponse {
            outcome: DesktopWorkspaceSelectOutcome::UserCanceled,
            snapshot: project_status(&supervisor, manager.authority(), false)?,
        }),
        SelectionIntentOutcome::ReplayedCommitted => Ok(DesktopWorkspaceSelectResponse {
            outcome: DesktopWorkspaceSelectOutcome::Committed,
            snapshot: project_status(&supervisor, manager.authority(), false)?,
        }),
        SelectionIntentOutcome::Prepared => {
            switch_workspace_runtime(
                &app,
                &supervisor,
                &paths,
                &mut manager,
                &request.idempotency_key,
                request.expected_revision,
                WorkspaceAuthorityIntent::Select,
            )?;
            Ok(DesktopWorkspaceSelectResponse {
                outcome: DesktopWorkspaceSelectOutcome::Committed,
                snapshot: project_status(&supervisor, manager.authority(), false)?,
            })
        }
    }
}

#[tauri::command]
pub(crate) fn desktop_workspace_clear(
    app: AppHandle,
    supervisor: State<'_, ControlRuntimeSupervisor>,
    request: Option<serde_json::Value>,
) -> Result<DesktopWorkspaceClearResponse, DesktopWorkspaceError> {
    let request = DesktopWorkspaceMutationRequest::parse(request)?;
    supervisor.require_workspace_authority_lease()?;
    supervisor.require_no_failed_process_quarantine()?;
    let _reload = supervisor
        .reload
        .lock()
        .map_err(|_| DesktopWorkspaceError::unavailable())?;
    let paths = prepare_paths(&app)
        .map_err(|_| DesktopWorkspaceError::internal_not_sent("desktop_workspace_paths_invalid"))?;
    let mut manager = open_authority(&app)?;
    match manager
        .replay_intent(
            &request.idempotency_key,
            request.expected_revision,
            WorkspaceAuthorityIntent::Clear,
        )
        .map_err(DesktopWorkspaceError::from_native)?
    {
        Some(WorkspaceAuthorityIntentReplay::Committed(None)) => {
            return Ok(DesktopWorkspaceClearResponse {
                outcome: DesktopWorkspaceClearOutcome::Committed,
                snapshot: project_status(&supervisor, manager.authority(), false)?,
            });
        }
        Some(WorkspaceAuthorityIntentReplay::Pending) => {
            return Err(DesktopWorkspaceError::transitioning());
        }
        Some(WorkspaceAuthorityIntentReplay::Committed(Some(_)))
        | Some(WorkspaceAuthorityIntentReplay::UserCanceled)
        | Some(WorkspaceAuthorityIntentReplay::Aborted)
        | Some(WorkspaceAuthorityIntentReplay::LegacyNoOp) => {
            return Err(DesktopWorkspaceError::conflict());
        }
        None => {}
    }
    match manager
        .prepare_clear(&request.idempotency_key, request.expected_revision)
        .map_err(DesktopWorkspaceError::from_native)?
    {
        WorkspaceAuthorityPrepareResult::Pending(_) => {}
        WorkspaceAuthorityPrepareResult::Committed(_)
        | WorkspaceAuthorityPrepareResult::Aborted => {
            return Err(DesktopWorkspaceError::conflict());
        }
    }
    switch_workspace_runtime(
        &app,
        &supervisor,
        &paths,
        &mut manager,
        &request.idempotency_key,
        request.expected_revision,
        WorkspaceAuthorityIntent::Clear,
    )?;
    Ok(DesktopWorkspaceClearResponse {
        outcome: DesktopWorkspaceClearOutcome::Committed,
        snapshot: project_status(&supervisor, manager.authority(), false)?,
    })
}

fn prepare_selection_intent(
    manager: &mut DesktopWorkspaceAuthorityManager,
    request: &DesktopWorkspaceMutationRequest,
    pick: impl FnOnce() -> Result<Option<PathBuf>, DesktopWorkspaceError>,
) -> Result<SelectionIntentOutcome, DesktopWorkspaceError> {
    match manager
        .begin_selection_intent(&request.idempotency_key, request.expected_revision)
        .map_err(DesktopWorkspaceError::from_native)?
    {
        WorkspaceSelectionBeginResult::Fresh => {}
        WorkspaceSelectionBeginResult::Awaiting => {
            return Err(DesktopWorkspaceError::transitioning());
        }
        WorkspaceSelectionBeginResult::Replayed(replay) => {
            return match replay {
                WorkspaceAuthorityIntentReplay::Committed(Some(_)) => {
                    Ok(SelectionIntentOutcome::ReplayedCommitted)
                }
                WorkspaceAuthorityIntentReplay::UserCanceled => {
                    Ok(SelectionIntentOutcome::UserCanceled)
                }
                WorkspaceAuthorityIntentReplay::Pending => {
                    Err(DesktopWorkspaceError::transitioning())
                }
                WorkspaceAuthorityIntentReplay::Committed(None)
                | WorkspaceAuthorityIntentReplay::Aborted
                | WorkspaceAuthorityIntentReplay::LegacyNoOp => {
                    Err(DesktopWorkspaceError::conflict())
                }
            };
        }
    }
    let path = match pick() {
        Ok(path) => path,
        Err(_) => {
            manager
                .record_selection_canceled(&request.idempotency_key, request.expected_revision)
                .map_err(|_| DesktopWorkspaceError::aborted())?;
            return Ok(SelectionIntentOutcome::UserCanceled);
        }
    };
    let Some(path) = path else {
        manager
            .record_selection_canceled(&request.idempotency_key, request.expected_revision)
            .map_err(DesktopWorkspaceError::from_native)?;
        return Ok(SelectionIntentOutcome::UserCanceled);
    };
    if let Err(error) = manager.prepare_awaiting_selection(
        &request.idempotency_key,
        request.expected_revision,
        path,
    ) {
        if error == crate::workspace_native::WorkspaceNativeError::AuthorityMutationUnknown {
            return Err(DesktopWorkspaceError::from_native(error));
        }
        if !manager
            .reload_if_unchanged()
            .map_err(DesktopWorkspaceError::from_native)?
        {
            return Err(DesktopWorkspaceError::aborted());
        }
        manager
            .record_selection_canceled(&request.idempotency_key, request.expected_revision)
            .map_err(|_| DesktopWorkspaceError::aborted())?;
        return Ok(SelectionIntentOutcome::UserCanceled);
    }
    Ok(SelectionIntentOutcome::Prepared)
}

#[cfg(test)]
#[path = "control_runtime_workspace_coordinator_tests.rs"]
mod tests;
