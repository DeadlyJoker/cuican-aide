use super::*;
use crewon_protocol::scene::SceneExecutionTargetKind;
use crewon_protocol::scene::SceneTeamMemberProfile;
use pretty_assertions::assert_eq;

#[test]
fn renders_a_bounded_structured_agent_profile() {
    let fragment = ExecutionTargetContextFragment::new(SceneExecutionTargetProfile {
        kind: SceneExecutionTargetKind::Agent,
        display_name: "Reviewer".to_string(),
        role: Some("Review changes".to_string()),
        model: Some("gpt-5".to_string()),
        instructions: Some("Prioritize regressions.".to_string()),
        capabilities: vec!["code-review".to_string()],
        team_members: Vec::new(),
    });

    assert_eq!(fragment.role(), "developer");
    let rendered = fragment.render();
    assert!(rendered.contains("<crewon_execution_target_context>"));
    assert!(rendered.contains("\"displayName\":\"Reviewer\""));
    assert!(rendered.contains("Prioritize regressions."));
}

#[test]
fn maximum_team_profile_stays_below_the_context_fragment_limit() {
    let fragment = ExecutionTargetContextFragment::new(SceneExecutionTargetProfile {
        kind: SceneExecutionTargetKind::Team,
        display_name: "T".repeat(128),
        role: Some("G".repeat(512)),
        model: None,
        instructions: None,
        capabilities: Vec::new(),
        team_members: (0..12)
            .map(|_| SceneTeamMemberProfile {
                name: "N".repeat(96),
                role: Some("R".repeat(160)),
                agent_id: Some("A".repeat(128)),
            })
            .collect(),
    });

    assert!(fragment.render().len() < 10_000);
}
