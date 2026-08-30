use std::sync::Arc;

use crewon_app_server_protocol::WorkspaceScope;
use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactIdempotencyKey;
use crewon_artifact::ArtifactKind;
use crewon_artifact::ArtifactRef;
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
use crewon_artifact::ThreadId;
use crewon_artifact::TraceContext;
use crewon_artifact::TraceId;
use crewon_artifact::TurnId;
use crewon_artifact::VerificationStatus;
use crewon_artifact::WorkspaceScopeId;
use crewon_policy::AccessDecisionId;
use crewon_policy::ActionDigest;
use crewon_policy::ApprovalId;
use crewon_policy::PolicyActor;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_state::ArtifactCommitOutcome;
use crewon_state::ProviderResourceKind;
use crewon_state::StateRuntime;
use crewon_task_runtime::UnixTimestamp;
use sha2::Digest;
use sha2::Sha256;

use super::provider_executor::ProviderArtifactImportError;
use super::provider_executor::ProviderDynamicArtifactImportRequest;
use super::provider_executor::ProviderDynamicArtifactImporter;
use crate::platform_control::artifact_adapter::ResolvedArtifactCommitInput;
use crate::platform_control::artifact_adapter::ResolvedArtifactTraceInput;
use crate::platform_control::artifact_adapter::prepare_artifact_commit_resolved;
use crate::platform_control::provider_connection_descriptor::ProviderConnectionClock;

const IMPORT_RETENTION_SECONDS: i64 = 60 * 60;

/// Imports verified Provider result bytes into the local durable Artifact store.
pub(crate) struct StateProviderDynamicArtifactImporter<Clock> {
    state: Arc<StateRuntime>,
    clock: Clock,
}

impl<Clock> StateProviderDynamicArtifactImporter<Clock>
where
    Clock: ProviderConnectionClock,
{
    pub(crate) fn new(state: Arc<StateRuntime>, clock: Clock) -> Self {
        Self { state, clock }
    }
}

impl<Clock> ProviderDynamicArtifactImporter for StateProviderDynamicArtifactImporter<Clock>
where
    Clock: ProviderConnectionClock + Send + Sync,
{
    async fn import(
        &self,
        request: ProviderDynamicArtifactImportRequest,
    ) -> Result<ArtifactRef, ProviderArtifactImportError> {
        let now = self.clock.now();
        let expires_at = now
            .checked_add(IMPORT_RETENTION_SECONDS)
            .ok_or(ProviderArtifactImportError::InvalidResponse)?;
        let artifact_ref = local_artifact_ref(&request)?;
        let body = PayloadBody::new(
            request.content.bytes().to_vec(),
            if request.content.workspace_sensitive() {
                PayloadSensitivity::WorkspaceSensitive
            } else {
                PayloadSensitivity::Internal
            },
        )
        .map_err(|_| ProviderArtifactImportError::InvalidResponse)?;
        if body.digest().as_str() != request.artifact.content_digest().as_str() {
            return Err(ProviderArtifactImportError::InvalidResponse);
        }
        let correlation = correlation(&request)?;
        let digest = import_digest(&request);
        let commit = prepare_artifact_commit_resolved(
            correlation.actor,
            correlation.workspace,
            correlation.trace,
            ResolvedArtifactCommitInput {
                artifact_id: artifact_ref.artifact_id().clone(),
                revision: artifact_ref.revision(),
                artifact_idempotency_key: ArtifactIdempotencyKey::new(format!(
                    "provider-dynamic-import:{digest}"
                ))
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                kind: ArtifactKind::StructuredResult,
                payload_id: PayloadId::new(format!("provider-dynamic-payload:{digest}"))
                    .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                body,
                media_type: MediaType::new(request.content.media_type())
                    .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                execution: correlation.execution,
                resource: correlation.resource,
                approval: correlation.approval,
                trace: ResolvedArtifactTraceInput {
                    span_id: SpanId::new(&request.claim.span_id)
                        .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                    parent_span_id: request
                        .claim
                        .parent_span_id
                        .as_deref()
                        .map(SpanId::new)
                        .transpose()
                        .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                },
                cost: CostCorrelation::None,
                verification: VerificationStatus::Verified,
                retention: RetentionPolicy::Session {
                    expires_at: UnixTimestamp::new(expires_at)
                        .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                },
                event_id: AuditEventId::new(format!("provider-dynamic-event:{digest}"))
                    .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                audit_idempotency_key: AuditIdempotencyKey::new(format!(
                    "provider-dynamic-audit:{digest}"
                ))
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
                created_at: UnixTimestamp::new(now)
                    .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
            },
        )
        .map_err(|_| ProviderArtifactImportError::InvalidResponse)?;
        let record = commit
            .into_state_record()
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?;
        match self
            .state
            .commit_artifact_record(&record)
            .await
            .map_err(|_| ProviderArtifactImportError::Unavailable)?
        {
            ArtifactCommitOutcome::Created | ArtifactCommitOutcome::ExistingSame => {
                Ok(artifact_ref)
            }
            ArtifactCommitOutcome::Conflict => Err(ProviderArtifactImportError::InvalidResponse),
        }
    }
}

