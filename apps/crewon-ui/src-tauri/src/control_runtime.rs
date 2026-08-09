//! Owns the packaged TypeScript Control API and runtime-worker processes.
//!
//! Session credentials exist only in this host state and the Control API child
//! environment. The renderer receives a short-lived copy through one typed Tauri
//! command; no build-time variable, URL, DOM node, log, or persistent web storage
//! is involved.

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::AppHandle;
use tauri::Manager;
use tauri::RunEvent;
use tauri::State;
use tauri_plugin_shell::process::CommandChild;
use zeroize::Zeroize;
use zeroize::Zeroizing;

#[path = "control_runtime_environment.rs"]
mod environment;
#[path = "control_runtime_process.rs"]
mod process;
#[path = "control_runtime_reload.rs"]
pub(crate) mod reload;

use self::environment::control_environment;
use self::environment::release_environment;
use self::environment::worker_environment;
use self::process::monitor_process;
use self::process::port_in_use;
use self::process::spawn_node;
use self::process::wait_for_ready;
use self::process::wait_for_successful_exit;
use self::process::ProcessEvents;
use self::process::ProcessRole;
use crate::provider_credentials;

const CONTROL_API_PORT: u16 = 3210;
const CONTROL_API_BASE_URL: &str = "http://127.0.0.1:3210/";
const DESKTOP_ORIGIN: &str = "http://tauri.localhost";
const ARTIFACT_KEY_ID: &str = "desktop-artifact-key-v1";
const SKIP_SIDECAR_ENV: &str = "CREWON_DESKTOP_SKIP_SIDECAR";
const READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy)]
pub enum ControlRuntimeStartError {
    AppDataUnavailable,
    ArtifactKeyInvalid,
    ControlApiNotReady,
    ProcessEventUnavailable,
    ProcessSpawnFailed,
    RandomnessUnavailable,
    ReleaseFailed,
    ProviderCredentialUnavailable,
    ActiveRun,
    RuntimeDatabaseUnavailable,
    RuntimeUnavailable,
    RuntimeRollbackFailed,
    ResourceUnavailable,
    RuntimeStateAlreadyInstalled,
    WorkerNotReady,
}

