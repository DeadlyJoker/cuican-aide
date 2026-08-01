use crate::ArtifactError;
use crate::ArtifactErrorKind;
use crate::ArtifactId;
use crate::ArtifactRevision;
use crate::AuditEventId;
use crate::CitationId;
use crate::CitationLocator;
use crate::EvidenceId;
use crate::MediaType;
use crate::PayloadBody;
use crate::PayloadDigest;
use crate::PayloadId;
use crate::PayloadSensitivity;
use crate::RunId;
use crate::ThreadId;
use crate::TraceContext;
use crate::TurnId;
use crate::WorkspaceScopeId;
use crewon_policy::AccessDecisionId;
use crewon_policy::ActionDigest;
use crewon_policy::ApprovalId;
use crewon_policy::PolicyActor;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::WorkspaceKey;
use crewon_task_runtime::AttemptId;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::UnixTimestamp;
use serde::Deserialize;
use serde::Serialize;

/// Maximum exact Artifact references attached to one Audit Event.
pub const MAX_ARTIFACT_REFS: usize = 16;

/// Exact immutable identity of an Artifact revision.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRef {
    artifact_id: ArtifactId,
    revision: ArtifactRevision,
}

impl ArtifactRef {
    /// Constructs one exact Artifact revision reference.
    pub fn new(artifact_id: ArtifactId, revision: ArtifactRevision) -> Self {
        Self {
            artifact_id,
            revision,
        }
    }

    pub fn artifact_id(&self) -> &ArtifactId {
        &self.artifact_id
    }

    pub fn revision(&self) -> ArtifactRevision {
        self.revision
    }
}

/// Exact immutable payload identity safe to place in metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayloadRef {
    payload_id: PayloadId,
    digest: PayloadDigest,
    byte_len: u64,
    media_type: MediaType,
    sensitivity: PayloadSensitivity,
}

impl PayloadRef {
    /// Derives a metadata-only reference from bounded payload bytes.
    pub fn from_body(payload_id: PayloadId, body: &PayloadBody, media_type: MediaType) -> Self {
        Self {
            payload_id,
            digest: body.digest(),
            byte_len: body.len() as u64,
            media_type,
            sensitivity: body.sensitivity(),
        }
    }

    /// Restores a stored reference after checking its canonical digest and size.
    pub fn restore(
        payload_id: PayloadId,
        digest: PayloadDigest,
        byte_len: u64,
        media_type: MediaType,
        sensitivity: PayloadSensitivity,
    ) -> Result<Self, ArtifactError> {
        if byte_len > crate::MAX_PAYLOAD_BYTES as u64 {
            return Err(ArtifactError::new(
                "payloadByteLen",
                ArtifactErrorKind::OutOfRange,
            ));
        }
        if sensitivity == PayloadSensitivity::Secret {
            return Err(ArtifactError::new(
                "payloadSensitivity",
                ArtifactErrorKind::SecretPayloadUnsupported,
            ));
        }
        Ok(Self {
            payload_id,
            digest,
            byte_len,
            media_type,
            sensitivity,
        })
    }

    pub fn payload_id(&self) -> &PayloadId {
        &self.payload_id
    }

    pub fn digest(&self) -> &PayloadDigest {
        &self.digest
    }

    pub fn byte_len(&self) -> u64 {
        self.byte_len
    }

    pub fn media_type(&self) -> &MediaType {
        &self.media_type
    }

    pub fn sensitivity(&self) -> PayloadSensitivity {
        self.sensitivity
    }

    pub fn verify_body(&self, body: &PayloadBody) -> Result<(), ArtifactError> {
        if self.byte_len != body.len() as u64
            || self.digest != body.digest()
            || self.sensitivity != body.sensitivity()
        {
            return Err(ArtifactError::new(
                "payloadBody",
                ArtifactErrorKind::Mismatch,
            ));
        }
        Ok(())
    }
}

/// Stable closed set of first-version Artifact projections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    Report,
    Document,
    Image,
    Dataset,
    CodePatch,
    StructuredResult,
    EvidenceBundle,
}

/// Logical workspace scope that owns Artifact retention and access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactWorkspaceScope {
    Conversation,
    Office,
    Workflow,
    Automation,
}

/// Server-derived workspace correlation; it never contains an absolute path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactWorkspace {
    workspace_key: WorkspaceKey,
    binding_id: BindingId,
    scope: ArtifactWorkspaceScope,
    scope_id: WorkspaceScopeId,
}

impl ArtifactWorkspace {
    pub fn new(
        workspace_key: WorkspaceKey,
        binding_id: BindingId,
        scope: ArtifactWorkspaceScope,
        scope_id: WorkspaceScopeId,
    ) -> Self {
        Self {
            workspace_key,
            binding_id,
            scope,
            scope_id,
        }
    }

    pub fn workspace_key(&self) -> &WorkspaceKey {
        &self.workspace_key
    }

    pub fn binding_id(&self) -> &BindingId {
        &self.binding_id
    }

    pub fn scope(&self) -> ArtifactWorkspaceScope {
        self.scope
    }

    pub fn scope_id(&self) -> &WorkspaceScopeId {
        &self.scope_id
    }
}

/// Exact execution that produced or observed a fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecutionCorrelation {
    Conversation {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    Task {
        task_id: TaskId,
        run_id: RunId,
        attempt_id: AttemptId,
    },
}

