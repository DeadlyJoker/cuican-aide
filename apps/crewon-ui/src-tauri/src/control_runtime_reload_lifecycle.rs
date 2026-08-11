fn start_and_supervise_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderRuntime>,
    generation: RuntimeGeneration,
) -> Result<(), (ControlRuntimeStartError, RuntimeGeneration)> {
    let children = start_runtime(app, supervisor, paths, provider, generation)
        .map_err(|error| (error, generation))?;
    supervise_started_runtime(app, supervisor, children, generation)
}

pub(super) fn supervise_started_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    children: RuntimeChildren,
    generation: RuntimeGeneration,
) -> Result<(), (ControlRuntimeStartError, RuntimeGeneration)> {
    let prepared = prepare_runtime_supervision(app, supervisor, children, generation)
        .map_err(|error| (error, generation))?;
    match install_prepared_runtime(supervisor, prepared, generation) {
        Ok(()) => Ok(()),
        Err((error, prepared)) => {
            stop_prepared_runtime(supervisor, prepared);
            Err((error, generation))
        }
    }
}

pub(super) fn prepare_runtime_supervision(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    children: RuntimeChildren,
    generation: RuntimeGeneration,
) -> Result<PreparedRuntimeSupervision, ControlRuntimeStartError> {
    let RuntimeChildren {
        control,
        control_events,
        worker,
        worker_events,
    } = children;
    let control_monitor = match prepare_process_monitor(
        app.clone(),
        control_events,
        "control-api-reload",
        ProcessRole::ControlApi(generation.control),
    ) {
        Ok(monitor) => monitor,
        Err(error) => {
            supervisor.quarantine_candidate_processes(vec![control, worker]);
            return Err(error);
        }
    };
    let worker_monitor = match prepare_process_monitor(
        app.clone(),
        worker_events,
        "runtime-worker-reload",
        ProcessRole::Worker(generation.worker),
    ) {
        Ok(monitor) => monitor,
        Err(error) => {
            drop(control_monitor);
            supervisor.quarantine_candidate_processes(vec![control, worker]);
            return Err(error);
        }
    };
    Ok(PreparedRuntimeSupervision {
        control,
        control_monitor,
        worker,
        worker_monitor,
    })
}

pub(super) fn install_prepared_runtime(
    supervisor: &ControlRuntimeSupervisor,
    prepared: PreparedRuntimeSupervision,
    generation: RuntimeGeneration,
) -> Result<(), (ControlRuntimeStartError, PreparedRuntimeSupervision)> {
    let PreparedRuntimeSupervision {
        control,
        control_monitor,
        worker,
        worker_monitor,
    } = prepared;
    match install_runtime(supervisor, control, worker, generation) {
        Ok(()) => {
            control_monitor.activate();
            worker_monitor.activate();
            Ok(())
        }
        Err((control, worker)) => Err((
            ControlRuntimeStartError::RuntimeUnavailable,
            PreparedRuntimeSupervision {
                control,
                control_monitor,
                worker,
                worker_monitor,
            },
        )),
    }
}

pub(super) fn stop_prepared_runtime(
    supervisor: &ControlRuntimeSupervisor,
    prepared: PreparedRuntimeSupervision,
) {
    let PreparedRuntimeSupervision {
        control,
        control_monitor,
        worker,
        worker_monitor,
    } = prepared;
    drop(control_monitor);
    drop(worker_monitor);
    supervisor.quarantine_candidate_processes(vec![control, worker]);
}

pub(super) fn stage_runtime_candidate(
    supervisor: &ControlRuntimeSupervisor,
    prepared: PreparedRuntimeSupervision,
) -> Result<(), PreparedRuntimeSupervision> {
    let Ok(mut candidate) = supervisor.candidate_runtime.lock() else {
        return Err(prepared);
    };
    if candidate.is_some() {
        return Err(prepared);
    }
    *candidate = Some(prepared);
    Ok(())
}

pub(super) fn stop_staged_runtime_candidate(supervisor: &ControlRuntimeSupervisor) {
    let candidate = supervisor
        .candidate_runtime
        .lock()
        .ok()
        .and_then(|mut candidate| candidate.take());
    if let Some(candidate) = candidate {
        stop_prepared_runtime(supervisor, candidate);
    }
}

pub(super) fn install_staged_runtime_candidate(
    supervisor: &ControlRuntimeSupervisor,
    generation: RuntimeGeneration,
) -> Result<(), ControlRuntimeStartError> {
    let prepared = supervisor
        .candidate_runtime
        .lock()
        .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?
        .take()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    match install_prepared_runtime(supervisor, prepared, generation) {
        Ok(()) => Ok(()),
        Err((error, prepared)) => {
            stop_prepared_runtime(supervisor, prepared);
            Err(error)
        }
    }
}
