use std::fmt;
use std::future::Future;
use std::sync::Arc;

use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactIdempotencyKey;
use crewon_artifact::ArtifactRef;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::AuditAction;
use crewon_artifact::AuditEvent;
use crewon_artifact::AuditEventId;
use crewon_artifact::AuditEventInput;
use crewon_artifact::AuditIdempotencyKey;
use crewon_artifact::AuditOutcome;
use crewon_artifact::AuditPayloadLink;
use crewon_artifact::CostCorrelation;
use crewon_artifact::ExecutionCorrelation;
use crewon_artifact::MediaType;
use crewon_artifact::PayloadBody;
use crewon_artifact::PayloadId;
use crewon_artifact::ResourceCorrelation;
use crewon_artifact::RunId;
use crewon_artifact::ThreadId;
use crewon_artifact::TraceContext;
use crewon_artifact::TurnId;
use crewon_artifact::VerificationStatus;
use crewon_policy::PolicyActor;
use crewon_provider_agent_platform::ProviderArtifactKind;
use crewon_provider_agent_platform::ProviderArtifactRetention;
use crewon_provider_agent_platform::ProviderRunArtifactContent;
use crewon_resource_federation::ResourceKind;
use crewon_state::ArtifactCommitOutcome;
use crewon_state::AuditAppendOutcome;
use crewon_state::PlatformAuditEventRecord;
use crewon_state::StateRuntime;
use crewon_task_runtime::AttemptId;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::UnixTimestamp;
use sha2::Digest;
use sha2::Sha256;

use self::identity::import_digest;
use self::identity::local_artifact_kind;
use self::identity::local_retention;
use self::identity::media_type;
use self::identity::payload_sensitivity;
use self::identity::source_digest;
use crate::platform_control::artifact_adapter::ResolvedArtifactCommitInput;
use crate::platform_control::artifact_adapter::ResolvedArtifactTraceInput;
use crate::platform_control::artifact_adapter::prepare_artifact_commit_resolved;

const MAX_PROVIDER_RUN_ID_BYTES: usize = 255;
const MAX_CLOCK_SKEW_SECONDS: i64 = 30;
const PROVIDER_ARTIFACT_LIFETIME_SECONDS: i64 = 7 * 24 * 60 * 60;

#[path = "provider_run_artifact_importer_identity.rs"]
mod identity;

/// Exact server-owned correlations and verified bytes for one Provider Run output revision.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct ProviderRunOutputArtifactImportRequest {
    pub(super) actor: PolicyActor,
    pub(super) workspace: ArtifactWorkspace,
    pub(super) task_id: TaskId,
    pub(super) run_id: RunId,
    pub(super) attempt_id: AttemptId,
    pub(super) thread_id: ThreadId,
    pub(super) turn_id: TurnId,
    pub(super) provider_run_id: String,
    pub(super) trace: TraceContext,
    pub(super) content: ProviderRunArtifactContent,
    pub(super) observed_at: UnixTimestamp,
    pub(super) now: UnixTimestamp,
}

impl fmt::Debug for ProviderRunOutputArtifactImportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunOutputArtifactImportRequest")
            .field("task_id", &self.task_id)
            .field("run_id", &self.run_id)
            .field("attempt_id", &self.attempt_id)
            .field("thread_id", &self.thread_id)
            .field("turn_id", &self.turn_id)
            .field("provider_run_id", &self.provider_run_id)
            .field("observed_at", &self.observed_at)
            .field("resource", self.content.authorization().resource())
            .field("artifact", self.content.artifact())
            .field("content_digest", &self.content.content_digest())
            .field("byte_length", &self.content.bytes().len())
            .field("content", &"[REDACTED]")
            .finish()
    }
}

/// Durable local result returned only after the Task Artifact and Turn Audit both exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ProviderRunOutputArtifactImportResult {
    artifact: ArtifactRef,
    association_audit_event_id: AuditEventId,
}

impl ProviderRunOutputArtifactImportResult {
    pub(super) fn artifact(&self) -> &ArtifactRef {
        &self.artifact
    }

    pub(super) fn association_audit_event_id(&self) -> &AuditEventId {
        &self.association_audit_event_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProviderRunOutputArtifactImportError {
    InvalidCorrelation,
    UnsupportedArtifact,
    Expired,
    StateUnavailable,
    Conflict,
}

impl fmt::Display for ProviderRunOutputArtifactImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Provider Run output Artifact import failed: {self:?}"
        )
    }
}

