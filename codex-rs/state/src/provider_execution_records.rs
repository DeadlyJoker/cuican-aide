use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt;

use crate::provider_execution_validation::digest_parts;
use crate::provider_execution_validation::validate_cursor;
use crate::provider_execution_validation::validate_hash;
use crate::provider_execution_validation::validate_id;
use crate::provider_execution_validation::validate_optional_cursor;
use crate::provider_execution_validation::validate_optional_revision;
use crate::provider_execution_validation::validate_revision;
use crate::provider_execution_validation::validate_time;
use crate::provider_execution_validation::validate_type;

pub const MAX_CLOUD_EXECUTION_CONTEXT_ARTIFACTS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderExecutionRecordErrorKind {
    Empty,
    TooLong,
    InvalidHash,
    OutOfRange,
    TooManyItems,
    Duplicate,
    InconsistentFields,
    DigestMismatch,
    InvalidTransition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderExecutionRecordError {
    field: &'static str,
    kind: ProviderExecutionRecordErrorKind,
}

impl ProviderExecutionRecordError {
    fn new(field: &'static str, kind: ProviderExecutionRecordErrorKind) -> Self {
        Self { field, kind }
    }

    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> ProviderExecutionRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for ProviderExecutionRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid Provider execution record field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ProviderExecutionRecordError {}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudExecutionArtifactRefRecord {
    pub artifact_id: String,
    pub revision: u64,
}

impl CloudExecutionArtifactRefRecord {
    fn validate(&self, field: &'static str) -> Result<(), ProviderExecutionRecordError> {
        validate_id(&self.artifact_id, field)?;
        validate_revision(self.revision, field)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudExecutionSpecRecord {
    pub execution_spec_id: String,
    pub revision: u64,
    pub digest: String,
    pub task_id: String,
    pub workspace_key: String,
    pub binding_id: String,
    pub provider_id: String,
    pub protocol_version: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub resource_revision: String,
    pub credential_id: String,
    pub credential_revision: u64,
    pub prompt_artifact: CloudExecutionArtifactRefRecord,
    pub context_artifacts: Vec<CloudExecutionArtifactRefRecord>,
    pub created_at: i64,
}

impl CloudExecutionSpecRecord {
    pub fn validate(&self) -> Result<(), ProviderExecutionRecordError> {
        validate_id(&self.execution_spec_id, "executionSpecId")?;
        validate_revision(self.revision, "executionSpecRevision")?;
        validate_hash(&self.digest, "executionSpecDigest")?;
        validate_id(&self.task_id, "taskId")?;
        validate_id(&self.workspace_key, "workspaceKey")?;
        validate_id(&self.binding_id, "bindingId")?;
        validate_id(&self.provider_id, "providerId")?;
        validate_type(&self.protocol_version, "protocolVersion")?;
        validate_type(&self.resource_kind, "resourceKind")?;
        if self.resource_kind != "agent" {
            return Err(error(
                "resourceKind",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            ));
        }
        validate_id(&self.resource_id, "resourceId")?;
        validate_id(&self.resource_revision, "resourceRevision")?;
        validate_id(&self.credential_id, "credentialId")?;
        validate_revision(self.credential_revision, "credentialRevision")?;
        self.prompt_artifact.validate("promptArtifact")?;
        validate_time(self.created_at, "createdAt")?;
        if self.context_artifacts.len() > MAX_CLOUD_EXECUTION_CONTEXT_ARTIFACTS {
            return Err(error(
                "contextArtifacts",
                ProviderExecutionRecordErrorKind::TooManyItems,
            ));
        }
        let mut artifacts = BTreeSet::new();
        artifacts.insert(self.prompt_artifact.clone());
        for artifact in &self.context_artifacts {
            artifact.validate("contextArtifact")?;
            if !artifacts.insert(artifact.clone()) {
                return Err(error(
                    "contextArtifacts",
                    ProviderExecutionRecordErrorKind::Duplicate,
                ));
            }
        }
        if self.digest != self.canonical_digest() {
            return Err(error(
                "executionSpecDigest",
                ProviderExecutionRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_digest(&self) -> String {
        let revision = self.revision.to_string();
        let credential_revision = self.credential_revision.to_string();
        let prompt_revision = self.prompt_artifact.revision.to_string();
        let created_at = self.created_at.to_string();
        let mut parts = vec![
            self.execution_spec_id.as_bytes(),
            revision.as_bytes(),
            self.task_id.as_bytes(),
            self.workspace_key.as_bytes(),
            self.binding_id.as_bytes(),
            self.provider_id.as_bytes(),
            self.protocol_version.as_bytes(),
            self.resource_kind.as_bytes(),
            self.resource_id.as_bytes(),
            self.resource_revision.as_bytes(),
            self.credential_id.as_bytes(),
            credential_revision.as_bytes(),
            self.prompt_artifact.artifact_id.as_bytes(),
            prompt_revision.as_bytes(),
            created_at.as_bytes(),
        ];
        let context_revisions = self
            .context_artifacts
            .iter()
            .map(|artifact| artifact.revision.to_string())
            .collect::<Vec<_>>();
        for (artifact, revision) in self.context_artifacts.iter().zip(&context_revisions) {
            parts.push(artifact.artifact_id.as_bytes());
            parts.push(revision.as_bytes());
        }
        digest_parts(b"crewon.cloud-execution-spec.v1\0", &parts)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProviderRunJournalKey {
    pub task_id: String,
    pub attempt_id: String,
    pub worker_run_id: String,
}

impl ProviderRunJournalKey {
    pub(crate) fn validate(&self) -> Result<(), ProviderExecutionRecordError> {
        validate_id(&self.task_id, "taskId")?;
        validate_id(&self.attempt_id, "attemptId")?;
        validate_id(&self.worker_run_id, "workerRunId")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRunJournalStatus {
    Starting,
    Running,
    Suspended,
    Reconciling,
    Completed,
    Failed,
    Cancelled,
}

impl ProviderRunJournalStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Suspended => "suspended",
            Self::Reconciling => "reconciling",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "starting" => Ok(Self::Starting),
            "running" => Ok(Self::Running),
            "suspended" => Ok(Self::Suspended),
            "reconciling" => Ok(Self::Reconciling),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => anyhow::bail!("invalid Provider Run journal status"),
        }
    }

    const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }

    fn can_transition_to(self, next: Self) -> bool {
        !self.is_terminal() && next != Self::Starting
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunJournalRecord {
    pub key: ProviderRunJournalKey,
    pub journal_version: u64,
    pub execution_spec_id: String,
    pub execution_spec_revision: u64,
    pub execution_spec_digest: String,
    pub provider_id: String,
    pub protocol_version: String,
    pub resource_id: String,
    pub resource_revision: String,
    pub credential_id: String,
    pub credential_revision: u64,
    pub provider_run_id: String,
    pub provider_attempt_id: String,
    pub provider_revision: Option<u64>,
    pub last_sequence: u64,
    pub last_cursor: Option<String>,
    pub status: ProviderRunJournalStatus,
    pub start_command_id: String,
    pub start_idempotency_key: String,
    pub request_digest: String,
    pub record_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ProviderRunJournalRecord {
    pub fn validate(&self) -> Result<(), ProviderExecutionRecordError> {
        self.key.validate()?;
        validate_id(&self.execution_spec_id, "executionSpecId")?;
        validate_revision(self.execution_spec_revision, "executionSpecRevision")?;
        validate_hash(&self.execution_spec_digest, "executionSpecDigest")?;
        validate_id(&self.provider_id, "providerId")?;
        validate_type(&self.protocol_version, "protocolVersion")?;
        validate_id(&self.resource_id, "resourceId")?;
        validate_id(&self.resource_revision, "resourceRevision")?;
        validate_id(&self.credential_id, "credentialId")?;
        validate_revision(self.credential_revision, "credentialRevision")?;
        validate_id(&self.provider_run_id, "providerRunId")?;
        validate_id(&self.provider_attempt_id, "providerAttemptId")?;
        validate_optional_revision(self.provider_revision, "providerRevision")?;
        validate_optional_cursor(self.last_cursor.as_deref(), "lastCursor")?;
        validate_id(&self.start_command_id, "startCommandId")?;
        validate_id(&self.start_idempotency_key, "startIdempotencyKey")?;
        validate_hash(&self.request_digest, "requestDigest")?;
        validate_hash(&self.record_hash, "recordHash")?;
        validate_time(self.created_at, "createdAt")?;
        validate_time(self.updated_at, "updatedAt")?;
        if self.updated_at < self.created_at
            || self.journal_version != self.last_sequence
            || (self.last_sequence == 0) != self.last_cursor.is_none()
            || (self.status == ProviderRunJournalStatus::Starting) != (self.last_sequence == 0)
        {
            return Err(error(
                "journalState",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            ));
        }
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                ProviderExecutionRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let execution_revision = self.execution_spec_revision.to_string();
        let credential_revision = self.credential_revision.to_string();
        digest_parts(
            b"crewon.provider-run-journal.v1\0",
            &[
                self.key.task_id.as_bytes(),
                self.key.attempt_id.as_bytes(),
                self.key.worker_run_id.as_bytes(),
                self.execution_spec_id.as_bytes(),
                execution_revision.as_bytes(),
                self.execution_spec_digest.as_bytes(),
                self.provider_id.as_bytes(),
                self.protocol_version.as_bytes(),
                self.resource_id.as_bytes(),
                self.resource_revision.as_bytes(),
                self.credential_id.as_bytes(),
                credential_revision.as_bytes(),
                self.provider_run_id.as_bytes(),
                self.provider_attempt_id.as_bytes(),
                self.start_command_id.as_bytes(),
                self.start_idempotency_key.as_bytes(),
                self.request_digest.as_bytes(),
            ],
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunJournalEventRecord {
    pub event_id: String,
    pub sequence: u64,
    pub cursor: String,
    pub event_type: String,
    pub projection: crate::ProviderRunEventProjectionRecord,
    pub created_at: i64,
}

impl ProviderRunJournalEventRecord {
    pub(crate) fn validate(&self, task_id: &str) -> Result<(), ProviderExecutionRecordError> {
        validate_id(&self.event_id, "providerEventId")?;
        if self.sequence == 0 {
            return Err(error(
                "providerSequence",
                ProviderExecutionRecordErrorKind::OutOfRange,
            ));
        }
        validate_cursor(&self.cursor, "providerCursor")?;
        validate_provider_event_type(&self.event_type)?;
        self.projection.validate(&self.event_type, task_id)?;
        validate_time(self.created_at, "providerEventCreatedAt")
    }

    pub(crate) fn canonical_hash(&self, provider_run_id: &str) -> String {
        let sequence = self.sequence.to_string();
        let created_at = self.created_at.to_string();
        digest_parts(
            b"crewon.provider-run-event.v2\0",
            &[
                provider_run_id.as_bytes(),
                self.event_id.as_bytes(),
                sequence.as_bytes(),
                self.cursor.as_bytes(),
                self.event_type.as_bytes(),
                self.projection.payload_digest.as_bytes(),
                created_at.as_bytes(),
            ],
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunJournalAdvanceRecord {
    pub key: ProviderRunJournalKey,
    pub expected_journal_version: u64,
    pub expected_sequence: u64,
    pub expected_cursor: Option<String>,
    pub event: ProviderRunJournalEventRecord,
    pub status: ProviderRunJournalStatus,
    pub provider_revision: Option<u64>,
    pub updated_at: i64,
}

impl ProviderRunJournalAdvanceRecord {
    pub fn validate(&self) -> Result<(), ProviderExecutionRecordError> {
        self.key.validate()?;
        validate_optional_cursor(self.expected_cursor.as_deref(), "expectedCursor")?;
        self.event.validate(&self.key.task_id)?;
        validate_optional_revision(self.provider_revision, "providerRevision")?;
        validate_time(self.updated_at, "updatedAt")?;
        if self.expected_journal_version != self.expected_sequence
            || self.event.sequence != self.expected_sequence.saturating_add(1)
            || (self.expected_sequence == 0) != self.expected_cursor.is_none()
            || self.updated_at < self.event.created_at
            || self.status == ProviderRunJournalStatus::Starting
            || !event_status_matches(&self.event.event_type, self.status)
        {
            return Err(error(
                "journalAdvance",
                ProviderExecutionRecordErrorKind::OutOfRange,
            ));
        }
        if self.event.event_type == "runStarted" && self.provider_revision.is_none() {
            return Err(error(
                "providerRevision",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudExecutionSpecCreateOutcome {
    Created,
    ExistingSame,
    Conflict,
    DependencyMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRunJournalCreateOutcome {
    Created,
    ExistingSame,
    Conflict,
    ExecutionSpecNotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderRunJournalAdvanceOutcome {
    Advanced(ProviderRunJournalRecord),
    Duplicate(ProviderRunJournalRecord),
    Conflict,
    NotFound,
}

pub(crate) fn provider_status_transition_is_valid(
    current: ProviderRunJournalStatus,
    next: ProviderRunJournalStatus,
) -> bool {
    current.can_transition_to(next)
}

fn event_status_matches(event_type: &str, status: ProviderRunJournalStatus) -> bool {
    match event_type {
        "runStarted" => status == ProviderRunJournalStatus::Running,
        "progress" => status == ProviderRunJournalStatus::Running,
        "toolResultAccepted" => matches!(
            status,
            ProviderRunJournalStatus::Running | ProviderRunJournalStatus::Suspended
        ),
        "approvalRequired" | "toolResultRequired" => status == ProviderRunJournalStatus::Suspended,
        "completed" => status == ProviderRunJournalStatus::Completed,
        "failed" => matches!(
            status,
            ProviderRunJournalStatus::Failed | ProviderRunJournalStatus::Reconciling
        ),
        "cancelled" => status == ProviderRunJournalStatus::Cancelled,
        _ => false,
    }
}

fn validate_provider_event_type(value: &str) -> Result<(), ProviderExecutionRecordError> {
    validate_type(value, "providerEventType")?;
    if !matches!(
        value,
        "runStarted"
            | "progress"
            | "approvalRequired"
            | "toolResultRequired"
            | "toolResultAccepted"
            | "completed"
            | "failed"
            | "cancelled"
    ) {
        return Err(error(
            "providerEventType",
            ProviderExecutionRecordErrorKind::InconsistentFields,
        ));
    }
    Ok(())
}

pub(crate) fn error(
    field: &'static str,
    kind: ProviderExecutionRecordErrorKind,
) -> ProviderExecutionRecordError {
    ProviderExecutionRecordError::new(field, kind)
}
