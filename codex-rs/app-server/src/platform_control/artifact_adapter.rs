use super::RequestIdentity;
use super::request_identity::RequestIdentityActorError;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactCommit;
use crewon_artifact::ArtifactError;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactIdempotencyKey;
use crewon_artifact::ArtifactKind;
use crewon_artifact::ArtifactManifest;
use crewon_artifact::ArtifactManifestInput;
use crewon_artifact::ArtifactRef;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::ArtifactWorkspaceScope;
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
use crewon_artifact::PayloadRef;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::ResourceCorrelation;
use crewon_artifact::RetentionPolicy;
use crewon_artifact::SpanId;
use crewon_artifact::TraceContext;
use crewon_artifact::TraceId;
use crewon_artifact::VerificationStatus;
use crewon_artifact::WorkspaceScopeId;
use crewon_policy::PolicyModelError;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::ModelError as ResourceModelError;
use crewon_resource_federation::WorkspaceKey;
use crewon_state::ArtifactCommitRecord;
use crewon_state::ArtifactDeletionReason;
use crewon_state::ArtifactManifestRecord;
use crewon_state::ArtifactPayloadDeleteRecord;
use crewon_state::ArtifactPayloadRecord;
use crewon_state::ArtifactPayloadSensitivity;
use crewon_state::ArtifactRetentionKind;
use crewon_state::PlatformAuditEventRecord;
use crewon_task_runtime::UnixTimestamp;
use std::fmt;

pub(crate) struct ResolvedArtifactTraceInput {
    pub span_id: SpanId,
    pub parent_span_id: Option<SpanId>,
}

/// Server-resolved values other than identity and Workspace ownership.
pub(crate) struct ResolvedArtifactCommitInput {
    pub artifact_id: ArtifactId,
    pub revision: ArtifactRevision,
    pub artifact_idempotency_key: ArtifactIdempotencyKey,
    pub kind: ArtifactKind,
    pub payload_id: PayloadId,
    pub body: PayloadBody,
    pub media_type: MediaType,
    pub execution: ExecutionCorrelation,
    pub resource: ResourceCorrelation,
    pub approval: ApprovalCorrelation,
    pub trace: ResolvedArtifactTraceInput,
    pub cost: CostCorrelation,
    pub verification: VerificationStatus,
    pub retention: RetentionPolicy,
    pub event_id: AuditEventId,
    pub audit_idempotency_key: AuditIdempotencyKey,
    pub created_at: UnixTimestamp,
}

pub(crate) struct ResolvedArtifactDeletionInput {
    pub payload: PayloadRef,
    pub artifacts: Vec<ArtifactRef>,
    pub execution: ExecutionCorrelation,
    pub resource: ResourceCorrelation,
    pub approval: ApprovalCorrelation,
    pub trace: ResolvedArtifactTraceInput,
    pub cost: CostCorrelation,
    pub reason: ArtifactDeletionReason,
    pub event_id: AuditEventId,
    pub audit_idempotency_key: AuditIdempotencyKey,
    pub deleted_at: UnixTimestamp,
}

/// Validated domain commit plus the short-lived body required by State persistence.
pub(crate) struct PreparedArtifactCommit {
    commit: ArtifactCommit,
    body: PayloadBody,
}

impl PreparedArtifactCommit {
    pub fn domain(&self) -> &ArtifactCommit {
        &self.commit
    }

