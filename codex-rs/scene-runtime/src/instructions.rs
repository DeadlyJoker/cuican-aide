use crewon_protocol::scene::ExternalActionPolicy;
use crewon_protocol::scene::LocalWritePolicy;
use crewon_protocol::scene::SceneExecutionStrategy;
use crewon_protocol::scene::SceneId;
use crewon_protocol::scene::SceneInteractionMode;
use crewon_protocol::scene::SceneThreadMetadata;

use crate::scene_skill_instructions;

pub fn render_scene_instructions(metadata: &SceneThreadMetadata) -> String {
    let strategy = match metadata.execution_strategy {
        SceneExecutionStrategy::Single => {
            "Complete the task as the only execution agent. Do not create, delegate to, message, list, or interrupt sub-agents."
        }
        SceneExecutionStrategy::Team => {
            "You are the lead agent for the server-resolved team. Delegate only bounded, concrete work through the available team tools, retain approval and cancellation control, and consolidate the final result."
        }
    };
    let local_write = match metadata.contract.local_write_policy {
        LocalWritePolicy::ReadOnly => {
            "This task is read-only. Do not modify the local workspace or external resources."
        }
        LocalWritePolicy::WorkspaceWrite => {
            "Local workspace writes are allowed when they directly advance the requested deliverable. Preserve unrelated user changes."
        }
    };
    let external_action = match metadata.contract.external_action_policy {
        ExternalActionPolicy::DraftOnly => {
            "External actions are draft-only: do not send, publish, push, share, schedule, or mutate connected services."
        }
        ExternalActionPolicy::ConfirmEach => {
            "Each external send, publish, push, share, scheduling action, or connected-service mutation requires runtime confirmation."
        }
    };

    format!(
        "Scene runtime contract (server resolved, version {}).\n{}\n{}\n{}\n{}\n{}\n{}\nFinish by stating what was completed, where artifacts are located, what was verified, and which actions remain unperformed or require confirmation.",
        metadata.version,
        strategy,
        local_write,
        external_action,
        scene_instructions(metadata.contract.scene),
        mode_instructions(metadata.contract.mode),
        scene_skill_instructions(metadata.contract.scene),
    )
}

fn scene_instructions(scene: SceneId) -> &'static str {
    match scene {
        SceneId::Office => {
            "Office scene: turn information into ready-to-use documents, tables, action lists, message drafts, or knowledge entries. Separate sourced facts from assumptions, make ownership and dates explicit, and optimize for immediate workplace use."
        }
        SceneId::Code => {
            "Code scene: inspect repository evidence and project rules before conclusions. Keep scope explicit, preserve user changes, and report concrete validation evidence for any implementation."
        }
        SceneId::Design => {
            "Design scene: reason in visual directions, states, systems, and handoff quality. Reuse established design systems when available, provide inspectable previews or findings, and cover accessibility and edge states where applicable."
        }
    }
}

fn mode_instructions(mode: SceneInteractionMode) -> &'static str {
    match mode {
        SceneInteractionMode::Auto => {
            "Auto mode: infer the requested behavior and deliverable from the user's explicit intent and available context. Act directly when the task is clear, remain read-only for questions, planning, and review, and use permitted workspace writes only when the requested outcome requires an artifact or implementation. Ask only the minimum clarification needed."
        }
        SceneInteractionMode::Organize => {
            "Organize mode: structure inputs, cite their source, and make action ownership explicit."
        }
        SceneInteractionMode::Write => {
            "Write mode: define audience and purpose, ground factual claims, and deliver copy that is ready to use."
        }
        SceneInteractionMode::Analyze => {
            "Analyze mode: explain the method, preserve source traceability, and distinguish evidence, calculations, and conclusions."
        }
        SceneInteractionMode::Coordinate => {
            "Coordinate mode: make owner, timing, external status, and intended target state explicit; draft first and use runtime confirmation for real actions."
        }
        SceneInteractionMode::Ask => {
            "Ask mode: answer from repository evidence without changing the workspace."
        }
        SceneInteractionMode::Plan => {
            "Plan mode: produce a scoped implementation plan with validation steps, dependencies, risks, and no workspace changes."
        }
        SceneInteractionMode::Implement => {
            "Implement mode: follow repository rules, make the smallest coherent code change, inspect the resulting diff, and run proportionate validation."
        }
        SceneInteractionMode::Review => {
            "Review mode: remain read-only, prioritize actionable findings, and cite exact evidence; do not implement fixes unless a new implementation task is requested."
        }
        SceneInteractionMode::Explore => {
            "Explore mode: produce meaningfully different visual directions, explain fit and tradeoffs, and label assumptions."
        }
        SceneInteractionMode::Refine => {
            "Refine mode: improve an existing direction while reusing the design system, covering relevant states, and producing an inspectable preview."
        }
        SceneInteractionMode::Produce => {
            "Produce mode: create a delivery-ready design artifact or handoff specification with states, accessibility, and preview evidence."
        }
        SceneInteractionMode::Inspect => {
            "Inspect mode: remain read-only and report prioritized design findings with state coverage and concrete evidence."
        }
    }
}

#[cfg(test)]
#[path = "instructions_tests.rs"]
mod tests;
