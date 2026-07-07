use serde_json::Value as JsonValue;

const MAX_CONTEXT_LINES: usize = 14;
const MAX_CONTEXT_TEXT_CHARS: usize = 180;
const MAX_SIGNAL_ITEMS: usize = 3;
const MAX_RECENT_MESSAGES: usize = 4;

enum OfficeMemberContextPolicy {
    Isolated,
    SharedDigest,
    ForkLastN,
}

pub(super) fn member_shared_context(
    config: &JsonValue,
    run_id: &str,
    context_policy: &str,
    is_zh: bool,
) -> String {
    match context_policy_kind(context_policy) {
        OfficeMemberContextPolicy::Isolated => {
            if is_zh {
                "共享办公室上下文：已按 contextPolicy=isolated 省略；只使用派发任务、成员线程历史和允许的长期记忆。".to_string()
            } else {
                "Shared Office context: omitted by contextPolicy=isolated; use only the delegated task, this member thread history, and allowed long-term memories.".to_string()
            }
        }
        OfficeMemberContextPolicy::SharedDigest | OfficeMemberContextPolicy::ForkLastN => {
            bounded_shared_digest(config, run_id, context_policy, is_zh)
        }
    }
}

fn context_policy_kind(context_policy: &str) -> OfficeMemberContextPolicy {
    let normalized = context_policy
        .trim()
        .chars()
        .filter(|ch| *ch != '-' && *ch != '_')
        .flat_map(char::to_lowercase)
        .collect::<String>();
    match normalized.as_str() {
        "isolated" | "private" | "privateonly" | "minimal" | "none" => {
            OfficeMemberContextPolicy::Isolated
        }
        "forklastn" | "forklast" => OfficeMemberContextPolicy::ForkLastN,
        _ => OfficeMemberContextPolicy::SharedDigest,
    }
}

fn bounded_shared_digest(
    config: &JsonValue,
    run_id: &str,
    context_policy: &str,
    is_zh: bool,
) -> String {
    let mut lines = Vec::new();
    let Some(run) = run_by_id(config, run_id) else {
        return if is_zh {
            format!(
                "共享办公室摘要（contextPolicy={}）：暂无匹配 run；只使用派发任务和允许的长期记忆。",
                truncate_chars(context_policy, MAX_CONTEXT_TEXT_CHARS)
            )
        } else {
            format!(
                "Shared Office digest (contextPolicy={}): no matching run is available; use the delegated task and allowed long-term memories.",
                truncate_chars(context_policy, MAX_CONTEXT_TEXT_CHARS)
            )
        };
    };

    push_run_summary(&mut lines, run, is_zh);
    push_plan_lines(&mut lines, run, is_zh);
    push_signal_lines(
        &mut lines,
        run,
        "acceptanceCriteria",
        if is_zh {
            "验收差距"
        } else {
            "Acceptance gap"
        },
        "criterion",
        is_not_passed,
    );
    push_signal_lines(
        &mut lines,
        run,
        "verificationChecks",
        if is_zh {
            "验证检查"
        } else {
            "Verification check"
        },
        "check",
        is_not_passed,
    );
    push_signal_lines(
        &mut lines,
        run,
        "evidence",
        if is_zh { "证据" } else { "Evidence" },
        "summary",
        |item| item.get("status").and_then(JsonValue::as_str) != Some("verified"),
    );
    push_signal_lines(
        &mut lines,
        run,
        "risks",
        if is_zh { "风险" } else { "Risk" },
        "summary",
        |item| {
            item.get("severity").and_then(JsonValue::as_str) == Some("high")
                && item
                    .get("mitigation")
                    .and_then(JsonValue::as_str)
                    .is_none_or(|mitigation| mitigation.trim().is_empty())
        },
    );
    push_signal_lines(
        &mut lines,
        run,
        "delegations",
        if is_zh { "委派" } else { "Delegation" },
        "task",
        |item| {
            matches!(
                item.get("status").and_then(JsonValue::as_str),
                Some("queued" | "running" | "failed" | "interrupted" | "blocked")
            )
        },
    );

    if matches!(
        context_policy_kind(context_policy),
        OfficeMemberContextPolicy::ForkLastN
    ) {
        push_recent_messages(&mut lines, config, is_zh);
    }

    if lines.is_empty() {
        lines.push(if is_zh {
            "没有可共享的 run 摘要；不要假设未提供的上下文。".to_string()
        } else {
            "No shared run digest is available; do not assume omitted context.".to_string()
        });
    }
    lines.truncate(MAX_CONTEXT_LINES);
    let heading = if is_zh {
        format!(
            "共享办公室摘要（有界，contextPolicy={}；不复制成员私有 transcript）：",
            truncate_chars(context_policy, MAX_CONTEXT_TEXT_CHARS)
        )
    } else {
        format!(
            "Shared Office digest (bounded, contextPolicy={}; private member transcripts omitted):",
            truncate_chars(context_policy, MAX_CONTEXT_TEXT_CHARS)
        )
    };
    format!("{heading}\n{}", lines.join("\n"))
}

