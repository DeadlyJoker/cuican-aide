use tauri::AppHandle;

use super::activate_release_before_worker;
use super::activate_runtime_release;
use super::environment::ControlAdmissionMode;
use super::private_credentials::PrivateCredentialBindings;
use super::reload::resolve_runtime_private_credentials;
use super::reload::start_control_with_admission;
use super::reload::start_worker_with_context;
use super::reload::RuntimeGeneration;
use super::reload::StartedControl;
use super::reload::StartedWorker;
use super::runtime_route_for_authority;
use super::workspace::start_workspace_foundation;
use super::workspace::StartedWorkspaceFoundation;
use super::workspace_candidate::stage_candidate;
use super::workspace_candidate::stage_prepared_candidate;
use super::workspace_candidate::staged_context;
use super::workspace_candidate::staged_mut;
use super::workspace_candidate::stop_staged_candidate;
use super::workspace_candidate::take_staged_candidate;
use super::workspace_commit::commit_or_reload;
use super::workspace_fence::WorkspaceSwitchFence;
use super::workspace_fence::WorkspaceSwitchFenceError;
use super::workspace_install::commit_workspace_install;
use super::workspace_install::install_prepared_workspace;
use super::workspace_install::prepare_workspace_install;
use super::workspace_install::PreparedWorkspaceInstall;
use super::workspace_postcommit::recover_committed_candidate;
use super::workspace_state::workspace_foundation_plan;
use super::workspace_state::WorkspaceFoundationPlan;
use super::workspace_state::WorkspaceSwitchPhase;
use super::workspace_state::WorkspaceSwitchState;
use super::workspace_termination::detach_current;
use super::workspace_termination::stop_detached;
use super::workspace_termination::stop_failed_installed;
use super::workspace_wire::DesktopWorkspaceError;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;
use super::RuntimePaths;
use crate::provider_credentials;
use crate::workspace_native::DesktopWorkspaceAuthority;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::WorkspaceAuthorityIntent;

pub(super) struct StagedWorkspaceCandidate {
    pub(super) foundation: Option<StartedWorkspaceFoundation>,
    pub(super) worker: Option<StartedWorker>,
    pub(super) control: Option<StartedControl>,
    pub(super) prepared: Option<PreparedWorkspaceInstall>,
}

