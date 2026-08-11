use std::sync::TryLockError;

use tauri::AppHandle;
use tauri::Manager;
use tauri::State;

use super::workspace_wire::DesktopWorkspaceAvailability;
use super::workspace_wire::DesktopWorkspaceError;
use super::workspace_wire::DesktopWorkspaceStatus;
use super::ControlRuntimeSupervisor;
use crate::workspace_native::DesktopWorkspaceAuthority;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;

#[tauri::command]
pub(crate) fn desktop_workspace_status(
    app: AppHandle,
    supervisor: State<'_, ControlRuntimeSupervisor>,
) -> Result<DesktopWorkspaceStatus, DesktopWorkspaceError> {
    supervisor.require_workspace_authority_lease()?;
    let _ = supervisor.retry_failed_process_quarantine();
    match supervisor.reload.try_lock() {
        Ok(reload) => {
            let manager = open_authority(&app)?;
            let status = project_status(&supervisor, manager.authority(), false);
            drop(reload);
            status
        }
        Err(TryLockError::WouldBlock) => {
            let manager = open_authority(&app)?;
            project_status(&supervisor, manager.authority(), true)
        }
        Err(TryLockError::Poisoned(_)) => Err(DesktopWorkspaceError::unavailable()),
    }
}

pub(super) fn open_authority(
    app: &AppHandle,
) -> Result<DesktopWorkspaceAuthorityManager, DesktopWorkspaceError> {
    let authority_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| DesktopWorkspaceError::unavailable())?
        .join("control-runtime-v0")
        .join("workspace-authority-v0");
    DesktopWorkspaceAuthorityManager::open_durable(authority_directory).map_err(|error| match error
    {
        crate::workspace_native::WorkspaceNativeError::AuthorityInvalid => {
            DesktopWorkspaceError::internal("desktop_workspace_authority_corrupt")
        }
        other => DesktopWorkspaceError::from_native(other),
    })
}

pub(super) fn project_status(
    supervisor: &ControlRuntimeSupervisor,
    authority: &DesktopWorkspaceAuthority,
    transitioning: bool,
) -> Result<DesktopWorkspaceStatus, DesktopWorkspaceError> {
    let lifecycle = supervisor
        .lifecycle
        .lock()
        .map_err(|_| DesktopWorkspaceError::unavailable())?;
    let supervisor_generation = lifecycle
        .control_generation
        .max(lifecycle.worker_generation)
        .max(lifecycle.device_generation)
        .max(lifecycle.gateway_generation);
    if transitioning {
        return DesktopWorkspaceStatus::project(
            authority,
            DesktopWorkspaceAvailability::Transitioning,
            supervisor_generation,
        );
    }
    let runtime_matches = if authority.current_snapshot().is_some() {
        lifecycle.control_api.is_some()
            && lifecycle.worker.is_some()
            && lifecycle.device.is_some()
            && lifecycle.gateway.is_some()
            && lifecycle
                .workspace
                .as_ref()
                .is_some_and(|workspace| workspace.matches_authority(authority))
    } else {
        lifecycle.control_api.is_some()
            && lifecycle.worker.is_some()
            && lifecycle.device.is_none()
            && lifecycle.gateway.is_none()
            && lifecycle.workspace.is_none()
    };
    let availability = if !lifecycle.available || !runtime_matches {
        DesktopWorkspaceAvailability::Unavailable
    } else if authority.pending().is_some() {
        DesktopWorkspaceAvailability::Transitioning
    } else {
        DesktopWorkspaceAvailability::Available
    };
    DesktopWorkspaceStatus::project(authority, availability, supervisor_generation)
}

#[cfg(test)]
#[path = "control_runtime_workspace_status_tests.rs"]
mod tests;