/// Optional exact Provider or resource revision correlation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResourceCorrelation {
    None,
    Provider { provider: ProviderRef },
    Resource { resource: ResourceRef },
}

/// Exact approval decision bound to an action digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalCorrelation {
    None,
    Decision {
        approval_id: ApprovalId,
        access_decision_id: AccessDecisionId,
        action_digest: ActionDigest,
    },
}

/// Payload lifetime and deletion authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RetentionPolicy {
    Session { expires_at: UnixTimestamp },
    Task { expires_at: UnixTimestamp },
    UserManaged,
    Compliance { expires_at: UnixTimestamp },
}

impl RetentionPolicy {
    /// Verifies that any expiry happens strictly after creation.
    pub fn validate_at(&self, created_at: UnixTimestamp) -> Result<(), ArtifactError> {
        let expires_at = match self {
            Self::Session { expires_at }
            | Self::Task { expires_at }
            | Self::Compliance { expires_at } => Some(*expires_at),
            Self::UserManaged => None,
        };
        if expires_at.is_some_and(|expires_at| expires_at <= created_at) {
            return Err(ArtifactError::new(
                "retention.expiresAt",
                ArtifactErrorKind::OutOfRange,
            ));
        }
        Ok(())
    }

    pub fn expires_at(&self) -> Option<UnixTimestamp> {
        match self {
            Self::Session { expires_at }
            | Self::Task { expires_at }
            | Self::Compliance { expires_at } => Some(*expires_at),
            Self::UserManaged => None,
        }
    }

    pub fn permits_user_delete(&self) -> bool {
        !matches!(self, Self::Compliance { .. })
    }
}

/// Verification performed by an authoritative adapter, not claimed by a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationStatus {
    Unverified,
    Verified,
    Rejected,
}

/// Named input for validated immutable Manifest construction.
pub struct ArtifactManifestInput {
    pub artifact_ref: ArtifactRef,
    pub kind: ArtifactKind,
    pub payload: PayloadRef,
    pub producer: PolicyActor,
    pub workspace: ArtifactWorkspace,
    pub execution: ExecutionCorrelation,
    pub resource: ResourceCorrelation,
    pub approval: ApprovalCorrelation,
    pub trace: TraceContext,
    pub verification: VerificationStatus,
    pub retention: RetentionPolicy,
    pub created_at: UnixTimestamp,
}

/// Immutable metadata-only Artifact manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactManifest {
    schema_version: u16,
    artifact_ref: ArtifactRef,
    kind: ArtifactKind,
    payload: PayloadRef,
    producer: PolicyActor,
    workspace: ArtifactWorkspace,
    execution: ExecutionCorrelation,
    resource: ResourceCorrelation,
    approval: ApprovalCorrelation,
    trace: TraceContext,
    verification: VerificationStatus,
    retention: RetentionPolicy,
    created_at: UnixTimestamp,
}

impl ArtifactManifest {
    /// Validates cross-field retention invariants and freezes the Manifest.
    pub fn new(input: ArtifactManifestInput) -> Result<Self, ArtifactError> {
        input.retention.validate_at(input.created_at)?;
        Ok(Self {
            schema_version: 1,
            artifact_ref: input.artifact_ref,
            kind: input.kind,
            payload: input.payload,
            producer: input.producer,
            workspace: input.workspace,
            execution: input.execution,
            resource: input.resource,
            approval: input.approval,
            trace: input.trace,
            verification: input.verification,
            retention: input.retention,
            created_at: input.created_at,
        })
    }

    pub fn artifact_ref(&self) -> &ArtifactRef {
        &self.artifact_ref
    }

    pub fn payload(&self) -> &PayloadRef {
        &self.payload
    }

    pub fn workspace(&self) -> &ArtifactWorkspace {
        &self.workspace
    }

    pub fn retention(&self) -> &RetentionPolicy {
        &self.retention
    }

    pub fn created_at(&self) -> UnixTimestamp {
        self.created_at
    }
}

/// Stable reference to one Audit Event.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditEventRef {
    event_id: AuditEventId,
}

impl AuditEventRef {
    pub fn new(event_id: AuditEventId) -> Self {
        Self { event_id }
    }

    pub fn event_id(&self) -> &AuditEventId {
        &self.event_id
    }
}

/// Source of evidence; body text is deliberately impossible here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EvidenceSource {
    Artifact { artifact: ArtifactRef },
    AuditEvent { event: AuditEventRef },
    Resource { resource: ResourceRef },
}

/// Authority's assessment of exact evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceAssessment {
    Observed,
    Verified,
    Rejected,
}

/// Evidence is an assessment over a stable source reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRef {
    evidence_id: EvidenceId,
    source: EvidenceSource,
    assessment: EvidenceAssessment,
}

impl EvidenceRef {
    pub fn new(
        evidence_id: EvidenceId,
        source: EvidenceSource,
        assessment: EvidenceAssessment,
    ) -> Self {
        Self {
            evidence_id,
            source,
            assessment,
        }
    }
}

/// Citation points into evidence without embedding copied source body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitationRef {
    citation_id: CitationId,
    evidence: EvidenceRef,
    locator: CitationLocator,
}

impl CitationRef {
    pub fn new(citation_id: CitationId, evidence: EvidenceRef, locator: CitationLocator) -> Self {
        Self {
            citation_id,
            evidence,
            locator,
        }
    }
}
