use std::fmt;

use crate::CloudAgentTurnRecord;
use crate::ThreadExecutionContextBindingRef;

pub const MAX_CLOUD_AGENT_LEGACY_IMPORT_BYTES: u64 = 1_000_000;
pub const MAX_CLOUD_AGENT_LEGACY_IMPORT_TURNS: usize = 10;
const MAX_ID_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentLegacyImportStatus {
    Pending,
    Completed,
}

impl CloudAgentLegacyImportStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "completed" => Ok(Self::Completed),
            _ => anyhow::bail!("invalid Cloud Agent legacy import status"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudAgentLegacyImportRecord {
    pub journal_id: String,
    pub source_key: String,
    pub source_digest: String,
    pub source_bytes: u64,
    pub thread_id: String,
    pub execution_binding: ThreadExecutionContextBindingRef,
    pub expected_turn_count: usize,
    pub status: CloudAgentLegacyImportStatus,
    pub imported_at: i64,
    pub completed_at: Option<i64>,
}

impl CloudAgentLegacyImportRecord {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_id(&self.journal_id, "journalId")?;
        validate_id(&self.source_key, "sourceKey")?;
        validate_digest(&self.source_digest)?;
        validate_id(&self.thread_id, "threadId")?;
        validate_id(&self.execution_binding.binding_id, "executionBindingId")?;
        if self.source_bytes == 0
            || self.source_bytes > MAX_CLOUD_AGENT_LEGACY_IMPORT_BYTES
            || self.execution_binding.revision == 0
            || self.expected_turn_count == 0
            || self.expected_turn_count > MAX_CLOUD_AGENT_LEGACY_IMPORT_TURNS
            || self.imported_at < 0
            || self
                .completed_at
                .is_some_and(|time| time < self.imported_at)
            || (self.status == CloudAgentLegacyImportStatus::Pending && self.completed_at.is_some())
            || (self.status == CloudAgentLegacyImportStatus::Completed
                && self.completed_at.is_none())
        {
            anyhow::bail!("invalid Cloud Agent legacy import lifecycle");
        }
        Ok(())
    }
}

impl fmt::Debug for CloudAgentLegacyImportRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentLegacyImportRecord")
            .field("journal_id", &self.journal_id)
            .field("source", &"[REDACTED]")
            .field("source_bytes", &self.source_bytes)
            .field("thread_id", &self.thread_id)
            .field("execution_binding", &"[REDACTED]")
            .field("expected_turn_count", &self.expected_turn_count)
            .field("status", &self.status)
            .field("imported_at", &self.imported_at)
            .field("completed_at", &self.completed_at)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentLegacyImportStart {
    pub journal_id: String,
    pub source_key: String,
    pub source_digest: String,
    pub source_bytes: u64,
    pub thread_id: String,
    pub execution_binding: ThreadExecutionContextBindingRef,
    pub expected_turn_count: usize,
    pub imported_at: i64,
}

impl CloudAgentLegacyImportStart {
    pub(crate) fn pending_record(&self) -> CloudAgentLegacyImportRecord {
        CloudAgentLegacyImportRecord {
            journal_id: self.journal_id.clone(),
            source_key: self.source_key.clone(),
            source_digest: self.source_digest.clone(),
            source_bytes: self.source_bytes,
            thread_id: self.thread_id.clone(),
            execution_binding: self.execution_binding.clone(),
            expected_turn_count: self.expected_turn_count,
            status: CloudAgentLegacyImportStatus::Pending,
            imported_at: self.imported_at,
            completed_at: None,
        }
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        self.pending_record().validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudAgentLegacyImportStartOutcome {
    Started(CloudAgentLegacyImportRecord),
    ExistingPending(CloudAgentLegacyImportRecord),
    ExistingCompleted(CloudAgentLegacyImportRecord),
    Conflict,
    DependencyMissing,
    CapacityExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentLegacyImportCommit {
    pub journal_id: String,
    pub source_digest: String,
    pub turns: Vec<CloudAgentTurnRecord>,
}

impl CloudAgentLegacyImportCommit {
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_id(&self.journal_id, "journalId")?;
        validate_digest(&self.source_digest)?;
        if self.turns.is_empty() || self.turns.len() > MAX_CLOUD_AGENT_LEGACY_IMPORT_TURNS {
            anyhow::bail!("invalid Cloud Agent legacy import Turn count");
        }
        for turn in &self.turns {
            turn.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentLegacyImportCommitOutcome {
    Committed,
    ExistingSame,
    Conflict,
    DependencyMissing,
    CapacityExceeded,
}

fn validate_id(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_ID_BYTES
        || value.chars().any(char::is_control)
    {
        anyhow::bail!("invalid Cloud Agent legacy import {field}");
    }
    Ok(())
}

fn validate_digest(value: &str) -> anyhow::Result<()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        anyhow::bail!("invalid Cloud Agent legacy import digest");
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        anyhow::bail!("invalid Cloud Agent legacy import digest");
    }
    Ok(())
}
