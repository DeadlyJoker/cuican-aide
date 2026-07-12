use super::*;
use crewon_protocol::scene::SceneDeliverable;
use crewon_protocol::scene::SceneExecutionTargetKind;
use crewon_protocol::scene::SceneTaskContract;

fn metadata(scene: SceneId, mode: SceneInteractionMode) -> SceneThreadMetadata {
    SceneThreadMetadata {
        version: 1,
        preset_version: 1,
        instruction_version: 1,
        contract: SceneTaskContract {
            scene,
            mode,
            deliverable: SceneDeliverable::Conversation,
            local_write_policy: LocalWritePolicy::ReadOnly,
            external_action_policy: ExternalActionPolicy::DraftOnly,
        },
        execution_target_kind: SceneExecutionTargetKind::Agent,
        execution_target_ref: Some("private-agent-id".to_string()),
        execution_target_token: "private-token".to_string(),
        execution_strategy: SceneExecutionStrategy::Single,
    }
}

#[test]
fn instructions_distinguish_scenes_without_leaking_target_identifiers() {
    let office =
        render_scene_instructions(&metadata(SceneId::Office, SceneInteractionMode::Organize));
    let code = render_scene_instructions(&metadata(SceneId::Code, SceneInteractionMode::Review));
    let design =
        render_scene_instructions(&metadata(SceneId::Design, SceneInteractionMode::Explore));

    assert!(office.contains("ready-to-use documents"));
    assert!(code.contains("repository evidence"));
    assert!(design.contains("visual directions"));
    for rendered in [&office, &code, &design] {
        assert!(!rendered.contains("private-agent-id"));
        assert!(!rendered.contains("private-token"));
    }
}
