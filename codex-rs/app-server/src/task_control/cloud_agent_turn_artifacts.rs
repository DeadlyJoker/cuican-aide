use std::fmt;

use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactIdempotencyKey;
use crewon_artifact::ArtifactKind;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::AuditEventId;
use crewon_artifact::AuditIdempotencyKey;
use crewon_artifact::CostCorrelation;
use crewon_artifact::ExecutionCorrelation;
use crewon_artifact::MediaType;
use crewon_artifact::PayloadBody;
use crewon_artifact::PayloadId;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::ResourceCorrelation;
use crewon_artifact::RetentionPolicy;
use crewon_artifact::SpanId;
use crewon_artifact::ThreadId as ArtifactThreadId;
use crewon_artifact::TurnId as ArtifactTurnId;
use crewon_artifact::VerificationStatus;
use crewon_core::context::ContextAudience;
use crewon_core::context::ContextualUserFragment;
use crewon_core::context::GovernedContextBundle;
use crewon_core::context::GovernedContextFragment;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_state::ArtifactCommitOutcome;
use crewon_state::CloudExecutionArtifactRefRecord;
use crewon_state::StateRuntime;
use crewon_task_runtime::UnixTimestamp;
use sha2::Digest;
use sha2::Sha256;

use crate::platform_control::RequestIdentity;
use crate::platform_control::artifact_adapter::ResolvedArtifactCommitInput;
use crate::platform_control::artifact_adapter::ResolvedArtifactTraceInput;
use crate::platform_control::artifact_adapter::prepare_artifact_commit;

const MAX_PROMPT_CHARS: usize = 10_000;
const CONTEXT_RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;

