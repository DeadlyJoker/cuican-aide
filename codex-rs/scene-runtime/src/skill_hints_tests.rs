use super::*;
use pretty_assertions::assert_eq;

/// The carrier choice per scene is a deliberate design decision, not an
/// oversight: `Code` has no skill because the platform's own shell and editing
/// tools already cover repository work. Asserting the whole mapping is what
/// keeps someone from "fixing" that gap by adding a redundant skill.
#[test]
fn each_scene_maps_to_its_chosen_carrier() {
    let mapped: Vec<(SceneId, Option<&str>)> = [SceneId::Office, SceneId::Code, SceneId::Design]
        .into_iter()
        .map(|scene| (scene, scene_skill(scene)))
        .collect();

    assert_eq!(
        mapped,
        vec![
            (SceneId::Office, Some("office-suite")),
            (SceneId::Code, None),
            (SceneId::Design, Some("design-studio")),
        ]
    );
}

#[test]
fn skill_backed_scenes_name_their_skill_and_its_purpose() {
    let office = scene_skill_instructions(SceneId::Office);
    assert!(office.contains("`office-suite`"), "office: {office}");
    assert!(
        office.contains("Word, PowerPoint and Excel"),
        "office: {office}"
    );

    let design = scene_skill_instructions(SceneId::Design);
    assert!(design.contains("`design-studio`"), "design: {design}");
    // The audit is only a gate if the model is told it cannot be skipped.
    assert!(design.contains("delivery gate"), "design: {design}");
}

/// Code's guidance replaces a skill, so it must point at the real tools and
/// carry the verification discipline that the deleted skill used to hold.
#[test]
fn code_guidance_points_at_platform_tools_instead_of_a_skill() {
    let rendered = scene_skill_instructions(SceneId::Code);

    assert!(
        !rendered.contains("code-craft"),
        "code should not reference a skill: {rendered}"
    );
    assert!(rendered.contains("no separate skill"), "code: {rendered}");
    assert!(rendered.contains("AGENTS.md"), "code: {rendered}");
    assert!(
        rendered.contains("Verification is not optional"),
        "code: {rendered}"
    );
}

/// Every injected fragment must stay bounded; these are per-turn prompt text.
#[test]
fn guidance_stays_within_a_bounded_prompt_budget() {
    let longest = [SceneId::Office, SceneId::Code, SceneId::Design]
        .into_iter()
        .map(|scene| scene_skill_instructions(scene).len())
        .max()
        .expect("three scenes");

    assert!(
        longest <= 1200,
        "scene guidance grew to {longest} bytes; keep detail in skills, not the prompt"
    );
}
