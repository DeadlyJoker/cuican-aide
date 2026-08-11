//! Coordinates the desktop Provider authority with the supervised runtime.
//!
//! The TypeScript authority establishes a durable admission fence before this
//! module detaches either child. A candidate Worker must then prove the exact
//! native runtime binding before the authority can be finalized.

use tauri::AppHandle;
use tauri::Manager;

use super::activate_release_before_worker;
use super::activate_runtime_release;
use super::prepare_paths;
use super::provider_coordinator;
use super::reload::install_staged_runtime_candidate;
use super::reload::prepare_runtime_supervision;
use super::reload::recover_runtime;
use super::reload::stage_runtime_candidate;
use super::reload::start_control;
use super::reload::start_worker;
use super::reload::stop_idle_runtime;
use super::reload::stop_prepared_runtime;
use super::reload::stop_staged_runtime_candidate;
use super::reload::RuntimeChildren;
use super::reload::RuntimeGeneration;
use super::reload::StopRuntimeError;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;
use super::RuntimePaths;
use crate::provider_credentials::ProviderCredentialRecovery;
use crate::provider_credentials::ProviderCredentialRecoveryDisposition;
use crate::provider_credentials::ProviderRuntimeMutation;
use crate::provider_credentials::ProviderRuntimeMutationFailure;

