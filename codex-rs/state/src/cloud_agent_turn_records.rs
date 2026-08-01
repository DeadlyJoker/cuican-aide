use std::collections::BTreeSet;
use std::fmt;

use sha2::Digest;
use sha2::Sha256;

use crate::CloudExecutionArtifactRefRecord;
use crate::CloudExecutionSpecRecord;
use crate::TaskCommitFencingRecord;
use crate::TaskCommitRecord;
use crate::TaskEventProducerRecord;
use crate::TaskRecord;
use crate::ThreadExecutionContextBindingRef;

pub const MAX_CLOUD_AGENT_TURN_OUTPUT_ARTIFACTS: usize = 32;
const MAX_ID_BYTES: usize = 512;
const MAX_ERROR_CODE_BYTES: usize = 128;
const DIGEST_PREFIX: &str = "sha256:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentTurnRecordErrorKind {
    Empty,
    TooLong,
    InvalidDigest,
    OutOfRange,
    TooManyItems,
    Duplicate,
    InconsistentFields,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnRecordError {
    field: &'static str,
    kind: CloudAgentTurnRecordErrorKind,
}

impl CloudAgentTurnRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> CloudAgentTurnRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for CloudAgentTurnRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid Cloud Agent Turn field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for CloudAgentTurnRecordError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudAgentTurnOrigin {
    DurableTask { task_id: String },
    LegacyImport { import_id: String },
}

impl CloudAgentTurnOrigin {
    pub fn task_id(&self) -> Option<&str> {
        match self {
            Self::DurableTask { task_id } => Some(task_id),
            Self::LegacyImport { .. } => None,
        }
    }

    pub fn import_id(&self) -> Option<&str> {
        match self {
            Self::DurableTask { .. } => None,
            Self::LegacyImport { import_id } => Some(import_id),
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::DurableTask { .. } => "durableTask",
            Self::LegacyImport { .. } => "legacyImport",
        }
    }