struct ImportCorrelation {
    actor: PolicyActor,
    workspace: ArtifactWorkspace,
    trace: TraceContext,
    execution: ExecutionCorrelation,
    resource: ResourceCorrelation,
    approval: ApprovalCorrelation,
}

fn correlation(
    request: &ProviderDynamicArtifactImportRequest,
) -> Result<ImportCorrelation, ProviderArtifactImportError> {
    let claim = &request.claim;
    let tenant_id = claim
        .tenant_id
        .as_deref()
        .ok_or(ProviderArtifactImportError::Unauthorized)?;
    let space_id = claim
        .space_id
        .as_deref()
        .ok_or(ProviderArtifactImportError::Unauthorized)?;
    let actor = PolicyActor::space_user(&claim.actor_id, tenant_id, space_id)
        .map_err(|_| ProviderArtifactImportError::Unauthorized)?;
    let workspace = ArtifactWorkspace::new(
        WorkspaceKey::new(&claim.workspace_key)
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        BindingId::new(&claim.workspace_binding_id)
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        workspace_scope(claim.workspace_scope),
        WorkspaceScopeId::new(&claim.workspace_scope_id)
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
    );
    let trace_id =
        TraceId::new(&claim.trace_id).map_err(|_| ProviderArtifactImportError::InvalidResponse)?;
    let span_id =
        SpanId::new(&claim.span_id).map_err(|_| ProviderArtifactImportError::InvalidResponse)?;
    let trace = match claim.parent_span_id.as_deref() {
        Some(parent) => TraceContext::child(
            trace_id,
            span_id,
            SpanId::new(parent).map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        ),
        None => Ok(TraceContext::root(trace_id, span_id)),
    }
    .map_err(|_| ProviderArtifactImportError::InvalidResponse)?;
    let resource = ResourceCorrelation::Resource {
        resource: provider_resource(claim)?,
    };
    let approval = match claim.approval_id.as_deref() {
        Some(approval_id) => ApprovalCorrelation::Decision {
            approval_id: ApprovalId::new(approval_id)
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
            access_decision_id: AccessDecisionId::new(&claim.access_decision_id)
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
            action_digest: ActionDigest::parse(&claim.action_digest)
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        },
        None => ApprovalCorrelation::None,
    };
    Ok(ImportCorrelation {
        actor,
        workspace,
        trace,
        execution: ExecutionCorrelation::Conversation {
            thread_id: ThreadId::new(&claim.thread_id)
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
            turn_id: TurnId::new(&claim.turn_id)
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        },
        resource,
        approval,
    })
}

fn provider_resource(
    claim: &super::ports::DynamicToolExecutionClaimRequest,
) -> Result<ResourceRef, ProviderArtifactImportError> {
    let kind = match claim.resource_kind {
        ProviderResourceKind::McpTool => ResourceKind::McpTool,
        ProviderResourceKind::KnowledgeBase => ResourceKind::KnowledgeBase,
        ProviderResourceKind::Agent
        | ProviderResourceKind::Skill
        | ProviderResourceKind::McpServer
        | ProviderResourceKind::Workflow => {
            return Err(ProviderArtifactImportError::InvalidResponse);
        }
    };
    Ok(ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new(&claim.provider_id)
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
            protocol_version: ProviderProtocolVersion::new(&claim.protocol_version)
                .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        },
        kind,
        resource_id: ResourceId::new(&claim.resource_id)
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        revision: ResourceRevision::new(&claim.resource_revision)
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
    })
}

fn local_artifact_ref(
    request: &ProviderDynamicArtifactImportRequest,
) -> Result<ArtifactRef, ProviderArtifactImportError> {
    let digest = import_digest(request);
    Ok(ArtifactRef::new(
        ArtifactId::new(format!("provider-dynamic-result:{digest}"))
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
        ArtifactRevision::new(request.artifact.revision())
            .map_err(|_| ProviderArtifactImportError::InvalidResponse)?,
    ))
}

fn import_digest(request: &ProviderDynamicArtifactImportRequest) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}\0{}\0{}\0{}\0{}\0{}",
                request.claim.provider_id,
                request.claim.call_id,
                request.claim.action_digest,
                request.artifact.artifact_id(),
                request.artifact.revision(),
                request.artifact.content_digest().as_str()
            )
            .as_bytes()
        )
    )
}

const fn workspace_scope(scope: WorkspaceScope) -> ArtifactWorkspaceScope {
    match scope {
        WorkspaceScope::Conversation => ArtifactWorkspaceScope::Conversation,
        WorkspaceScope::Office => ArtifactWorkspaceScope::Office,
        WorkspaceScope::Workflow => ArtifactWorkspaceScope::Workflow,
        WorkspaceScope::Automation => ArtifactWorkspaceScope::Automation,
    }
}

#[cfg(test)]
#[path = "provider_artifact_importer_tests.rs"]
mod tests;