fn run_by_id<'a>(config: &'a JsonValue, run_id: &str) -> Option<&'a JsonValue> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)?
        .iter()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(run_id))
}

fn push_run_summary(lines: &mut Vec<String>, run: &JsonValue, is_zh: bool) {
    let title = run.get("title").and_then(JsonValue::as_str);
    let status = run.get("status").and_then(JsonValue::as_str);
    let loop_status = run
        .get("loop")
        .and_then(|loop_value| loop_value.get("status"))
        .and_then(JsonValue::as_str);
    let review_action = run
        .get("loop")
        .and_then(|loop_value| loop_value.get("review"))
        .and_then(|review| review.get("nextAction"))
        .and_then(JsonValue::as_str);
    let parts = [
        title.map(|value| truncate_chars(value, MAX_CONTEXT_TEXT_CHARS)),
        status.map(|value| format!("status={value}")),
        loop_status.map(|value| format!("loop={value}")),
        review_action.map(|value| format!("next={value}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if !parts.is_empty() {
        lines.push(format!(
            "- {}: {}",
            if is_zh { "运行" } else { "Run" },
            parts.join("; ")
        ));
    }
}

fn push_plan_lines(lines: &mut Vec<String>, run: &JsonValue, is_zh: bool) {
    let Some(plan) = run.get("plan").and_then(JsonValue::as_array) else {
        return;
    };
    for item in plan
        .iter()
        .filter(|item| item.get("status").and_then(JsonValue::as_str) != Some("completed"))
        .take(MAX_SIGNAL_ITEMS)
    {
        let Some(step) = item.get("step").and_then(JsonValue::as_str) else {
            continue;
        };
        let status = item
            .get("status")
            .and_then(JsonValue::as_str)
            .unwrap_or("pending");
        lines.push(format!(
            "- {}: [{}] {}",
            if is_zh { "计划" } else { "Plan" },
            status,
            truncate_chars(step, MAX_CONTEXT_TEXT_CHARS)
        ));
    }
}

fn push_signal_lines(
    lines: &mut Vec<String>,
    run: &JsonValue,
    array_key: &str,
    label: &str,
    text_key: &str,
    keep: impl Fn(&JsonValue) -> bool,
) {
    let Some(items) = run.get(array_key).and_then(JsonValue::as_array) else {
        return;
    };
    for item in items
        .iter()
        .filter(|item| keep(item))
        .take(MAX_SIGNAL_ITEMS)
    {
        let Some(text) = item.get(text_key).and_then(JsonValue::as_str) else {
            continue;
        };
        let details = [
            item.get("status").and_then(JsonValue::as_str),
            item.get("severity").and_then(JsonValue::as_str),
            item.get("member").and_then(JsonValue::as_str),
            item.get("agentId").and_then(JsonValue::as_str),
            item.get("evidence").and_then(JsonValue::as_str),
            item.get("command").and_then(JsonValue::as_str),
        ]
        .into_iter()
        .flatten()
        .filter(|detail| !detail.trim().is_empty())
        .map(|detail| truncate_chars(detail, MAX_CONTEXT_TEXT_CHARS))
        .collect::<Vec<_>>();
        let suffix = if details.is_empty() {
            String::new()
        } else {
            format!(" ({})", details.join("; "))
        };
        lines.push(format!(
            "- {label}: {}{suffix}",
            truncate_chars(text, MAX_CONTEXT_TEXT_CHARS)
        ));
    }
}

fn push_recent_messages(lines: &mut Vec<String>, config: &JsonValue, is_zh: bool) {
    let Some(messages) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("messages"))
        .and_then(JsonValue::as_array)
    else {
        return;
    };
    let mut recent = messages
        .iter()
        .rev()
        .filter_map(|message| {
            let text = message.get("text").and_then(JsonValue::as_str)?;
            let author = message
                .get("author")
                .and_then(JsonValue::as_str)
                .unwrap_or("Office");
            Some(format!(
                "- {}: {}: {}",
                if is_zh {
                    "最近消息"
                } else {
                    "Recent message"
                },
                truncate_chars(author, 40),
                truncate_chars(text, MAX_CONTEXT_TEXT_CHARS)
            ))
        })
        .take(MAX_RECENT_MESSAGES)
        .collect::<Vec<_>>();
    recent.reverse();
    lines.extend(recent);
}

fn is_not_passed(item: &JsonValue) -> bool {
    item.get("status").and_then(JsonValue::as_str) != Some("passed")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    let mut chars = value.chars();
    let mut truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}
