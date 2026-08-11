fn start_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderRuntime>,
    private_credentials: Option<&PrivateCredentialBindings>,
    generation: RuntimeGeneration,
) -> Result<RuntimeChildren, ControlRuntimeStartError> {
    let worker = start_worker(app, paths, provider, private_credentials, generation)?;
    let control = match start_control(
        app,
        supervisor,
        paths,
        generation,
        worker.workspace_worker.as_ref(),
    ) {
        Ok(control) => control,
        Err(error) => {
            supervisor.quarantine_candidate_processes(vec![worker.child]);
            return Err(error);
        }
    };
    Ok(RuntimeChildren {
        control: control.child,
        control_events: control.events,
        worker: worker.child,
        worker_events: worker.events,
    })
}

pub(super) fn start_worker(
    app: &AppHandle,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderRuntime>,
    private_credentials: Option<&PrivateCredentialBindings>,
    generation: RuntimeGeneration,
) -> Result<StartedWorker, ControlRuntimeStartError> {
    let supervisor = app
        .try_state::<ControlRuntimeSupervisor>()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let session = supervisor
        .session
        .as_ref()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let workspace = supervisor
        .lifecycle
        .lock()
        .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?
        .workspace
        .clone();
    start_worker_with_context(
        app,
        &supervisor,
        paths,
        provider,
        private_credentials,
        generation,
        session,
        workspace.as_deref(),
    )
}

pub(super) fn start_worker_with_context(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderRuntime>,
    private_credentials: Option<&PrivateCredentialBindings>,
    generation: RuntimeGeneration,
    session: &super::SessionMaterial,
    workspace: Option<&super::workspace::WorkspaceRuntimeContext>,
) -> Result<StartedWorker, ControlRuntimeStartError> {
    let runtime_route = workspace
        .map(super::workspace::WorkspaceRuntimeContext::runtime_route)
        .transpose()?
        .unwrap_or_else(RuntimeRouteProjection::standalone);
    let workspace_bootstrap = workspace
        .map(|workspace| workspace.worker_bootstrap(provider, session, private_credentials))
        .transpose()?;
    let legacy_bootstrap = workspace_bootstrap
        .is_none()
        .then(|| worker_bootstrap_input(provider, session))
        .transpose()
        .map_err(|()| ControlRuntimeStartError::ProviderCredentialUnavailable)?;
    let worker_bootstrap_input = workspace_bootstrap
        .as_ref()
        .map(|bootstrap| bootstrap.input.as_ref())
        .or(legacy_bootstrap.as_deref())
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let (events, child) = spawn_node_with_input(
        app,
        Some(supervisor),
        &paths.worker_bundle,
        &paths.root,
        worker_environment(
            paths,
            provider,
            &runtime_route,
        ),
        if generation.worker.is_multiple_of(2) {
            "crewon-runtime-worker-events-even"
        } else {
            "crewon-runtime-worker-events-odd"
        },
        worker_bootstrap_input,
    )?;
    if wait_for_ready(&events, b"CrewON Runtime Worker started", READY_TIMEOUT).is_err() {
        supervisor.quarantine_candidate_processes(vec![child]);
        return Err(ControlRuntimeStartError::WorkerNotReady);
    }
    let provider_ready = provider_ready_signal(provider);
    if wait_for_ready(&events, provider_ready.as_bytes(), READY_TIMEOUT).is_err() {
        supervisor.quarantine_candidate_processes(vec![child]);
        return Err(ControlRuntimeStartError::WorkerNotReady);
    }
    let (child, workspace_worker) = match workspace_bootstrap {
        Some(bootstrap) => {
            let (child, ready) = admit_workspace_ready(
                child,
                || bootstrap.wait_ready(&events),
                |child| supervisor.quarantine_candidate_processes(vec![child]),
            )?;
            (child, Some(ready))
        }
        None => (child, None),
    };
    Ok(StartedWorker {
        child,
        events,
        workspace_worker,
    })
}

