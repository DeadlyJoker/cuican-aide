use std::collections::BTreeSet;
use std::fmt;

use serde::Serialize;

use crate::AgentPlatformProviderError;
use crate::ProviderRunAuthorizationBinding;

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_RUN_ID_BYTES: usize = 255;
const MAX_CURSOR_BYTES: usize = 64;
const MAX_PROMPT_CHARS: usize = 10_000;
const MAX_CONTEXT_REFS: usize = 32;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_ARTIFACT_REF_BYTES: usize = 1024;
const MAX_CANCEL_REASON_CHARS: usize = 1_000;
const MAX_EVENT_LIST_LIMIT: u16 = 100;

/// Provider Artifact kind accepted by the durable Run wire contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderArtifactKind {
    File,
    Image,
    Report,
    Evidence,
    ToolResult,
}

/// Retention class attached to a Provider Artifact reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderArtifactRetention {
    Session,
    Task,
    UserManaged,
    Compliance,
}

/// Bounded metadata-only Artifact reference; it never contains Artifact bytes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderArtifactRef {
    artifact_id: String,
    task_id: String,
    kind: ProviderArtifactKind,
    revision: u64,
    retention: ProviderArtifactRetention,
    created_at: i64,
}

impl ProviderArtifactRef {
    /// Constructs a bounded Artifact reference for one exact revision.
    pub fn new(
        artifact_id: impl Into<String>,
        task_id: impl Into<String>,
        kind: ProviderArtifactKind,
        revision: u64,
        retention: ProviderArtifactRetention,
        created_at: i64,
    ) -> Result<Self, AgentPlatformProviderError> {
        let artifact = Self {
            artifact_id: bounded_identifier(artifact_id.into())?,
            task_id: bounded_identifier(task_id.into())?,
            kind,
            revision,
            retention,
            created_at,
        };
        if artifact.revision == 0
            || artifact.created_at < 0
            || serde_json::to_vec(&artifact)
                .map_err(|_| AgentPlatformProviderError::InvalidRequest)?
                .len()
                > MAX_ARTIFACT_REF_BYTES
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(artifact)
    }

    pub fn artifact_id(&self) -> &str {
        &self.artifact_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn kind(&self) -> ProviderArtifactKind {
        self.kind
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn retention(&self) -> ProviderArtifactRetention {
        self.retention
    }

    pub fn created_at(&self) -> i64 {
        self.created_at
    }
}

/// Fully validated durable Run start request.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunStartRequest {
    authorization: ProviderRunAuthorizationBinding,
    command_id: String,
    idempotency_key: String,
    request_digest: String,
    prompt: String,
    context_refs: Vec<ProviderArtifactRef>,
}

impl fmt::Debug for ProviderRunStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunStartRequest")
            .field("authorization", &self.authorization)
            .field("command_id", &self.command_id)
            .field("idempotency_key", &self.idempotency_key)
            .field("request_digest", &self.request_digest)
            .field("prompt", &"[REDACTED]")
            .field("context_ref_count", &self.context_refs.len())
            .finish()
    }
}

impl ProviderRunStartRequest {
    pub fn new(
        authorization: ProviderRunAuthorizationBinding,
        command_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        request_digest: impl Into<String>,
        prompt: impl Into<String>,
        context_refs: Vec<ProviderArtifactRef>,
    ) -> Result<Self, AgentPlatformProviderError> {
        let command_id = bounded_identifier(command_id.into())?;
        let idempotency_key = bounded_identifier(idempotency_key.into())?;
        let request_digest = bounded_identifier(request_digest.into())?;
        if !request_digest.starts_with("sha256:") {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        let prompt = prompt.into();
        if prompt.is_empty()
            || prompt.chars().count() > MAX_PROMPT_CHARS
            || prompt.chars().any(forbidden_prompt_character)
            || context_refs.len() > MAX_CONTEXT_REFS
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        let mut identities = BTreeSet::new();
        for artifact in &context_refs {
            if artifact.task_id() != authorization.task_id()
                || !identities.insert((artifact.artifact_id(), artifact.revision()))
            {
                return Err(AgentPlatformProviderError::InvalidRequest);
            }
        }
        let input = ProviderRunInputSize {
            prompt: &prompt,
            context_refs: &context_refs,
        };
        if serde_json::to_vec(&input)
            .map_err(|_| AgentPlatformProviderError::InvalidRequest)?
            .len()
            > MAX_INPUT_BYTES
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            authorization,
            command_id,
            idempotency_key,
            request_digest,
            prompt,
            context_refs,
        })
    }

    pub fn authorization(&self) -> &ProviderRunAuthorizationBinding {
        &self.authorization
    }

    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn request_digest(&self) -> &str {
        &self.request_digest
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

    pub fn context_refs(&self) -> &[ProviderArtifactRef] {
        &self.context_refs
    }
}

