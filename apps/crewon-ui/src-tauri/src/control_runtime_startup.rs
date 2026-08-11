struct RuntimePaths {
    artifact_database: PathBuf,
    artifact_key: PathBuf,
    artifact_root: PathBuf,
    control_api_bundle: PathBuf,
    control_database: PathBuf,
    device_gateway_bundle: PathBuf,
    provider_coordinator_bundle: PathBuf,
    root: PathBuf,
    runtime_release_bundle: PathBuf,
    worker_bundle: PathBuf,
    workspace_authority: PathBuf,
    workspace_launch_root: PathBuf,
    workspace_runtime_root: PathBuf,
}

struct StartedRuntime {
    control_events: ProcessEvents,
    device_events: Option<ProcessEvents>,
    gateway_events: Option<ProcessEvents>,
    supervisor: ControlRuntimeSupervisor,
    worker_events: ProcessEvents,
}

#[tauri::command]
pub fn control_runtime_bootstrap(
    supervisor: State<'_, ControlRuntimeSupervisor>,
) -> Result<ControlRuntimeBootstrap, &'static str> {
    supervisor.bootstrap()
}

/// Installs managed state and starts both Node children for a packaged build.
pub fn install(app: &AppHandle) -> Result<(), ControlRuntimeStartError> {
    if std::env::var(SKIP_SIDECAR_ENV).is_ok_and(|value| !value.is_empty()) {
        return manage_supervisor(app, ControlRuntimeSupervisor::unavailable());
    }

    let started = match start(app) {
        Ok(started) => started,
        Err(error) => {
            let _ = manage_supervisor(app, ControlRuntimeSupervisor::unavailable());
            return Err(error);
        }
    };
    manage_supervisor(app, started.supervisor)?;
    if let Some(gateway_events) = started.gateway_events {
        if let Err(error) = monitor_process(
            app.clone(),
            gateway_events,
            "device-gateway",
            ProcessRole::Gateway(1),
        ) {
            shutdown_managed_supervisor(app);
            return Err(error);
        }
    }
    if let Some(device_events) = started.device_events {
        if let Err(error) = monitor_process(
            app.clone(),
            device_events,
            "device-runtime",
            ProcessRole::Device(1),
        ) {
            shutdown_managed_supervisor(app);
            return Err(error);
        }
    }
    if let Err(error) = monitor_process(
        app.clone(),
        started.control_events,
        "control-api",
        ProcessRole::ControlApi(1),
    ) {
        shutdown_managed_supervisor(app);
        return Err(error);
    }
    if let Err(error) = monitor_process(
        app.clone(),
        started.worker_events,
        "runtime-worker",
        ProcessRole::Worker(1),
    ) {
        shutdown_managed_supervisor(app);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn shutdown_managed_supervisor(app: &AppHandle) {
    if let Some(supervisor) = app.try_state::<ControlRuntimeSupervisor>() {
        supervisor.shutdown();
    }
}

fn manage_supervisor(
    app: &AppHandle,
    supervisor: ControlRuntimeSupervisor,
) -> Result<(), ControlRuntimeStartError> {
    if app.manage(supervisor) {
        Ok(())
    } else {
        Err(ControlRuntimeStartError::RuntimeStateAlreadyInstalled)
    }
}

fn start(app: &AppHandle) -> Result<StartedRuntime, ControlRuntimeStartError> {
    if port_in_use(CONTROL_API_PORT) {
        return Err(ControlRuntimeStartError::ControlApiNotReady);
    }

    let paths = prepare_paths(app)?;
    let workspace_authority_lease =
        crate::workspace_native::WorkspaceAuthorityLease::acquire(&paths.workspace_authority)
            .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
    retain_startup_lease(workspace_authority_lease)?;
    workspace::recover_pending_workspace_authority(&paths)?;
    provider_credentials::recover_pending_mutation(app, |recovery| {
        provider_switch::recover_provider_authority(app, &paths, recovery)
    })
    .map_err(|_| ControlRuntimeStartError::ProviderCredentialUnavailable)?;
    let session = SessionMaterial::generate()?;
    let workspace_authority = workspace::selected_workspace_authority(&paths)?;
    let runtime_route = runtime_route_for_authority(workspace_authority.as_ref())?;
    let provider_binding = provider_credentials::active_provider_binding(app)
        .map_err(|_| ControlRuntimeStartError::ProviderCredentialUnavailable)?;
    activate_runtime_release(app, &paths, provider_binding.as_ref(), &runtime_route)?;
    let provider_runtime = provider_credentials::active_provider_runtime(app)
        .map_err(|_| ControlRuntimeStartError::ProviderCredentialUnavailable)?;
    let mut workspace_foundation = match workspace_authority {
        Some(authority) => Some(workspace::start_workspace_foundation(
            app, &paths, authority, None,
        )?),
        None => None,
    };
    let worker_environment = worker_environment(&paths, provider_runtime.as_ref(), &runtime_route);
    let workspace_bootstrap = match workspace_foundation
        .as_ref()
        .map(|foundation| {
            foundation
                .context
                .worker_bootstrap(provider_runtime.as_ref(), &session)
        })
        .transpose()
    {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            workspace::stop_workspace_foundation(workspace_foundation.take());
            return Err(error);
        }
    };
    let legacy_bootstrap = workspace_bootstrap
        .is_none()
        .then(|| worker_bootstrap_input(provider_runtime.as_ref(), &session))
        .transpose()
        .map_err(|()| ControlRuntimeStartError::ProviderCredentialUnavailable)?;
    let worker_bootstrap = workspace_bootstrap
        .as_ref()
        .map(|bootstrap| bootstrap.input.as_ref())
        .or(legacy_bootstrap.as_deref())
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let worker = spawn_node_with_input(
        app,
        None,
        &paths.worker_bundle,
        &paths.root,
        worker_environment,
        "crewon-runtime-worker-events",
        worker_bootstrap,
    );
    let (worker_events, worker) = match worker {
        Ok(worker) => worker,
        Err(error) => {
            workspace::stop_workspace_foundation(workspace_foundation.take());
            return Err(error);
        }
    };
    if wait_for_ready(
        &worker_events,
        b"CrewON Runtime Worker started",
        READY_TIMEOUT,
    )
    .is_err()
    {
        terminate_startup_children(vec![worker]);
        workspace::stop_workspace_foundation(workspace_foundation.take());
        return Err(ControlRuntimeStartError::WorkerNotReady);
    }
    let provider_ready = provider_ready_signal(provider_runtime.as_ref());
    if wait_for_ready(&worker_events, provider_ready.as_bytes(), READY_TIMEOUT).is_err() {
        terminate_startup_children(vec![worker]);
        workspace::stop_workspace_foundation(workspace_foundation.take());
        return Err(ControlRuntimeStartError::WorkerNotReady);
    }
    let workspace_worker = match workspace_bootstrap {
        Some(bootstrap) => match bootstrap.wait_ready(&worker_events) {
            Ok(route) => Some(route),
            Err(error) => {
                terminate_startup_children(vec![worker]);
                workspace::stop_workspace_foundation(workspace_foundation.take());
                return Err(error);
            }
        },
        None => None,
    };
    let workspace_environment =
        workspace_worker
            .as_ref()
            .map(|worker| environment::WorkspaceWorkerEnvironment {
                origin: &worker.origin,
                token: worker.token.as_str(),
                deadline_ms: worker.deadline_ms,
            });
    let (control_events, control_api) = match spawn_node(
        app,
        &paths.control_api_bundle,
        &paths.root,
        control_environment(
            &paths,
            &session,
            workspace_environment.as_ref(),
            &runtime_route,
            ControlAdmissionMode::Active,
        ),
        "crewon-control-api-events",
    ) {
        Ok(started) => started,
        Err(error) => {
            terminate_startup_children(vec![worker]);
            workspace::stop_workspace_foundation(workspace_foundation.take());
            return Err(error);
        }
    };
    if wait_for_ready(
        &control_events,
        b"CrewON Control API listening on 127.0.0.1:3210",
        READY_TIMEOUT,
    )
    .is_err()
    {
        terminate_startup_children(vec![control_api, worker]);
        workspace::stop_workspace_foundation(workspace_foundation.take());
        return Err(ControlRuntimeStartError::ControlApiNotReady);
    }

    let (workspace, gateway_events, device_events) = match workspace_foundation {
        Some(foundation) => (
            Some((foundation.context, foundation.gateway, foundation.device)),
            Some(foundation.gateway_events),
            Some(foundation.device_events),
        ),
        None => (None, None, None),
    };

    Ok(StartedRuntime {
        control_events,
        device_events,
        gateway_events,
        supervisor: ControlRuntimeSupervisor::started(
            session,
            control_api,
            worker,
            workspace,
            take_startup_lease(),
        ),
        worker_events,
    })
}

fn retain_startup_lease(
    lease: crate::workspace_native::WorkspaceAuthorityLease,
) -> Result<(), ControlRuntimeStartError> {
    let mut startup = STARTUP_QUARANTINE
        .lock()
        .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
    if startup.lease.is_some() {
        return Err(ControlRuntimeStartError::RuntimeUnavailable);
    }
    startup.lease = Some(lease);
    Ok(())
}

fn take_startup_lease() -> Option<crate::workspace_native::WorkspaceAuthorityLease> {
    STARTUP_QUARANTINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .lease
        .take()
}

fn quarantine_startup_processes(processes: Vec<CommandChild>) {
    match STARTUP_QUARANTINE.lock() {
        Ok(mut startup) => startup.processes.extend(processes),
        Err(_) => {
            for process in processes {
                std::mem::forget(process);
            }
        }
    }
}

fn provider_ready_signal(provider: Option<&provider_credentials::ActiveProviderRuntime>) -> String {
    format!(
        "CrewON Provider Runtime ready:{}",
        provider
            .map(|runtime| runtime.binding.runtime_binding_id.as_str())
            .unwrap_or("none")
    )
}

fn prepare_paths(app: &AppHandle) -> Result<RuntimePaths, ControlRuntimeStartError> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| ControlRuntimeStartError::AppDataUnavailable)?
        .join("control-runtime-v0");
    let artifact_root = root.join("artifacts");
    fs::create_dir_all(&artifact_root).map_err(|_| ControlRuntimeStartError::AppDataUnavailable)?;
    restrict_directory(&root)?;

    let control_api_bundle = app
        .path()
        .resolve("binaries/runtime/control-api.mjs", BaseDirectory::Resource)
        .map_err(|_| ControlRuntimeStartError::ResourceUnavailable)?;
    let worker_bundle = app
        .path()
        .resolve(
            "binaries/runtime/runtime-worker.mjs",
            BaseDirectory::Resource,
        )
        .map_err(|_| ControlRuntimeStartError::ResourceUnavailable)?;
    let device_gateway_bundle = app
        .path()
        .resolve(
            "binaries/runtime/device-gateway.mjs",
            BaseDirectory::Resource,
        )
        .map_err(|_| ControlRuntimeStartError::ResourceUnavailable)?;
    let runtime_release_bundle = app
        .path()
        .resolve(
            "binaries/runtime/runtime-release.mjs",
            BaseDirectory::Resource,
        )
        .map_err(|_| ControlRuntimeStartError::ResourceUnavailable)?;
    let provider_coordinator_bundle = app
        .path()
        .resolve(
            "binaries/runtime/provider-settings-coordinator.mjs",
            BaseDirectory::Resource,
        )
        .map_err(|_| ControlRuntimeStartError::ResourceUnavailable)?;
    require_regular_file(&control_api_bundle)?;
    require_regular_file(&provider_coordinator_bundle)?;
    require_regular_file(&runtime_release_bundle)?;
    require_regular_file(&worker_bundle)?;

    let artifact_key = root.join("artifact-encryption.key");
    write_or_validate_artifact_key(&artifact_key)?;
    Ok(RuntimePaths {
        artifact_database: root.join("artifact-metadata.sqlite"),
        artifact_key,
        artifact_root,
        control_api_bundle,
        control_database: root.join("control.sqlite"),
        device_gateway_bundle,
        provider_coordinator_bundle,
        root: root.clone(),
        runtime_release_bundle,
        worker_bundle,
        workspace_authority: root.join("workspace-authority-v0"),
        workspace_launch_root: root.join("workspace-launch"),
        workspace_runtime_root: root.join("workspace-runtimes"),
    })
}

