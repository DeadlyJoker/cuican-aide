#![allow(dead_code)]

#[path = "../src/steering.rs"]
mod steering;

use crewon_protocol::ThreadId;
use crewon_protocol::protocol::ThreadGoal;
use crewon_protocol::protocol::ThreadGoalStatus;
use pretty_assertions::assert_eq;
use serde_json::Value;

const REFERENCE: &str =
    include_str!("../../../../packages/test-contracts/fixtures/goal-continuation.reference.json");

#[test]
fn continuation_prompt_matches_shared_typescript_semantics_reference() {
    let reference: Value = serde_json::from_str(REFERENCE).expect("parse Goal reference fixture");
    assert_eq!(
        reference_string(&reference, "/schemaVersion"),
        "crewon.goal-continuation-reference.v0"
    );

    let goal = ThreadGoal {
        thread_id: ThreadId::from_string("11111111-1111-4111-8111-111111111111")
            .expect("parse fixed thread id"),
        objective: reference_string(&reference, "/goal/objective").to_string(),
        status: ThreadGoalStatus::Active,
        token_budget: Some(reference_i64(&reference, "/goal/tokenBudget")),
        tokens_used: reference_i64(&reference, "/goal/tokensUsed"),
        time_used_seconds: reference_i64(&reference, "/goal/timeUsedSeconds"),
        created_at: 0,
        updated_at: 0,
    };
    let rendered = serde_json::to_value(steering::continuation_steering_item(&goal))
        .expect("serialize continuation steering item");
    let prompt = reference_string(&rendered, "/content/0/text");
    let max_utf8_bytes = reference_u64(&reference, "/maxUtf8Bytes") as usize;
    assert!(
        prompt.len() <= max_utf8_bytes,
        "prompt used {} bytes, hard cap is {max_utf8_bytes}",
        prompt.len()
    );

    for semantic in reference_array(&reference, "/requiredSemantics") {
        let semantic_id = reference_string(semantic, "/id");
        for fragment in reference_array(semantic, "/fragments") {
            let fragment = fragment.as_str().expect("semantic fragment is a string");
            assert!(
                prompt.contains(fragment),
                "missing {semantic_id} fragment: {fragment}"
            );
        }
    }
    for fragment in reference_array(&reference, "/requiredEscapedFragments") {
        let fragment = fragment.as_str().expect("escaped fragment is a string");
        assert!(
            prompt.contains(fragment),
            "missing escaped fragment: {fragment}"
        );
    }
    for fragment in reference_array(&reference, "/forbiddenFragments") {
        let fragment = fragment.as_str().expect("forbidden fragment is a string");
        assert!(
            !prompt.contains(fragment),
            "unsafe raw fragment rendered: {fragment}"
        );
    }
}

#[test]
fn all_goal_context_prompts_bound_worst_case_objectives() {
    let active_goal = ThreadGoal {
        thread_id: ThreadId::from_string("11111111-1111-4111-8111-111111111111")
            .expect("parse fixed thread id"),
        objective: "😀&".repeat(2_000),
        status: ThreadGoalStatus::Active,
        token_budget: Some(100_000),
        tokens_used: 123,
        time_used_seconds: 45,
        created_at: 0,
        updated_at: 0,
    };
    let mut budget_limited_goal = active_goal.clone();
    budget_limited_goal.status = ThreadGoalStatus::BudgetLimited;

    let prompts = [
        steering::continuation_steering_item(&active_goal),
        steering::objective_updated_steering_item(&active_goal),
        steering::budget_limit_steering_item(&budget_limited_goal),
    ]
    .map(|item| {
        let rendered = serde_json::to_value(item).expect("serialize Goal context item");
        reference_string(&rendered, "/content/0/text").to_string()
    });

    for prompt in prompts {
        let used_bytes = prompt.len();
        assert!(
            used_bytes <= 9_999,
            "Goal context item used {used_bytes} bytes"
        );
        assert!(prompt.contains("Objective truncated to fit the model-context hard cap"));
        assert!(prompt.contains("Call get_goal before acting"));
        assert!(prompt.contains("&amp;"));
    }
}

fn reference_string<'a>(reference: &'a Value, pointer: &str) -> &'a str {
    reference
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("reference string missing at {pointer}"))
}

fn reference_i64(reference: &Value, pointer: &str) -> i64 {
    reference
        .pointer(pointer)
        .and_then(Value::as_i64)
        .unwrap_or_else(|| panic!("reference integer missing at {pointer}"))
}

fn reference_u64(reference: &Value, pointer: &str) -> u64 {
    reference
        .pointer(pointer)
        .and_then(Value::as_u64)
        .unwrap_or_else(|| panic!("reference unsigned integer missing at {pointer}"))
}

fn reference_array<'a>(reference: &'a Value, pointer: &str) -> &'a [Value] {
    reference
        .pointer(pointer)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_else(|| panic!("reference array missing at {pointer}"))
}
