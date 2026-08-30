use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactRef;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::ArtifactWorkspaceScope;
use crewon_artifact::AuditAction;
use crewon_artifact::AuditErrorCode;
use crewon_artifact::AuditEvent;
use crewon_artifact::AuditEventId;
use crewon_artifact::AuditEventInput;
use crewon_artifact::AuditIdempotencyKey;
use crewon_artifact::AuditOutcome;
use crewon_artifact::AuditPayloadLink;
use crewon_artifact::CostCorrelation;
use crewon_artifact::ExecutionCorrelation;
use crewon_artifact::ResourceCorrelation;
use crewon_artifact::SpanId;
use crewon_artifact::ThreadId;
use crewon_artifact::TraceContext;
use crewon_artifact::TraceId;
use crewon_artifact::TurnId;
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
use crewon_state::DynamicToolExecutionFailureCode as StateFailureCode;
use crewon_state::DynamicToolExecutionRecord as StateExecutionRecord;
use crewon_state::DynamicToolExecutionResultRecord as StateResultRecord;
use crewon_state::DynamicToolExecutionTerminalRecord as StateTerminalRecord;
use crewon_state::DynamicToolExecutionUnknownCode as StateUnknownCode;
use crewon_state::PlatformAuditEventRecord;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_task_runtime::UnixTimestamp;
use sha2::Digest;
use sha2::Sha256;

use super::ports::DynamicToolPortError;

pub(super) fn external_action_audit(
    completed: &StateExecutionRecord,
) -> Result<PlatformAuditEventRecord, DynamicToolPortError> {
    let actor = PolicyActor::space_user(
        &completed.actor_id,
        &completed.tenant_id,
        &completed.space_id,
    )
    .map_err(|_| DynamicToolPortError::InvalidResponse)?;
    let workspace = ArtifactWorkspace::new(
        WorkspaceKey::new(&completed.workspace_key)
            .map_err(|_| DynamicToolPortError::InvalidResponse)?,
        BindingId::new(&completed.workspace_binding_id)
            .map_err(|_| DynamicToolPortError::InvalidResponse)?,
        artifact_workspace_scope(completed.workspace_scope),
        WorkspaceScopeId::new(&completed.workspace_scope_id)
            .map_err(|_| DynamicToolPortError::InvalidResponse)?,
    );
    let execution = ExecutionCorrelation::Conversation {
        thread_id: ThreadId::new(&completed.thread_id)
            .map_err(|_| DynamicToolPortError::InvalidResponse)?,
        turn_id: TurnId::new(&completed.turn_id)
            .map_err(|_| DynamicToolPortError::InvalidResponse)?,
    };
    let trace_id =
        TraceId::new(&completed.trace_id).map_err(|_| DynamicToolPortError::InvalidResponse)?;
    let span_id =
        SpanId::new(&completed.span_id).map_err(|_| DynamicToolPortError::InvalidResponse)?;
    let trace = match completed.parent_span_id.as_deref() {
        Some(parent) => TraceContext::child(
            trace_id,
            span_id,
            SpanId::new(parent).map_err(|_| DynamicToolPortError::InvalidResponse)?,
        ),
        None => Ok(TraceContext::root(trace_id, span_id)),
    }
    .map_err(|_| DynamicToolPortError::InvalidResponse)?;
    let approval = match completed.approval_id.as_deref() {
        Some(approval_id) => ApprovalCorrelation::Decision {
            approval_id: ApprovalId::new(approval_id)
                .map_err(|_| DynamicToolPortError::InvalidResponse)?,
            access_decision_id: AccessDecisionId::new(&completed.access_decision_id)
                .map_err(|_| DynamicToolPortError::InvalidResponse)?,
            action_digest: ActionDigest::parse(&completed.action_digest)
                .map_err(|_| DynamicToolPortError::InvalidResponse)?,
        },
        None => ApprovalCorrelation::None,
    };
    let resource = ResourceCorrelation::Resource {
        resource: ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new(&completed.provider_id)
                    .map_err(|_| DynamicToolPortError::InvalidResponse)?,
                protocol_version: ProviderProtocolVersion::new(&completed.protocol_version)
                    .map_err(|_| DynamicToolPortError::InvalidResponse)?,
            },
            kind: artifact_resource_kind(completed.resource_kind)?,
            resource_id: ResourceId::new(&completed.resource_id)
                .map_err(|_| DynamicToolPortError::InvalidResponse)?,
            revision: ResourceRevision::new(&completed.resource_revision)
                .map_err(|_| DynamicToolPortError::InvalidResponse)?,
        },
    };
    let artifacts = match &completed.terminal {
        StateTerminalRecord::Succeeded(StateResultRecord::Artifact {
            artifact_id,
            revision,
        }) => vec![ArtifactRef::new(
            ArtifactId::new(artifact_id).map_err(|_| DynamicToolPortError::InvalidResponse)?,
            ArtifactRevision::new(*revision).map_err(|_| DynamicToolPortError::InvalidResponse)?,
        )],
        StateTerminalRecord::Claimed
        | StateTerminalRecord::Succeeded(StateResultRecord::Inline { .. })
        | StateTerminalRecord::Failed(_)
        | StateTerminalRecord::Unknown(_) => Vec::new(),
    };
    let event_id = AuditEventId::new(audit_event_id(&completed.call_id))
        .map_err(|_| DynamicToolPortError::InvalidResponse)?;
    let idempotency_key = AuditIdempotencyKey::new(audit_idempotency_key(&completed.call_id))
        .map_err(|_| DynamicToolPortError::InvalidResponse)?;
    let event = AuditEvent::new(AuditEventInput {
        event_id,
        idempotency_key,
        actor,
        workspace,
        execution,
        action: AuditAction::ExternalAction,
        outcome: audit_outcome(&completed.terminal)?,
        trace,
        cost: CostCorrelation::None,
        resource,
        approval,
        artifacts,
        payload: AuditPayloadLink::None,
        occurred_at: UnixTimestamp::new(completed.updated_at)
            .map_err(|_| DynamicToolPortError::InvalidResponse)?,
    })
    .map_err(|_| DynamicToolPortError::InvalidResponse)?;
    let record = PlatformAuditEventRecord {
        event_id: event.event_id().as_str().to_string(),
        idempotency_key: event.idempotency_key().as_str().to_string(),
        event_type: "externalAction".to_string(),
        metadata_json: serde_json::to_string(&event)
            .map_err(|_| DynamicToolPortError::InvalidResponse)?,
        payload_id: None,
        occurred_at: event.occurred_at().get(),
    };
    record
        .validate()
        .map_err(|_| DynamicToolPortError::InvalidResponse)?;
    Ok(record)
}

