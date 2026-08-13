use super::process::terminate_managed_children;
use super::process::ManagedChild as CommandChild;
use super::process::ProcessRole;
use super::reload::RuntimeGeneration;
use super::workspace_fence::WorkspaceSwitchFence;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;
use crate::workspace_native::DesktopWorkspaceAuthority;

pub(super) struct DetachedRuntime {
    pub(super) generation: RuntimeGeneration,
    pub(super) expected: Vec<ProcessRole>,
    control: CommandChild,
    worker: CommandChild,
}

pub(super) struct StopDetachedOutcome {
    pub(super) processes: Vec<CommandChild>,
    pub(super) stopped: bool,
}

pub(super) fn detach_current(
    supervisor: &ControlRuntimeSupervisor,
    authority: &DesktopWorkspaceAuthority,
) -> Result<DetachedRuntime, ControlRuntimeStartError> {
    let mut lifecycle = supervisor
        .lifecycle
        .lock()
        .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
    if !lifecycle.available
        || lifecycle.control_api.is_none()
        || lifecycle.worker.is_none()
        || lifecycle
            .workspace
            .as_ref()
            .is_some_and(|context| !context.matches_authority(authority))
        || (authority.current_snapshot().is_some() && lifecycle.workspace.is_none())
    {
        return Err(ControlRuntimeStartError::RuntimeUnavailable);
    }
    let generation = RuntimeGeneration {
        control: next(lifecycle.control_generation)?,
        worker: next(lifecycle.worker_generation)?,
    };
    let expected = vec![
        ProcessRole::ControlApi(lifecycle.control_generation),
        ProcessRole::Worker(lifecycle.worker_generation),
    ];
    supervisor.terminations.begin(expected.clone())?;
    let detached = DetachedRuntime {
        control: lifecycle.control_api.take().expect("checked Control child"),
        worker: lifecycle.worker.take().expect("checked Worker child"),
        generation,
        expected,
    };
    lifecycle.available = false;
    lifecycle.candidate_failures.clear();
    lifecycle.workspace = None;
    lifecycle.control_generation = generation.control;
    lifecycle.worker_generation = generation.worker;
    Ok(detached)
}

pub(super) fn stop_detached(
    supervisor: &ControlRuntimeSupervisor,
    detached: DetachedRuntime,
) -> StopDetachedOutcome {
    let DetachedRuntime {
        control,
        worker,
        expected,
        ..
    } = detached;
    let processes = vec![control, worker];
    let stopped = terminate_managed_children(&processes, super::TERMINATION_TIMEOUT);
    let processes = if stopped {
        supervisor.terminations.finish(&expected);
        Vec::new()
    } else {
        processes
    };
    StopDetachedOutcome { processes, stopped }
}

pub(super) fn stop_failed_installed(
    supervisor: &ControlRuntimeSupervisor,
    generation: RuntimeGeneration,
    fence: WorkspaceSwitchFence,
) -> Option<WorkspaceSwitchFence> {
    let mut lifecycle = supervisor
        .lifecycle
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let generations_match = lifecycle.control_generation == generation.control
        && lifecycle.worker_generation == generation.worker;
    lifecycle.available = false;
    lifecycle.candidate_failures.clear();
    let expected = [
        lifecycle
            .control_api
            .as_ref()
            .map(|_| ProcessRole::ControlApi(lifecycle.control_generation)),
        lifecycle
            .worker
            .as_ref()
            .map(|_| ProcessRole::Worker(lifecycle.worker_generation)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let processes = [lifecycle.control_api.take(), lifecycle.worker.take()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    lifecycle.workspace = None;
    drop(lifecycle);
    if generations_match && terminate_managed_children(&processes, super::TERMINATION_TIMEOUT) {
        return Some(fence);
    }
    match fence.into_connection() {
        Ok(connection) => {
            supervisor.retain_failed_admission_fence_with_processes(connection, expected, processes)
        }
        Err(_) => {
            for process in processes {
                std::mem::forget(process);
            }
        }
    }
    None
}

fn next(value: u64) -> Result<u64, ControlRuntimeStartError> {
    value
        .checked_add(1)
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)
}