    pub fn into_state_record(self) -> Result<ArtifactCommitRecord, ArtifactAdapterError> {
        let manifest = self.commit.manifest();
        manifest.payload().verify_body(&self.body)?;
        let sensitivity = match manifest.payload().sensitivity() {
            PayloadSensitivity::Public => ArtifactPayloadSensitivity::Public,
            PayloadSensitivity::Internal => ArtifactPayloadSensitivity::Internal,
            PayloadSensitivity::WorkspaceSensitive => {
                ArtifactPayloadSensitivity::WorkspaceSensitive
            }
            PayloadSensitivity::Secret => return Err(ArtifactAdapterError::SecretInvariant),
        };
        let (retention_kind, expires_at) = match manifest.retention() {
            RetentionPolicy::Session { expires_at } => {
                (ArtifactRetentionKind::Session, Some(expires_at.get()))
            }
            RetentionPolicy::Task { expires_at } => {
                (ArtifactRetentionKind::Task, Some(expires_at.get()))
            }
            RetentionPolicy::UserManaged => (ArtifactRetentionKind::UserManaged, None),
            RetentionPolicy::Compliance { expires_at } => {
                (ArtifactRetentionKind::Compliance, Some(expires_at.get()))
            }
        };
        let created_event = self.commit.created_event();
        let record = ArtifactCommitRecord {
            payload: ArtifactPayloadRecord {
                payload_id: manifest.payload().payload_id().as_str().to_string(),
                sha256: manifest.payload().digest().as_str().to_string(),
                media_type: manifest.payload().media_type().as_str().to_string(),
                sensitivity,
                retention_kind,
                expires_at,
                content: self.body.as_bytes().to_vec(),
                created_at: manifest.created_at().get(),
            },
            manifest: ArtifactManifestRecord {
                artifact_id: manifest.artifact_ref().artifact_id().as_str().to_string(),
                revision: manifest.artifact_ref().revision().get(),
                idempotency_key: self.commit.idempotency_key().as_str().to_string(),
                payload_id: manifest.payload().payload_id().as_str().to_string(),
                manifest_json: serde_json::to_string(manifest)
                    .map_err(|_| ArtifactAdapterError::Serialization)?,
                created_at: manifest.created_at().get(),
            },
            created_event: PlatformAuditEventRecord {
                event_id: created_event.event_id().as_str().to_string(),
                idempotency_key: created_event.idempotency_key().as_str().to_string(),
                event_type: "artifactCreated".to_string(),
                metadata_json: serde_json::to_string(created_event)
                    .map_err(|_| ArtifactAdapterError::Serialization)?,
                payload_id: Some(manifest.payload().payload_id().as_str().to_string()),
                occurred_at: created_event.occurred_at().get(),
            },
        };
        record.validate()?;
        Ok(record)
    }
}

pub(crate) fn prepare_artifact_commit(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    input: ResolvedArtifactCommitInput,
) -> Result<PreparedArtifactCommit, ArtifactAdapterError> {
    let actor = server_actor(identity)?;
    let workspace = artifact_workspace(workspace)?;
    let trace = trace_context(identity, &input.trace)?;
    prepare_artifact_commit_resolved(actor, workspace, trace, input)
}

pub(crate) fn prepare_artifact_commit_resolved(
    actor: crewon_policy::PolicyActor,
    workspace: ArtifactWorkspace,
    trace: TraceContext,
    input: ResolvedArtifactCommitInput,
) -> Result<PreparedArtifactCommit, ArtifactAdapterError> {
    let payload = PayloadRef::from_body(input.payload_id, &input.body, input.media_type);
    let artifact_ref = ArtifactRef::new(input.artifact_id, input.revision);
    let manifest = ArtifactManifest::new(ArtifactManifestInput {
        artifact_ref: artifact_ref.clone(),
        kind: input.kind,
        payload: payload.clone(),
        producer: actor.clone(),
        workspace: workspace.clone(),
        execution: input.execution.clone(),
        resource: input.resource.clone(),
        approval: input.approval.clone(),
        trace: trace.clone(),
        verification: input.verification,
        retention: input.retention,
        created_at: input.created_at,
    })?;
    let created_event = AuditEvent::new(AuditEventInput {
        event_id: input.event_id,
        idempotency_key: input.audit_idempotency_key,
        actor,
        workspace,
        execution: input.execution,
        action: AuditAction::ArtifactCreated,
        outcome: AuditOutcome::Succeeded,
        trace,
        cost: input.cost,
        resource: input.resource,
        approval: input.approval,
        artifacts: vec![artifact_ref],
        payload: AuditPayloadLink::Payload { payload },
        occurred_at: input.created_at,
    })?;
    let commit = ArtifactCommit::new(input.artifact_idempotency_key, manifest, created_event)?;
    Ok(PreparedArtifactCommit {
        commit,
        body: input.body,
    })
}