fn audit_outcome(terminal: &StateTerminalRecord) -> Result<AuditOutcome, DynamicToolPortError> {
    let error_code =
        |value: &str| AuditErrorCode::new(value).map_err(|_| DynamicToolPortError::InvalidResponse);
    Ok(match terminal {
        StateTerminalRecord::Claimed => return Err(DynamicToolPortError::InvalidResponse),
        StateTerminalRecord::Succeeded(_) => AuditOutcome::Succeeded,
        StateTerminalRecord::Failed(StateFailureCode::Rejected) => AuditOutcome::Failed {
            error_code: error_code("dynamicTool.rejected")?,
        },
        StateTerminalRecord::Failed(StateFailureCode::ExecutionFailed) => AuditOutcome::Failed {
            error_code: error_code("dynamicTool.executionFailed")?,
        },
        StateTerminalRecord::Unknown(StateUnknownCode::Timeout) => AuditOutcome::Unknown {
            error_code: error_code("dynamicTool.timeout")?,
        },
        StateTerminalRecord::Unknown(StateUnknownCode::AdapterUnavailable) => {
            AuditOutcome::Unknown {
                error_code: error_code("dynamicTool.adapterUnavailable")?,
            }
        }
        StateTerminalRecord::Unknown(StateUnknownCode::InvalidResponse) => AuditOutcome::Unknown {
            error_code: error_code("dynamicTool.invalidResponse")?,
        },
    })
}

pub(super) fn audit_event_id(call_id: &str) -> String {
    format!("dynamic-tool-event:{}", completion_digest(call_id))
}

fn audit_idempotency_key(call_id: &str) -> String {
    format!("dynamic-tool-completion:{}", completion_digest(call_id))
}

fn completion_digest(call_id: &str) -> String {
    format!("{:x}", Sha256::digest(call_id.as_bytes()))
}

const fn artifact_workspace_scope(scope: ProviderResourceWorkspaceScope) -> ArtifactWorkspaceScope {
    match scope {
        ProviderResourceWorkspaceScope::Conversation => ArtifactWorkspaceScope::Conversation,
        ProviderResourceWorkspaceScope::Office => ArtifactWorkspaceScope::Office,
        ProviderResourceWorkspaceScope::Workflow => ArtifactWorkspaceScope::Workflow,
        ProviderResourceWorkspaceScope::Automation => ArtifactWorkspaceScope::Automation,
    }
}

fn artifact_resource_kind(
    kind: ProviderResourceKind,
) -> Result<ResourceKind, DynamicToolPortError> {
    match kind {
        ProviderResourceKind::McpTool => Ok(ResourceKind::McpTool),
        ProviderResourceKind::KnowledgeBase => Ok(ResourceKind::KnowledgeBase),
        ProviderResourceKind::Agent
        | ProviderResourceKind::Skill
        | ProviderResourceKind::McpServer
        | ProviderResourceKind::Workflow => Err(DynamicToolPortError::InvalidResponse),
    }
}