pub(crate) fn coordinate_provider_runtime(
    app: &AppHandle,
    mutation: &ProviderRuntimeMutation<'_>,
) -> Result<(), ProviderRuntimeMutationFailure> {
    let supervisor = app.try_state::<ControlRuntimeSupervisor>().ok_or(
        ProviderRuntimeMutationFailure::BeforeCommit(
            ControlRuntimeStartError::RuntimeUnavailable.code(),
        ),
    )?;
    let _reload = supervisor.reload.lock().map_err(|_| {
        ProviderRuntimeMutationFailure::BeforeCommit(
            ControlRuntimeStartError::RuntimeUnavailable.code(),
        )
    })?;
    let paths = prepare_paths(app)
        .map_err(|error| ProviderRuntimeMutationFailure::BeforeCommit(error.code()))?;
    let runtime_route = supervisor
        .runtime_route()
        .map_err(|error| ProviderRuntimeMutationFailure::BeforeCommit(error.code()))?;
    let authority = provider_coordinator::inspect(app, &paths)
        .map_err(|error| ProviderRuntimeMutationFailure::BeforeCommit(error.code()))?;
    let previous_provider_id = mutation
        .previous_runtime
        .map(|runtime| runtime.binding.provider_id.as_str());
    if authority.phase != "inspect"
        || authority.disposition.is_some()
        || authority.pending.is_some()
        || authority.catalog.as_ref().is_some_and(|catalog| {
            catalog.active_provider_id.as_deref() != previous_provider_id
                || catalog.runtime_binding_id.as_deref()
                    != mutation
                        .previous_runtime
                        .map(|runtime| runtime.binding.runtime_binding_id.as_str())
        })
    {
        return Err(ProviderRuntimeMutationFailure::BeforeCommit(
            ControlRuntimeStartError::ProviderCoordinatorFailed.code(),
        ));
    }
    let bindings = mutation
        .bindings
        .iter()
        .map(|binding| provider_coordinator::ProviderAuthorityBinding {
            provider_id: binding.provider_id.clone(),
            display_name: binding.provider_id.clone(),
            endpoint: binding.endpoint.clone(),
            credential_kind: binding.credential_kind,
            environment_variable: binding.environment_variable.clone(),
        })
        .collect::<Vec<_>>();
    let expected_revision = authority
        .catalog
        .as_ref()
        .map_or(0, |catalog| catalog.revision);
    let prepare_input = || provider_coordinator::PrepareProviderAuthority {
        operation_id: mutation.operation_id,
        runtime_binding_id: mutation.runtime_binding_id,
        expected_revision,
        active_provider_id: mutation.active_provider_id,
        bindings: &bindings,
        ttl_ms: 5 * 60 * 1_000,
    };
    let prepared = match provider_coordinator::prepare(app, &paths, prepare_input()) {
        Ok(prepared) => prepared,
        Err(_) => provider_coordinator::prepare(app, &paths, prepare_input()).map_err(|_| {
            supervisor.shutdown();
            ProviderRuntimeMutationFailure::AfterCommit
        })?,
    };
    if prepared.phase != "prepare"
        || !matches!(
            prepared.disposition.as_deref(),
            Some("prepared" | "replayed")
        )
        || prepared.catalog.is_some()
        || prepared.pending.as_ref().is_none_or(|pending| {
            pending.operation_id != mutation.operation_id
                || pending.base_revision != expected_revision
                || pending.runtime_binding_id.as_deref() != mutation.runtime_binding_id
        })
    {
        return Err(ProviderRuntimeMutationFailure::BeforeCommit(
            ControlRuntimeStartError::ProviderCoordinatorFailed.code(),
        ));
    }

    let generation = match stop_idle_runtime(&supervisor, &paths) {
        Ok(generation) => generation,
        Err(StopRuntimeError::BeforeStop(error)) => {
            return abort_before_commit(app, &paths, mutation, error, None, &supervisor);
        }
        Err(StopRuntimeError::AfterStop(ControlRuntimeStartError::RuntimeRollbackFailed, _)) => {
            supervisor.shutdown();
            return Err(ProviderRuntimeMutationFailure::AfterCommit);
        }
        Err(StopRuntimeError::AfterStop(error, generation)) => {
            return abort_before_commit(
                app,
                &paths,
                mutation,
                error,
                Some(generation),
                &supervisor,
            );
        }
    };
    let worker = match activate_release_before_worker(
        || {
            activate_runtime_release(
                app,
                &paths,
                mutation.candidate_runtime.map(|runtime| &runtime.binding),
                &runtime_route,
            )
        },
        || start_worker(app, &paths, mutation.candidate_runtime, generation),
    ) {
        Ok(worker) => worker,
        Err(error) => {
            return abort_before_commit(
                app,
                &paths,
                mutation,
                error,
                Some(generation),
                &supervisor,
            );
        }
    };
    let (worker, control) = match start_control_candidate(
        worker,
        |worker| {
            start_control(
                app,
                &supervisor,
                &paths,
                generation,
                worker.workspace_worker.as_ref(),
            )
        },
        |worker| {
            supervisor.quarantine_candidate_processes(vec![worker.child]);
        },
    ) {
        Ok(children) => children,
        Err(error) => {
            return abort_before_commit(
                app,
                &paths,
                mutation,
                error,
                Some(generation),
                &supervisor,
            );
        }
    };
    let children = RuntimeChildren {
        control: control.child,
        control_events: control.events,
        worker: worker.child,
        worker_events: worker.events,
    };
    let prepared = match prepare_runtime_supervision(app, &supervisor, children, generation) {
        Ok(prepared) => prepared,
        Err(error) => {
            return abort_before_commit(
                app,
                &paths,
                mutation,
                error,
                Some(generation),
                &supervisor,
            );
        }
    };
    if let Err(prepared) = stage_runtime_candidate(&supervisor, prepared) {
        stop_prepared_runtime(&supervisor, prepared);
        return abort_before_commit(
            app,
            &paths,
            mutation,
            ControlRuntimeStartError::RuntimeUnavailable,
            Some(generation),
            &supervisor,
        );
    }
    let binding_id = coordinator_binding(mutation);
    match commit_provider_candidate(
        (),
        || {
            let finalize =
                || provider_coordinator::finalize(app, &paths, mutation.operation_id, &binding_id);
            finalize().or_else(|_| finalize())
        },
        |finalized| {
            finalized.phase == "finalize"
                && finalized.pending.is_none()
                && finalized.catalog.as_ref().is_some_and(|catalog| {
                    catalog.revision == expected_revision + 1
                        && catalog.active_provider_id.as_deref() == mutation.active_provider_id
                        && catalog.runtime_binding_id.as_deref() == mutation.runtime_binding_id
                })
        },
        |()| install_staged_runtime_candidate(&supervisor, generation).map_err(|error| (error, ())),
        |()| stop_staged_runtime_candidate(&supervisor),
    ) {
        Ok(()) => Ok(()),
        Err(CandidateCommitFailure::BeforeFinalize(error)) => {
            abort_before_commit(app, &paths, mutation, error, Some(generation), &supervisor)
        }
        Err(CandidateCommitFailure::FinalizedAuthorityInvalid)
        | Err(CandidateCommitFailure::Install(_)) => {
            supervisor.shutdown();
            Err(ProviderRuntimeMutationFailure::AfterCommit)
        }
    }
}

pub(super) enum CandidateCommitFailure<E> {
    BeforeFinalize(E),
    FinalizedAuthorityInvalid,
    Install(E),
}

pub(super) fn start_control_candidate<W, C, E>(
    worker: W,
    start_control: impl FnOnce(&W) -> Result<C, E>,
    stop_worker: impl FnOnce(W),
) -> Result<(W, C), E> {
    match start_control(&worker) {
        Ok(control) => Ok((worker, control)),
        Err(error) => {
            stop_worker(worker);
            Err(error)
        }
    }
}

