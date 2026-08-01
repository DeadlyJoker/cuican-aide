use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactIdempotencyKey;
use crewon_artifact::ArtifactKind;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::ArtifactWorkspaceScope;
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
use crewon_artifact::TraceContext;
use crewon_artifact::TraceId;
use crewon_artifact::TurnId as ArtifactTurnId;
use crewon_artifact::VerificationStatus;
use crewon_artifact::WorkspaceScopeId;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::WorkspaceKey;
use crewon_state::ArtifactCommitOutcome;
use crewon_state::CloudExecutionArtifactRefRecord;
use crewon_state::StateRuntime;
use crewon_task_runtime::UnixTimestamp;

use super::cloud_agent_legacy_import_source::LegacySessionSource;
use super::cloud_agent_legacy_importer::CloudAgentLegacySessionImportError;
use super::cloud_agent_legacy_importer::CloudAgentLegacySessionImportRequest;
use super::cloud_agent_legacy_importer::stable_digest;
use super::cloud_agent_legacy_importer::stable_id;
use crate::platform_control::artifact_adapter::ResolvedArtifactCommitInput;
use crate::platform_control::artifact_adapter::ResolvedArtifactTraceInput;
use crate::platform_control::artifact_adapter::prepare_artifact_commit_resolved;

#[allow(clippy::too_many_arguments)]
pub(super) async fn commit_legacy_artifact(
    state: &StateRuntime,
    request: &CloudAgentLegacySessionImportRequest<'_>,
    source: &LegacySessionSource,
    turn_id: &str,
    ordinal: usize,
    role: &str,
    body: &str,
    imported_at: i64,
) -> Result<CloudExecutionArtifactRefRecord, CloudAgentLegacySessionImportError> {
    let seed = stable_digest(&[
        source.source_key.as_bytes(),
        source.source_digest.as_bytes(),
        request.thread_id.as_bytes(),
        request.execution_binding.binding_id().as_str().as_bytes(),
        ordinal.to_string().as_bytes(),
        role.as_bytes(),
    ]);
    let reference = CloudExecutionArtifactRefRecord {
        artifact_id: stable_id("legacy-artifact", seed.as_bytes()),
        revision: 1,
    };
    let trace_id = stable_id("legacy-artifact-trace", seed.as_bytes());
    let span_id = SpanId::new(stable_id("legacy-artifact-span", seed.as_bytes()))
        .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?;
    let actor = request
        .identity
        .policy_actor()
        .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?;
    let artifact_workspace = ArtifactWorkspace::new(
        WorkspaceKey::new(&request.workspace.workspace_key)
            .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
        BindingId::new(&request.workspace.binding_id)
            .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
        ArtifactWorkspaceScope::Conversation,
        WorkspaceScopeId::new(&request.workspace.scope_id)
            .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
    );
    let trace = TraceContext::root(
        TraceId::new(&trace_id).map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
        span_id.clone(),
    );
    let record = prepare_artifact_commit_resolved(
        actor,
        artifact_workspace,
        trace,
        ResolvedArtifactCommitInput {
            artifact_id: ArtifactId::new(&reference.artifact_id)
                .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            revision: ArtifactRevision::new(/*value*/ 1)
                .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            artifact_idempotency_key: ArtifactIdempotencyKey::new(stable_id(
                "legacy-artifact-create",
                seed.as_bytes(),
            ))
            .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            kind: ArtifactKind::Document,
            payload_id: PayloadId::new(stable_id("legacy-payload", seed.as_bytes()))
                .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            body: PayloadBody::new(
                body.as_bytes().to_vec(),
                PayloadSensitivity::WorkspaceSensitive,
            )
            .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            media_type: MediaType::new("text/plain")
                .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            execution: ExecutionCorrelation::Conversation {
                thread_id: ArtifactThreadId::new(request.thread_id)
                    .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
                turn_id: ArtifactTurnId::new(turn_id)
                    .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            },
            resource: ResourceCorrelation::Resource {
                resource: request.execution_binding.resource().clone(),
            },
            approval: ApprovalCorrelation::None,
            trace: ResolvedArtifactTraceInput {
                span_id,
                parent_span_id: None,
            },
            cost: CostCorrelation::None,
            verification: VerificationStatus::Verified,
            retention: RetentionPolicy::UserManaged,
            event_id: AuditEventId::new(stable_id("legacy-artifact-event", seed.as_bytes()))
                .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            audit_idempotency_key: AuditIdempotencyKey::new(stable_id(
                "legacy-artifact-audit",
                seed.as_bytes(),
            ))
            .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
            created_at: UnixTimestamp::new(imported_at)
                .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?,
        },
    )
    .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?
    .into_state_record()
    .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?;
    match state
        .commit_artifact_record(&record)
        .await
        .map_err(|_| CloudAgentLegacySessionImportError::StateUnavailable)?
    {
        ArtifactCommitOutcome::Created | ArtifactCommitOutcome::ExistingSame => Ok(reference),
        ArtifactCommitOutcome::Conflict => {
            Err(CloudAgentLegacySessionImportError::ArtifactConflict)
        }
    }
}
