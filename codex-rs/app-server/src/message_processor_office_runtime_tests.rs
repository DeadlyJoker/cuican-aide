use serde_json::json;

use super::OFFICE_RUNTIME_REPAIR_MAX_INSTRUCTIONS_CHARS;
use super::office_agent_runtime_developer_instructions;

#[test]
fn office_runtime_repair_instructions_are_bounded() {
    let config = json!({
        "instructions": "x".repeat(20_000),
        "developerInstructions": "y".repeat(20_000),
        "role": "z".repeat(20_000),
    });

    let instructions = office_agent_runtime_developer_instructions(
        &config,
        &"Member ".repeat(1_000),
        &"agent-".repeat(1_000),
    )
    .expect("runtime instructions should be generated");

    assert!(
        instructions.chars().count() <= OFFICE_RUNTIME_REPAIR_MAX_INSTRUCTIONS_CHARS,
        "runtime repair instructions exceeded bounded context budget: {} chars",
        instructions.chars().count()
    );
    assert!(instructions.contains("durable runtime thread"));
    assert!(instructions.contains("truncated"));
}
