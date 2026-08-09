use rusqlite::Connection;
use rusqlite::OpenFlags;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;

use super::activate_runtime_release;
use super::environment::control_environment;
use super::environment::worker_environment;
use super::monitor_process;
use super::prepare_paths;
use super::process::spawn_node;
use super::process::wait_for_ready;
use super::process::ProcessEvents;
use super::process::ProcessRole;
use super::provider_credentials;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;
use super::RuntimePaths;
use super::READY_TIMEOUT;

const ACTIVE_RUN_SQL: &str = "SELECT 1 FROM run_snapshots
    WHERE json_extract(state_json, '$.status') IS NULL
       OR json_extract(state_json, '$.status')
          NOT IN ('completed', 'failed', 'canceled')
    LIMIT 1";

#[derive(Clone, Copy)]
struct RuntimeGeneration {
    control: u64,
    worker: u64,
}

struct RuntimeChildren {
    control: CommandChild,
    control_events: ProcessEvents,
    worker: CommandChild,
    worker_events: ProcessEvents,
}

enum StopRuntimeError {
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

    let generation = match stop_idle_runtime(&supervisor, &paths) {
        Ok(generation) => generation,
        Err(StopRuntimeError::BeforeStop(error)) => return Err(error),
        Err(StopRuntimeError::AfterStop(ControlRuntimeStartError::RuntimeRollbackFailed, _)) => {
            supervisor.shutdown();
            return Err(ControlRuntimeStartError::RuntimeRollbackFailed);
        }
        Err(StopRuntimeError::AfterStop(error, generation)) => {
            recover_runtime(app, &supervisor, &paths, previous, generation)?;
            return Err(error);
        }
    };

    if let Err(error) =
        activate_runtime_release(app, &paths, candidate.map(|runtime| &runtime.binding))
    {
        recover_runtime(app, &supervisor, &paths, previous, generation)?;
        return Err(error);
    }

    match start_and_supervise_runtime(app, &supervisor, &paths, candidate, generation) {
        Ok(()) => Ok(()),
        Err((ControlRuntimeStartError::RuntimeRollbackFailed, _)) => {
            supervisor.shutdown();
            Err(ControlRuntimeStartError::RuntimeRollbackFailed)
        }
        Err((error, recovery_generation)) => {
            recover_runtime(app, &supervisor, &paths, previous, recovery_generation)?;
            Err(error)
        }
    }
}

fn stop_idle_runtime(
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
) -> Result<RuntimeGeneration, StopRuntimeError> {
    let mut database = Connection::open_with_flags(
        &paths.control_database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| {
        StopRuntimeError::BeforeStop(ControlRuntimeStartError::RuntimeDatabaseUnavailable)
    })?;
    let transaction = database
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| {
            StopRuntimeError::BeforeStop(ControlRuntimeStartError::RuntimeDatabaseUnavailable)
        })?;
    if has_active_run(&transaction).map_err(StopRuntimeError::BeforeStop)? {
        return Err(StopRuntimeError::BeforeStop(
            ControlRuntimeStartError::ActiveRun,
        ));
    }

    // BEGIN IMMEDIATE blocks every admission write before Control is detached.
    // Once both children are killed, commit releases the DB for release
    // activation while no process capable of accepting a new Run is alive.
    let (control, worker, generation) =
        detach_runtime(supervisor).map_err(StopRuntimeError::BeforeStop)?;
    let control_killed = control.kill().is_ok();
    let worker_killed = worker.kill().is_ok();
    if !control_killed || !worker_killed {
        supervisor.shutdown();
        return Err(StopRuntimeError::AfterStop(
            ControlRuntimeStartError::RuntimeRollbackFailed,
            generation,
        ));
    }
    if transaction.commit().is_err() {
        return Err(StopRuntimeError::AfterStop(
            ControlRuntimeStartError::RuntimeDatabaseUnavailable,
            generation,
        ));
    }
    Ok(generation)
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
) -> Result<(CommandChild, CommandChild, RuntimeGeneration), ControlRuntimeStartError> {
    let mut lifecycle = supervisor
        .lifecycle
        .lock()
        .map_err(|_| ControlRuntimeStartError::RuntimeUnavailable)?;
    if !lifecycle.available || lifecycle.control_api.is_none() || lifecycle.worker.is_none() {
        return Err(ControlRuntimeStartError::RuntimeUnavailable);
    }
    let generation = RuntimeGeneration {
        control: lifecycle
            .control_generation
            .checked_add(1)
            .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?,
        worker: lifecycle
            .worker_generation
            .checked_add(1)
            .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?,
    };
    let control = lifecycle
        .control_api
        .take()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let worker = lifecycle
        .worker
        .take()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    lifecycle.control_generation = generation.control;
    lifecycle.worker_generation = generation.worker;
    Ok((control, worker, generation))
}

