use super::*;
use crewon_protocol::scene::SceneExecutionTargetKind;
use crewon_protocol::scene::SceneExecutionTargetProfile;
use crewon_protocol::scene::SceneTeamMemberProfile;
use pretty_assertions::assert_eq;

fn experts_profile() -> SceneExecutionTargetProfile {
    SceneExecutionTargetProfile {
        kind: SceneExecutionTargetKind::Experts,
        display_name: "Delivery council".to_string(),
        role: Some("Review and deliver".to_string()),
        model: None,
        instructions: None,
        capabilities: Vec::new(),
        team_members: vec![
            SceneTeamMemberProfile {
                name: "Research".to_string(),
                role: Some("Find risks".to_string()),
                agent_id: Some("explorer".to_string()),
            },
            SceneTeamMemberProfile {
                name: "Delivery".to_string(),
                role: Some("Implement fixes".to_string()),
                agent_id: Some("worker".to_string()),
            },
        ],
    }
}

#[test]
fn experts_delegation_accepts_only_configured_agent_types() {
    let profile = experts_profile();

    assert_eq!(
        resolve_spawn_role_name(Some(&profile), Some("explorer"), "research"),
        Ok(Some("explorer".to_string()))
    );
    assert_eq!(
        resolve_spawn_role_name(Some(&profile), Some("worker"), "delivery"),
        Ok(Some("worker".to_string()))
    );
    assert_eq!(
        resolve_spawn_role_name(Some(&profile), None, "research"),
        Err(FunctionCallError::RespondToModel(
            "Experts delegation requires agent_type, or task_name must exactly match a configured agentId"
                .to_string()
        ))
    );
    assert_eq!(
        resolve_spawn_role_name(Some(&profile), Some("default"), "research"),
        Err(FunctionCallError::RespondToModel(
            "agent_type 'default' is not allowed by this Experts definition".to_string()
        ))
    );
}

#[test]
fn non_experts_targets_do_not_restrict_agent_types() {
    let mut profile = experts_profile();
    profile.kind = SceneExecutionTargetKind::Team;

    assert_eq!(
        resolve_spawn_role_name(Some(&profile), None, "research"),
        Ok(None)
    );
}

#[test]
fn experts_infer_agent_type_from_exact_task_name() {
    let profile = experts_profile();

    assert_eq!(
        resolve_spawn_role_name(Some(&profile), None, "explorer"),
        Ok(Some("explorer".to_string()))
    );
}

#[test]
fn experts_default_to_an_independent_fork_for_explicit_agent_types() {
    let args = SpawnAgentArgs {
        message: "Inspect the workflow".to_string(),
        task_name: "workflow_inspection".to_string(),
        agent_type: Some("explorer".to_string()),
        model: None,
        reasoning_effort: None,
        service_tier: None,
        fork_turns: None,
        fork_context: None,
    };

    assert_eq!(args.fork_mode(Some(&experts_profile())), Ok(None));
}

#[test]
fn non_experts_keep_the_full_history_default() {
    let args = SpawnAgentArgs {
        message: "Inspect the workflow".to_string(),
        task_name: "workflow_inspection".to_string(),
        agent_type: None,
        model: None,
        reasoning_effort: None,
        service_tier: None,
        fork_turns: None,
        fork_context: None,
    };

    assert_eq!(
        args.fork_mode(None),
        Ok(Some(SpawnAgentForkMode::FullHistory))
    );
}
