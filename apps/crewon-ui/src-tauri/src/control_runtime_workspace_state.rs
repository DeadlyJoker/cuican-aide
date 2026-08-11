#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WorkspaceFoundationPlan {
    None,
    Reuse,
    Start,
}

pub(super) fn workspace_foundation_plan(
    old_binding: Option<&str>,
    candidate_binding: Option<&str>,
) -> WorkspaceFoundationPlan {
    match (old_binding, candidate_binding) {
        (_, None) => WorkspaceFoundationPlan::None,
        (Some(old), Some(candidate)) if old == candidate => WorkspaceFoundationPlan::Reuse,
        (None | Some(_), Some(_)) => WorkspaceFoundationPlan::Start,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum WorkspaceSwitchPhase {
    Pending,
    FoundationStaged,
    AdmissionFenced,
    OldRuntimeStopped,
    CandidatePrepared,
    CatalogCommitted,
    CandidateInstalled,
    Published,
}

#[derive(Debug)]
pub(super) struct WorkspaceSwitchState {
    phase: WorkspaceSwitchPhase,
}

impl WorkspaceSwitchState {
    pub(super) fn new() -> Self {
        Self {
            phase: WorkspaceSwitchPhase::Pending,
        }
    }

    pub(super) fn advance(
        &mut self,
        expected: WorkspaceSwitchPhase,
        next: WorkspaceSwitchPhase,
    ) -> Result<(), ()> {
        if self.phase != expected || next <= expected {
            return Err(());
        }
        self.phase = next;
        Ok(())
    }

    pub(super) fn requires_committed_authority_recovery(&self) -> bool {
        self.phase >= WorkspaceSwitchPhase::CatalogCommitted
    }
}

#[cfg(test)]
#[path = "control_runtime_workspace_state_tests.rs"]
mod tests;