fn activate_runtime_release(
    app: &AppHandle,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderBinding>,
    route: &RuntimeRouteProjection,
) -> Result<(), ControlRuntimeStartError> {
    let (events, child) = spawn_node(
        app,
        &paths.runtime_release_bundle,
        &paths.root,
        release_environment(paths, provider, route),
        "crewon-runtime-release-events",
    )?;
    if wait_for_successful_exit(&events, READY_TIMEOUT).is_err() {
        terminate_startup_children(vec![child]);
        return Err(ControlRuntimeStartError::ReleaseFailed);
    }
    Ok(())
}

fn activate_release_before_worker<W, E>(
    activate_release: impl FnOnce() -> Result<(), E>,
    start_worker: impl FnOnce() -> Result<W, E>,
) -> Result<W, E> {
    activate_release()?;
    start_worker()
}

fn runtime_route_for_authority(
    authority: Option<&DesktopWorkspaceAuthority>,
) -> Result<RuntimeRouteProjection, ControlRuntimeStartError> {
    authority.map_or_else(
        || Ok(RuntimeRouteProjection::standalone()),
        |authority| {
            RuntimeRouteProjection::from_authority(authority)
                .map_err(|_| ControlRuntimeStartError::WorkspaceRuntimeFailed)
        },
    )
}