pub(crate) struct CloudAgentTurnArtifactRequest<'a> {
    pub(crate) state: &'a StateRuntime,
    pub(crate) identity: &'a RequestIdentity,
    pub(crate) workspace: &'a WorkspaceRef,
    pub(crate) execution_binding: &'a ResolvedResourceBinding,
    pub(crate) thread_id: &'a str,
    pub(crate) turn_id: &'a str,
    pub(crate) client_user_message_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) context_fragments: Vec<GovernedContextFragment>,
    pub(crate) now: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CloudAgentTurnArtifacts {
    pub(crate) prompt: CloudExecutionArtifactRefRecord,
    pub(crate) context: Vec<CloudExecutionArtifactRefRecord>,
    pub(crate) created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CloudAgentTurnArtifactRefs {
    pub(crate) prompt: CloudExecutionArtifactRefRecord,
    pub(crate) context: Vec<CloudExecutionArtifactRefRecord>,
}

impl fmt::Debug for CloudAgentTurnArtifacts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentTurnArtifacts")
            .field("prompt", &"[REDACTED]")
            .field("context_count", &self.context.len())
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum CloudAgentTurnArtifactError {
    #[error("Cloud Agent Turn input is invalid")]
    InvalidInput,
    #[error("Cloud Agent Turn context is invalid")]
    InvalidContext,
    #[error("Cloud Agent Turn Artifact identity conflicts with durable state")]
    ArtifactConflict,
    #[error("Cloud Agent Turn Artifact state is unavailable")]
    StateUnavailable,
}

pub(crate) async fn materialize_cloud_agent_turn_artifacts(
    request: CloudAgentTurnArtifactRequest<'_>,
) -> Result<CloudAgentTurnArtifacts, CloudAgentTurnArtifactError> {
    validate_artifact_request(&request)?;
    let expected = expected_cloud_agent_turn_artifact_refs(&request)?;

    let prompt = commit_artifact(
        &request,
        ArtifactMaterialization {
            role: "prompt".to_string(),
            body: request.prompt.as_bytes().to_vec(),
            kind: ArtifactKind::Document,
        },
    )
    .await?;
    debug_assert_eq!(prompt, expected.prompt);
    let created_at = request
        .state
        .get_artifact_record(&prompt.artifact_id, prompt.revision)
        .await
        .map_err(|_| CloudAgentTurnArtifactError::StateUnavailable)?
        .ok_or(CloudAgentTurnArtifactError::ArtifactConflict)?
        .manifest
        .created_at;
    let mut context = Vec::with_capacity(request.context_fragments.len());
    for (ordinal, fragment) in request.context_fragments.iter().enumerate() {
        context.push(
            commit_artifact(
                &request,
                ArtifactMaterialization {
                    role: format!("context:{ordinal}"),
                    body: fragment.render().into_bytes(),
                    kind: ArtifactKind::StructuredResult,
                },
            )
            .await?,
        );
    }
    debug_assert_eq!(context, expected.context);
    Ok(CloudAgentTurnArtifacts {
        prompt,
        context,
        created_at,
    })
}

pub(crate) fn expected_cloud_agent_turn_artifact_refs(
    request: &CloudAgentTurnArtifactRequest<'_>,
) -> Result<CloudAgentTurnArtifactRefs, CloudAgentTurnArtifactError> {
    validate_artifact_request(request)?;
    let prompt = artifact_ref(
        request,
        &ArtifactMaterialization {
            role: "prompt".to_string(),
            body: request.prompt.as_bytes().to_vec(),
            kind: ArtifactKind::Document,
        },
    );
    let context = request
        .context_fragments
        .iter()
        .enumerate()
        .map(|(ordinal, fragment)| {
            artifact_ref(
                request,
                &ArtifactMaterialization {
                    role: format!("context:{ordinal}"),
                    body: fragment.render().into_bytes(),
                    kind: ArtifactKind::StructuredResult,
                },
            )
        })
        .collect();
    Ok(CloudAgentTurnArtifactRefs { prompt, context })
}

fn validate_artifact_request(
    request: &CloudAgentTurnArtifactRequest<'_>,
) -> Result<(), CloudAgentTurnArtifactError> {
    if request.workspace.scope != WorkspaceScope::Conversation
        || request.workspace.scope_id != request.thread_id
        || request.workspace.workspace_key != request.execution_binding.workspace_key().as_str()
        || request.prompt.trim().is_empty()
        || request.prompt.chars().count() > MAX_PROMPT_CHARS
        || request.now < 0
    {
        return Err(CloudAgentTurnArtifactError::InvalidInput);
    }
    let audience = ContextAudience::single(&request.workspace.binding_id, request.thread_id)
        .map_err(|_| CloudAgentTurnArtifactError::InvalidContext)?;
    GovernedContextBundle::new(audience, request.context_fragments.clone())
        .map_err(|_| CloudAgentTurnArtifactError::InvalidContext)?;
    Ok(())
}

struct ArtifactMaterialization {
    role: String,
    body: Vec<u8>,
    kind: ArtifactKind,
}

async fn commit_artifact(
    request: &CloudAgentTurnArtifactRequest<'_>,
    artifact: ArtifactMaterialization,
) -> Result<CloudExecutionArtifactRefRecord, CloudAgentTurnArtifactError> {
    let seed = artifact_seed(request, &artifact);
    let reference = artifact_ref(request, &artifact);
    let artifact_id = reference.artifact_id.clone();
    let payload_id = stable_id("cloud-agent-payload", &seed);
    let existing = request
        .state
        .get_artifact_record(&artifact_id, /*revision*/ 1)
        .await
        .map_err(|_| CloudAgentTurnArtifactError::StateUnavailable)?;
    let created_at = existing
        .as_ref()
        .map_or(request.now, |record| record.manifest.created_at);
    let expires_at = existing
        .as_ref()
        .and_then(|record| record.payload.expires_at)
        .unwrap_or_else(|| request.now.saturating_add(CONTEXT_RETENTION_SECONDS));
    if expires_at <= created_at {
        return Err(CloudAgentTurnArtifactError::ArtifactConflict);
    }
    let record = prepare_artifact_commit(
        request.identity,
        request.workspace,
        ResolvedArtifactCommitInput {
            artifact_id: ArtifactId::new(&artifact_id)
                .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            revision: ArtifactRevision::new(/*value*/ 1)
                .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            artifact_idempotency_key: ArtifactIdempotencyKey::new(stable_id(
                "cloud-agent-artifact-create",
                &seed,
            ))
            .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            kind: artifact.kind,
            payload_id: PayloadId::new(payload_id)
                .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            body: PayloadBody::new(artifact.body, PayloadSensitivity::WorkspaceSensitive)
                .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            media_type: MediaType::new("text/plain")
                .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            execution: ExecutionCorrelation::Conversation {
                thread_id: ArtifactThreadId::new(request.thread_id)
                    .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
                turn_id: ArtifactTurnId::new(request.turn_id)
                    .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            },
            resource: ResourceCorrelation::Resource {
                resource: request.execution_binding.resource().clone(),
            },
            approval: ApprovalCorrelation::None,
            trace: ResolvedArtifactTraceInput {
                span_id: SpanId::new(stable_id("cloud-agent-artifact-span", &seed))
                    .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
                parent_span_id: None,
            },
            cost: CostCorrelation::None,
            verification: VerificationStatus::Verified,
            retention: RetentionPolicy::Task {
                expires_at: UnixTimestamp::new(expires_at)
                    .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            },
            event_id: AuditEventId::new(stable_id("cloud-agent-artifact-event", &seed))
                .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            audit_idempotency_key: AuditIdempotencyKey::new(stable_id(
                "cloud-agent-artifact-audit",
                &seed,
            ))
            .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
            created_at: UnixTimestamp::new(created_at)
                .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?,
        },
    )
    .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?
    .into_state_record()
    .map_err(|_| CloudAgentTurnArtifactError::InvalidInput)?;
    match request
        .state
        .commit_artifact_record(&record)
        .await
        .map_err(|_| CloudAgentTurnArtifactError::StateUnavailable)?
    {
        ArtifactCommitOutcome::Created | ArtifactCommitOutcome::ExistingSame => Ok(reference),
        ArtifactCommitOutcome::Conflict => Err(CloudAgentTurnArtifactError::ArtifactConflict),
    }
}

fn artifact_ref(
    request: &CloudAgentTurnArtifactRequest<'_>,
    artifact: &ArtifactMaterialization,
) -> CloudExecutionArtifactRefRecord {
    CloudExecutionArtifactRefRecord {
        artifact_id: stable_id("cloud-agent-artifact", &artifact_seed(request, artifact)),
        revision: 1,
    }
}

fn artifact_seed(
    request: &CloudAgentTurnArtifactRequest<'_>,
    artifact: &ArtifactMaterialization,
) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.cloud-agent-turn-artifact.v1\0");
    for part in [
        request.workspace.workspace_key.as_bytes(),
        request.workspace.binding_id.as_bytes(),
        request.execution_binding.binding_id().as_str().as_bytes(),
        request.thread_id.as_bytes(),
        request.turn_id.as_bytes(),
        request.client_user_message_id.as_bytes(),
        artifact.role.as_bytes(),
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().to_vec()
}

fn stable_id(prefix: &str, seed: &[u8]) -> String {
    let digest = Sha256::digest(seed);
    format!("{prefix}:{digest:x}")
}

#[cfg(test)]
#[path = "cloud_agent_turn_artifacts_tests.rs"]
mod tests;