pub(crate) fn prepare_artifact_deletion(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    input: ResolvedArtifactDeletionInput,
) -> Result<ArtifactPayloadDeleteRecord, ArtifactAdapterError> {
    let actor = server_actor(identity)?;
    let workspace = artifact_workspace(workspace)?;
    let trace = trace_context(identity, &input.trace)?;
    let action = if input.reason == ArtifactDeletionReason::RetentionExpired {
        AuditAction::RetentionExpired
    } else {
        AuditAction::PayloadDeleted
    };
    let event_type = if input.reason == ArtifactDeletionReason::RetentionExpired {
        "retentionExpired"
    } else {
        "payloadDeleted"
    };
    let payload_id = input.payload.payload_id().as_str().to_string();
    let audit_payload_id = payload_id.clone();
    let event = AuditEvent::new(AuditEventInput {
        event_id: input.event_id,
        idempotency_key: input.audit_idempotency_key,
        actor,
        workspace,
        execution: input.execution,
        action,
        outcome: AuditOutcome::Succeeded,
        trace,
        cost: input.cost,
        resource: input.resource,
        approval: input.approval,
        artifacts: input.artifacts,
        payload: AuditPayloadLink::Payload {
            payload: input.payload,
        },
        occurred_at: input.deleted_at,
    })?;
    let record = ArtifactPayloadDeleteRecord {
        payload_id,
        reason: input.reason,
        deleted_at: input.deleted_at.get(),
        audit_event: PlatformAuditEventRecord {
            event_id: event.event_id().as_str().to_string(),
            idempotency_key: event.idempotency_key().as_str().to_string(),
            event_type: event_type.to_string(),
            metadata_json: serde_json::to_string(&event)
                .map_err(|_| ArtifactAdapterError::Serialization)?,
            payload_id: Some(audit_payload_id),
            occurred_at: event.occurred_at().get(),
        },
    };
    record.validate()?;
    Ok(record)
}

fn server_actor(
    identity: &RequestIdentity,
) -> Result<crewon_policy::PolicyActor, ArtifactAdapterError> {
    identity.policy_actor().map_err(|error| match error {
        RequestIdentityActorError::IdentityScope => ArtifactAdapterError::IdentityScope,
        RequestIdentityActorError::Model(error) => ArtifactAdapterError::Policy(error),
    })
}

fn trace_context(
    identity: &RequestIdentity,
    trace: &ResolvedArtifactTraceInput,
) -> Result<TraceContext, ArtifactAdapterError> {
    let trace_id = TraceId::new(&identity.reference().trace_id)?;
    Ok(match &trace.parent_span_id {
        Some(parent_span_id) => {
            TraceContext::child(trace_id, trace.span_id.clone(), parent_span_id.clone())?
        }
        None => TraceContext::root(trace_id, trace.span_id.clone()),
    })
}

fn artifact_workspace(workspace: &WorkspaceRef) -> Result<ArtifactWorkspace, ArtifactAdapterError> {
    let scope = match workspace.scope {
        WorkspaceScope::Conversation => ArtifactWorkspaceScope::Conversation,
        WorkspaceScope::Office => ArtifactWorkspaceScope::Office,
        WorkspaceScope::Workflow => ArtifactWorkspaceScope::Workflow,
        WorkspaceScope::Automation => ArtifactWorkspaceScope::Automation,
    };
    Ok(ArtifactWorkspace::new(
        WorkspaceKey::new(&workspace.workspace_key)?,
        BindingId::new(&workspace.binding_id)?,
        scope,
        WorkspaceScopeId::new(&workspace.scope_id)?,
    ))
}

#[derive(Debug)]
pub(crate) enum ArtifactAdapterError {
    IdentityScope,
    SecretInvariant,
    Serialization,
    Artifact(ArtifactError),
    Policy(PolicyModelError),
    Resource(ResourceModelError),
    State(crewon_state::ArtifactRecordError),
}

impl From<ArtifactError> for ArtifactAdapterError {
    fn from(error: ArtifactError) -> Self {
        Self::Artifact(error)
    }
}

impl From<PolicyModelError> for ArtifactAdapterError {
    fn from(error: PolicyModelError) -> Self {
        Self::Policy(error)
    }
}

impl From<ResourceModelError> for ArtifactAdapterError {
    fn from(error: ResourceModelError) -> Self {
        Self::Resource(error)
    }
}

impl From<crewon_state::ArtifactRecordError> for ArtifactAdapterError {
    fn from(error: crewon_state::ArtifactRecordError) -> Self {
        Self::State(error)
    }
}

impl fmt::Display for ArtifactAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::IdentityScope => formatter.write_str("Artifact adapter rejected identity scope"),
            Self::SecretInvariant => {
                formatter.write_str("Artifact adapter rejected Secret payload invariant")
            }
            Self::Serialization => {
                formatter.write_str("Artifact adapter failed metadata serialization")
            }
            Self::Artifact(error) => write!(formatter, "Artifact adapter: {error}"),
            Self::Policy(error) => write!(formatter, "Artifact adapter policy: {error}"),
            Self::Resource(error) => write!(formatter, "Artifact adapter resource: {error}"),
            Self::State(error) => write!(formatter, "Artifact adapter state: {error}"),
        }
    }
}

impl std::error::Error for ArtifactAdapterError {}

#[cfg(test)]
#[path = "artifact_adapter_tests.rs"]
mod tests;
