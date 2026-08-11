use pretty_assertions::assert_eq;

use super::workspace_foundation_plan;
use super::WorkspaceFoundationPlan;
use super::WorkspaceSwitchPhase;
use super::WorkspaceSwitchState;

#[test]
fn different_same_and_clear_authorities_have_unambiguous_foundation_plans() {
    assert_eq!(
        workspace_foundation_plan(Some("old"), Some("new")),
        WorkspaceFoundationPlan::Start
    );
    assert_eq!(
        workspace_foundation_plan(Some("same"), Some("same")),
        WorkspaceFoundationPlan::Reuse
    );
    assert_eq!(
        workspace_foundation_plan(Some("old"), None),
        WorkspaceFoundationPlan::None
    );
}

#[test]
fn switch_trace_freezes_order_and_every_failure_certainty_boundary() {
    let phases = [
        WorkspaceSwitchPhase::FoundationStaged,
        WorkspaceSwitchPhase::AdmissionFenced,
        WorkspaceSwitchPhase::OldRuntimeStopped,
        WorkspaceSwitchPhase::CandidatePrepared,
        WorkspaceSwitchPhase::CatalogCommitted,
        WorkspaceSwitchPhase::CandidateInstalled,
        WorkspaceSwitchPhase::Published,
    ];
    for failed_after in 0..phases.len() {
        let mut state = WorkspaceSwitchState::new();
        let mut previous = WorkspaceSwitchPhase::Pending;
        for next in phases.iter().take(failed_after + 1) {
            state.advance(previous, *next).unwrap();
            previous = *next;
        }
        assert_eq!(
            state.requires_committed_authority_recovery(),
            phases[failed_after] >= WorkspaceSwitchPhase::CatalogCommitted
        );
    }
    let mut invalid = WorkspaceSwitchState::new();
    assert_eq!(
        invalid.advance(
            WorkspaceSwitchPhase::FoundationStaged,
            WorkspaceSwitchPhase::CatalogCommitted,
        ),
        Err(())
    );
}
