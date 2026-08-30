use crate::AgentPlatformProviderError;
use crate::ProviderArtifactKind;
use crate::ProviderArtifactRef;
use crate::ProviderArtifactRetention;
use crate::ProviderRunCancelRequest;
use crate::ProviderRunCancelResult;
use crate::ProviderRunCancelStatus;
use crate::ProviderRunEventsRequest;
use crate::ProviderRunReadRequest;
use crate::ProviderRunSnapshot;
use crate::ProviderRunStartRequest;
use crate::ProviderRunStartResult;
use crate::ProviderRunStatus;
use crate::wire::ResourceRefWire;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ArtifactKindWire {
    File,
    Image,
    Report,
    Evidence,
    ToolResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ArtifactRetentionWire {
    Session,
    Task,
    UserManaged,
    Compliance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArtifactRefWire {
    artifact_id: String,
    task_id: String,
    kind: ArtifactKindWire,
    revision: u64,
    retention: ArtifactRetentionWire,
    created_at: i64,
}

impl ArtifactRefWire {
    pub(crate) fn from_domain(artifact: &ProviderArtifactRef) -> Self {
        Self {
            artifact_id: artifact.artifact_id().to_string(),
            task_id: artifact.task_id().to_string(),
            kind: match artifact.kind() {
                ProviderArtifactKind::File => ArtifactKindWire::File,
                ProviderArtifactKind::Image => ArtifactKindWire::Image,
                ProviderArtifactKind::Report => ArtifactKindWire::Report,
                ProviderArtifactKind::Evidence => ArtifactKindWire::Evidence,
                ProviderArtifactKind::ToolResult => ArtifactKindWire::ToolResult,
            },
            revision: artifact.revision(),
            retention: match artifact.retention() {
                ProviderArtifactRetention::Session => ArtifactRetentionWire::Session,
                ProviderArtifactRetention::Task => ArtifactRetentionWire::Task,
                ProviderArtifactRetention::UserManaged => ArtifactRetentionWire::UserManaged,
                ProviderArtifactRetention::Compliance => ArtifactRetentionWire::Compliance,
            },
            created_at: artifact.created_at(),
        }
    }

    pub(crate) fn into_domain(self) -> Result<ProviderArtifactRef, AgentPlatformProviderError> {
        ProviderArtifactRef::new(
            self.artifact_id,
            self.task_id,
            match self.kind {
                ArtifactKindWire::File => ProviderArtifactKind::File,
                ArtifactKindWire::Image => ProviderArtifactKind::Image,
                ArtifactKindWire::Report => ProviderArtifactKind::Report,
                ArtifactKindWire::Evidence => ProviderArtifactKind::Evidence,
                ArtifactKindWire::ToolResult => ProviderArtifactKind::ToolResult,
            },
            self.revision,
            match self.retention {
                ArtifactRetentionWire::Session => ProviderArtifactRetention::Session,
                ArtifactRetentionWire::Task => ProviderArtifactRetention::Task,
                ArtifactRetentionWire::UserManaged => ProviderArtifactRetention::UserManaged,
                ArtifactRetentionWire::Compliance => ProviderArtifactRetention::Compliance,
            },
            self.created_at,
        )
        .map_err(|_| AgentPlatformProviderError::InvalidResponse)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StartCommandType {
    Start,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRunInputWire {
    prompt: String,
    context_refs: Vec<ArtifactRefWire>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartCommandWire {
    #[serde(rename = "type")]
    command_type: StartCommandType,
    command_id: String,
    idempotency_key: String,
    request_digest: String,
    resource: ResourceRefWire,
    input: ProviderRunInputWire,
}

impl StartCommandWire {
    pub(crate) fn from_domain(
        request: &ProviderRunStartRequest,
    ) -> Result<Self, AgentPlatformProviderError> {
        Ok(Self {
            command_type: StartCommandType::Start,
            command_id: request.command_id().to_string(),
            idempotency_key: request.idempotency_key().to_string(),
            request_digest: request.request_digest().to_string(),
            resource: ResourceRefWire::from_domain(request.authorization().resource())?,
            input: ProviderRunInputWire {
                prompt: request.prompt().to_string(),
                context_refs: request
                    .context_refs()
                    .iter()
                    .map(ArtifactRefWire::from_domain)
                    .collect(),
            },
        })
    }
}

macro_rules! run_command_wire {
    ($name:ident, $kind:ident, $tag:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        enum $kind { $tag }

        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub(crate) struct $name {
            #[serde(rename = "type")]
            command_type: $kind,
            command_id: String,
            provider_run_id: String,
            $($field: $ty,)*
        }
    };
}

run_command_wire!(ReadCommandWire, ReadCommandType, Read {});
run_command_wire!(ListEventsCommandWire, ListEventsCommandType, ListEvents {
    after_cursor: Option<String>,
    limit: u16,
});
run_command_wire!(
    CancelCommandWire,
    CancelCommandType,
    Cancel {
        reason: String,
        expected_revision: u64,
    }
);

impl From<&ProviderRunReadRequest> for ReadCommandWire {
    fn from(request: &ProviderRunReadRequest) -> Self {
        Self {
            command_type: ReadCommandType::Read,
            command_id: request.command_id().to_string(),
            provider_run_id: request.provider_run_id().to_string(),
        }
    }
}

impl From<&ProviderRunEventsRequest> for ListEventsCommandWire {
    fn from(request: &ProviderRunEventsRequest) -> Self {
        Self {
            command_type: ListEventsCommandType::ListEvents,
            command_id: request.command_id().to_string(),
            provider_run_id: request.provider_run_id().to_string(),
            after_cursor: request.after_cursor().map(str::to_string),
            limit: request.limit(),
        }
    }
}

impl From<&ProviderRunCancelRequest> for CancelCommandWire {
    fn from(request: &ProviderRunCancelRequest) -> Self {
        Self {
            command_type: CancelCommandType::Cancel,
            command_id: request.command_id().to_string(),
            provider_run_id: request.provider_run_id().to_string(),
            reason: request.reason().to_string(),
            expected_revision: request.expected_revision(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartResponseWire {
    provider_run_id: String,
    attempt_id: String,
    created: bool,
}

impl StartResponseWire {
    pub(crate) fn into_domain(self) -> Result<ProviderRunStartResult, AgentPlatformProviderError> {
        ProviderRunStartResult::new(self.provider_run_id, self.attempt_id, self.created)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RunStatusWire {
    Queued,
    Running,
    Suspended,
    Reconciling,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadResponseWire {
    provider_run_id: String,
    attempt_id: String,
    status: RunStatusWire,
    revision: u64,
    last_sequence: u64,
    created_at: i64,
    updated_at: i64,
}

impl ReadResponseWire {
    pub(crate) fn into_domain(
        self,
        requested_run_id: &str,
    ) -> Result<ProviderRunSnapshot, AgentPlatformProviderError> {
        if self.provider_run_id != requested_run_id {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        ProviderRunSnapshot::new(
            self.provider_run_id,
            self.attempt_id,
            match self.status {
                RunStatusWire::Queued => ProviderRunStatus::Queued,
                RunStatusWire::Running => ProviderRunStatus::Running,
                RunStatusWire::Suspended => ProviderRunStatus::Suspended,
                RunStatusWire::Reconciling => ProviderRunStatus::Reconciling,
                RunStatusWire::Completed => ProviderRunStatus::Completed,
                RunStatusWire::Failed => ProviderRunStatus::Failed,
                RunStatusWire::Cancelled => ProviderRunStatus::Cancelled,
            },
            self.revision,
            self.last_sequence,
            self.created_at,
            self.updated_at,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CancelStatusWire {
    CancelRequested,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelResponseWire {
    status: CancelStatusWire,
    revision: u64,
    duplicate: bool,
}

impl CancelResponseWire {
    pub(crate) fn into_domain(self) -> Result<ProviderRunCancelResult, AgentPlatformProviderError> {
        ProviderRunCancelResult::new(
            match self.status {
                CancelStatusWire::CancelRequested => ProviderRunCancelStatus::CancelRequested,
                CancelStatusWire::Cancelled => ProviderRunCancelStatus::Cancelled,
            },
            self.revision,
            self.duplicate,
        )
    }
}

#[cfg(test)]
#[path = "run_wire_tests.rs"]
mod tests;