impl std::error::Error for ProviderRunOutputArtifactImportError {}

/// Imports already verified Provider Run output bytes into local Artifact and Audit authority.
///
/// Implementations must be idempotent across restart and must not expose payload bytes through
/// Debug, Display, errors, Artifact metadata, or Audit metadata.
pub(super) trait ProviderRunOutputArtifactImporter: Send + Sync {
    fn import(
        &self,
        request: ProviderRunOutputArtifactImportRequest,
    ) -> impl Future<
        Output = Result<
            ProviderRunOutputArtifactImportResult,
            ProviderRunOutputArtifactImportError,
        >,
    > + Send;
}

pub(super) struct StateProviderRunOutputArtifactImporter {
    state: Arc<StateRuntime>,
}

impl StateProviderRunOutputArtifactImporter {
    pub(super) fn new(state: Arc<StateRuntime>) -> Self {
        Self { state }
    }
}

impl ProviderRunOutputArtifactImporter for StateProviderRunOutputArtifactImporter {
    async fn import(
        &self,
        request: ProviderRunOutputArtifactImportRequest,
    ) -> Result<ProviderRunOutputArtifactImportResult, ProviderRunOutputArtifactImportError> {
        let prepared = prepare_import(&request)?;
        let record = prepared
            .commit
            .into_state_record()
            .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
        match self
            .state
            .commit_artifact_record(&record)
            .await
            .map_err(|_| ProviderRunOutputArtifactImportError::StateUnavailable)?
        {
            ArtifactCommitOutcome::Created | ArtifactCommitOutcome::ExistingSame => {}
            ArtifactCommitOutcome::Conflict => {
                return Err(ProviderRunOutputArtifactImportError::Conflict);
            }
        }
        match self
            .state
            .append_platform_audit_event(&prepared.association_audit)
            .await
            .map_err(|_| ProviderRunOutputArtifactImportError::StateUnavailable)?
        {
            AuditAppendOutcome::Created | AuditAppendOutcome::ExistingSame => {
                Ok(ProviderRunOutputArtifactImportResult {
                    artifact: prepared.artifact,
                    association_audit_event_id: prepared.association_audit_event_id,
                })
            }
            AuditAppendOutcome::Conflict => Err(ProviderRunOutputArtifactImportError::Conflict),
        }
    }
}

struct PreparedImport {
    commit: crate::platform_control::artifact_adapter::PreparedArtifactCommit,
    artifact: ArtifactRef,
    association_audit: PlatformAuditEventRecord,
    association_audit_event_id: AuditEventId,
}

