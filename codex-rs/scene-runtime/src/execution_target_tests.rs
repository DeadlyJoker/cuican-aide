use super::*;
use pretty_assertions::assert_eq;

fn resolver() -> ExecutionTargetResolver {
    ExecutionTargetResolver::new("target.crewon.default", TargetRuntimeAvailability::Ready)
        .expect("default token should be valid")
}

fn catalog() -> Vec<ExecutionTargetCatalogRecord> {
    vec![
        ExecutionTargetCatalogRecord {
            kind: ExecutionTargetKind::Agent,
            id: "writer".to_string(),
            token: "target.agent.writer".to_string(),
            authorization: TargetAuthorization::Authorized,
            runtime_availability: TargetRuntimeAvailability::Ready,
        },
        ExecutionTargetCatalogRecord {
            kind: ExecutionTargetKind::Team,
            id: "launch-team".to_string(),
            token: "target.team.launch-team".to_string(),
            authorization: TargetAuthorization::Authorized,
            runtime_availability: TargetRuntimeAvailability::Ready,
        },
    ]
}

#[test]
fn crewon_is_the_default_single_agent_target() {
    assert_eq!(
        resolver().resolve(&ExecutionTargetSelection::Crewon, &catalog()),
        Ok(ResolvedExecutionTarget {
            kind: ExecutionTargetKind::Crewon,
            token: "target.crewon.default".to_string(),
            execution_strategy: ExecutionStrategy::Single,
            availability: TargetAvailability::Ready,
        })
    );
}

#[test]
fn defined_agent_resolves_to_single_strategy() {
    assert_eq!(
        resolver().resolve(
            &ExecutionTargetSelection::Agent {
                id: "writer".to_string(),
            },
            &catalog(),
        ),
        Ok(ResolvedExecutionTarget {
            kind: ExecutionTargetKind::Agent,
            token: "target.agent.writer".to_string(),
            execution_strategy: ExecutionStrategy::Single,
            availability: TargetAvailability::Ready,
        })
    );
}

#[test]
fn defined_team_resolves_to_team_strategy() {
    assert_eq!(
        resolver().resolve(
            &ExecutionTargetSelection::Team {
                id: "launch-team".to_string(),
            },
            &catalog(),
        ),
        Ok(ResolvedExecutionTarget {
            kind: ExecutionTargetKind::Team,
            token: "target.team.launch-team".to_string(),
            execution_strategy: ExecutionStrategy::Team,
            availability: TargetAvailability::Ready,
        })
    );
}

#[test]
fn unavailable_team_runtime_does_not_fall_back_to_single() {
    let resolver = ExecutionTargetResolver::new(
        "target.crewon.default",
        TargetRuntimeAvailability::Unavailable,
    )
    .expect("default token should be valid");

    assert_eq!(
        resolver.resolve(
            &ExecutionTargetSelection::Team {
                id: "launch-team".to_string(),
            },
            &catalog(),
        ),
        Ok(ResolvedExecutionTarget {
            kind: ExecutionTargetKind::Team,
            token: "target.team.launch-team".to_string(),
            execution_strategy: ExecutionStrategy::Team,
            availability: TargetAvailability::Unavailable,
        })
    );
}

#[test]
fn unknown_agent_is_rejected() {
    assert_eq!(
        resolver().resolve(
            &ExecutionTargetSelection::Agent {
                id: "missing".to_string(),
            },
            &catalog(),
        ),
        Err(ExecutionTargetError::TargetNotFound {
            kind: ExecutionTargetKind::Agent,
            id: "missing".to_string(),
        })
    );
}

#[test]
fn invalid_server_token_is_rejected() {
    let catalog = vec![ExecutionTargetCatalogRecord {
        kind: ExecutionTargetKind::Agent,
        id: "writer".to_string(),
        token: "not a valid token".to_string(),
        authorization: TargetAuthorization::Authorized,
        runtime_availability: TargetRuntimeAvailability::Ready,
    }];

    assert_eq!(
        resolver().resolve(
            &ExecutionTargetSelection::Agent {
                id: "writer".to_string(),
            },
            &catalog,
        ),
        Err(ExecutionTargetError::InvalidToken)
    );
}
