pub(super) fn complete_candidate(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    authority: &DesktopWorkspaceAuthority,
    private_credentials: Option<&PrivateCredentialBindings>,
    generation: RuntimeGeneration,
    admission: ControlAdmissionMode,
) -> Result<(), DesktopWorkspaceError> {
    let needs_foundation =
        authority.current_snapshot().is_some() && staged_context(supervisor)?.is_none();
    if needs_foundation {
        let foundation =
            start_workspace_foundation(app, paths, authority.clone(), Some(supervisor))
                .map_err(|error| map_runtime_error(error, false))?;
        staged_mut(supervisor)?
            .as_mut()
            .expect("checked staged candidate")
            .foundation = Some(foundation);
    }
    let context = staged_context(supervisor)?;
    let provider = provider_credentials::active_provider_runtime(app)
        .map_err(|_| DesktopWorkspaceError::aborted())?;
    let runtime_route = runtime_route_for_authority(Some(authority))
        .map_err(|error| map_runtime_error(error, false))?;
    let session = supervisor
        .session
        .as_ref()
        .ok_or_else(DesktopWorkspaceError::unavailable)?;
    let worker = activate_release_before_worker(
        || {
            activate_runtime_release(
                app,
                paths,
                provider.as_ref().map(|runtime| &runtime.binding),
                &runtime_route,
            )
            .map_err(|error| map_runtime_error(error, false))
        },
        || {
            start_worker_with_context(
                app,
                supervisor,
                paths,
                provider.as_ref(),
                private_credentials,
                generation,
                session,
                context.as_deref(),
            )
            .map_err(|error| map_runtime_error(error, false))
        },
    )?;
    let route = worker.workspace_worker.clone();
    staged_mut(supervisor)?
        .as_mut()
        .expect("checked staged candidate")
        .worker = Some(worker);
    let control = start_control_with_admission(
        app,
        supervisor,
        paths,
        generation,
        route.as_ref(),
        &runtime_route,
        admission,
    )
    .map_err(|error| map_runtime_error(error, false))?;
    staged_mut(supervisor)?
        .as_mut()
        .expect("checked staged candidate")
        .control = Some(control);
    Ok(())
}

fn recover_old(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    manager: &mut DesktopWorkspaceAuthorityManager,
    operation_id: &str,
    old: &DesktopWorkspaceAuthority,
    private_credentials: Option<&PrivateCredentialBindings>,
    generation: RuntimeGeneration,
) -> Result<(), DesktopWorkspaceError> {
    stop_staged_candidate(supervisor);
    if supervisor.require_no_failed_process_quarantine().is_err()
        || abort_pending(manager, operation_id).is_err()
        || stage_pre_fence_foundation(app, supervisor, paths, old, old).is_err()
        || complete_candidate(
            app,
            supervisor,
            paths,
            old,
            private_credentials,
            generation,
            ControlAdmissionMode::Paused,
        )
        .is_err()
    {
        supervisor.shutdown();
        return Err(DesktopWorkspaceError::aborted());
    }
    let runtime = take_staged_candidate(supervisor)?.into_complete()?;
    let prepared = prepare_workspace_install(
        app,
        supervisor,
        runtime,
        generation,
        ControlAdmissionMode::Paused,
    )
    .map_err(|_| DesktopWorkspaceError::aborted())?;
    let activation_fence = WorkspaceSwitchFence::begin(&paths.control_database)
        .map_err(|_| DesktopWorkspaceError::aborted())?;
    if install_prepared_workspace(supervisor, prepared, generation).is_err() {
        if let Some(fence) = stop_failed_installed(supervisor, generation, activation_fence) {
            drop(fence);
        }
        return Err(DesktopWorkspaceError::aborted());
    }
    if let Err(fence) = commit_workspace_install(supervisor, generation, old, activation_fence) {
        if let Some(fence) = stop_failed_installed(supervisor, generation, fence) {
            drop(fence);
        }
        return Err(DesktopWorkspaceError::aborted());
    }
    Err(DesktopWorkspaceError::internal_not_sent(
        "desktop_workspace_candidate_rejected",
    ))
}

fn abort_pending(
    manager: &mut DesktopWorkspaceAuthorityManager,
    operation_id: &str,
) -> Result<(), DesktopWorkspaceError> {
    manager
        .abort(operation_id)
        .map_err(DesktopWorkspaceError::from_native)
}

fn map_precommit_fence_error(error: WorkspaceSwitchFenceError) -> DesktopWorkspaceError {
    match error {
        WorkspaceSwitchFenceError::ActiveAuthority => DesktopWorkspaceError::active_authority(),
        WorkspaceSwitchFenceError::Unavailable => {
            DesktopWorkspaceError::internal_not_sent("desktop_workspace_fence_unavailable")
        }
    }
}

fn map_runtime_error(
    _error: ControlRuntimeStartError,
    possibly_sent: bool,
) -> DesktopWorkspaceError {
    if possibly_sent {
        DesktopWorkspaceError::aborted()
    } else {
        DesktopWorkspaceError::internal_not_sent("desktop_workspace_candidate_failed")
    }
}
