//! Chooses how each scene's capability reaches the model.
//!
//! The three scenes need different carriers, and picking the wrong one costs
//! either context budget or determinism:
//!
//! * **Office** ships as a skill. Its value is a large JSON spec contract for
//!   docx/pptx/xlsx that would sit in the prompt every turn while almost no
//!   conversation produces a document. On-demand loading is exactly what skills
//!   are for.
//! * **Code** gets no skill. The platform already exposes `shell`,
//!   `apply_patch`, and `unified_exec`, which is what repository work needs; a
//!   skill wrapping "run a few commands and summarize" only adds indirection.
//!   What the scene actually needs is standing discipline, so it lives here as
//!   prompt text.
//! * **Design** ships as a skill for rendering, plus a standing rule that the
//!   audit is a gate rather than an optional extra. A quality gate the model may
//!   forget to run is not a gate.
//!
//! Skills ship in the `crewon-skills` crate and install under
//! `CODEX_HOME/skills/.system/<name>`.

use crewon_protocol::scene::SceneId;

/// Bundled skill that owns Word/PowerPoint/Excel deliverables.
pub const OFFICE_SKILL: &str = "office-suite";
/// Bundled skill that owns design artifact rendering and auditing.
pub const DESIGN_SKILL: &str = "design-studio";

/// Returns the bundled skill a scene's deliverables depend on, if it has one.
///
/// `Code` returns `None` on purpose: see the module docs.
pub fn scene_skill(scene: SceneId) -> Option<&'static str> {
    match scene {
        SceneId::Office => Some(OFFICE_SKILL),
        SceneId::Code => None,
        SceneId::Design => Some(DESIGN_SKILL),
    }
}

/// Renders the scene's capability guidance: which skill to load, or the standing
/// discipline that replaces one.
pub fn scene_skill_instructions(scene: SceneId) -> &'static str {
    match scene {
        SceneId::Office => {
            "Scene toolchain: the `office-suite` skill owns building, reading and validating Word, PowerPoint and Excel deliverables. Load it before producing such a file, follow its workflow, and use its bundled scripts instead of improvising an equivalent. Never hand-write Office file bytes. If the skill is unavailable, say so rather than silently degrading the deliverable."
        }
        SceneId::Code => {
            "Scene toolchain: use the platform's own shell, file editing and execution tools directly; this scene has no separate skill to load. Before changing anything, read the repository's rules files (`AGENTS.md` and any nested ones covering the code you touch) and the neighbouring implementation of the same kind, and derive build/test/lint commands from the actual manifests rather than assuming them. Verification is not optional: run format, then lint, then the narrowest relevant test target, and widen only if you touched shared code. Never weaken a test or add a lint suppression to make a check pass, and never imply a command ran when it did not — name what you could not verify instead."
        }
        SceneId::Design => {
            "Scene toolchain: the `design-studio` skill owns rendering HTML design artifacts to images and auditing them. Load it before producing a visual deliverable and use its scripts for preview evidence. Its accessibility and contrast audit is a delivery gate, not an optional extra: run it on every artifact you produce and resolve what it reports before presenting the result, or state plainly why a finding is a false positive."
        }
    }
}

#[cfg(test)]
#[path = "skill_hints_tests.rs"]
mod tests;