fn require_regular_file(path: &Path) -> Result<(), ControlRuntimeStartError> {
    let metadata = fs::metadata(path).map_err(|_| ControlRuntimeStartError::ResourceUnavailable)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(ControlRuntimeStartError::ResourceUnavailable);
    }
    Ok(())
}

fn restrict_directory(path: &Path) -> Result<(), ControlRuntimeStartError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| ControlRuntimeStartError::AppDataUnavailable)?;
    }
    Ok(())
}

fn write_or_validate_artifact_key(path: &Path) -> Result<(), ControlRuntimeStartError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_artifact_key_metadata(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut bytes = Zeroizing::new([0_u8; 32]);
            getrandom::fill(bytes.as_mut())
                .map_err(|_| ControlRuntimeStartError::RandomnessUnavailable)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(path) {
                Ok(mut file) => {
                    file.write_all(bytes.as_ref())
                        .and_then(|()| file.sync_all())
                        .map_err(|_| ControlRuntimeStartError::ArtifactKeyInvalid)?;
                    Ok(())
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(path)
                        .map_err(|_| ControlRuntimeStartError::ArtifactKeyInvalid)?;
                    validate_artifact_key_metadata(metadata)
                }
                Err(_) => Err(ControlRuntimeStartError::ArtifactKeyInvalid),
            }
        }
        Err(_) => Err(ControlRuntimeStartError::ArtifactKeyInvalid),
    }
}

fn validate_artifact_key_metadata(metadata: fs::Metadata) -> Result<(), ControlRuntimeStartError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != 32 {
        return Err(ControlRuntimeStartError::ArtifactKeyInvalid);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ControlRuntimeStartError::ArtifactKeyInvalid);
        }
    }
    Ok(())
}

fn random_secret() -> Result<Zeroizing<String>, ControlRuntimeStartError> {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| ControlRuntimeStartError::RandomnessUnavailable)?;
    Ok(Zeroizing::new(hex::encode(bytes.as_ref())))
}
