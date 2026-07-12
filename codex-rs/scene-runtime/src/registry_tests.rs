use super::*;
use pretty_assertions::assert_eq;

#[test]
fn registry_contains_all_scene_presets() {
    assert_eq!(
        all_scene_presets()
            .iter()
            .map(|preset| preset.scene)
            .collect::<Vec<_>>(),
        vec![SceneId::Office, SceneId::Code, SceneId::Design]
    );
}

#[test]
fn auto_contracts_allow_scene_appropriate_execution() {
    assert_eq!(
        [SceneId::Office, SceneId::Code, SceneId::Design]
            .map(|scene| { resolve_scene_contract(scene, SceneInteractionMode::Auto, None) }),
        [
            Ok(SceneTaskContract {
                scene: SceneId::Office,
                mode: SceneInteractionMode::Auto,
                deliverable: SceneDeliverable::Document,
                local_write_policy: LocalWritePolicy::WorkspaceWrite,
                external_action_policy: ExternalActionPolicy::DraftOnly,
            }),
            Ok(SceneTaskContract {
                scene: SceneId::Code,
                mode: SceneInteractionMode::Auto,
                deliverable: SceneDeliverable::CodeChange,
                local_write_policy: LocalWritePolicy::WorkspaceWrite,
                external_action_policy: ExternalActionPolicy::ConfirmEach,
            }),
            Ok(SceneTaskContract {
                scene: SceneId::Design,
                mode: SceneInteractionMode::Auto,
                deliverable: SceneDeliverable::DesignDirections,
                local_write_policy: LocalWritePolicy::WorkspaceWrite,
                external_action_policy: ExternalActionPolicy::ConfirmEach,
            }),
        ]
    );
}

#[test]
fn contract_resolver_accepts_allowed_deliverable_override() {
    assert_eq!(
        resolve_scene_contract(
            SceneId::Office,
            SceneInteractionMode::Write,
            Some(SceneDeliverable::MessageDraft),
        ),
        Ok(SceneTaskContract {
            scene: SceneId::Office,
            mode: SceneInteractionMode::Write,
            deliverable: SceneDeliverable::MessageDraft,
            local_write_policy: LocalWritePolicy::WorkspaceWrite,
            external_action_policy: ExternalActionPolicy::DraftOnly,
        })
    );
}

#[test]
fn contract_resolver_rejects_mode_from_another_scene() {
    assert_eq!(
        resolve_scene_contract(SceneId::Office, SceneInteractionMode::Implement, None),
        Err(SceneContractError::ModeNotAvailable {
            scene: SceneId::Office,
            mode: SceneInteractionMode::Implement,
        })
    );
}

#[test]
fn contract_resolver_rejects_deliverable_from_another_mode() {
    assert_eq!(
        resolve_scene_contract(
            SceneId::Code,
            SceneInteractionMode::Review,
            Some(SceneDeliverable::CodeChange),
        ),
        Err(SceneContractError::DeliverableNotAvailable {
            scene: SceneId::Code,
            mode: SceneInteractionMode::Review,
            deliverable: SceneDeliverable::CodeChange,
        })
    );
}
