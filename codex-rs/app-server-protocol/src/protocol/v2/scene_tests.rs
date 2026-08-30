use super::*;
use pretty_assertions::assert_eq;

#[test]
fn scene_descriptor_is_derived_from_runtime_registry() {
    let descriptors = runtime::all_scene_presets()
        .iter()
        .map(SceneDescriptor::from)
        .collect::<Vec<_>>();

    assert_eq!(
        descriptors
            .iter()
            .map(|item| item.scene_id)
            .collect::<Vec<_>>(),
        vec![SceneId::Office, SceneId::Code, SceneId::Design]
    );
    assert_eq!(
        descriptors[0].mode_specs[0].mode,
        SceneInteractionMode::Auto
    );
    assert_eq!(
        descriptors[0].mode_specs[0].default_contract,
        SceneTaskContract {
            scene: SceneId::Office,
            mode: SceneInteractionMode::Auto,
            deliverable: SceneDeliverable::Document,
            local_write_policy: LocalWritePolicy::WorkspaceWrite,
            external_action_policy: ExternalActionPolicy::DraftOnly,
        }
    );
}