pub(super) fn admit_workspace_ready<W, R, E>(
    worker: W,
    wait_ready: impl FnOnce() -> Result<R, E>,
    stop_worker: impl FnOnce(W),
) -> Result<(W, R), E> {
    match wait_ready() {
        Ok(ready) => Ok((worker, ready)),
        Err(error) => {
            stop_worker(worker);
            Err(error)
        }
    }
}

pub(super) fn start_control(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    generation: RuntimeGeneration,
    workspace_worker: Option<&super::workspace::WorkspaceWorkerRoute>,
) -> Result<StartedControl, ControlRuntimeStartError> {
    let runtime_route = supervisor.runtime_route()?;
    start_control_with_admission(
        app,
        supervisor,
        paths,
        generation,
        workspace_worker,
        &runtime_route,
        ControlAdmissionMode::Active,
    )
}

pub(super) fn start_control_with_admission(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    generation: RuntimeGeneration,
    workspace_worker: Option<&super::workspace::WorkspaceWorkerRoute>,
    runtime_route: &RuntimeRouteProjection,
    admission: ControlAdmissionMode,
) -> Result<StartedControl, ControlRuntimeStartError> {
    let session = supervisor
        .session
        .as_ref()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let workspace_environment = workspace_worker.map(|worker| WorkspaceWorkerEnvironment {
        origin: &worker.origin,
        token: worker.token.as_str(),
        deadline_ms: worker.deadline_ms,
    });
    let (events, child) = spawn_node(
        app,
        &paths.control_api_bundle,
        &paths.root,
        control_environment(
            paths,
            session,
            workspace_environment.as_ref(),
            runtime_route,
            admission,
        ),
        if generation.control.is_multiple_of(2) {
            "crewon-control-api-events-even"
        } else {
            "crewon-control-api-events-odd"
        },
    )?;
    let expected = match admission {
        ControlAdmissionMode::Active => "CrewON Control API listening on 127.0.0.1:3210",
        ControlAdmissionMode::Paused => "CrewON Control API candidate ready on 127.0.0.1:3210",
    };
    if wait_for_ready(&events, expected.as_bytes(), READY_TIMEOUT).is_err() {
        supervisor.quarantine_candidate_processes(vec![child]);
        return Err(ControlRuntimeStartError::ControlApiNotReady);
    }
    Ok(StartedControl { child, events })
}

fn install_runtime(
    supervisor: &ControlRuntimeSupervisor,
    control: CommandChild,
    worker: CommandChild,
    generation: RuntimeGeneration,
) -> Result<(), (CommandChild, CommandChild)> {
    let Ok(mut lifecycle) = supervisor.lifecycle.lock() else {
        return Err((control, worker));
    };
    if !lifecycle.available
        || lifecycle.control_generation != generation.control
        || lifecycle.worker_generation != generation.worker
        || lifecycle.control_api.is_some()
        || lifecycle.worker.is_some()
    {
        return Err((control, worker));
    }
    lifecycle.control_api = Some(control);
    lifecycle.worker = Some(worker);
    Ok(())
}

pub(super) fn recover_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    previous: Option<&provider_credentials::ActiveProviderRuntime>,
    runtime_route: &RuntimeRouteProjection,
    private_credentials: Option<&PrivateCredentialBindings>,
    generation: RuntimeGeneration,
) -> Result<(), ControlRuntimeStartError> {
    if activate_runtime_release(
        app,
        paths,
        previous.map(|runtime| &runtime.binding),
        runtime_route,
    )
    .is_err()
        || start_and_supervise_runtime(
            app,
            supervisor,
            paths,
            previous,
            private_credentials,
            generation,
        )
        .is_err()
    {
        supervisor.shutdown();
        return Err(ControlRuntimeStartError::RuntimeRollbackFailed);
    }
    Ok(())
}