    fn validate(&self) -> Result<(), CloudAgentTurnRecordError> {
        match self {
            Self::DurableTask { task_id } => validate_id(task_id, "taskId"),
            Self::LegacyImport { import_id } => validate_id(import_id, "importId"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudAgentTurnStatus {
    Queued,
    Running,
    Suspended,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
    ResultUnavailable,
}

impl CloudAgentTurnStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::ResultUnavailable
        )
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Suspended => "suspended",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::ResultUnavailable => "resultUnavailable",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "suspended" => Ok(Self::Suspended),
            "finalizing" => Ok(Self::Finalizing),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "resultUnavailable" => Ok(Self::ResultUnavailable),
            _ => anyhow::bail!("invalid Cloud Agent Turn status"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudAgentTurnRecord {
    pub thread_id: String,
    pub turn_id: String,
    pub client_user_message_id: String,
    pub origin: CloudAgentTurnOrigin,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub workspace_key: String,
    pub execution_binding: ThreadExecutionContextBindingRef,
    pub prompt_artifact: CloudExecutionArtifactRefRecord,
    pub status: CloudAgentTurnStatus,
    pub last_provider_sequence: u64,
    pub primary_output_artifact: Option<CloudExecutionArtifactRefRecord>,
    pub additional_output_artifacts: Vec<CloudExecutionArtifactRefRecord>,
    pub error_code: Option<String>,
    pub trace_id: Option<String>,
    pub revision: u64,
    pub creation_digest: String,
    pub record_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

impl CloudAgentTurnRecord {
    pub fn validate(&self) -> Result<(), CloudAgentTurnRecordError> {
        validate_id(&self.thread_id, "threadId")?;
        validate_id(&self.turn_id, "turnId")?;
        validate_id(&self.client_user_message_id, "clientUserMessageId")?;
        self.origin.validate()?;
        validate_id(&self.local_actor_id, "localActorId")?;
        validate_id(&self.local_tenant_id, "localTenantId")?;
        validate_id(&self.local_space_id, "localSpaceId")?;
        validate_id(&self.workspace_key, "workspaceKey")?;
        validate_id(&self.execution_binding.binding_id, "executionBindingId")?;
        validate_revision(self.execution_binding.revision, "executionBindingRevision")?;
        validate_artifact(&self.prompt_artifact, "promptArtifact")?;
        validate_optional_text(
            self.error_code.as_deref(),
            "errorCode",
            MAX_ERROR_CODE_BYTES,
        )?;
        validate_optional_text(self.trace_id.as_deref(), "traceId", MAX_ID_BYTES)?;
        validate_revision(self.revision, "revision")?;
        validate_digest(&self.creation_digest, "creationDigest")?;
        validate_digest(&self.record_hash, "recordHash")?;
        validate_time(self.created_at, "createdAt")?;
        if self.updated_at < self.created_at
            || self.completed_at.is_some_and(|time| time < self.created_at)
        {
            return Err(error(
                "lifecycle",
                CloudAgentTurnRecordErrorKind::OutOfRange,
            ));
        }
        validate_outputs(self)?;
        validate_status_fields(self)?;
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                CloudAgentTurnRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let execution_revision = self.execution_binding.revision.to_string();
        let prompt_revision = self.prompt_artifact.revision.to_string();
        let last_provider_sequence = self.last_provider_sequence.to_string();
        let revision = self.revision.to_string();
        let created_at = self.created_at.to_string();
        let updated_at = self.updated_at.to_string();
        let completed_at = self.completed_at.map(|value| value.to_string());
        let origin_id = self
            .origin
            .task_id()
            .or_else(|| self.origin.import_id())
            .unwrap_or_default();
        let mut parts = vec![
            self.thread_id.as_bytes(),
            self.turn_id.as_bytes(),
            self.client_user_message_id.as_bytes(),
            self.origin.kind().as_bytes(),
            origin_id.as_bytes(),
            self.local_actor_id.as_bytes(),
            self.local_tenant_id.as_bytes(),
            self.local_space_id.as_bytes(),
            self.workspace_key.as_bytes(),
            self.execution_binding.binding_id.as_bytes(),
            execution_revision.as_bytes(),
            self.prompt_artifact.artifact_id.as_bytes(),
            prompt_revision.as_bytes(),
            self.status.as_str().as_bytes(),
            last_provider_sequence.as_bytes(),
            self.error_code.as_deref().unwrap_or_default().as_bytes(),
            self.trace_id.as_deref().unwrap_or_default().as_bytes(),
            revision.as_bytes(),
            self.creation_digest.as_bytes(),
            created_at.as_bytes(),
            updated_at.as_bytes(),
            completed_at.as_deref().unwrap_or_default().as_bytes(),
        ];
        let primary_revision = self
            .primary_output_artifact
            .as_ref()
            .map(|artifact| artifact.revision.to_string());
        if let Some(primary) = &self.primary_output_artifact {
            parts.push(primary.artifact_id.as_bytes());
            parts.push(primary_revision.as_deref().unwrap_or_default().as_bytes());
        }
        let additional_revisions = self
            .additional_output_artifacts
            .iter()
            .map(|artifact| artifact.revision.to_string())
            .collect::<Vec<_>>();
        for (artifact, artifact_revision) in self
            .additional_output_artifacts
            .iter()
            .zip(&additional_revisions)
        {
            parts.push(artifact.artifact_id.as_bytes());
            parts.push(artifact_revision.as_bytes());
        }
        digest_parts(b"crewon.cloud-agent-turn.v1\0", &parts)
    }

    pub fn is_initial_queued(&self) -> bool {
        self.status == CloudAgentTurnStatus::Queued
            && self.last_provider_sequence == 0
            && self.primary_output_artifact.is_none()
            && self.additional_output_artifacts.is_empty()
            && self.error_code.is_none()
            && self.revision == 1
            && self.completed_at.is_none()
    }
}

impl fmt::Debug for CloudAgentTurnRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentTurnRecord")
            .field("thread_id", &self.thread_id)
            .field("turn_id", &self.turn_id)
            .field("origin_kind", &self.origin.kind())
            .field("status", &self.status)
            .field("last_provider_sequence", &self.last_provider_sequence)
            .field(
                "additional_output_count",
                &self.additional_output_artifacts.len(),
            )
            .field("revision", &self.revision)
            .field("owner", &"[REDACTED]")
            .field("workspace", &"[REDACTED]")
            .field("artifacts", &"[REDACTED]")
            .field("digests", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .field("completed_at", &self.completed_at)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAgentTurnCreateBundle {
    pub task_genesis: TaskRecord,
    pub accepted_commit: TaskCommitRecord,
    pub execution_spec: CloudExecutionSpecRecord,
    pub turn: CloudAgentTurnRecord,
}

impl CloudAgentTurnCreateBundle {
    pub fn validate(&self) -> Result<(), CloudAgentTurnRecordError> {
        self.task_genesis
            .validate()
            .map_err(|_| inconsistent("taskGenesis"))?;
        self.accepted_commit
            .validate()
            .map_err(|_| inconsistent("acceptedCommit"))?;
        self.execution_spec
            .validate()
            .map_err(|_| inconsistent("executionSpec"))?;
        self.turn.validate()?;
        let Some(task_id) = self.turn.origin.task_id() else {
            return Err(inconsistent("turnOrigin"));
        };
        let attempt = self
            .accepted_commit
            .attempt
            .as_ref()
            .ok_or_else(|| inconsistent("acceptedAttempt"))?;
        if self.task_genesis.task_id != task_id
            || self.task_genesis.authority != "localAppServer"
            || self.task_genesis.strategy != "single"
            || self.task_genesis.status != "created"
            || self.task_genesis.aggregate_version != 0
            || self.task_genesis.stream_offset != 0
            || self.task_genesis.active_attempt_id.is_some()
            || self.task_genesis.lease.is_some()
            || self.accepted_commit.task_id != task_id
            || self.accepted_commit.expected_version != 0
            || self.accepted_commit.snapshot.status != "queued"
            || self.accepted_commit.snapshot.aggregate_version != 1
            || self.accepted_commit.snapshot.stream_offset != 1
            || self.accepted_commit.snapshot.active_attempt_id.as_deref()
                != Some(attempt.attempt_id.as_str())
            || self.accepted_commit.snapshot.lease.is_some()
            || self.accepted_commit.event.stream_offset != 1
            || self.accepted_commit.event.event_type != "taskAccepted"
            || self.accepted_commit.event.producer != TaskEventProducerRecord::Authority
            || self.accepted_commit.inbox.receipt_kind != "command"
            || self.accepted_commit.outbox.len() != 1
            || self.accepted_commit.outbox[0].decision_type != "enqueueAttempt"
            || self.accepted_commit.fencing != TaskCommitFencingRecord::Authority
            || self.execution_spec.task_id != task_id
            || self.execution_spec.revision != 1
            || self.execution_spec.workspace_key != self.turn.workspace_key
            || self.execution_spec.binding_id != self.turn.execution_binding.binding_id
            || self.execution_spec.prompt_artifact != self.turn.prompt_artifact
            || self.task_genesis.created_at != self.execution_spec.created_at
            || self.task_genesis.created_at != self.turn.created_at
            || self.accepted_commit.snapshot.updated_at != self.turn.updated_at
            || !self.turn.is_initial_queued()
        {
            return Err(inconsistent("createBundle"));
        }
        if self.turn.creation_digest != self.canonical_digest() {
            return Err(error(
                "creationDigest",
                CloudAgentTurnRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_digest(&self) -> String {
        let spec_revision = self.execution_spec.revision.to_string();
        let execution_binding_revision = self.turn.execution_binding.revision.to_string();
        let created_at = self.turn.created_at.to_string();
        let mut parts = vec![
            self.task_genesis.task_id.as_bytes(),
            self.task_genesis.authority.as_bytes(),
            self.task_genesis.strategy.as_bytes(),
            self.task_genesis.contract_json.as_bytes(),
            self.accepted_commit.snapshot.snapshot_json.as_bytes(),
            self.accepted_commit.event.event_id.as_bytes(),
            self.accepted_commit.event.event_json.as_bytes(),
            self.accepted_commit.inbox.receipt_id.as_bytes(),
            self.execution_spec.execution_spec_id.as_bytes(),
            spec_revision.as_bytes(),
            self.execution_spec.digest.as_bytes(),
            self.turn.thread_id.as_bytes(),
            self.turn.turn_id.as_bytes(),
            self.turn.client_user_message_id.as_bytes(),
            self.turn.workspace_key.as_bytes(),
            self.turn.execution_binding.binding_id.as_bytes(),
            execution_binding_revision.as_bytes(),
            self.turn.prompt_artifact.artifact_id.as_bytes(),
            created_at.as_bytes(),
        ];
        for outbox in &self.accepted_commit.outbox {
            parts.push(outbox.outbox_id.as_bytes());
            parts.push(outbox.decision_type.as_bytes());
            parts.push(outbox.payload_json.as_bytes());
        }
        digest_parts(b"crewon.cloud-agent-turn-create.v1\0", &parts)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudAgentTurnCreateOutcome {
    Created(CloudAgentTurnRecord),
    ExistingSame(CloudAgentTurnRecord),
    Conflict,
    DependencyMissing,
    ActiveTurnExists,
    CapacityExceeded,
}

fn validate_outputs(record: &CloudAgentTurnRecord) -> Result<(), CloudAgentTurnRecordError> {
    if record.additional_output_artifacts.len() > MAX_CLOUD_AGENT_TURN_OUTPUT_ARTIFACTS {
        return Err(error(
            "additionalOutputArtifacts",
            CloudAgentTurnRecordErrorKind::TooManyItems,
        ));
    }
    let mut seen = BTreeSet::new();
    if let Some(primary) = &record.primary_output_artifact {
        validate_artifact(primary, "primaryOutputArtifact")?;
        seen.insert(primary.clone());
    }
    for artifact in &record.additional_output_artifacts {
        validate_artifact(artifact, "additionalOutputArtifact")?;
        if !seen.insert(artifact.clone()) {
            return Err(error(
                "additionalOutputArtifacts",
                CloudAgentTurnRecordErrorKind::Duplicate,
            ));
        }
    }
    Ok(())
}

fn validate_status_fields(record: &CloudAgentTurnRecord) -> Result<(), CloudAgentTurnRecordError> {
    if record.status.is_terminal() != record.completed_at.is_some() {
        return Err(inconsistent("completedAt"));
    }
    match record.status {
        CloudAgentTurnStatus::Completed
            if record.primary_output_artifact.is_none() || record.error_code.is_some() =>
        {
            Err(inconsistent("completedOutput"))
        }
        CloudAgentTurnStatus::Failed | CloudAgentTurnStatus::ResultUnavailable
            if record.error_code.is_none() =>
        {
            Err(inconsistent("errorCode"))
        }
        CloudAgentTurnStatus::Queued
        | CloudAgentTurnStatus::Running
        | CloudAgentTurnStatus::Suspended
        | CloudAgentTurnStatus::Finalizing
            if record.primary_output_artifact.is_some() || record.error_code.is_some() =>
        {
            Err(inconsistent("nonTerminalResult"))
        }
        CloudAgentTurnStatus::Queued
        | CloudAgentTurnStatus::Running
        | CloudAgentTurnStatus::Suspended
        | CloudAgentTurnStatus::Finalizing
        | CloudAgentTurnStatus::Completed
        | CloudAgentTurnStatus::Failed
        | CloudAgentTurnStatus::Cancelled
        | CloudAgentTurnStatus::ResultUnavailable => Ok(()),
    }
}

fn validate_artifact(
    artifact: &CloudExecutionArtifactRefRecord,
    field: &'static str,
) -> Result<(), CloudAgentTurnRecordError> {
    validate_id(&artifact.artifact_id, field)?;
    validate_revision(artifact.revision, field)
}

fn validate_id(value: &str, field: &'static str) -> Result<(), CloudAgentTurnRecordError> {
    validate_text(value, field, MAX_ID_BYTES)
}

fn validate_optional_text(
    value: Option<&str>,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), CloudAgentTurnRecordError> {
    value.map_or(Ok(()), |value| validate_text(value, field, max_bytes))
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), CloudAgentTurnRecordError> {
    if value.trim().is_empty() || value.trim() != value || value.chars().any(char::is_control) {
        return Err(error(field, CloudAgentTurnRecordErrorKind::Empty));
    }
    if value.len() > max_bytes {
        return Err(error(field, CloudAgentTurnRecordErrorKind::TooLong));
    }
    Ok(())
}

fn validate_revision(value: u64, field: &'static str) -> Result<(), CloudAgentTurnRecordError> {
    if value == 0 || i64::try_from(value).is_err() {
        return Err(error(field, CloudAgentTurnRecordErrorKind::OutOfRange));
    }
    Ok(())
}

fn validate_time(value: i64, field: &'static str) -> Result<(), CloudAgentTurnRecordError> {
    if value < 0 {
        return Err(error(field, CloudAgentTurnRecordErrorKind::OutOfRange));
    }
    Ok(())
}

fn validate_digest(value: &str, field: &'static str) -> Result<(), CloudAgentTurnRecordError> {
    let Some(hex) = value.strip_prefix(DIGEST_PREFIX) else {
        return Err(error(field, CloudAgentTurnRecordErrorKind::InvalidDigest));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(field, CloudAgentTurnRecordErrorKind::InvalidDigest));
    }
    Ok(())
}

fn digest_parts(domain: &[u8], parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("{DIGEST_PREFIX}{:x}", hasher.finalize())
}

fn inconsistent(field: &'static str) -> CloudAgentTurnRecordError {
    error(field, CloudAgentTurnRecordErrorKind::InconsistentFields)
}

fn error(field: &'static str, kind: CloudAgentTurnRecordErrorKind) -> CloudAgentTurnRecordError {
    CloudAgentTurnRecordError { field, kind }
}