pub(super) fn switch_workspace_runtime(
    app: &AppHandle,
    supervisor: &ControlRuntimeSupervisor,
    paths: &RuntimePaths,
    manager: &mut DesktopWorkspaceAuthorityManager,
    operation_id: &str,
    expected_revision: u64,
    intent: WorkspaceAuthorityIntent,
) -> Result<(), DesktopWorkspaceError> {
    let mut switch_state = WorkspaceSwitchState::new();
    let old_authority = manager
        .active_authority_projection()
        .map_err(DesktopWorkspaceError::from_native)?;
    let candidate_authority = manager
        .pending_candidate_authority(operation_id)
        .map_err(DesktopWorkspaceError::from_native)?;
    let old_private_credentials = resolve_workspace_private_credentials(&old_authority)?;
    let candidate_private_credentials =
        resolve_workspace_private_credentials(&candidate_authority)?;
    if stage_pre_fence_foundation(supervisor, &old_authority, &candidate_authority).is_err() {
        return match abort_pending(manager, operation_id) {
            Ok(()) => Err(DesktopWorkspaceError::internal_not_sent(
                "desktop_workspace_candidate_failed",
            )),
            Err(_) => Err(DesktopWorkspaceError::aborted()),
        };
    }
    advance_switch(
        &mut switch_state,
        WorkspaceSwitchPhase::Pending,
        WorkspaceSwitchPhase::FoundationStaged,
    )?;

    let fence = match WorkspaceSwitchFence::begin(&paths.control_database) {
        Ok(fence) => fence,
        Err(error) => {
            stop_staged_candidate(supervisor);
            abort_pending(manager, operation_id)?;
            return Err(map_precommit_fence_error(error));
        }
    };
    advance_switch(
        &mut switch_state,
        WorkspaceSwitchPhase::FoundationStaged,
        WorkspaceSwitchPhase::AdmissionFenced,
    )?;
    let detached = match detach_current(supervisor, &old_authority) {
        Ok(detached) => detached,
        Err(_error) => {
            stop_staged_candidate(supervisor);
            abort_pending(manager, operation_id)?;
            return Err(DesktopWorkspaceError::internal_not_sent(
                "desktop_workspace_runtime_unavailable",
            ));
        }
    };
    let generation = detached.generation;
    let expected = detached.expected.clone();
    let stopped = stop_detached(supervisor, detached);
    if !stopped.stopped {
        stop_staged_candidate(supervisor);
        supervisor.shutdown();
        let connection = fence
            .into_connection()
            .map_err(|_| DesktopWorkspaceError::aborted())?;
        supervisor.retain_failed_admission_fence_with_processes(
            connection,
            expected,
            stopped.processes,
        );
        return Err(DesktopWorkspaceError::aborted());
    }
    supervisor.terminations.finish(&expected);
    advance_switch(
        &mut switch_state,
        WorkspaceSwitchPhase::AdmissionFenced,
        WorkspaceSwitchPhase::OldRuntimeStopped,
    )?;
    if let Err(failed_fence) = fence.commit() {
        drop(failed_fence);
        return recover_old(
            app,
            supervisor,
            paths,
            manager,
            operation_id,
            &old_authority,
            old_private_credentials.as_ref(),
            generation,
        );
    }

    if complete_candidate(
        app,
        supervisor,
        paths,
        &candidate_authority,
        candidate_private_credentials.as_ref(),
        generation,
        ControlAdmissionMode::Paused,
    )
    .is_err()
    {
        return recover_old(
            app,
            supervisor,
            paths,
            manager,
            operation_id,
            &old_authority,
            old_private_credentials.as_ref(),
            generation,
        );
    }
    let prepared = match take_staged_candidate(supervisor)
        .and_then(StagedWorkspaceCandidate::into_complete)
        .and_then(|runtime| {
            prepare_workspace_install(
                app,
                supervisor,
                runtime,
                generation,
                ControlAdmissionMode::Paused,
            )
            .map_err(|error| map_runtime_error(error, false))
        }) {
        Ok(prepared) => prepared,
        Err(_) => {
            return recover_old(
                app,
                supervisor,
                paths,
                manager,
                operation_id,
                &old_authority,
                old_private_credentials.as_ref(),
                generation,
            );
        }
    };
    if stage_prepared_candidate(supervisor, prepared).is_err() {
        return recover_old(
            app,
            supervisor,
            paths,
            manager,
            operation_id,
            &old_authority,
            old_private_credentials.as_ref(),
            generation,
        );
    }
    advance_switch(
        &mut switch_state,
        WorkspaceSwitchPhase::OldRuntimeStopped,
        WorkspaceSwitchPhase::CandidatePrepared,
    )?;
    let committed = match commit_or_reload(
        paths,
        manager,
        operation_id,
        expected_revision,
        intent,
        &candidate_authority,
    ) {
        Ok(committed) => committed,
        Err(_) => {
            stop_staged_candidate(supervisor);
            supervisor.shutdown();
            return Err(DesktopWorkspaceError::aborted());
        }
    };
    if !committed {
        return recover_old(
            app,
            supervisor,
            paths,
            manager,
            operation_id,
            &old_authority,
            old_private_credentials.as_ref(),
            generation,
        );
    }
    advance_switch(
        &mut switch_state,
        WorkspaceSwitchPhase::CandidatePrepared,
        WorkspaceSwitchPhase::CatalogCommitted,
    )?;

    let prepared = match take_staged_candidate(supervisor).and_then(|candidate| {
        candidate
            .prepared
            .ok_or_else(DesktopWorkspaceError::aborted)
    }) {
        Ok(prepared) => prepared,
        Err(_) => {
            stop_staged_candidate(supervisor);
            supervisor.shutdown();
            return Err(postcommit_failure(&switch_state));
        }
    };
    let activation_fence = match WorkspaceSwitchFence::begin(&paths.control_database) {
        Ok(fence) => fence,
        Err(_) => {
            prepared.stop(supervisor);
            supervisor.shutdown();
            return Err(postcommit_failure(&switch_state));
        }
    };
    if install_prepared_workspace(supervisor, prepared, generation).is_err() {
        return match stop_failed_installed(supervisor, generation, activation_fence) {
            Some(fence) => recover_committed_candidate(
                app,
                supervisor,
                paths,
                &candidate_authority,
                candidate_private_credentials.as_ref(),
                generation,
                fence,
            ),
            None => Err(postcommit_failure(&switch_state)),
        };
    }
    advance_switch(
        &mut switch_state,
        WorkspaceSwitchPhase::CatalogCommitted,
        WorkspaceSwitchPhase::CandidateInstalled,
    )?;
    if let Err(fence) = commit_workspace_install(
        supervisor,
        generation,
        &candidate_authority,
        activation_fence,
    ) {
        return match stop_failed_installed(supervisor, generation, fence) {
            Some(fence) => recover_committed_candidate(
                app,
                supervisor,
                paths,
                &candidate_authority,
                candidate_private_credentials.as_ref(),
                generation,
                fence,
            ),
            None => Err(postcommit_failure(&switch_state)),
        };
    }
    advance_switch(
        &mut switch_state,
        WorkspaceSwitchPhase::CandidateInstalled,
        WorkspaceSwitchPhase::Published,
    )?;
    Ok(())
}