fn prepare_import(
    request: &ProviderRunOutputArtifactImportRequest,
) -> Result<PreparedImport, ProviderRunOutputArtifactImportError> {
    validate_request(request)?;
    let artifact = request.content.artifact();
    let source_digest = source_digest(request)?;
    let import_digest = import_digest(request, &source_digest)?;
    let local_artifact = ArtifactRef::new(
        ArtifactId::new(format!("provider-run-result:{source_digest}"))
            .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
        ArtifactRevision::new(artifact.revision())
            .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
    );
    let body = PayloadBody::new(
        request.content.bytes().to_vec(),
        payload_sensitivity(request.content.sensitivity()),
    )
    .map_err(|_| ProviderRunOutputArtifactImportError::UnsupportedArtifact)?;
    if body.digest().as_str() != request.content.content_digest() {
        return Err(ProviderRunOutputArtifactImportError::InvalidCorrelation);
    }
    let created_at = request.observed_at;
    let expires_at = UnixTimestamp::new(
        artifact
            .created_at()
            .checked_add(PROVIDER_ARTIFACT_LIFETIME_SECONDS)
            .ok_or(ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
    )
    .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
    let resource = ResourceCorrelation::Resource {
        resource: request.content.authorization().resource().clone(),
    };
    let task_execution = ExecutionCorrelation::Task {
        task_id: request.task_id.clone(),
        run_id: request.run_id.clone(),
        attempt_id: request.attempt_id.clone(),
    };
    let trace_input = ResolvedArtifactTraceInput {
        span_id: request.trace.span_id().clone(),
        parent_span_id: request.trace.parent_span_id().cloned(),
    };
    let commit = prepare_artifact_commit_resolved(
        request.actor.clone(),
        request.workspace.clone(),
        request.trace.clone(),
        ResolvedArtifactCommitInput {
            artifact_id: local_artifact.artifact_id().clone(),
            revision: local_artifact.revision(),
            artifact_idempotency_key: ArtifactIdempotencyKey::new(format!(
                "provider-run-import:{import_digest}"
            ))
            .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
            kind: local_artifact_kind(artifact.kind())?,
            payload_id: PayloadId::new(format!("provider-run-payload:{import_digest}"))
                .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
            body,
            media_type: MediaType::new(media_type(request.content.media_type()))
                .map_err(|_| ProviderRunOutputArtifactImportError::UnsupportedArtifact)?,
            execution: task_execution,
            resource: resource.clone(),
            approval: ApprovalCorrelation::None,
            trace: trace_input,
            cost: CostCorrelation::None,
            verification: VerificationStatus::Verified,
            retention: local_retention(artifact.retention(), expires_at)?,
            event_id: AuditEventId::new(format!("provider-run-artifact-event:{import_digest}"))
                .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
            audit_idempotency_key: AuditIdempotencyKey::new(format!(
                "provider-run-artifact-audit:{import_digest}"
            ))
            .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
            created_at,
        },
    )
    .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
    let association_audit_event_id =
        AuditEventId::new(format!("provider-run-turn-event:{import_digest}"))
            .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
    let association = AuditEvent::new(AuditEventInput {
        event_id: association_audit_event_id.clone(),
        idempotency_key: AuditIdempotencyKey::new(format!(
            "provider-run-turn-audit:{import_digest}"
        ))
        .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
        actor: request.actor.clone(),
        workspace: request.workspace.clone(),
        execution: ExecutionCorrelation::Conversation {
            thread_id: request.thread_id.clone(),
            turn_id: request.turn_id.clone(),
        },
        action: AuditAction::ExternalAction,
        outcome: AuditOutcome::Succeeded,
        trace: request.trace.clone(),
        cost: CostCorrelation::None,
        resource,
        approval: ApprovalCorrelation::None,
        artifacts: vec![local_artifact.clone()],
        payload: AuditPayloadLink::None,
        occurred_at: created_at,
    })
    .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
    let association_audit = PlatformAuditEventRecord {
        event_id: association.event_id().as_str().to_string(),
        idempotency_key: association.idempotency_key().as_str().to_string(),
        event_type: "externalAction".to_string(),
        metadata_json: serde_json::to_string(&association)
            .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?,
        payload_id: None,
        occurred_at: association.occurred_at().get(),
    };
    association_audit
        .validate()
        .map_err(|_| ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
    Ok(PreparedImport {
        commit,
        artifact: local_artifact,
        association_audit,
        association_audit_event_id,
    })
}

fn validate_request(
    request: &ProviderRunOutputArtifactImportRequest,
) -> Result<(), ProviderRunOutputArtifactImportError> {
    let artifact = request.content.artifact();
    if request.provider_run_id.is_empty()
        || request.provider_run_id.len() > MAX_PROVIDER_RUN_ID_BYTES
        || request.provider_run_id.chars().any(char::is_control)
        || request.task_id.as_str() != request.content.authorization().task_id()
        || artifact.task_id() != request.task_id.as_str()
        || request.content.authorization().resource().kind != ResourceKind::Agent
        || request.content.content_digest()
            != format!("sha256:{:x}", Sha256::digest(request.content.bytes()))
    {
        return Err(ProviderRunOutputArtifactImportError::InvalidCorrelation);
    }
    if artifact.kind() == ProviderArtifactKind::Image
        || !matches!(
            artifact.retention(),
            ProviderArtifactRetention::Session | ProviderArtifactRetention::Task
        )
    {
        return Err(ProviderRunOutputArtifactImportError::UnsupportedArtifact);
    }
    let expires_at = artifact
        .created_at()
        .checked_add(PROVIDER_ARTIFACT_LIFETIME_SECONDS)
        .ok_or(ProviderRunOutputArtifactImportError::InvalidCorrelation)?;
    let observed_at_is_current = request
        .now
        .get()
        .checked_add(MAX_CLOCK_SKEW_SECONDS)
        .is_some_and(|latest| request.observed_at.get() <= latest);
    if request.observed_at.get() < artifact.created_at() || !observed_at_is_current {
        return Err(ProviderRunOutputArtifactImportError::InvalidCorrelation);
    }
    if request.observed_at.get() >= expires_at || request.now.get() >= expires_at {
        return Err(ProviderRunOutputArtifactImportError::Expired);
    }
    Ok(())
}

#[cfg(test)]
#[path = "provider_run_artifact_importer_tests.rs"]
mod tests;
