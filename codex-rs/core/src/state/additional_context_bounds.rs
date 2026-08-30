use std::collections::BTreeMap;

use crewon_protocol::protocol::AdditionalContextEntry;

pub(super) const MAX_INCOMING_ENTRIES: usize = 32;
pub(super) const MAX_STORED_ENTRIES: usize = 64;
pub(super) const MAX_COMPACTION_REPLAY_ENTRIES: usize = 32;
pub(super) const MAX_KEY_BYTES_PER_ENTRY: usize = 128;
pub(super) const MAX_KEY_BYTES_TOTAL: usize = 2 * 1024;
// This cap leaves enough room for the longest supported 128-byte key and the complete context
// envelope while keeping every rendered fragment below the context-fragments 1,000-byte ceiling.
pub(super) const MAX_VALUE_BYTES_PER_ENTRY: usize = 704;
pub(super) const MAX_VALUE_BYTES_TOTAL: usize = 12 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct BoundingStats {
    pub(super) dropped_entries: usize,
    pub(super) truncated_values: usize,
}

impl BoundingStats {
    pub(super) fn changed(self) -> bool {
        self.dropped_entries > 0 || self.truncated_values > 0
    }
}

pub(super) fn bound_values(
    values: BTreeMap<String, AdditionalContextEntry>,
    max_entries: usize,
    priority: impl Fn(&str, &AdditionalContextEntry) -> u8,
) -> (BTreeMap<String, AdditionalContextEntry>, BoundingStats) {
    let mut candidates = values.into_iter().collect::<Vec<_>>();
    candidates.sort_by_key(|(key, entry)| (priority(key, entry), key.clone()));
    let mut stats = BoundingStats::default();
    let mut selected = Vec::new();
    let mut remaining_key_bytes = MAX_KEY_BYTES_TOTAL;
    for (key, entry) in candidates {
        let entry_priority = priority(&key, &entry);
        if selected.len() >= max_entries
            || key.len() > MAX_KEY_BYTES_PER_ENTRY
            || key.len() > remaining_key_bytes
        {
            stats.dropped_entries = stats.dropped_entries.saturating_add(1);
            continue;
        }
        remaining_key_bytes = remaining_key_bytes.saturating_sub(key.len());
        selected.push((entry_priority, key, entry));
    }

    let mut bounded = BTreeMap::new();
    let mut remaining_value_bytes = MAX_VALUE_BYTES_TOTAL;
    let mut group_start = 0usize;
    while group_start < selected.len() {
        let group_priority = selected[group_start].0;
        let group_end = selected[group_start..]
            .iter()
            .position(|(candidate_priority, _, _)| *candidate_priority != group_priority)
            .map_or(selected.len(), |offset| group_start + offset);
        for (group_index, (_, key, entry)) in selected[group_start..group_end].iter().enumerate() {
            let remaining_group_entries =
                group_end.saturating_sub(group_start + group_index).max(1);
            let value_budget =
                (remaining_value_bytes / remaining_group_entries).min(MAX_VALUE_BYTES_PER_ENTRY);
            let value = truncate_middle_utf8_bytes(&entry.value, value_budget);
            stats.truncated_values = stats
                .truncated_values
                .saturating_add(usize::from(value != entry.value));
            remaining_value_bytes = remaining_value_bytes.saturating_sub(value.len());
            bounded.insert(
                key.clone(),
                AdditionalContextEntry {
                    value,
                    kind: entry.kind,
                },
            );
        }
        group_start = group_end;
    }
    (bounded, stats)
}

fn truncate_middle_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    if max_bytes == 0 {
        return String::new();
    }
    const MARKER: &str = "…";
    if max_bytes <= MARKER.len() {
        return value
            .chars()
            .scan(0usize, |used, ch| {
                let next = used.saturating_add(ch.len_utf8());
                (next <= max_bytes).then(|| {
                    *used = next;
                    ch
                })
            })
            .collect();
    }

    let content_budget = max_bytes - MARKER.len();
    let head_budget = content_budget / 2;
    let tail_budget = content_budget - head_budget;
    let mut head_end = 0usize;
    for (index, ch) in value.char_indices() {
        let end = index + ch.len_utf8();
        if end > head_budget {
            break;
        }
        head_end = end;
    }
    let mut tail_start = value.len();
    let mut tail_bytes = 0usize;
    for (index, ch) in value.char_indices().rev() {
        let next = tail_bytes.saturating_add(ch.len_utf8());
        if next > tail_budget || index < head_end {
            break;
        }
        tail_start = index;
        tail_bytes = next;
    }
    format!("{}{}{}", &value[..head_end], MARKER, &value[tail_start..])
}
