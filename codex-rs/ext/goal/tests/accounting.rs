#![allow(dead_code)]

#[path = "../src/accounting.rs"]
mod accounting;

use accounting::GoalAccountingState;
use crewon_protocol::config_types::ModeKind;
use crewon_protocol::protocol::TokenUsage;
use pretty_assertions::assert_eq;
use serde_json::Value;

const GOAL_RUNTIME_REFERENCE: &str = include_str!(
    "../../../../packages/test-contracts/fixtures/goal-runtime-semantics.reference.json"
);

#[test]
fn goal_accounting_uses_turn_start_baseline_for_exact_deltas() {
    let state = GoalAccountingState::default();
    state.start_turn(
        "turn-1",
        ModeKind::Default,
        &token_usage(
            /*input_tokens*/ 100, /*cached_input_tokens*/ 10, /*output_tokens*/ 30,
            /*reasoning_output_tokens*/ 5, /*total_tokens*/ 135,
        ),
    );

    let recorded = state
        .record_token_usage(
            "turn-1",
            &token_usage(
                /*input_tokens*/ 120, /*cached_input_tokens*/ 14,
                /*output_tokens*/ 42, /*reasoning_output_tokens*/ 8,
                /*total_tokens*/ 162,
            ),
        )
        .expect("token delta should be recorded");

    assert_eq!(28, recorded.turn_delta);
    assert_eq!(28, recorded.thread_unflushed_delta);
}

#[test]
fn goal_accounting_ignores_plan_mode_turns() {
    let state = GoalAccountingState::default();
    state.start_turn("turn-1", ModeKind::Plan, &TokenUsage::default());

    let recorded = state.record_token_usage(
        "turn-1",
        &token_usage(
            /*input_tokens*/ 20, /*cached_input_tokens*/ 5, /*output_tokens*/ 8,
            /*reasoning_output_tokens*/ 2, /*total_tokens*/ 30,
        ),
    );

    assert_eq!(None, recorded);
}

#[test]
fn first_budget_crossing_reports_steering_at_most_once_per_goal() {
    let reference: Value =
        serde_json::from_str(GOAL_RUNTIME_REFERENCE).expect("parse Goal runtime reference");
    let budget_case = reference
        .pointer("/toolBoundaryCases")
        .and_then(Value::as_array)
        .and_then(|cases| {
            cases.iter().find(|case| {
                case.pointer("/id").and_then(Value::as_str) == Some("first-budget-crossing")
            })
        })
        .expect("budget Tool boundary reference");
    assert_eq!(
        budget_case
            .pointer("/budgetSteering/required")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        budget_case
            .pointer("/budgetSteering/atMostOncePerGoal")
            .and_then(Value::as_bool),
        Some(true)
    );

    let accounting = GoalAccountingState::default();
    assert!(accounting.mark_budget_limit_reported_if_new("goal-reference"));
    assert!(!accounting.mark_budget_limit_reported_if_new("goal-reference"));
}

fn token_usage(
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
    reasoning_output_tokens: i64,
    total_tokens: i64,
) -> TokenUsage {
    TokenUsage {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
    }
}