macro_rules! run_request {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, Eq)]
        pub struct $name {
            authorization: ProviderRunAuthorizationBinding,
            command_id: String,
            provider_run_id: String,
            $(pub(crate) $field: $ty,)*
        }

        impl $name {
            pub fn authorization(&self) -> &ProviderRunAuthorizationBinding {
                &self.authorization
            }

            pub fn command_id(&self) -> &str {
                &self.command_id
            }

            pub fn provider_run_id(&self) -> &str {
                &self.provider_run_id
            }
        }
    };
}

run_request!(ProviderRunReadRequest {});
run_request!(ProviderRunEventsRequest {
    after_cursor: Option<String>,
    limit: u16,
});
run_request!(ProviderRunCancelRequest {
    reason: String,
    expected_revision: u64,
});

impl ProviderRunReadRequest {
    pub fn new(
        authorization: ProviderRunAuthorizationBinding,
        command_id: impl Into<String>,
        provider_run_id: impl Into<String>,
    ) -> Result<Self, AgentPlatformProviderError> {
        Ok(Self {
            authorization,
            command_id: bounded_identifier(command_id.into())?,
            provider_run_id: bounded_request_run_id(provider_run_id.into())?,
        })
    }
}

impl ProviderRunEventsRequest {
    pub fn new(
        authorization: ProviderRunAuthorizationBinding,
        command_id: impl Into<String>,
        provider_run_id: impl Into<String>,
        after_cursor: Option<String>,
        limit: u16,
    ) -> Result<Self, AgentPlatformProviderError> {
        if limit == 0 || limit > MAX_EVENT_LIST_LIMIT {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        if let Some(cursor) = after_cursor.as_deref() {
            validate_cursor(cursor).map_err(|_| AgentPlatformProviderError::InvalidRequest)?;
        }
        Ok(Self {
            authorization,
            command_id: bounded_identifier(command_id.into())?,
            provider_run_id: bounded_request_run_id(provider_run_id.into())?,
            after_cursor,
            limit,
        })
    }

    pub fn after_cursor(&self) -> Option<&str> {
        self.after_cursor.as_deref()
    }

    pub fn limit(&self) -> u16 {
        self.limit
    }
}

impl ProviderRunCancelRequest {
    pub fn new(
        authorization: ProviderRunAuthorizationBinding,
        command_id: impl Into<String>,
        provider_run_id: impl Into<String>,
        reason: impl Into<String>,
        expected_revision: u64,
    ) -> Result<Self, AgentPlatformProviderError> {
        let reason = reason.into();
        if reason.is_empty()
            || reason.chars().count() > MAX_CANCEL_REASON_CHARS
            || reason.chars().any(forbidden_prompt_character)
            || expected_revision == 0
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            authorization,
            command_id: bounded_identifier(command_id.into())?,
            provider_run_id: bounded_request_run_id(provider_run_id.into())?,
            reason,
            expected_revision,
        })
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn expected_revision(&self) -> u64 {
        self.expected_revision
    }
}

/// Closed durable Run lifecycle states returned by Agent Platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRunStatus {
    Queued,
    Running,
    Suspended,
    Reconciling,
    Completed,
    Failed,
    Cancelled,
}

impl ProviderRunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// Result of one idempotent Provider Run admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunStartResult {
    pub(crate) provider_run_id: String,
    pub(crate) attempt_id: String,
    pub(crate) created: bool,
}

impl ProviderRunStartResult {
    /// Constructs a validated start result for durable Run adapters and Harness fakes.
    pub fn new(
        provider_run_id: impl Into<String>,
        attempt_id: impl Into<String>,
        created: bool,
    ) -> Result<Self, AgentPlatformProviderError> {
        Ok(Self {
            provider_run_id: bounded_response_run_id(provider_run_id.into())?,
            attempt_id: bounded_response_identifier(attempt_id.into())?,
            created,
        })
    }

