use std::collections::BTreeSet;
use std::fmt;

use serde::Deserialize;
use serde::Serialize;

use crate::ProviderExecutionRecordError;
use crate::ProviderExecutionRecordErrorKind;
use crate::ProviderRunJournalEventRecord;
use crate::ProviderRunJournalKey;
use crate::digest_bytes;
use crate::provider_execution_records::error;
use crate::provider_execution_validation::validate_hash;
use crate::provider_execution_validation::validate_id;
use crate::provider_execution_validation::validate_revision;
use crate::provider_execution_validation::validate_time;

const MAX_PROJECTION_JSON_BYTES: usize = 16 * 1024;
const MAX_PROGRESS_CHARS: usize = 2_000;
const MAX_CANCEL_REASON_CHARS: usize = 1_000;
const MAX_OUTPUT_ARTIFACTS: usize = 32;

/// Bounded sequence query for one exact durable Provider Run journal.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunJournalEventPageQuery {
    pub key: ProviderRunJournalKey,
    pub after_sequence: u64,
    pub limit: u32,
}

impl fmt::Debug for ProviderRunJournalEventPageQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunJournalEventPageQuery")
            .field("key", &"[REDACTED]")
            .field("after_sequence", &self.after_sequence)
            .field("limit", &self.limit)
            .finish()
    }
}

/// Exact contiguous Provider event projections returned from one SQLite snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunJournalEventPage {
    pub journal_last_sequence: u64,
    pub events: Vec<ProviderRunJournalEventRecord>,
}

/// Bounded canonical Provider event payload persisted beside one journal event.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunEventProjectionRecord {
    pub payload_digest: String,
    pub projection_json: String,
}

impl ProviderRunEventProjectionRecord {
    pub fn new(
        event_type: &str,
        task_id: &str,
        projection_json: String,
    ) -> Result<Self, ProviderExecutionRecordError> {
        let record = Self {
            payload_digest: digest_bytes(projection_json.as_bytes()),
            projection_json,
        };
        record.validate(event_type, task_id)?;
        Ok(record)
    }

    pub fn from_projection(
        task_id: &str,
        projection: &ProviderRunEventProjection,
    ) -> Result<Self, ProviderExecutionRecordError> {
        let projection_json = serde_json::to_string(projection).map_err(|_| {
            error(
                "providerEventProjection",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            )
        })?;
        Self::new(projection.event_type(), task_id, projection_json)
    }

    pub fn decode(
        &self,
        event_type: &str,
        task_id: &str,
    ) -> Result<ProviderRunEventProjection, ProviderExecutionRecordError> {
        self.validate(event_type, task_id)?;
        serde_json::from_str(&self.projection_json).map_err(|_| {
            error(
                "providerEventProjection",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            )
        })
    }

    pub(crate) fn validate(
        &self,
        event_type: &str,
        task_id: &str,
    ) -> Result<(), ProviderExecutionRecordError> {
        validate_hash(&self.payload_digest, "providerEventPayloadDigest")?;
        if self.projection_json.len() > MAX_PROJECTION_JSON_BYTES {
            return Err(error(
                "providerEventProjection",
                ProviderExecutionRecordErrorKind::TooLong,
            ));
        }
        if self.payload_digest != digest_bytes(self.projection_json.as_bytes()) {
            return Err(error(
                "providerEventPayloadDigest",
                ProviderExecutionRecordErrorKind::DigestMismatch,
            ));
        }
        let projection: ProviderRunEventProjection = serde_json::from_str(&self.projection_json)
            .map_err(|_| {
                error(
                    "providerEventProjection",
                    ProviderExecutionRecordErrorKind::InconsistentFields,
                )
            })?;
        let canonical_json = serde_json::to_string(&projection).map_err(|_| {
            error(
                "providerEventProjection",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            )
        })?;
        if canonical_json != self.projection_json {
            return Err(error(
                "providerEventProjection",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            ));
        }
        if projection.event_type() != event_type {
            return Err(error(
                "providerEventProjectionType",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            ));
        }
        projection.validate(task_id)
    }
}

impl fmt::Debug for ProviderRunEventProjectionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunEventProjectionRecord")
            .field("payload_digest", &self.payload_digest)
            .field("projection_json", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderRunEventProjection {
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
        output_artifacts: Vec<ProviderRunOutputArtifactRef>,
    },
    Failed {
        code: ProviderRunFailureCode,
        retryable: bool,
        provider_run_id: String,
        trace_id: String,
    },
    Cancelled {
        reason: String,
    },
}

