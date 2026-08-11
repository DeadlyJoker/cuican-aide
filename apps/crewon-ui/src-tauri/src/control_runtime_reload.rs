use rusqlite::Connection;
use rusqlite::OpenFlags;
use rusqlite::OptionalExtension;
use tauri::AppHandle;
use tauri::Manager;

use super::activate_runtime_release;
use super::environment::control_environment;
use super::environment::worker_bootstrap_input;
use super::environment::worker_environment;
use super::environment::ControlAdmissionMode;
use super::environment::WorkspaceWorkerEnvironment;
use super::prepare_paths;
use super::process::prepare_process_monitor;
use super::process::spawn_node;
use super::process::spawn_node_with_input;
use super::process::terminate_managed_children;
use super::process::wait_for_ready;
use super::process::ManagedChild as CommandChild;
use super::process::PreparedProcessMonitor;
use super::process::ProcessEvents;
use super::process::ProcessRole;
use super::provider_credentials;
use super::provider_ready_signal;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;
use super::RuntimePaths;
use super::READY_TIMEOUT;
use crate::workspace_native::RuntimeRouteProjection;

const ACTIVE_RUN_SQL: &str = "SELECT 1 FROM run_snapshots
    WHERE json_extract(state_json, '$.status') IS NULL
       OR json_extract(state_json, '$.status')
          NOT IN ('completed', 'failed', 'canceled')
    LIMIT 1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RuntimeGeneration {
    pub(super) control: u64,
    pub(super) device: u64,
    pub(super) gateway: u64,
    pub(super) worker: u64,
}

pub(super) struct RuntimeChildren {
    pub(super) control: CommandChild,
    pub(super) control_events: ProcessEvents,
    pub(super) worker: CommandChild,
    pub(super) worker_events: ProcessEvents,
}

pub(super) struct StartedWorker {
    pub(super) child: CommandChild,
    pub(super) events: ProcessEvents,
    pub(super) workspace_worker: Option<super::workspace::WorkspaceWorkerRoute>,
}

pub(super) struct StartedControl {
    pub(super) child: CommandChild,
    pub(super) events: ProcessEvents,
}

struct DetachedRuntime {
    control: CommandChild,
    worker: CommandChild,
    next_generation: RuntimeGeneration,
    expected_terminations: Vec<ProcessRole>,
}

pub(super) struct PreparedRuntimeSupervision {
    control: CommandChild,
    control_monitor: PreparedProcessMonitor,
    worker: CommandChild,
    worker_monitor: PreparedProcessMonitor,
}

pub(super) enum StopRuntimeError {
    BeforeStop(ControlRuntimeStartError),
    AfterStop(ControlRuntimeStartError, RuntimeGeneration),
}

/// Re-applies the currently active Provider without exposing its credential to
/// the renderer. Credential mutation commands call the same supervised path.
#[tauri::command]
pub fn control_runtime_reload_provider(app: AppHandle) -> Result<(), &'static str> {
    let runtime = provider_credentials::active_provider_runtime(&app)
        .map_err(provider_credentials::ProviderCredentialError::code)?;
    replace_provider_runtime(&app, runtime.as_ref(), runtime.as_ref())
        .map_err(ControlRuntimeStartError::code)
}

pub(crate) fn replace_provider_runtime(
    app: &AppHandle,
    previous: Option<&provider_credentials::ActiveProviderRuntime>,
    candidate: Option<&provider_credentials::ActiveProviderRuntime>,
) -> Result<(), ControlRuntimeStartError> {
    let supervisor = app
        .try_state::<ControlRuntimeSupervisor>()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let _reload = supervisor
        .reload
        .lock()
        .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
    let paths = prepare_paths(app)?;
    let runtime_route = supervisor.runtime_route()?;

    let generation = match stop_idle_runtime(&supervisor, &paths) {
        Ok(generation) => generation,
        Err(StopRuntimeError::BeforeStop(error)) => return Err(error),
        Err(StopRuntimeError::AfterStop(ControlRuntimeStartError::RuntimeRollbackFailed, _)) => {
            supervisor.shutdown();
            return Err(ControlRuntimeStartError::RuntimeRollbackFailed);
        }
        Err(StopRuntimeError::AfterStop(error, generation)) => {
            recover_runtime(
                app,
                &supervisor,
                &paths,
                previous,
                &runtime_route,
                generation,
            )?;
            return Err(error);
        }
    };

    if let Err(error) = activate_runtime_release(
        app,
        &paths,
        candidate.map(|runtime| &runtime.binding),
        &runtime_route,
    ) {
        recover_runtime(
            app,
            &supervisor,
            &paths,
            previous,
            &runtime_route,
            generation,
        )?;
        return Err(error);
    }

    match start_and_supervise_runtime(app, &supervisor, &paths, candidate, generation) {
        Ok(()) => Ok(()),
        Err((ControlRuntimeStartError::RuntimeRollbackFailed, _)) => {
            supervisor.shutdown();
            Err(ControlRuntimeStartError::RuntimeRollbackFailed)
        }
        Err((error, recovery_generation)) => {
            recover_runtime(
                app,
                &supervisor,
                &paths,
                previous,
                &runtime_route,
                recovery_generation,
            )?;
            Err(error)
        }
    }
}

