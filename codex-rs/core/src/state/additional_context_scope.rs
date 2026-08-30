use std::collections::BTreeMap;
use std::collections::BTreeSet;

use crewon_protocol::protocol::AdditionalContextEntry;
use crewon_protocol::protocol::AdditionalContextKind;

const SCOPED_CONTEXT_KEY_PREFIX: &str = "scope__";
const SCOPED_CONTEXT_KEY_SEPARATOR: &str = "__";
const SCOPED_CONTEXT_STATE_NAME: &str = "crewon_scope_state";
pub(super) const ACTIVE_SCOPE_STATE: &str =
    "[active scope snapshot; this snapshot supersedes earlier values from the same scope]";
pub(super) const CLEARED_SCOPE_STATE: &str =
    "[cleared scope; ignore all earlier values from the same scope]";
pub(super) const CLEARED_CONTEXT_VALUE: &str = "[cleared]";
pub(super) const COMPACTION_NOTICE_KEY: &str = "crewon_additional_context_compaction";

pub(super) fn incoming_priority(key: &str, _entry: &AdditionalContextEntry) -> u8 {
    u8::from(scoped_context_owner(key).is_none())
}

pub(super) fn store_priority(
    key: &str,
    entry: &AdditionalContextEntry,
    active_scoped_owners: &BTreeSet<String>,
) -> u8 {
    match scoped_context_owner(key) {
        Some(owner) if active_scoped_owners.contains(owner) && is_scope_state_key(key) => 0,
        Some(owner) if active_scoped_owners.contains(owner) => 1,
        Some(_) if is_scope_state_key(key) => 2,
        None if entry.value != CLEARED_CONTEXT_VALUE => 3,
        Some(_) => 4,
        None => 5,
    }
}

pub(super) fn fragment_priority(
    key: &str,
    entry: &AdditionalContextEntry,
    active_scoped_owners: &BTreeSet<String>,
) -> (u8, String) {
    let priority = match scoped_context_owner(key) {
        Some(owner) if !active_scoped_owners.contains(owner) && is_scope_state_key(key) => 0,
        None if entry.value == CLEARED_CONTEXT_VALUE => 1,
        None => 2,
        Some(owner) if active_scoped_owners.contains(owner) && !is_scope_state_key(key) => 3,
        Some(owner) if active_scoped_owners.contains(owner) => 4,
        Some(_) => 5,
    };
    (priority, key.to_string())
}

pub(super) fn scoped_context_owner(key: &str) -> Option<&str> {
    let scoped_key = key.strip_prefix(SCOPED_CONTEXT_KEY_PREFIX)?;
    let (owner, _) = scoped_key.split_once(SCOPED_CONTEXT_KEY_SEPARATOR)?;
    (!owner.is_empty()).then_some(owner)
}

fn scoped_context_name(key: &str) -> Option<&str> {
    let scoped_key = key.strip_prefix(SCOPED_CONTEXT_KEY_PREFIX)?;
    let (_, name) = scoped_key.split_once(SCOPED_CONTEXT_KEY_SEPARATOR)?;
    Some(name)
}

pub(super) fn is_scope_state_key(key: &str) -> bool {
    scoped_context_name(key) == Some(SCOPED_CONTEXT_STATE_NAME)
}

pub(super) fn scope_state_key(owner: &str) -> String {
    format!(
        "{SCOPED_CONTEXT_KEY_PREFIX}{owner}{SCOPED_CONTEXT_KEY_SEPARATOR}{SCOPED_CONTEXT_STATE_NAME}"
    )
}

pub(super) fn scope_state_entry(
    value: &str,
    kind: AdditionalContextKind,
) -> AdditionalContextEntry {
    AdditionalContextEntry {
        value: value.to_string(),
        kind,
    }
}

pub(super) fn scoped_owner_kind(
    values: &BTreeMap<String, AdditionalContextEntry>,
    owner: &str,
) -> AdditionalContextKind {
    if values.iter().any(|(key, entry)| {
        scoped_context_owner(key) == Some(owner) && entry.kind == AdditionalContextKind::Application
    }) {
        AdditionalContextKind::Application
    } else {
        AdditionalContextKind::Untrusted
    }
}

pub(super) fn has_scoped_owner_payload(
    values: &BTreeMap<String, AdditionalContextEntry>,
    owner: &str,
) -> bool {
    values
        .keys()
        .any(|key| scoped_context_owner(key) == Some(owner) && !is_scope_state_key(key))
}

pub(super) fn scoped_owner_snapshot(
    values: &BTreeMap<String, AdditionalContextEntry>,
    owner: &str,
) -> BTreeMap<String, AdditionalContextEntry> {
    values
        .iter()
        .filter(|(key, _)| scoped_context_owner(key) == Some(owner) && !is_scope_state_key(key))
        .map(|(key, entry)| (key.clone(), entry.clone()))
        .collect()
}

pub(super) fn remove_scoped_owner_values(
    values: &mut BTreeMap<String, AdditionalContextEntry>,
    owner: &str,
) {
    values.retain(|key, _| scoped_context_owner(key) != Some(owner));
}
