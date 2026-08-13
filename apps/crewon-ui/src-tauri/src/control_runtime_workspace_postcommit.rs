use tauri::AppHandle;

use super::environment::ControlAdmissionMode;
use super::private_credentials::PrivateCredentialBindings;
use super::reload::RuntimeGeneration;
use super::workspace_candidate::stage_candidate;
use super::workspace_candidate::stop_staged_candidate;
use super::workspace_candidate::take_staged_candidate;
use super::workspace_fence::WorkspaceSwitchFence;
use super::workspace_install::commit_workspace_install;
use super::workspace_install::install_prepared_workspace;
use super::workspace_install::prepare_workspace_install;
use super::workspace_switch::complete_candidate;
use super::workspace_switch::StagedWorkspaceCandidate;
use super::workspace_termination::stop_failed_installed;
use super::workspace_wire::DesktopWorkspaceError;
use super::ControlRuntimeSupervisor;
use super::RuntimePaths;
use crate::workspace_native::DesktopWorkspaceAuthority;

pub(super) fn recover_committed_candidate(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    authority: &DesktopWorkspaceAuthority,
    private_credentials: Option<&PrivateCredentialBindings>,
    generation: RuntimeGeneration,
    fence: WorkspaceSwitchFence,
) -> Result<(), DesktopWorkspaceError> {
    let generation = match prepare_repair_generation(supervisor, generation) {
        Ok(generation) => generation,
        Err(()) => {
            retain_unrecoverable_activation_fence(supervisor, fence);
            return Err(DesktopWorkspaceError::aborted());
        }
    };
    if supervisor.require_no_failed_process_quarantine().is_err()
        || stage_candidate(
            supervisor,
            StagedWorkspaceCandidate {
                foundation: None,
                worker: None,
                control: None,
                prepared: None,
            },
        )
        .is_err()
        || complete_candidate(
            app,
            supervisor,
            paths,
            authority,
            private_credentials,
            generation,
            ControlAdmissionMode::Paused,
        )
        .is_err()
    {
        stop_staged_candidate(supervisor);
        retain_unrecoverable_activation_fence(supervisor, fence);
        return Err(DesktopWorkspaceError::aborted());
    }
    let prepared = match take_staged_candidate(supervisor)
        .and_then(StagedWorkspaceCandidate::into_complete)
        .and_then(|runtime| {
            prepare_workspace_install(
                app,
                supervisor,
                runtime,
                generation,
                ControlAdmissionMode::Paused,
            )
            .map_err(|_| DesktopWorkspaceError::aborted())
        }) {
        Ok(prepared) => prepared,
        Err(_) => {
            stop_staged_candidate(supervisor);
            retain_unrecoverable_activation_fence(supervisor, fence);
            return Err(DesktopWorkspaceError::aborted());
        }
    };
    if install_prepared_workspace(supervisor, prepared, generation).is_err() {
        if let Some(fence) = stop_failed_installed(supervisor, generation, fence) {
            retain_unrecoverable_activation_fence(supervisor, fence);
        }
        return Err(DesktopWorkspaceError::aborted());
    }
    if let Err(fence) = commit_workspace_install(supervisor, generation, authority, fence) {
        if let Some(fence) = stop_failed_installed(supervisor, generation, fence) {
            retain_unrecoverable_activation_fence(supervisor, fence);
        }
        return Err(DesktopWorkspaceError::aborted());
    }
    Ok(())
}

fn prepare_repair_generation(
    supervisor: &ControlRuntimeSupervisor,
    failed: RuntimeGeneration,
) -> Result<RuntimeGeneration, ()> {
    let mut lifecycle = supervisor.lifecycle.lock().map_err(|_| ())?;
    if lifecycle.available
        || lifecycle.control_generation != failed.control
        || lifecycle.worker_generation != failed.worker
        || lifecycle.control_api.is_some()
        || lifecycle.worker.is_some()
        || lifecycle.workspace.is_some()
    {
        return Err(());
    }
    let generation = RuntimeGeneration {
        control: failed.control.checked_add(1).ok_or(())?,
        worker: failed.worker.checked_add(1).ok_or(())?,
    };
    lifecycle.control_generation = generation.control;
    lifecycle.worker_generation = generation.worker;
    lifecycle.candidate_failures.clear();
    Ok(generation)
}

fn retain_unrecoverable_activation_fence(
    supervisor: &ControlRuntimeSupervisor,
    fence: WorkspaceSwitchFence,
) {
    if let Ok(connection) = fence.into_connection() {
        supervisor.retain_failed_admission_fence_with_processes(connection, Vec::new(), Vec::new());
    }
}

#[cfg(test)]
#[path = "control_runtime_workspace_postcommit_tests.rs"]
mod tests;