pub(super) fn commit_provider_candidate<C, R, E>(
    candidate: C,
    finalize: impl FnOnce() -> Result<R, E>,
    finalized_authority_valid: impl FnOnce(&R) -> bool,
    install: impl FnOnce(C) -> Result<(), (E, C)>,
    stop: impl FnOnce(C),
) -> Result<(), CandidateCommitFailure<E>> {
    let finalized = match finalize() {
        Ok(finalized) => finalized,
        Err(error) => {
            stop(candidate);
            return Err(CandidateCommitFailure::BeforeFinalize(error));
        }
    };
    if !finalized_authority_valid(&finalized) {
        stop(candidate);
        return Err(CandidateCommitFailure::FinalizedAuthorityInvalid);
    }
    match install(candidate) {
        Ok(()) => Ok(()),
        Err((error, candidate)) => {
            stop(candidate);
            Err(CandidateCommitFailure::Install(error))
        }
    }
}

pub(super) fn recover_provider_authority(
    app: &AppHandle,
    paths: &RuntimePaths,
    recovery: &ProviderCredentialRecovery<'_>,
) -> Result<ProviderCredentialRecoveryDisposition, &'static str> {
    let authority =
        provider_coordinator::inspect(app, paths).map_err(ControlRuntimeStartError::code)?;
    if authority.phase != "inspect" || authority.disposition.is_some() {
        return Err(ControlRuntimeStartError::ProviderCoordinatorFailed.code());
    }
    if authority.pending.as_ref().is_some_and(|pending| {
        pending.operation_id != recovery.operation_id
            || pending.runtime_binding_id.as_deref() != recovery.runtime_binding_id
    }) {
        return Err(ControlRuntimeStartError::ProviderCoordinatorFailed.code());
    }
    let binding_id = recovery
        .runtime_binding_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}:disabled", recovery.operation_id));
    let recovery_binding = format!("{}:recovery", recovery.operation_id);
    let recover = || {
        provider_coordinator::recover(
            app,
            paths,
            recovery.operation_id,
            &binding_id,
            &recovery_binding,
        )
    };
    let recovered = recover()
        .or_else(|_| recover())
        .map_err(ControlRuntimeStartError::code)?;
    if recovered.phase != "recover" || recovered.pending.is_some() {
        return Err(ControlRuntimeStartError::ProviderCoordinatorFailed.code());
    }
    let recovered_binding = recovered
        .catalog
        .as_ref()
        .and_then(|catalog| catalog.runtime_binding_id.as_deref());
    let previous_binding = recovery
        .previous_runtime
        .map(|runtime| runtime.binding.runtime_binding_id.as_str());
    match recovered.disposition.as_deref() {
        Some("finalized") if recovered_binding == recovery.runtime_binding_id => {
            Ok(ProviderCredentialRecoveryDisposition::KeepCandidate)
        }
        Some("aborted" | "expired" | "missing")
            if recovered.catalog.is_none() || recovered_binding == previous_binding =>
        {
            Ok(ProviderCredentialRecoveryDisposition::RestorePrevious)
        }
        _ => Err(ControlRuntimeStartError::ProviderCoordinatorFailed.code()),
    }
}

fn coordinator_binding(mutation: &ProviderRuntimeMutation<'_>) -> String {
    mutation
        .runtime_binding_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}:disabled", mutation.operation_id))
}

fn abort_before_commit(
    app: &AppHandle,
    paths: &RuntimePaths,
    mutation: &ProviderRuntimeMutation<'_>,
    error: ControlRuntimeStartError,
    generation: Option<RuntimeGeneration>,
    supervisor: &ControlRuntimeSupervisor,
) -> Result<(), ProviderRuntimeMutationFailure> {
    let binding_id = coordinator_binding(mutation);
    let aborted = provider_coordinator::abort(app, paths, mutation.operation_id, &binding_id)
        .or_else(|_| provider_coordinator::abort(app, paths, mutation.operation_id, &binding_id))
        .is_ok_and(|result| {
            result.phase == "abort"
                && matches!(result.disposition.as_deref(), Some("aborted" | "replayed"))
                && result.pending.is_none()
                && result.catalog.as_ref().is_none_or(|catalog| {
                    catalog.active_provider_id.as_deref()
                        == mutation
                            .previous_runtime
                            .map(|runtime| runtime.binding.provider_id.as_str())
                        && catalog.runtime_binding_id.as_deref()
                            == mutation
                                .previous_runtime
                                .map(|runtime| runtime.binding.runtime_binding_id.as_str())
                })
        });
    let recovered = generation.is_none_or(|generation| {
        supervisor.runtime_route().is_ok_and(|runtime_route| {
            recover_runtime(
                app,
                supervisor,
                paths,
                mutation.previous_runtime,
                &runtime_route,
                generation,
            )
            .is_ok()
        })
    });
    if aborted && recovered {
        Err(ProviderRuntimeMutationFailure::BeforeCommit(error.code()))
    } else {
        supervisor.shutdown();
        Err(ProviderRuntimeMutationFailure::AfterCommit)
    }
}
