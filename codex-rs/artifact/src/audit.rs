use crate::ApprovalCorrelation;
use crate::ArtifactError;
use crate::ArtifactErrorKind;
use crate::ArtifactIdempotencyKey;
use crate::ArtifactRef;
use crate::ArtifactWorkspace;
use crate::AuditErrorCode;
use crate::AuditEventId;
use crate::AuditIdempotencyKey;
use crate::CurrencyCode;
use crate::ExecutionCorrelation;
use crate::MAX_ARTIFACT_REFS;
use crate::PayloadRef;
use crate::ResourceCorrelation;
use crate::SpanId;
use crate::TraceId;
use crewon_policy::PolicyActor;
use crewon_task_runtime::UnixTimestamp;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;

/// Trace identity shared across policy, resource, execution, and Artifact facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceContext {
    trace_id: TraceId,
    span_id: SpanId,
    parent_span_id: Option<SpanId>,
}

impl TraceContext {
    /// Creates a root trace span.
    pub fn root(trace_id: TraceId, span_id: SpanId) -> Self {
        Self {
            trace_id,
            span_id,
            parent_span_id: None,
        }
    }

    /// Creates a child span, rejecting a self-parent cycle.
    pub fn child(
        trace_id: TraceId,
        span_id: SpanId,
        parent_span_id: SpanId,
    ) -> Result<Self, ArtifactError> {
        if span_id == parent_span_id {
            return Err(ArtifactError::new(
                "parentSpanId",
                ArtifactErrorKind::Mismatch,
            ));
        }
        Ok(Self {
            trace_id,
            span_id,
            parent_span_id: Some(parent_span_id),
        })
    }

    pub fn trace_id(&self) -> &TraceId {
        &self.trace_id
    }

    pub fn span_id(&self) -> &SpanId {
        &self.span_id
    }

    pub fn parent_span_id(&self) -> Option<&SpanId> {
        self.parent_span_id.as_ref()
    }
}

/// Integer-only usage and monetary cost snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageCost {
    input_tokens: u64,
    output_tokens: u64,
    tool_calls: u32,
    amount_micros: u64,
    currency: CurrencyCode,
}

impl UsageCost {
    pub fn new(
        input_tokens: u64,
        output_tokens: u64,
        tool_calls: u32,
        amount_micros: u64,
        currency: CurrencyCode,
    ) -> Self {
        Self {
            input_tokens,
            output_tokens,
            tool_calls,
            amount_micros,
            currency,
        }
    }
}

/// Optional cost is explicit instead of inferred from nullable fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CostCorrelation {
    None,
    Usage { cost: UsageCost },
}

/// Optional payload association used only for bounded detail stored separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AuditPayloadLink {
    None,
    Payload { payload: PayloadRef },
}

/// Stable first-version fact vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuditAction {
    ArtifactCreated,
    ArtifactRead,
    PayloadDeleted,
    RetentionExpired,
    PolicyEvaluated,
    ApprovalDecided,
    ExternalAction,
}

/// Stable outcome without raw external error text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AuditOutcome {
    Succeeded,
    Failed { error_code: AuditErrorCode },
    Denied { error_code: AuditErrorCode },
    Cancelled { error_code: AuditErrorCode },
    Unknown { error_code: AuditErrorCode },
}

/// Named input for validated Audit Event construction.
pub struct AuditEventInput {
    pub event_id: AuditEventId,
    pub idempotency_key: AuditIdempotencyKey,
    pub actor: PolicyActor,
    pub workspace: ArtifactWorkspace,
    pub execution: ExecutionCorrelation,
    pub action: AuditAction,
    pub outcome: AuditOutcome,
    pub trace: TraceContext,
    pub cost: CostCorrelation,
    pub resource: ResourceCorrelation,
    pub approval: ApprovalCorrelation,
    pub artifacts: Vec<ArtifactRef>,
    pub payload: AuditPayloadLink,
    pub occurred_at: UnixTimestamp,
}

/// Metadata-only immutable Audit Event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditEvent {
    schema_version: u16,
    event_id: AuditEventId,
    idempotency_key: AuditIdempotencyKey,
    actor: PolicyActor,
    workspace: ArtifactWorkspace,
    execution: ExecutionCorrelation,
    action: AuditAction,
    outcome: AuditOutcome,
    trace: TraceContext,
    cost: CostCorrelation,
    resource: ResourceCorrelation,
    approval: ApprovalCorrelation,
    artifacts: Vec<ArtifactRef>,
    payload: AuditPayloadLink,
    occurred_at: UnixTimestamp,
}

impl AuditEvent {
    /// Builds a bounded event and rejects duplicate Artifact references.
    pub fn new(input: AuditEventInput) -> Result<Self, ArtifactError> {
        if input.artifacts.len() > MAX_ARTIFACT_REFS {
            return Err(ArtifactError::too_many("artifacts"));
        }
        let unique = input.artifacts.iter().cloned().collect::<BTreeSet<_>>();
        if unique.len() != input.artifacts.len() {
            return Err(ArtifactError::new(
                "artifacts",
                ArtifactErrorKind::Duplicate,
            ));
        }
        Ok(Self {
            schema_version: 1,
            event_id: input.event_id,
            idempotency_key: input.idempotency_key,
            actor: input.actor,
            workspace: input.workspace,
            execution: input.execution,
            action: input.action,
            outcome: input.outcome,
            trace: input.trace,
            cost: input.cost,
            resource: input.resource,
            approval: input.approval,
            artifacts: input.artifacts,
            payload: input.payload,
            occurred_at: input.occurred_at,
        })
    }

    pub fn event_id(&self) -> &AuditEventId {
        &self.event_id
    }

    pub fn idempotency_key(&self) -> &AuditIdempotencyKey {
        &self.idempotency_key
    }

    pub fn artifacts(&self) -> &[ArtifactRef] {
        &self.artifacts
    }

    pub fn payload(&self) -> &AuditPayloadLink {
        &self.payload
    }

    pub fn occurred_at(&self) -> UnixTimestamp {
        self.occurred_at
    }
}

/// Atomic domain commit keeps idempotency separate from the immutable manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactCommit {
    idempotency_key: ArtifactIdempotencyKey,
    manifest: crate::ArtifactManifest,
    created_event: AuditEvent,
}

impl ArtifactCommit {
    /// Correlates one Manifest with its exactly matching creation Audit Event.
    pub fn new(
        idempotency_key: ArtifactIdempotencyKey,
        manifest: crate::ArtifactManifest,
        created_event: AuditEvent,
    ) -> Result<Self, ArtifactError> {
        if created_event.action != AuditAction::ArtifactCreated
            || created_event.occurred_at != manifest.created_at()
            || created_event.workspace != *manifest.workspace()
            || created_event.artifacts != [manifest.artifact_ref().clone()]
        {
            return Err(ArtifactError::new(
                "createdEvent",
                ArtifactErrorKind::Mismatch,
            ));
        }
        match created_event.payload() {
            AuditPayloadLink::Payload { payload } if payload == manifest.payload() => {}
            AuditPayloadLink::None | AuditPayloadLink::Payload { .. } => {
                return Err(ArtifactError::new(
                    "createdEvent.payload",
                    ArtifactErrorKind::Mismatch,
                ));
            }
        }
        Ok(Self {
            idempotency_key,
            manifest,
            created_event,
        })
    }

    pub fn idempotency_key(&self) -> &ArtifactIdempotencyKey {
        &self.idempotency_key
    }

    pub fn manifest(&self) -> &crate::ArtifactManifest {
        &self.manifest
    }

    pub fn created_event(&self) -> &AuditEvent {
        &self.created_event
    }
}