impl ControlRuntimeStartError {
    pub fn code(self) -> &'static str {
        match self {
            Self::AppDataUnavailable => "control_runtime_app_data_unavailable",
            Self::ArtifactKeyInvalid => "control_runtime_artifact_key_invalid",
            Self::ControlApiNotReady => "control_runtime_control_api_not_ready",
            Self::ProcessEventUnavailable => "control_runtime_process_event_unavailable",
            Self::ProcessSpawnFailed => "control_runtime_process_spawn_failed",
            Self::RandomnessUnavailable => "control_runtime_randomness_unavailable",
            Self::ReleaseFailed => "control_runtime_release_failed",
            Self::ProviderCredentialUnavailable => {
                "control_runtime_provider_credential_unavailable"
            }
            Self::ActiveRun => "control_runtime_active_run",
            Self::RuntimeDatabaseUnavailable => "control_runtime_database_unavailable",
            Self::RuntimeUnavailable => "control_runtime_unavailable",
            Self::RuntimeRollbackFailed => "control_runtime_rollback_failed",
            Self::ResourceUnavailable => "control_runtime_resource_unavailable",
            Self::RuntimeStateAlreadyInstalled => "control_runtime_state_already_installed",
            Self::WorkerNotReady => "control_runtime_worker_not_ready",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRuntimeBootstrap {
    base_url: String,
    csrf_token: String,
    origin: String,
    session_token: String,
}

impl Drop for ControlRuntimeBootstrap {
    fn drop(&mut self) {
        self.csrf_token.zeroize();
        self.session_token.zeroize();
    }
}

struct SessionMaterial {
    csrf_token: Zeroizing<String>,
    session_token: Zeroizing<String>,
}

impl SessionMaterial {
    fn generate() -> Result<Self, ControlRuntimeStartError> {
        let csrf_token = random_secret()?;
        let session_token = random_secret()?;
        if csrf_token == session_token {
            return Err(ControlRuntimeStartError::RandomnessUnavailable);
        }
        Ok(Self {
            csrf_token,
            session_token,
        })
    }

    fn public_bootstrap(&self) -> ControlRuntimeBootstrap {
        ControlRuntimeBootstrap {
            base_url: CONTROL_API_BASE_URL.to_string(),
            csrf_token: self.csrf_token.to_string(),
            origin: DESKTOP_ORIGIN.to_string(),
            session_token: self.session_token.to_string(),
        }
    }
}

struct RuntimeLifecycle {
    available: bool,
    control_generation: u64,
    control_api: Option<CommandChild>,
    worker: Option<CommandChild>,
    worker_generation: u64,
}

/// Managed Tauri state that owns both child lifetimes and ephemeral credentials.
pub struct ControlRuntimeSupervisor {
    lifecycle: Mutex<RuntimeLifecycle>,
    reload: Mutex<()>,
    session: Option<SessionMaterial>,
}

impl ControlRuntimeSupervisor {
    fn unavailable() -> Self {
        Self {
            lifecycle: Mutex::new(RuntimeLifecycle {
                available: false,
                control_generation: 0,
                control_api: None,
                worker: None,
                worker_generation: 0,
            }),
            reload: Mutex::new(()),
            session: None,
        }
    }

    fn started(session: SessionMaterial, control_api: CommandChild, worker: CommandChild) -> Self {
        Self {
            lifecycle: Mutex::new(RuntimeLifecycle {
                available: true,
                control_generation: 1,
                control_api: Some(control_api),
                worker: Some(worker),
                worker_generation: 1,
            }),
            reload: Mutex::new(()),
            session: Some(session),
        }
    }

    fn bootstrap(&self) -> Result<ControlRuntimeBootstrap, &'static str> {
        let Ok(lifecycle) = self.lifecycle.lock() else {
            return Err("control_runtime_unavailable");
        };
        if !lifecycle.available || lifecycle.control_api.is_none() || lifecycle.worker.is_none() {
            return Err("control_runtime_unavailable");
        }
        self.session
            .as_ref()
            .map(SessionMaterial::public_bootstrap)
            .ok_or("control_runtime_unavailable")
    }

    fn shutdown(&self) {
        let Ok(mut lifecycle) = self.lifecycle.lock() else {
            return;
        };
        lifecycle.available = false;
        let children = [lifecycle.control_api.take(), lifecycle.worker.take()];
        drop(lifecycle);
        for child in children.into_iter().flatten() {
            let _ = child.kill();
        }
    }

    fn process_terminated(&self, role: ProcessRole) {
        let should_shutdown = match self.lifecycle.lock() {
            Ok(lifecycle) => match role {
                ProcessRole::ControlApi(generation) => {
                    lifecycle.control_generation == generation && lifecycle.control_api.is_some()
                }
                ProcessRole::Worker(generation) => {
                    lifecycle.worker_generation == generation && lifecycle.worker.is_some()
                }
            },
            Err(_) => true,
        };
        if should_shutdown {
            self.shutdown();
        }
    }
}

impl Drop for ControlRuntimeSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct RuntimePaths {
    artifact_database: PathBuf,
    artifact_key: PathBuf,
    artifact_root: PathBuf,
    control_api_bundle: PathBuf,
    control_database: PathBuf,
    root: PathBuf,
    runtime_release_bundle: PathBuf,
    worker_bundle: PathBuf,
}

struct StartedRuntime {
    control_events: ProcessEvents,
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
    let session = SessionMaterial::generate()?;
    let provider_binding = provider_credentials::active_provider_binding(app)
        .map_err(|_| ControlRuntimeStartError::ProviderCredentialUnavailable)?;
    activate_runtime_release(app, &paths, provider_binding.as_ref())?;
    let (control_events, control_api) = spawn_node(
        app,
        &paths.control_api_bundle,
        &paths.root,
        control_environment(&paths, &session),
        "crewon-control-api-events",
    )?;
    if wait_for_ready(
        &control_events,
        b"CrewON Control API listening on 127.0.0.1:3210",
        READY_TIMEOUT,
    )
    .is_err()
    {
        let _ = control_api.kill();
        return Err(ControlRuntimeStartError::ControlApiNotReady);
    }

    let provider_runtime = provider_credentials::active_provider_runtime(app)
        .map_err(|_| ControlRuntimeStartError::ProviderCredentialUnavailable)?;
    let worker_environment = worker_environment(&paths, provider_runtime.as_ref());
    drop(provider_runtime);
    let worker = spawn_node(
        app,
        &paths.worker_bundle,
        &paths.root,
        worker_environment,
        "crewon-runtime-worker-events",
    );
    let (worker_events, worker) = match worker {
        Ok(worker) => worker,
        Err(error) => {
            let _ = control_api.kill();
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
        let _ = control_api.kill();
        let _ = worker.kill();
        return Err(ControlRuntimeStartError::WorkerNotReady);
    }

    Ok(StartedRuntime {
        control_events,
        supervisor: ControlRuntimeSupervisor::started(session, control_api, worker),
        worker_events,
    })
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
    let runtime_release_bundle = app
        .path()
        .resolve(
            "binaries/runtime/runtime-release.mjs",
            BaseDirectory::Resource,
        )
        .map_err(|_| ControlRuntimeStartError::ResourceUnavailable)?;
    require_regular_file(&control_api_bundle)?;
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
        root,
        runtime_release_bundle,
        worker_bundle,
    })
}

fn activate_runtime_release(
    app: &AppHandle,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderBinding>,
) -> Result<(), ControlRuntimeStartError> {
    let (events, child) = spawn_node(
        app,
        &paths.runtime_release_bundle,
        &paths.root,
        release_environment(paths, provider),
        "crewon-runtime-release-events",
    )?;
    if wait_for_successful_exit(&events, READY_TIMEOUT).is_err() {
        let _ = child.kill();
        return Err(ControlRuntimeStartError::ReleaseFailed);
    }
    Ok(())
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

pub fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    if !matches!(event, RunEvent::Exit) {
        return;
    }
    shutdown_managed_supervisor(app);
}

#[cfg(test)]
#[path = "control_runtime_tests.rs"]
mod tests;
