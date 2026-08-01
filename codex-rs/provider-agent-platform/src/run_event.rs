use std::collections::BTreeSet;

use crate::AgentPlatformProviderError;
use crate::ProviderArtifactRef;
use crate::run_model::bounded_response_identifier;
use crate::run_model::bounded_response_run_id;
use crate::run_model::validate_cursor;

const EVENT_SCHEMA_VERSION: &str = "3.0.0";
const MAX_EVENT_PAGE_ITEMS: usize = 100;
const MAX_EVENT_SUMMARY_CHARS: usize = 2_000;
const MAX_CANCEL_REASON_CHARS: usize = 1_000;
const MAX_OUTPUT_ARTIFACTS: usize = 32;

/// Safe Provider failure codes that can appear inside a terminal failed event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRunFailureCode {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    CapabilityUnsupported,
    ProviderUnavailable,
    Timeout,
    UnknownOutcome,
    Internal,
}

/// Sanitized error payload from one failed Provider Run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunFailure {
    code: ProviderRunFailureCode,
    retryable: bool,
    provider_run_id: String,
    trace_id: String,
}

impl ProviderRunFailure {
    /// Constructs one bounded Provider failure without raw response text.
    pub fn new(
        code: ProviderRunFailureCode,
        retryable: bool,
        provider_run_id: String,
        trace_id: String,
    ) -> Result<Self, AgentPlatformProviderError> {
        Ok(Self {
            code,
            retryable,
            provider_run_id: bounded_response_run_id(provider_run_id)?,
            trace_id: bounded_response_identifier(trace_id)?,
        })
    }

    pub fn code(&self) -> ProviderRunFailureCode {
        self.code
    }
    pub fn retryable(&self) -> bool {
        self.retryable
    }
    pub fn provider_run_id(&self) -> &str {
        &self.provider_run_id
    }
    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }
}

/// Common, validated metadata carried by every Provider event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunEventMetadata {
    event_id: String,
    provider_run_id: String,
    attempt_id: String,
    sequence: u64,
    cursor: String,
    created_at: i64,
}

impl ProviderRunEventMetadata {
    /// Constructs exact versioned metadata for a validated Provider event.
    pub fn new(
        event_id: String,
        provider_run_id: String,
        attempt_id: String,
        sequence: u64,
        cursor: String,
        schema_version: String,
        created_at: i64,
    ) -> Result<Self, AgentPlatformProviderError> {
        if schema_version != EVENT_SCHEMA_VERSION
            || sequence == 0
            || created_at < 0
            || validate_cursor(&cursor)? != sequence
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self {
            event_id: bounded_response_identifier(event_id)?,
            provider_run_id: bounded_response_run_id(provider_run_id)?,
            attempt_id: bounded_response_identifier(attempt_id)?,
            sequence,
            cursor,
            created_at,
        })
    }

    pub fn event_id(&self) -> &str {
        &self.event_id
    }
    pub fn provider_run_id(&self) -> &str {
        &self.provider_run_id
    }
    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn cursor(&self) -> &str {
        &self.cursor
    }
    pub fn created_at(&self) -> i64 {
        self.created_at
    }
}

/// Strict, typed Provider event payload.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderRunEventPayload {
    RunStarted {
        revision: u64,
    },
    Progress {
        summary: String,
    },
    ApprovalRequired {
        approval_id: String,
        action_digest: String,
        expires_at: i64,
    },
    ToolResultRequired {
        tool_call_id: String,
        tool_schema_revision: String,
        arguments_digest: String,
        intent_digest: String,
        nonce: String,
        expires_at: i64,
    },
    ToolResultAccepted {
        tool_call_id: String,
        intent_digest: String,
        result_digest: String,
    },
    Completed {
        output_artifacts: Vec<ProviderArtifactRef>,
    },
    Failed {
        error: ProviderRunFailure,
    },
    Cancelled {
        reason: String,
    },
}