    pub fn provider_run_id(&self) -> &str {
        &self.provider_run_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn created(&self) -> bool {
        self.created
    }
}

/// Current Provider-owned Run snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunSnapshot {
    pub(crate) provider_run_id: String,
    pub(crate) attempt_id: String,
    pub(crate) status: ProviderRunStatus,
    pub(crate) revision: u64,
    pub(crate) last_sequence: u64,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

impl ProviderRunSnapshot {
    /// Constructs one validated Provider Run snapshot.
    pub fn new(
        provider_run_id: impl Into<String>,
        attempt_id: impl Into<String>,
        status: ProviderRunStatus,
        revision: u64,
        last_sequence: u64,
        created_at: i64,
        updated_at: i64,
    ) -> Result<Self, AgentPlatformProviderError> {
        if revision == 0 || last_sequence == 0 || created_at < 0 || updated_at < created_at {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self {
            provider_run_id: bounded_response_run_id(provider_run_id.into())?,
            attempt_id: bounded_response_identifier(attempt_id.into())?,
            status,
            revision,
            last_sequence,
            created_at,
            updated_at,
        })
    }

    pub fn provider_run_id(&self) -> &str {
        &self.provider_run_id
    }
    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub fn status(&self) -> ProviderRunStatus {
        self.status
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn last_sequence(&self) -> u64 {
        self.last_sequence
    }
    pub fn created_at(&self) -> i64 {
        self.created_at
    }
    pub fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

/// Status returned by an idempotent cancellation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRunCancelStatus {
    CancelRequested,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunCancelResult {
    pub(crate) status: ProviderRunCancelStatus,
    pub(crate) revision: u64,
    pub(crate) duplicate: bool,
}

impl ProviderRunCancelResult {
    /// Constructs one validated idempotent cancellation result.
    pub fn new(
        status: ProviderRunCancelStatus,
        revision: u64,
        duplicate: bool,
    ) -> Result<Self, AgentPlatformProviderError> {
        if revision == 0 {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self {
            status,
            revision,
            duplicate,
        })
    }

    pub fn status(&self) -> ProviderRunCancelStatus {
        self.status
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn duplicate(&self) -> bool {
        self.duplicate
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRunInputSize<'a> {
    prompt: &'a str,
    context_refs: &'a [ProviderArtifactRef],
}

pub(crate) fn bounded_identifier(value: String) -> Result<String, AgentPlatformProviderError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.chars().any(char::is_control)
    {
        return Err(AgentPlatformProviderError::InvalidRequest);
    }
    Ok(value)
}

pub(crate) fn bounded_response_identifier(
    value: String,
) -> Result<String, AgentPlatformProviderError> {
    bounded_text(
        value,
        MAX_IDENTIFIER_BYTES,
        AgentPlatformProviderError::InvalidResponse,
    )
}

pub(crate) fn bounded_response_run_id(value: String) -> Result<String, AgentPlatformProviderError> {
    bounded_text(
        value,
        MAX_RUN_ID_BYTES,
        AgentPlatformProviderError::InvalidResponse,
    )
}

pub(crate) fn validate_cursor(cursor: &str) -> Result<u64, AgentPlatformProviderError> {
    if cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES || cursor.chars().any(char::is_control)
    {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    let sequence = cursor
        .strip_prefix("event-")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|sequence| *sequence > 0)
        .ok_or(AgentPlatformProviderError::InvalidResponse)?;
    if cursor != format!("event-{sequence:04}") {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    Ok(sequence)
}

fn forbidden_prompt_character(character: char) -> bool {
    character.is_control() && !matches!(character, '\n' | '\r' | '\t')
}

fn bounded_request_run_id(value: String) -> Result<String, AgentPlatformProviderError> {
    bounded_text(
        value,
        MAX_RUN_ID_BYTES,
        AgentPlatformProviderError::InvalidRequest,
    )
}

fn bounded_text(
    value: String,
    max_bytes: usize,
    error: AgentPlatformProviderError,
) -> Result<String, AgentPlatformProviderError> {
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(error);
    }
    Ok(value)
}

#[cfg(test)]
#[path = "run_model_tests.rs"]
mod tests;
