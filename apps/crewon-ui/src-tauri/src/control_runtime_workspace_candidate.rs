use std::sync::Arc;
use std::sync::MutexGuard;

use super::workspace::quarantine_workspace_foundation;
use super::workspace::WorkspaceRuntimeContext;
use super::workspace_install::CompleteWorkspaceRuntime;
use super::workspace_install::PreparedWorkspaceInstall;
use super::workspace_switch::StagedWorkspaceCandidate;
use super::workspace_wire::DesktopWorkspaceError;
use super::ControlRuntimeSupervisor;

impl StagedWorkspaceCandidate {
    pub(super) fn into_complete(
        mut self,
    ) -> Result<CompleteWorkspaceRuntime, DesktopWorkspaceError> {
        let (context, gateway, gateway_events) = match self.foundation.take()
        {
            Some(foundation) => (
                Some(foundation.context),
                Some(foundation.gateway),
                Some(foundation.gateway_events),
            ),
            None => (None, None, None),
        };
        let worker = self
            .worker
            .take()
            .ok_or_else(DesktopWorkspaceError::aborted)?;
        let control = self
            .control
            .take()
            .ok_or_else(DesktopWorkspaceError::aborted)?;
        Ok(CompleteWorkspaceRuntime {
            context,
            control: control.child,
            control_events: control.events,
            device: None,
            device_events: None,
            gateway,
            gateway_events,
            worker: worker.child,
            worker_events: worker.events,
        })
    }

    fn stop(mut self, supervisor: &ControlRuntimeSupervisor) {
        let mut children = Vec::new();
        if let Some(control) = self.control.take() {
            children.push(control.child);
        }
        if let Some(worker) = self.worker.take() {
            children.push(worker.child);
        }
        supervisor.quarantine_candidate_processes(children);
        quarantine_workspace_foundation(supervisor, self.foundation.take());
        if let Some(prepared) = self.prepared.take() {
            prepared.stop(supervisor);
        }
    }
}

pub(super) fn stop_staged_candidate(supervisor: &ControlRuntimeSupervisor) {
    let mut staged = supervisor
        .candidate_workspace
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(candidate) = staged.take() {
        candidate.stop(supervisor);
    }
}

pub(super) fn stage_candidate(
    supervisor: &ControlRuntimeSupervisor,
    candidate: StagedWorkspaceCandidate,
) -> Result<(), DesktopWorkspaceError> {
    let mut staged = match supervisor.candidate_workspace.lock() {
        Ok(staged) => staged,
        Err(poisoned) => {
            let mut staged = poisoned.into_inner();
            if let Some(existing) = staged.take() {
                existing.stop(supervisor);
            }
            candidate.stop(supervisor);
            return Err(DesktopWorkspaceError::aborted());
        }
    };
    if staged.is_some() {
        candidate.stop(supervisor);
        return Err(DesktopWorkspaceError::transitioning());
    }
    *staged = Some(candidate);
    Ok(())
}

pub(super) fn stage_prepared_candidate(
    supervisor: &ControlRuntimeSupervisor,
    prepared: PreparedWorkspaceInstall,
) -> Result<(), DesktopWorkspaceError> {
    stage_candidate(
        supervisor,
        StagedWorkspaceCandidate {
            foundation: None,
            worker: None,
            control: None,
            prepared: Some(prepared),
        },
    )
}

pub(super) fn staged_mut(
    supervisor: &ControlRuntimeSupervisor,
) -> Result<MutexGuard<'_, Option<StagedWorkspaceCandidate>>, DesktopWorkspaceError> {
    let staged = supervisor
        .candidate_workspace
        .lock()
        .map_err(|_| DesktopWorkspaceError::unavailable())?;
    if staged.is_none() {
        return Err(DesktopWorkspaceError::unavailable());
    }
    Ok(staged)
}

pub(super) fn staged_context(
    supervisor: &ControlRuntimeSupervisor,
) -> Result<Option<Arc<WorkspaceRuntimeContext>>, DesktopWorkspaceError> {
    Ok(staged_mut(supervisor)?
        .as_ref()
        .and_then(|candidate| candidate.foundation.as_ref())
        .map(|foundation| Arc::clone(&foundation.context)))
}

pub(super) fn take_staged_candidate(
    supervisor: &ControlRuntimeSupervisor,
) -> Result<StagedWorkspaceCandidate, DesktopWorkspaceError> {
    let mut staged = supervisor
        .candidate_workspace
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    staged.take().ok_or_else(DesktopWorkspaceError::aborted)
}