fn start_and_supervise_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderRuntime>,
    generation: RuntimeGeneration,
) -> Result<(), (ControlRuntimeStartError, RuntimeGeneration)> {
    let children = start_runtime(app, supervisor, paths, provider, generation)
        .map_err(|error| (error, generation))?;
    let (control_events, worker_events) = install_runtime(supervisor, children, generation)
        .map_err(|children| {
            let _ = children.control.kill();
            let _ = children.worker.kill();
            (ControlRuntimeStartError::RuntimeUnavailable, generation)
        })?;

    if monitor_process(
        app.clone(),
        control_events,
        "control-api-reload",
        ProcessRole::ControlApi(generation.control),
    )
    .is_err()
    {
        return stop_candidate_runtime(supervisor);
    }
    if monitor_process(
        app.clone(),
        worker_events,
        "runtime-worker-reload",
        ProcessRole::Worker(generation.worker),
    )
    .is_err()
    {
        return stop_candidate_runtime(supervisor);
    }
    Ok(())
}

fn start_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    provider: Option<&provider_credentials::ActiveProviderRuntime>,
    generation: RuntimeGeneration,
) -> Result<RuntimeChildren, ControlRuntimeStartError> {
    let session = supervisor
        .session
        .as_ref()
        .ok_or(ControlRuntimeStartError::RuntimeUnavailable)?;
    let (worker_events, worker) = spawn_node(
        app,
        &paths.worker_bundle,
        &paths.root,
        worker_environment(paths, provider),
        if generation.worker.is_multiple_of(2) {
            "crewon-runtime-worker-events-even"
        } else {
            "crewon-runtime-worker-events-odd"
        },
    )?;
    if wait_for_ready(
        &worker_events,
        b"CrewON Runtime Worker started",
        READY_TIMEOUT,
    )
    .is_err()
    {
        let _ = worker.kill();
        return Err(ControlRuntimeStartError::WorkerNotReady);
    }

    let control = spawn_node(
        app,
        &paths.control_api_bundle,
        &paths.root,
        control_environment(paths, session),
        if generation.control.is_multiple_of(2) {
            "crewon-control-api-events-even"
        } else {
            "crewon-control-api-events-odd"
        },
    );
    let (control_events, control) = match control {
        Ok(started) => started,
        Err(error) => {
            let _ = worker.kill();
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
        let _ = control.kill();
        let _ = worker.kill();
        return Err(ControlRuntimeStartError::ControlApiNotReady);
    }
    Ok(RuntimeChildren {
        control,
        control_events,
        worker,
        worker_events,
    })
}

fn install_runtime(
    supervisor: &ControlRuntimeSupervisor,
    children: RuntimeChildren,
    generation: RuntimeGeneration,
) -> Result<(ProcessEvents, ProcessEvents), RuntimeChildren> {
    let Ok(mut lifecycle) = supervisor.lifecycle.lock() else {
        return Err(children);
    };
    if !lifecycle.available
        || lifecycle.control_generation != generation.control
        || lifecycle.worker_generation != generation.worker
        || lifecycle.control_api.is_some()
        || lifecycle.worker.is_some()
    {
        return Err(children);
    }
    let RuntimeChildren {
        control,
        control_events,
        worker,
        worker_events,
    } = children;
    lifecycle.control_api = Some(control);
    lifecycle.worker = Some(worker);
    Ok((control_events, worker_events))
}

fn stop_candidate_runtime(
    supervisor: &ControlRuntimeSupervisor,
) -> Result<(), (ControlRuntimeStartError, RuntimeGeneration)> {
    let (control, worker, generation) = detach_runtime(supervisor).map_err(|_| {
        supervisor.shutdown();
        (
            ControlRuntimeStartError::RuntimeRollbackFailed,
            RuntimeGeneration {
                control: 0,
                worker: 0,
            },
        )
    })?;
    let control_killed = control.kill().is_ok();
    let worker_killed = worker.kill().is_ok();
    if !control_killed || !worker_killed {
        supervisor.shutdown();
        return Err((ControlRuntimeStartError::RuntimeRollbackFailed, generation));
    }
    Err((
        ControlRuntimeStartError::ProcessEventUnavailable,
        generation,
    ))
}

fn recover_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    previous: Option<&provider_credentials::ActiveProviderRuntime>,
    generation: RuntimeGeneration,
) -> Result<(), ControlRuntimeStartError> {
    if activate_runtime_release(app, paths, previous.map(|runtime| &runtime.binding)).is_err()
        || start_and_supervise_runtime(app, supervisor, paths, previous, generation).is_err()
    {
        supervisor.shutdown();
        return Err(ControlRuntimeStartError::RuntimeRollbackFailed);
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn active_run_sql() -> &'static str {
    ACTIVE_RUN_SQL
}
