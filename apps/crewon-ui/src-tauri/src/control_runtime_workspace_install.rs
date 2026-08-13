use std::sync::Arc;

use tauri::AppHandle;

use super::environment::ControlAdmissionMode;
use super::process::prepare_process_monitor;
use super::process::prepare_process_monitor_with_ready;
use super::process::ManagedChild as CommandChild;
use super::process::PreparedProcessMonitor;
use super::process::ProcessEvents;
use super::process::ProcessRole;
use super::reload::RuntimeGeneration;
use super::workspace::WorkspaceRuntimeContext;
use super::workspace_fence::WorkspaceSwitchFence;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;
use super::READY_TIMEOUT;
use crate::workspace_native::DesktopWorkspaceAuthority;

const ACTIVATION_CONFIRMED: &[u8] = b"CrewON Control API activation confirmed";

pub(super) struct CompleteWorkspaceRuntime {
    pub(super) context: Option<Arc<WorkspaceRuntimeContext>>,
    pub(super) control: CommandChild,
    pub(super) control_events: ProcessEvents,
    pub(super) worker: CommandChild,
    pub(super) worker_events: ProcessEvents,
}

pub(super) struct PreparedWorkspaceInstall {
    admission: ControlAdmissionMode,
    context: Option<Arc<WorkspaceRuntimeContext>>,
    control: CommandChild,
    control_monitor: PreparedProcessMonitor,
    worker: CommandChild,
    worker_monitor: PreparedProcessMonitor,
}

pub(super) fn prepare_workspace_install(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    runtime: CompleteWorkspaceRuntime,
    generation: RuntimeGeneration,
    admission: ControlAdmissionMode,
) -> Result<PreparedWorkspaceInstall, ControlRuntimeStartError> {
    let CompleteWorkspaceRuntime {
        context,
        control,
        control_events,
        worker,
        worker_events,
    } = runtime;
    let control_monitor = match admission {
        ControlAdmissionMode::Active => prepare_process_monitor(
            app.clone(),
            control_events,
            "control-api-workspace-switch",
            ProcessRole::ControlApi(generation.control),
        ),
        ControlAdmissionMode::Paused => prepare_process_monitor_with_ready(
            app.clone(),
            control_events,
            "control-api-workspace-switch",
            ProcessRole::ControlApi(generation.control),
            ACTIVATION_CONFIRMED,
        ),
    };
    let control_monitor = match control_monitor {
        Ok(monitor) => monitor,
        Err(error) => {
            stop_children(supervisor, control, worker);
            return Err(error);
        }
    };
    let worker_monitor = match prepare_process_monitor(
        app.clone(),
        worker_events,
        "runtime-worker-workspace-switch",
        ProcessRole::Worker(generation.worker),
    ) {
        Ok(monitor) => monitor,
        Err(error) => {
            drop(control_monitor);
            stop_children(supervisor, control, worker);
            return Err(error);
        }
    };
    Ok(PreparedWorkspaceInstall {
        admission,
        context,
        control,
        control_monitor,
        worker,
        worker_monitor,
    })
}

pub(super) fn install_prepared_workspace(
    supervisor: &ControlRuntimeSupervisor,
    prepared: PreparedWorkspaceInstall,
    generation: RuntimeGeneration,
) -> Result<(), ControlRuntimeStartError> {
    let mut lifecycle = match supervisor.lifecycle.lock() {
        Ok(lifecycle) => lifecycle,
        Err(_) => {
            prepared.stop(supervisor);
            return Err(ControlRuntimeStartError::RuntimeUnavailable);
        }
    };
    if lifecycle.control_generation != generation.control
        || lifecycle.worker_generation != generation.worker
        || lifecycle.control_api.is_some()
        || lifecycle.worker.is_some()
    {
        drop(lifecycle);
        prepared.stop(supervisor);
        return Err(ControlRuntimeStartError::RuntimeUnavailable);
    }
    let PreparedWorkspaceInstall {
        admission,
        context,
        control,
        control_monitor,
        worker,
        worker_monitor,
    } = prepared;
    lifecycle.control_api = Some(control);
    lifecycle.worker = Some(worker);
    lifecycle.workspace = context;
    lifecycle.available = admission == ControlAdmissionMode::Active;
    lifecycle.candidate_failures.clear();
    drop(lifecycle);
    worker_monitor.activate();
    match admission {
        ControlAdmissionMode::Active => control_monitor.activate(),
        ControlAdmissionMode::Paused => {
            let wrote_activation = supervisor.lifecycle.lock().is_ok_and(|mut lifecycle| {
                lifecycle
                    .control_api
                    .as_mut()
                    .is_some_and(|control| control.write(b"activate\n").is_ok())
            });
            if !wrote_activation
                || control_monitor
                    .activate_and_wait_ready(READY_TIMEOUT)
                    .is_err()
            {
                return Err(ControlRuntimeStartError::ControlApiNotReady);
            }
        }
    }
    Ok(())
}

pub(super) fn commit_workspace_install(
    supervisor: &ControlRuntimeSupervisor,
    generation: RuntimeGeneration,
    authority: &DesktopWorkspaceAuthority,
    fence: WorkspaceSwitchFence,
) -> Result<(), WorkspaceSwitchFence> {
    let mut lifecycle = match supervisor.lifecycle.lock() {
        Ok(lifecycle) => lifecycle,
        Err(_) => return Err(fence),
    };
    if lifecycle.control_generation != generation.control
        || lifecycle.worker_generation != generation.worker
        || !lifecycle.candidate_failures.is_empty()
        || lifecycle.control_api.is_none()
        || lifecycle.worker.is_none()
        || lifecycle
            .control_api
            .as_ref()
            .is_none_or(|control| !control.is_running())
        || lifecycle
            .worker
            .as_ref()
            .is_none_or(|worker| !worker.is_running())
        || (authority.current_snapshot().is_some()
            && lifecycle
                .workspace
                .as_ref()
                .is_none_or(|workspace| !workspace.matches_authority(authority)))
        || (authority.current_snapshot().is_none() && lifecycle.workspace.is_some())
    {
        return Err(fence);
    }
    fence.commit()?;
    lifecycle.available = true;
    Ok(())
}

impl PreparedWorkspaceInstall {
    pub(super) fn stop(self, supervisor: &ControlRuntimeSupervisor) {
        let Self {
            control,
            control_monitor,
            worker,
            worker_monitor,
            ..
        } = self;
        drop(control_monitor);
        drop(worker_monitor);
        stop_children(supervisor, control, worker);
    }
}

fn stop_children(
    supervisor: &ControlRuntimeSupervisor,
    control: CommandChild,
    worker: CommandChild,
) {
    let children = vec![control, worker];
    supervisor.quarantine_candidate_processes(children);
}

#[cfg(test)]
#[path = "control_runtime_workspace_install_tests.rs"]
mod tests;
