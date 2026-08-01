use std::collections::HashMap;

#[cfg(test)]
use super::user_input_once_durable::DurableAdmissionMatch;
#[cfg(test)]
use super::user_input_once_durable::DurableExecutionFenceMatch;
#[cfg(test)]
use super::user_input_once_durable::classify_durable_admission;
#[cfg(test)]
use super::user_input_once_durable::classify_durable_execution_fence;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::InitialHistory;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::UserInputOnceMarker;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
const LEGACY_MARKER_VERSION: u8 = 1;
pub(super) const MARKER_VERSION: u8 = 2;
pub(super) const EXECUTION_FENCE_VERSION: u8 = 2;
const MAX_CLIENT_ID_BYTES: usize = 256;
const MAX_TURN_ID_BYTES: usize = 256;
const PAYLOAD_HASH_BYTES: usize = 64;
const MAX_ENTRIES: usize = 4096;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserInputOnceState {
    Persisted,
    AdmissionOnly,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserInputOnceExecutionState {
    LegacyUnknown,
    NotStarted,
    Started,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UserInputOnceReceipt {
    pub(crate) turn_id: String,
    pub(crate) state: UserInputOnceState,
    pub(crate) execution_state: UserInputOnceExecutionState,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum UserInputOnceLookupError {
    Legacy,
    Conflict { turn_id: String },
}
enum Entry {
    Legacy,
    Marked {
        marker: UserInputOnceMarker,
        persisted: bool,
        execution_fenced: bool,
        execution_ambiguous: bool,
    },
}
#[derive(Default)]
pub(crate) struct UserInputOnceIndex {
    entries: HashMap<String, Entry>,
    overflowed: bool,
}
impl UserInputOnceIndex {
    pub(crate) fn from_history(history: &InitialHistory, thread_id: ThreadId) -> Self {
        let (items, inherit_markers) = match history {
            InitialHistory::Resumed(resumed) => (resumed.history.as_slice(), true),
            InitialHistory::Forked(items) => (items.as_slice(), false),
            InitialHistory::New | InitialHistory::Cleared => return Self::default(),
        };
        let mut entries = HashMap::new();
        let mut overflowed = false;
        for item in items {
            match item {
                RolloutItem::UserInputOnceMarker(marker)
                    if inherit_markers
                        && marker.phase == UserInputOnceMarkerPhase::Admission
                        && valid_client_id(&marker.client_id) =>
                {
                    if marker.thread_id != thread_id {
                        insert_history_entry(
                            &mut entries,
                            &mut overflowed,
                            marker.client_id.clone(),
                            Entry::Legacy,
                        );
                        continue;
                    }
                    if valid_marker(marker) {
                        insert_history_entry(
                            &mut entries,
                            &mut overflowed,
                            marker.client_id.clone(),
                            Entry::Marked {
                                marker: marker.clone(),
                                persisted: false,
                                execution_fenced: false,
                                execution_ambiguous: false,
                            },
                        );
                    } else {
                        insert_history_entry(
                            &mut entries,
                            &mut overflowed,
                            marker.client_id.clone(),
                            Entry::Legacy,
                        );
                    }
                }
                RolloutItem::UserInputOnceMarker(fence)
                    if inherit_markers
                        && fence.phase == UserInputOnceMarkerPhase::ExecutionFence
                        && valid_client_id(&fence.client_id) =>
                {
                    if fence.thread_id != thread_id {
                        insert_history_entry(
                            &mut entries,
                            &mut overflowed,
                            fence.client_id.clone(),
                            Entry::Legacy,
                        );
                        continue;
                    }
                    match entries.get_mut(&fence.client_id) {
                        Some(Entry::Marked {
                            marker,
                            execution_fenced,
                            execution_ambiguous,
                            ..
                        }) if valid_execution_fence(fence)
                            && marker.version == MARKER_VERSION
                            && marker.thread_id == fence.thread_id
                            && marker.payload_hash == fence.payload_hash
                            && marker.turn_id == fence.turn_id =>
                        {
                            *execution_fenced = true;
                        }
                        Some(Entry::Marked {
                            execution_ambiguous,
                            ..
                        }) => *execution_ambiguous = true,
                        Some(Entry::Legacy) => {}
                        None => {
                            insert_history_entry(
                                &mut entries,
                                &mut overflowed,
                                fence.client_id.clone(),
                                Entry::Legacy,
                            );
                        }
                    }
                }
                RolloutItem::UserInputOnceMarker(marker)
                    if inherit_markers && valid_client_id(&marker.client_id) =>
                {
                    if marker.thread_id != thread_id {
                        insert_history_entry(
                            &mut entries,
                            &mut overflowed,
                            marker.client_id.clone(),
                            Entry::Legacy,
                        );
                        continue;
                    }
                    insert_history_entry(
                        &mut entries,
                        &mut overflowed,
                        marker.client_id.clone(),
                        Entry::Legacy,
                    );
                }
                RolloutItem::EventMsg(EventMsg::UserMessage(event)) => {
                    let Some(client_id) =
                        event.client_id.as_deref().filter(|id| valid_client_id(id))
                    else {
                        continue;
                    };
                    if let Some(Entry::Marked { persisted, .. }) = entries.get_mut(client_id) {
                        *persisted = true;
                    } else {
                        insert_history_entry(
                            &mut entries,
                            &mut overflowed,
                            client_id.to_string(),
                            Entry::Legacy,
                        );
                    }
                }
                _ => {}
            }
        }
        let mut turn_clients = HashMap::<String, Option<String>>::new();
        for (client_id, entry) in &entries {
            let Entry::Marked { marker, .. } = entry else {
                continue;
            };
            turn_clients
                .entry(marker.turn_id.clone())
                .and_modify(|owner| *owner = None)
                .or_insert_with(|| Some(client_id.clone()));
        }
        for entry in entries.values_mut() {
            if let Entry::Marked {
                marker,
                execution_ambiguous,
                ..
            } = entry
                && turn_clients.get(&marker.turn_id) == Some(&None)
            {
                *execution_ambiguous = true;
            }
        }
        for item in items {
            let turn_id = match item {
                RolloutItem::EventMsg(EventMsg::TurnStarted(event)) => Some(event.turn_id.as_str()),
                RolloutItem::EventMsg(EventMsg::TurnComplete(event)) => {
                    Some(event.turn_id.as_str())
                }
                RolloutItem::EventMsg(EventMsg::TurnAborted(event)) => event.turn_id.as_deref(),
                _ => None,
            };
            let Some(client_id) = turn_id
                .and_then(|turn_id| turn_clients.get(turn_id))
                .and_then(Option::as_ref)
            else {
                continue;
            };
            if let Some(Entry::Marked {
                execution_fenced,
                execution_ambiguous,
                ..
            }) = entries.get_mut(client_id)
                && !*execution_fenced
            {
                *execution_ambiguous = true;
            }
        }
        Self {
            entries,
            overflowed,
        }
    }
    pub(crate) fn lookup(
        &self,
        client_id: &str,
        payload_hash: &str,
    ) -> Result<Option<UserInputOnceReceipt>, UserInputOnceLookupError> {
        let Some(entry) = self.entries.get(client_id) else {
            return if self.overflowed || self.entries.len() >= MAX_ENTRIES {
                Err(UserInputOnceLookupError::Legacy)
            } else {
                Ok(None)
            };
        };
        let Entry::Marked {
            marker,
            persisted,
            execution_fenced,
            execution_ambiguous,
        } = entry
        else {
            return Err(UserInputOnceLookupError::Legacy);
        };
        if marker.payload_hash != payload_hash {
            return Err(UserInputOnceLookupError::Conflict {
                turn_id: marker.turn_id.clone(),
            });
        }
        Ok(Some(UserInputOnceReceipt {
            turn_id: marker.turn_id.clone(),
            state: if *persisted {
                UserInputOnceState::Persisted
            } else {
                UserInputOnceState::AdmissionOnly
            },
            execution_state: execution_state(
                marker,
                *persisted,
                *execution_fenced,
                *execution_ambiguous,
            ),
        }))
    }
    pub(crate) fn insert(&mut self, marker: UserInputOnceMarker) {
        if self.entries.contains_key(&marker.client_id) {
            return;
        }
        if self.entries.len() >= MAX_ENTRIES {
            self.overflowed = true;
            return;
        }
        self.entries.insert(
            marker.client_id.clone(),
            Entry::Marked {
                marker,
                persisted: false,
                execution_fenced: false,
                execution_ambiguous: false,
            },
        );
    }
    pub(crate) fn insert_execution_fence(&mut self, fence: &UserInputOnceMarker) {
        let Some(Entry::Marked {
            marker,
            execution_fenced,
            execution_ambiguous,
            ..
        }) = self.entries.get_mut(&fence.client_id)
        else {
            return;
        };
        if valid_execution_fence(fence)
            && marker.version == MARKER_VERSION
            && marker.thread_id == fence.thread_id
            && marker.payload_hash == fence.payload_hash
            && marker.turn_id == fence.turn_id
        {
            *execution_fenced = true;
        } else {
            *execution_ambiguous = true;
        }
    }
    pub(crate) fn mark_execution_ambiguous(&mut self, client_id: &str) {
        if let Some(Entry::Marked {
            execution_ambiguous,
            ..
        }) = self.entries.get_mut(client_id)
        {
            *execution_ambiguous = true;
        } else {
            self.reserve_legacy(client_id.to_string());
        }
    }
    pub(crate) fn reserve_legacy(&mut self, client_id: String) -> bool {
        if self.entries.contains_key(&client_id) || self.entries.len() >= MAX_ENTRIES {
            self.overflowed |= self.entries.len() >= MAX_ENTRIES;
            return false;
        }
        self.entries.insert(client_id, Entry::Legacy);
        true
    }
}

fn insert_history_entry(
    entries: &mut HashMap<String, Entry>,
    overflowed: &mut bool,
    client_id: String,
    entry: Entry,
) {
    if let Some(existing) = entries.get_mut(&client_id) {
        *existing = Entry::Legacy;
        return;
    }
    if entries.len() >= MAX_ENTRIES {
        *overflowed = true;
        return;
    }
    entries.insert(client_id, entry);
}

pub(super) fn valid_marker(marker: &UserInputOnceMarker) -> bool {
    matches!(marker.version, LEGACY_MARKER_VERSION | MARKER_VERSION)
        && marker.phase == UserInputOnceMarkerPhase::Admission
        && valid_client_id(&marker.client_id)
        && valid_bounded_id(&marker.turn_id, MAX_TURN_ID_BYTES)
        && valid_payload_hash(&marker.payload_hash)
}

pub(super) fn valid_execution_fence(fence: &UserInputOnceMarker) -> bool {
    fence.version == EXECUTION_FENCE_VERSION
        && fence.phase == UserInputOnceMarkerPhase::ExecutionFence
        && valid_client_id(&fence.client_id)
        && valid_bounded_id(&fence.turn_id, MAX_TURN_ID_BYTES)
        && valid_payload_hash(&fence.payload_hash)
}

fn execution_state(
    marker: &UserInputOnceMarker,
    persisted: bool,
    execution_fenced: bool,
    execution_ambiguous: bool,
) -> UserInputOnceExecutionState {
    if marker.version != MARKER_VERSION || execution_ambiguous || (persisted && !execution_fenced) {
        UserInputOnceExecutionState::LegacyUnknown
    } else if execution_fenced {
        UserInputOnceExecutionState::Started
    } else {
        UserInputOnceExecutionState::NotStarted
    }
}

pub(crate) fn valid_client_id(client_id: &str) -> bool {
    valid_bounded_id(client_id, MAX_CLIENT_ID_BYTES)
}

pub(crate) fn valid_payload_hash(payload_hash: &str) -> bool {
    payload_hash.len() == PAYLOAD_HASH_BYTES
        && payload_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_bounded_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value == value.trim()
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "user_input_once_index_tests.rs"]
mod tests;
