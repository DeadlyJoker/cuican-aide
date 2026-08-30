use std::fmt;
use std::fs::File;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::path::Path;

use crewon_protocol::ThreadId;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::RolloutLine;
use serde_json::Value;
use tracing::warn;

use crate::compression;

/// Rollout mutation classes protected by the Legacy Fence artifact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RolloutMutation {
    Resume,
    Append,
    Metadata,
    Compact,
    Archive,
    Unarchive,
    Delete,
    ForkImport,
}

impl fmt::Display for RolloutMutation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            Self::Resume => "resume",
            Self::Append => "append",
            Self::Metadata => "metadata update",
            Self::Compact => "compression",
            Self::Archive => "archive",
            Self::Unarchive => "unarchive",
            Self::Delete => "delete",
            Self::ForkImport => "fork or import",
        };
        formatter.write_str(label)
    }
}

/// Result of inspecting an existing rollout for downgrade-safe mutation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RolloutFenceState {
    MarkerFree,
    MarkerBearing,
    Unreadable,
}

/// Stable, path-free error returned when a Legacy Fence artifact rejects a mutation.
#[derive(Debug)]
pub struct LegacyFenceViolation {
    thread_id: ThreadId,
    mutation: RolloutMutation,
    state: RolloutFenceState,
    reason: &'static str,
}

impl fmt::Display for LegacyFenceViolation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Self {
            thread_id,
            mutation,
            reason,
            ..
        } = self;
        write!(
            formatter,
            "legacy fence rejected {mutation} for thread {thread_id}: {reason}"
        )
    }
}

impl std::error::Error for LegacyFenceViolation {}

impl LegacyFenceViolation {
    /// Thread whose rollout mutation was rejected.
    pub fn thread_id(&self) -> ThreadId {
        self.thread_id
    }

    /// Mutation class rejected by the artifact fence.
    pub fn mutation(&self) -> RolloutMutation {
        self.mutation
    }

    /// Fence classification that caused the rejection.
    pub fn state(&self) -> RolloutFenceState {
        self.state
    }
}

/// Returns true when `error` is a stable Legacy Fence rejection.
pub fn is_legacy_fence_violation(error: &io::Error) -> bool {
    legacy_fence_violation(error).is_some()
}

/// Returns the structured Legacy Fence rejection carried by `error`, when present.
pub fn legacy_fence_violation(error: &io::Error) -> Option<&LegacyFenceViolation> {
    error
        .get_ref()
        .and_then(|source| source.downcast_ref::<LegacyFenceViolation>())
}

pub(crate) fn ensure_existing_rollout_mutation_allowed(
    rollout_path: &Path,
    thread_id: ThreadId,
    mutation: RolloutMutation,
) -> io::Result<()> {
    if !cfg!(feature = "legacy-fence-artifact") {
        return Ok(());
    }

    let state = classify_rollout_blocking(rollout_path);
    match state {
        RolloutFenceState::MarkerFree => Ok(()),
        RolloutFenceState::MarkerBearing => Err(violation(
            thread_id,
            mutation,
            state,
            "rollout contains durable user-input-once markers",
        )),
        RolloutFenceState::Unreadable => Err(violation(
            thread_id,
            mutation,
            state,
            "rollout could not be verified as marker-free",
        )),
    }
}

pub(crate) fn ensure_rollout_items_allowed(
    items: &[RolloutItem],
    mutation: RolloutMutation,
) -> io::Result<()> {
    if !cfg!(feature = "legacy-fence-artifact") {
        return Ok(());
    }

    let marker = items.iter().find_map(|item| match item {
        RolloutItem::UserInputOnceMarker(marker) => Some(marker),
        RolloutItem::SessionMeta(_)
        | RolloutItem::ResponseItem(_)
        | RolloutItem::Compacted(_)
        | RolloutItem::TurnContext(_)
        | RolloutItem::EventMsg(_) => None,
    });
    let Some(marker) = marker else {
        return Ok(());
    };
    Err(violation(
        marker.thread_id,
        mutation,
        RolloutFenceState::MarkerBearing,
        "mutation would persist a durable user-input-once marker",
    ))
}

fn classify_rollout_blocking(rollout_path: &Path) -> RolloutFenceState {
    let reader = match open_rollout_reader_blocking(rollout_path) {
        Ok(reader) => reader,
        Err(error) => {
            warn!(
                path = %rollout_path.display(),
                %error,
                "legacy fence could not open rollout"
            );
            return RolloutFenceState::Unreadable;
        }
    };
    classify_lines(reader, rollout_path)
}

fn classify_lines(reader: Box<dyn BufRead>, rollout_path: &Path) -> RolloutFenceState {
    let mut state = RolloutFenceState::Unreadable;
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                warn!(
                    path = %rollout_path.display(),
                    %error,
                    "legacy fence could not read rollout line"
                );
                return RolloutFenceState::Unreadable;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let mut value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(error) => {
                warn!(
                    path = %rollout_path.display(),
                    %error,
                    "legacy fence could not parse rollout line"
                );
                return RolloutFenceState::Unreadable;
            }
        };
        if strip_legacy_ghost_snapshot_rollout_line(&mut value) {
            continue;
        }
        let rollout_line = match serde_json::from_value::<RolloutLine>(value) {
            Ok(rollout_line) => rollout_line,
            Err(error) => {
                warn!(
                    path = %rollout_path.display(),
                    %error,
                    "legacy fence could not parse rollout item"
                );
                return RolloutFenceState::Unreadable;
            }
        };
        if state == RolloutFenceState::Unreadable {
            state = RolloutFenceState::MarkerFree;
        }
        if matches!(rollout_line.item, RolloutItem::UserInputOnceMarker(_)) {
            state = RolloutFenceState::MarkerBearing;
        }
    }
    state
}

pub(crate) fn strip_legacy_ghost_snapshot_rollout_line(value: &mut Value) -> bool {
    match value.get("type").and_then(Value::as_str) {
        Some("response_item") => value
            .get("payload")
            .is_some_and(is_legacy_ghost_snapshot_response_item),
        Some("compacted") => {
            if let Some(replacement_history) = value
                .get_mut("payload")
                .and_then(|payload| payload.get_mut("replacement_history"))
                .and_then(Value::as_array_mut)
            {
                replacement_history.retain(|item| !is_legacy_ghost_snapshot_response_item(item));
            }
            false
        }
        _ => false,
    }
}

fn is_legacy_ghost_snapshot_response_item(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("ghost_snapshot")
}

fn open_rollout_reader_blocking(rollout_path: &Path) -> io::Result<Box<dyn BufRead>> {
    let plain_path = compression::plain_rollout_path(rollout_path);
    if plain_path.exists() {
        return Ok(Box::new(BufReader::new(File::open(plain_path)?)));
    }

    let compressed_path = plain_path.with_extension("jsonl.zst");
    let decoder = zstd::stream::read::Decoder::new(File::open(compressed_path)?)?;
    Ok(Box::new(BufReader::new(decoder)))
}

fn violation(
    thread_id: ThreadId,
    mutation: RolloutMutation,
    state: RolloutFenceState,
    reason: &'static str,
) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        LegacyFenceViolation {
            thread_id,
            mutation,
            state,
            reason,
        },
    )
}

#[cfg(test)]
#[path = "legacy_fence_tests.rs"]
mod tests;
