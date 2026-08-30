use crewon_core::context::ContextualUserFragment;
use crewon_core::context::InternalContextSource;
use crewon_core::context::InternalModelContextFragment;
use crewon_protocol::models::ResponseItem;
use crewon_protocol::protocol::ThreadGoal;
use crewon_utils_template::Template;
use std::sync::LazyLock;

const MAX_GOAL_CONTEXT_PROMPT_BYTES: usize = 9_999;
const TRUNCATED_GOAL_OBJECTIVE_NOTICE: &str = "\n[Objective truncated to fit the model-context hard cap. Call get_goal before acting to retrieve the complete objective.]";

static CONTINUATION_PROMPT_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/goals/continuation.md"),
        "goals/continuation.md",
    )
});

static BUDGET_LIMIT_PROMPT_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/goals/budget_limit.md"),
        "goals/budget_limit.md",
    )
});

static OBJECTIVE_UPDATED_PROMPT_TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
    parse_embedded_template(
        include_str!("../templates/goals/objective_updated.md"),
        "goals/objective_updated.md",
    )
});

fn parse_embedded_template(source: &'static str, template_name: &str) -> Template {
    match Template::parse(source) {
        Ok(template) => template,
        Err(err) => panic!("embedded template {template_name} is invalid: {err}"),
    }
}

pub(crate) fn budget_limit_steering_item(goal: &ThreadGoal) -> ResponseItem {
    goal_context_input_item(budget_limit_prompt(goal))
}

pub(crate) fn objective_updated_steering_item(goal: &ThreadGoal) -> ResponseItem {
    goal_context_input_item(objective_updated_prompt(goal))
}

pub(crate) fn continuation_steering_item(goal: &ThreadGoal) -> ResponseItem {
    goal_context_input_item(continuation_prompt(goal))
}

fn goal_context_input_item(prompt: String) -> ResponseItem {
    ContextualUserFragment::into(InternalModelContextFragment::new(
        InternalContextSource::from_static("goal"),
        prompt,
    ))
}

fn continuation_prompt(goal: &ThreadGoal) -> String {
    let tokens_used = goal.tokens_used.to_string();
    let token_budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());
    let remaining_tokens = goal
        .token_budget
        .map(|budget| (budget - goal.tokens_used).max(0).to_string())
        .unwrap_or_else(|| "unbounded".to_string());

    bounded_goal_prompt(&goal.objective, |objective| {
        CONTINUATION_PROMPT_TEMPLATE
            .render([
                ("objective", objective),
                ("tokens_used", tokens_used.as_str()),
                ("token_budget", token_budget.as_str()),
                ("remaining_tokens", remaining_tokens.as_str()),
            ])
            .unwrap_or_else(|err| {
                panic!("embedded goals/continuation.md template failed to render: {err}")
            })
    })
}

fn budget_limit_prompt(goal: &ThreadGoal) -> String {
    let time_used_seconds = goal.time_used_seconds.to_string();
    let tokens_used = goal.tokens_used.to_string();
    let token_budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());

    bounded_goal_prompt(&goal.objective, |objective| {
        BUDGET_LIMIT_PROMPT_TEMPLATE
            .render([
                ("objective", objective),
                ("time_used_seconds", time_used_seconds.as_str()),
                ("tokens_used", tokens_used.as_str()),
                ("token_budget", token_budget.as_str()),
            ])
            .unwrap_or_else(|err| {
                panic!("embedded goals/budget_limit.md template failed to render: {err}")
            })
    })
}

fn objective_updated_prompt(goal: &ThreadGoal) -> String {
    let tokens_used = goal.tokens_used.to_string();
    let (token_budget, remaining_tokens) = match goal.token_budget {
        Some(token_budget) => (
            token_budget.to_string(),
            (token_budget - goal.tokens_used).max(0).to_string(),
        ),
        None => ("none".to_string(), "unknown".to_string()),
    };

    bounded_goal_prompt(&goal.objective, |objective| {
        OBJECTIVE_UPDATED_PROMPT_TEMPLATE
            .render([
                ("objective", objective),
                ("tokens_used", tokens_used.as_str()),
                ("token_budget", token_budget.as_str()),
                ("remaining_tokens", remaining_tokens.as_str()),
            ])
            .unwrap_or_else(|err| {
                panic!("embedded goals/objective_updated.md template failed to render: {err}")
            })
    })
}

fn bounded_goal_prompt(objective: &str, render: impl Fn(&str) -> String) -> String {
    let body_limit = goal_context_body_limit();
    let complete = render(&escape_xml_text(objective));
    if complete.len() <= body_limit {
        return complete;
    }

    let objective_chars = objective.chars().collect::<Vec<_>>();
    let mut lower = 0;
    let mut upper = objective_chars.len();
    while lower < upper {
        let midpoint = lower + (upper - lower).div_ceil(2);
        let prefix = objective_chars[..midpoint].iter().collect::<String>();
        let mut projected = escape_xml_text(&prefix);
        projected.push_str(TRUNCATED_GOAL_OBJECTIVE_NOTICE);
        if render(&projected).len() <= body_limit {
            lower = midpoint;
        } else {
            upper = midpoint - 1;
        }
    }

    let prefix = objective_chars[..lower].iter().collect::<String>();
    let mut projected = escape_xml_text(&prefix);
    projected.push_str(TRUNCATED_GOAL_OBJECTIVE_NOTICE);
    let bounded = render(&projected);
    assert!(
        bounded.len() <= body_limit,
        "embedded Goal template exceeds the model-context hard cap"
    );
    bounded
}

fn goal_context_body_limit() -> usize {
    let wrapper_bytes = InternalModelContextFragment::new(
        InternalContextSource::from_static("goal"),
        String::new(),
    )
    .render()
    .len();
    assert!(
        wrapper_bytes <= MAX_GOAL_CONTEXT_PROMPT_BYTES,
        "Goal context wrapper exceeds the model-context hard cap"
    );
    MAX_GOAL_CONTEXT_PROMPT_BYTES - wrapper_bytes
}

fn escape_xml_text(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
