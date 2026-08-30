use serde_json::Value as JsonValue;

const MAX_AGENT_PROFILE_CHARS: usize = 640;
const MAX_AGENT_PROFILE_FIELD_CHARS: usize = 240;
const MAX_AGENT_PROFILE_LIST_ITEMS: usize = 8;

pub(super) fn agent_profile_summary(agent_config: &JsonValue) -> Option<String> {
    let mut parts = Vec::new();
    for (label, keys) in [
        ("role", &["role", "persona", "specialty"][..]),
        (
            "instructions",
            &[
                "instructions",
                "systemPrompt",
                "prompt",
                "developerInstructions",
                "description",
            ][..],
        ),
        ("policy", &["policy", "guardrails", "constraints"][..]),
    ] {
        if let Some(value) = keys
            .iter()
            .filter_map(|key| agent_config.get(*key))
            .find_map(profile_text)
        {
            parts.push(format!("{label}={value}"));
        }
    }
    for (label, keys) in [
        ("skills", &["skills", "capabilities"][..]),
        ("tools", &["tools", "toolIds"][..]),
    ] {
        if let Some(value) = keys
            .iter()
            .filter_map(|key| agent_config.get(*key))
            .find_map(profile_list)
        {
            parts.push(format!("{label}={value}"));
        }
    }
    let profile = parts.join("; ");
    if profile.is_empty() {
        None
    } else {
        Some(truncate_profile(&profile, MAX_AGENT_PROFILE_CHARS))
    }
}

fn profile_text(value: &JsonValue) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_profile(value, MAX_AGENT_PROFILE_FIELD_CHARS))
}

fn profile_list(value: &JsonValue) -> Option<String> {
    let values = value.as_array()?;
    let items = values
        .iter()
        .take(MAX_AGENT_PROFILE_LIST_ITEMS)
        .filter_map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    item.get("name")
                        .or_else(|| item.get("title"))
                        .and_then(JsonValue::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
                .map(|value| truncate_profile(value, MAX_AGENT_PROFILE_FIELD_CHARS))
        })
        .collect::<Vec<_>>();
    (!items.is_empty()).then(|| items.join(", "))
}

fn truncate_profile(value: &str, max_chars: usize) -> String {
    let value = value.trim();
    let mut chars = value.chars();
    let mut truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        truncated.push_str("...");
    }
    truncated
}