fn resolve_workspace_private_credentials(
    authority: &DesktopWorkspaceAuthority,
) -> Result<Option<PrivateCredentialBindings>, DesktopWorkspaceError> {
    let route = runtime_route_for_authority(Some(authority))
        .map_err(|error| map_runtime_error(error, false))?;
    resolve_runtime_private_credentials(&route).map_err(|error| map_runtime_error(error, false))
}

fn advance_switch(
    state: &mut WorkspaceSwitchState,
    expected: WorkspaceSwitchPhase,
    next: WorkspaceSwitchPhase,
) -> Result<(), DesktopWorkspaceError> {
    state
        .advance(expected, next)
        .map_err(|()| DesktopWorkspaceError::internal("desktop_workspace_switch_state_invalid"))
}

fn postcommit_failure(state: &WorkspaceSwitchState) -> DesktopWorkspaceError {
    if state.requires_committed_authority_recovery() {
        DesktopWorkspaceError::aborted()
    } else {
        DesktopWorkspaceError::internal_not_sent("desktop_workspace_candidate_failed")
    }
}

fn stage_pre_fence_foundation(
    supervisor: &ControlRuntimeSupervisor,
    old: &DesktopWorkspaceAuthority,
    candidate: &DesktopWorkspaceAuthority,
) -> Result<(), DesktopWorkspaceError> {
    let old_binding = old
        .current_snapshot()
        .map(|workspace| workspace.workspace_runtime_binding_id());
    let candidate_binding = candidate
        .current_snapshot()
        .map(|workspace| workspace.workspace_runtime_binding_id());
    let foundation = match workspace_foundation_plan(old_binding, candidate_binding) {
        WorkspaceFoundationPlan::Start => Some(
            start_workspace_foundation(candidate.clone())
                .map_err(|error| map_runtime_error(error, false))?,
        ),
        WorkspaceFoundationPlan::None | WorkspaceFoundationPlan::Reuse => None,
    };
    stage_candidate(
        supervisor,
        StagedWorkspaceCandidate {
            foundation,
            worker: None,
            control: None,
            prepared: None,
        },
    )
}

include!("control_runtime_workspace_completion.rs");