impl ProviderRunEventProjection {
    pub const fn event_type(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "runStarted",
            Self::Progress { .. } => "progress",
            Self::ApprovalRequired { .. } => "approvalRequired",
            Self::ToolResultRequired { .. } => "toolResultRequired",
            Self::ToolResultAccepted { .. } => "toolResultAccepted",
            Self::Completed { .. } => "completed",
            Self::Failed { .. } => "failed",
            Self::Cancelled { .. } => "cancelled",
        }
    }

    fn validate(&self, task_id: &str) -> Result<(), ProviderExecutionRecordError> {
        match self {
            Self::RunStarted { revision } => validate_revision(*revision, "providerEventRevision"),
            Self::Progress { summary } => {
                validate_body(summary, "providerProgressSummary", MAX_PROGRESS_CHARS)
            }
            Self::ApprovalRequired {
                approval_id,
                action_digest,
                expires_at,
            } => {
                validate_id(approval_id, "providerApprovalId")?;
                validate_hash(action_digest, "providerActionDigest")?;
                validate_time(*expires_at, "providerApprovalExpiresAt")
            }
            Self::ToolResultRequired {
                tool_call_id,
                tool_schema_revision,
                arguments_digest,
                intent_digest,
                nonce,
                expires_at,
            } => {
                validate_id(tool_call_id, "providerToolCallId")?;
                validate_id(tool_schema_revision, "providerToolSchemaRevision")?;
                validate_hash(arguments_digest, "providerArgumentsDigest")?;
                validate_hash(intent_digest, "providerIntentDigest")?;
                validate_id(nonce, "providerToolNonce")?;
                validate_time(*expires_at, "providerToolResultExpiresAt")
            }
            Self::ToolResultAccepted {
                tool_call_id,
                intent_digest,
                result_digest,
            } => {
                validate_id(tool_call_id, "providerToolCallId")?;
                validate_hash(intent_digest, "providerIntentDigest")?;
                validate_hash(result_digest, "providerResultDigest")
            }
            Self::Completed { output_artifacts } => {
                if output_artifacts.len() > MAX_OUTPUT_ARTIFACTS {
                    return Err(error(
                        "providerOutputArtifacts",
                        ProviderExecutionRecordErrorKind::TooManyItems,
                    ));
                }
                let mut identities = BTreeSet::new();
                for artifact in output_artifacts {
                    artifact.validate(task_id)?;
                    if !identities.insert((&artifact.artifact_id, artifact.revision)) {
                        return Err(error(
                            "providerOutputArtifacts",
                            ProviderExecutionRecordErrorKind::Duplicate,
                        ));
                    }
                }
                Ok(())
            }
            Self::Failed {
                code,
                retryable,
                provider_run_id,
                trace_id,
            } => {
                let _ = (code, retryable);
                validate_id(provider_run_id, "providerRunId")?;
                validate_id(trace_id, "providerTraceId")
            }
            Self::Cancelled { reason } => {
                validate_body(reason, "providerCancelReason", MAX_CANCEL_REASON_CHARS)
            }
        }
    }
}

impl fmt::Debug for ProviderRunEventProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunEventProjection")
            .field("event_type", &self.event_type())
            .field(
                "output_artifact_count",
                &match self {
                    Self::Completed { output_artifacts } => output_artifacts.len(),
                    _ => 0,
                },
            )
            .field("payload", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRunOutputArtifactRef {
    pub artifact_id: String,
    pub task_id: String,
    pub kind: ProviderRunOutputArtifactKind,
    pub revision: u64,
    pub retention: ProviderRunOutputArtifactRetention,
    pub created_at: i64,
}

impl ProviderRunOutputArtifactRef {
    fn validate(&self, task_id: &str) -> Result<(), ProviderExecutionRecordError> {
        let _ = (self.kind, self.retention);
        validate_id(&self.artifact_id, "providerOutputArtifactId")?;
        validate_id(&self.task_id, "providerOutputArtifactTaskId")?;
        validate_revision(self.revision, "providerOutputArtifactRevision")?;
        validate_time(self.created_at, "providerOutputArtifactCreatedAt")?;
        if self.task_id != task_id {
            return Err(error(
                "providerOutputArtifactTaskId",
                ProviderExecutionRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderRunOutputArtifactRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunOutputArtifactRef")
            .field("kind", &self.kind)
            .field("revision", &self.revision)
            .field("retention", &self.retention)
            .field("created_at", &self.created_at)
            .field("identity", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderRunOutputArtifactKind {
    File,
    Image,
    Report,
    Evidence,
    ToolResult,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderRunOutputArtifactRetention {
    Session,
    Task,
    UserManaged,
    Compliance,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

fn validate_body(
    value: &str,
    field: &'static str,
    max_chars: usize,
) -> Result<(), ProviderExecutionRecordError> {
    if value.is_empty() {
        return Err(error(field, ProviderExecutionRecordErrorKind::Empty));
    }
    if value.chars().count() > max_chars {
        return Err(error(field, ProviderExecutionRecordErrorKind::TooLong));
    }
    Ok(())
}