pub(super) fn stop_idle_runtime(
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
) -> Result<RuntimeGeneration, StopRuntimeError> {
    let database = Connection::open_with_flags(
        &paths.control_database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| {
        StopRuntimeError::BeforeStop(ControlRuntimeStartError::RuntimeDatabaseUnavailable)
    })?;
    database.execute_batch("BEGIN IMMEDIATE").map_err(|_| {
        StopRuntimeError::BeforeStop(ControlRuntimeStartError::RuntimeDatabaseUnavailable)
    })?;
    if has_active_run(&database).map_err(StopRuntimeError::BeforeStop)? {
        return Err(StopRuntimeError::BeforeStop(
            ControlRuntimeStartError::ActiveRun,
        ));
    }

    // BEGIN IMMEDIATE blocks every admission write before Control is detached.
    // Only guardian proof that both process trees are clean allows this fence
    // to commit and release admission for the replacement runtime.
    let detached = detach_runtime(supervisor).map_err(StopRuntimeError::BeforeStop)?;
    let DetachedRuntime {
        control,
        worker,
        next_generation,
        expected_terminations,
    } = detached;
    let processes = vec![control, worker];
    if !terminate_managed_children(&processes, super::TERMINATION_TIMEOUT) {
        supervisor.shutdown();
        supervisor.retain_failed_admission_fence_with_processes(
            database,
            expected_terminations,
            processes,
        );
        return Err(StopRuntimeError::AfterStop(
            ControlRuntimeStartError::RuntimeRollbackFailed,
            next_generation,
        ));
    }
    supervisor.terminations.finish(&expected_terminations);
    if database.execute_batch("COMMIT").is_err() {
        return Err(StopRuntimeError::AfterStop(
            ControlRuntimeStartError::RuntimeDatabaseUnavailable,
            next_generation,
        ));
    }
    Ok(next_generation)
}

fn has_active_run(database: &Connection) -> Result<bool, ControlRuntimeStartError> {
    let has_runs_table = database
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_snapshots'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| ControlRuntimeStartError::RuntimeDatabaseUnavailable)?
        .is_some();
    if !has_runs_table {
        return Ok(false);
    }
    Ok(database
        .query_row(ACTIVE_RUN_SQL, [], |_| Ok(()))
        .optional()
        .map_err(|_| ControlRuntimeStartError::RuntimeDatabaseUnavailable)?
        .is_some())
}

fn detach_runtime(
    supervisor: &ControlRuntimeSupervisor,
) -> Result<DetachedRuntime, ControlRuntimeStartError> {
    let mut lifecycle = supervisor
        .lifecycle
        .lock()
        .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
    if !lifecycle.available || lifecycle.control_api.is_none() || lifecycle.worker.is_none() {
        return Err(ControlRuntimeStartError::RuntimeUnavailable);
    }
    let expected_terminations = vec![
        ProcessRole::ControlApi(lifecycle.control_generation),
        ProcessRole::Worker(lifecycle.worker_generation),
    ];
    let next_generation = next_provider_generation(&lifecycle)?;
    supervisor
        .terminations
        .begin(expected_terminations.clone())?;
    let control = lifecycle
        .control_api
        .take()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let worker = lifecycle
        .worker
        .take()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    lifecycle.control_generation = next_generation.control;
    lifecycle.worker_generation = next_generation.worker;
    Ok(DetachedRuntime {
        control,
        worker,
        next_generation,
        expected_terminations,
    })
}

fn next_provider_generation(
    lifecycle: &super::RuntimeLifecycle,
) -> Result<RuntimeGeneration, ControlRuntimeStartError> {
    Ok(RuntimeGeneration {
        control: lifecycle
            .control_generation
            .checked_add(1)
            .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?,
        device: lifecycle.device_generation,
        gateway: lifecycle.gateway_generation,
        worker: lifecycle
            .worker_generation
            .checked_add(1)
            .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?,
    })
}

#[cfg(test)]
pub(super) fn next_provider_generation_for_test(
    lifecycle: &super::RuntimeLifecycle,
) -> Result<RuntimeGeneration, ControlRuntimeStartError> {
    next_provider_generation(lifecycle)
}

include!("control_runtime_reload_lifecycle.rs");

include!("control_runtime_reload_start.rs");

#[cfg(test)]
pub(super) fn active_run_sql() -> &'static str {
    ACTIVE_RUN_SQL
}