impl ProviderRunEventPayload {
    pub(crate) fn validate(&self, task_id: &str) -> Result<(), AgentPlatformProviderError> {
        match self {
            Self::RunStarted { revision } if *revision == 0 => {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            Self::Progress { summary }
                if summary.is_empty() || summary.chars().count() > MAX_EVENT_SUMMARY_CHARS =>
            {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            Self::ApprovalRequired {
                approval_id,
                action_digest,
                expires_at,
            } if invalid_text(approval_id) || invalid_digest(action_digest) || *expires_at < 0 => {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            Self::ToolResultRequired {
                tool_call_id,
                tool_schema_revision,
                arguments_digest,
                intent_digest,
                nonce,
                expires_at,
            } if [tool_call_id, tool_schema_revision, nonce]
                .into_iter()
                .any(|value| invalid_text(value))
                || invalid_digest(arguments_digest)
                || invalid_digest(intent_digest)
                || *expires_at < 0 =>
            {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            Self::ToolResultAccepted {
                tool_call_id,
                intent_digest,
                result_digest,
            } if invalid_text(tool_call_id)
                || invalid_digest(intent_digest)
                || invalid_digest(result_digest) =>
            {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            Self::Completed { output_artifacts }
                if output_artifacts.len() > MAX_OUTPUT_ARTIFACTS
                    || output_artifacts
                        .iter()
                        .any(|artifact| artifact.task_id() != task_id)
                    || output_artifacts
                        .iter()
                        .map(|artifact| (artifact.artifact_id(), artifact.revision()))
                        .collect::<BTreeSet<_>>()
                        .len()
                        != output_artifacts.len() =>
            {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            Self::Failed { error } if error.provider_run_id().is_empty() => {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            Self::Cancelled { reason }
                if reason.is_empty() || reason.chars().count() > MAX_CANCEL_REASON_CHARS =>
            {
                Err(AgentPlatformProviderError::InvalidResponse)
            }
            _ => Ok(()),
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed { .. } | Self::Failed { .. } | Self::Cancelled { .. }
        )
    }

    pub(crate) fn is_run_started(&self) -> bool {
        matches!(self, Self::RunStarted { .. })
    }

    pub(crate) fn requires_approval_capability(&self) -> bool {
        matches!(self, Self::ApprovalRequired { .. })
    }

    pub(crate) fn requires_tool_result_capability(&self) -> bool {
        matches!(
            self,
            Self::ToolResultRequired { .. } | Self::ToolResultAccepted { .. }
        )
    }
}

/// One typed event with metadata and a closed payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunEvent {
    metadata: ProviderRunEventMetadata,
    payload: ProviderRunEventPayload,
}

impl ProviderRunEvent {
    /// Constructs one typed event and validates its Task and Run correlations.
    pub fn new(
        metadata: ProviderRunEventMetadata,
        payload: ProviderRunEventPayload,
        task_id: &str,
    ) -> Result<Self, AgentPlatformProviderError> {
        payload.validate(task_id)?;
        if let ProviderRunEventPayload::Failed { error } = &payload
            && error.provider_run_id() != metadata.provider_run_id()
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self { metadata, payload })
    }

    pub fn metadata(&self) -> &ProviderRunEventMetadata {
        &self.metadata
    }
    pub fn payload(&self) -> &ProviderRunEventPayload {
        &self.payload
    }
}

/// Validated, contiguous page of Provider events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunEventPage {
    events: Vec<ProviderRunEvent>,
    last_cursor: Option<String>,
}

impl ProviderRunEventPage {
    /// Constructs one bounded contiguous page after an optional cursor.
    pub fn validated(
        events: Vec<ProviderRunEvent>,
        last_cursor: Option<String>,
        requested_run_id: &str,
        after_cursor: Option<&str>,
    ) -> Result<Self, AgentPlatformProviderError> {
        if events.len() > MAX_EVENT_PAGE_ITEMS {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        let after_sequence = after_cursor.map(validate_cursor).transpose()?.unwrap_or(0);
        if events.is_empty() {
            if last_cursor.as_deref() != after_cursor {
                return Err(AgentPlatformProviderError::InvalidResponse);
            }
            return Ok(Self {
                events,
                last_cursor,
            });
        }
        let expected_attempt = events[0].metadata.attempt_id().to_string();
        let mut previous_created_at = -1;
        let mut event_ids = BTreeSet::new();
        for (expected_sequence, (index, event)) in
            (after_sequence + 1..).zip(events.iter().enumerate())
        {
            let metadata = event.metadata();
            if metadata.provider_run_id() != requested_run_id
                || metadata.attempt_id() != expected_attempt
                || metadata.sequence() != expected_sequence
                || metadata.created_at() < previous_created_at
                || !event_ids.insert(metadata.event_id())
                || (event.payload().is_terminal() && index + 1 != events.len())
                || (metadata.sequence() == 1) != event.payload().is_run_started()
            {
                return Err(AgentPlatformProviderError::InvalidResponse);
            }
            previous_created_at = metadata.created_at();
        }
        if last_cursor.as_deref() != events.last().map(|event| event.metadata().cursor()) {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self {
            events,
            last_cursor,
        })
    }

    pub fn events(&self) -> &[ProviderRunEvent] {
        &self.events
    }
    pub fn last_cursor(&self) -> Option<&str> {
        self.last_cursor.as_deref()
    }
}

fn invalid_text(value: &str) -> bool {
    value.is_empty() || value.len() > 255 || value.chars().any(char::is_control)
}

fn invalid_digest(value: &str) -> bool {
    !value.starts_with("sha256:") || invalid_text(value)
}

#[cfg(test)]
#[path = "run_event_tests.rs"]
mod tests;
