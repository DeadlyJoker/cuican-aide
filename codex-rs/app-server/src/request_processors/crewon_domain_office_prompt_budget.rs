const TRUNCATION_MARKER: &str = "\n…[bounded Office context truncated]…\n";

pub(super) fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    if max_bytes <= TRUNCATION_MARKER.len() {
        return value[..floor_char_boundary(value, max_bytes)].to_string();
    }
    let content_bytes = max_bytes - TRUNCATION_MARKER.len();
    let end = floor_char_boundary(value, content_bytes);
    format!("{}{}", &value[..end], TRUNCATION_MARKER)
}

pub(super) fn truncate_middle_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    if max_bytes <= TRUNCATION_MARKER.len() {
        return value[..floor_char_boundary(value, max_bytes)].to_string();
    }
    let content_bytes = max_bytes - TRUNCATION_MARKER.len();
    let head_budget = content_bytes.saturating_mul(/*rhs*/ 2) / 3;
    let tail_budget = content_bytes - head_budget;
    let head_end = floor_char_boundary(value, head_budget);
    let tail_start = ceil_char_boundary(value, value.len().saturating_sub(tail_budget));
    format!(
        "{}{}{}",
        &value[..head_end],
        TRUNCATION_MARKER,
        &value[tail_start..]
    )
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while !value.is_char_boundary(index) {
        index = index.saturating_sub(/*rhs*/ 1);
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while !value.is_char_boundary(index) {
        index = index.saturating_add(/*rhs*/ 1);
    }
    index
}

#[cfg(test)]
#[path = "crewon_domain_office_prompt_budget_tests.rs"]
mod tests;
