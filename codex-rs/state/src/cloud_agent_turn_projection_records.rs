use std::fmt;

use crate::CloudExecutionArtifactRefRecord;
use crate::ProviderRunJournalKey;

pub const MAX_CLOUD_AGENT_FINALIZATION_ATTEMPTS: u32 = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentTurnProjectionStatus {
    Running,
    Suspended,
    Failed,
    Cancelled,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudAgentProviderEventRef {
    pub key: ProviderRunJournalKey,
    pub provider_run_id: String,
    pub event_id: String,
    pub sequence: u64,
    pub payload_digest: String,
}

impl fmt::Debug for CloudAgentProviderEventRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentProviderEventRef")
            .field("sequence", &self.sequence)
            .field("identity", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudAgentTurnFinalizationRecord {
    pub turn_id: String,
    pub task_id: String,
    pub event: CloudAgentProviderEventRef,
    pub status: CloudAgentTurnFinalizationStatus,
    pub attempts: u32,
    pub available_at: i64,
    pub last_error_code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

impl fmt::Debug for CloudAgentTurnFinalizationRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentTurnFinalizationRecord")
            .field("turn_id", &self.turn_id)
            .field("event", &self.event)
            .field("status", &self.status)
            .field("attempts", &self.attempts)
            .field("available_at", &self.available_at)
            .field("last_error_code", &self.last_error_code)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .field("completed_at", &self.completed_at)
            .field("task", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentTurnFinalizationStatus {
    Pending,
    Completed,
    ResultUnavailable,
}

impl CloudAgentTurnFinalizationStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::ResultUnavailable => "resultUnavailable",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "completed" => Ok(Self::Completed),
            "resultUnavailable" => Ok(Self::ResultUnavailable),
            _ => anyhow::bail!("invalid Cloud Agent Turn finalization status"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudAgentTurnProjectionCandidate {
    pub turn_id: String,
    pub task_id: String,
    pub key: ProviderRunJournalKey,
    pub provider_run_id: String,
    pub last_provider_sequence: u64,
    pub journal_last_sequence: u64,
    pub finalization: Option<CloudAgentTurnFinalizationRecord>,
}

impl fmt::Debug for CloudAgentTurnProjectionCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentTurnProjectionCandidate")
            .field("turn_id", &self.turn_id)
            .field("last_provider_sequence", &self.last_provider_sequence)
            .field("journal_last_sequence", &self.journal_last_sequence)
            .field("has_finalization", &self.finalization.is_some())
            .field("execution", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudAgentTurnProjectionRequest {
    pub turn_id: String,
    pub event: CloudAgentProviderEventRef,
    pub status: CloudAgentTurnProjectionStatus,
    pub error_code: Option<String>,
    pub trace_id: Option<String>,
    pub projected_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnCancellationCandidate {
    pub turn_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnCancellationProjectionRequest {
    pub turn_id: String,
    pub task_id: String,
    pub projected_at: i64,
}

impl fmt::Debug for CloudAgentTurnProjectionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentTurnProjectionRequest")
            .field("turn_id", &self.turn_id)
            .field("event", &self.event)
            .field("status", &self.status)
            .field("error_code", &self.error_code)
            .field("trace_id", &self.trace_id.as_ref().map(|_| "[REDACTED]"))
            .field("projected_at", &self.projected_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudAgentTurnBeginFinalizationRequest {
    pub turn_id: String,
    pub event: CloudAgentProviderEventRef,
    pub available_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnFinalizationRetryRequest {
    pub turn_id: String,
    pub event: CloudAgentProviderEventRef,
    pub expected_attempts: u32,
    pub available_at: i64,
    pub error_code: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnCompleteRequest {
    pub turn_id: String,
    pub event: CloudAgentProviderEventRef,
    pub expected_attempts: u32,
    pub primary_output_artifact: CloudExecutionArtifactRefRecord,
    pub additional_output_artifacts: Vec<CloudExecutionArtifactRefRecord>,
    pub completed_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnResultUnavailableRequest {
    pub turn_id: String,
    pub event: CloudAgentProviderEventRef,
    pub expected_attempts: u32,
    pub final_attempts: u32,
    pub error_code: String,
    pub completed_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentTurnProjectionOutcome {
    Applied,
    Duplicate,
    Conflict,
    NotFound,
}
