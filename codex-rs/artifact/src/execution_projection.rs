use crewon_policy::PolicyActor;
use serde::Deserialize;

use crate::ApprovalCorrelation;
use crate::ArtifactError;
use crate::ArtifactErrorKind;
use crate::ArtifactKind;
use crate::ArtifactRef;
use crate::ArtifactWorkspace;
use crate::ExecutionCorrelation;
use crate::MediaType;
use crate::PayloadDigest;
use crate::PayloadId;
use crate::PayloadRef;
use crate::PayloadSensitivity;
use crate::ResourceCorrelation;
use crate::RetentionPolicy;
use crate::TraceContext;
use crate::VerificationStatus;
use crewon_task_runtime::UnixTimestamp;

/// Revalidated subset of an Artifact Manifest needed at an execution boundary.
///
/// Producer, approval, resource, and trace metadata remain in the immutable
/// Manifest and are deliberately not copied into execution input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactExecutionProjection {
    artifact_ref: ArtifactRef,
    kind: ArtifactKind,
    payload: PayloadRef,
    workspace: ArtifactWorkspace,
    execution: ExecutionCorrelation,
    verification: VerificationStatus,
    retention: RetentionPolicy,
    created_at: UnixTimestamp,
}

impl ArtifactExecutionProjection {
    /// Parses the complete v1 Manifest shape and revalidates its bounded fields.
    pub fn from_manifest_json(json: &str) -> Result<Self, ArtifactError> {
        let wire = serde_json::from_str::<ArtifactExecutionProjectionWire>(json)
            .map_err(|_| invalid_manifest())?;
        if wire.schema_version != 1 {
            return Err(invalid_manifest());
        }
        let payload = PayloadRef::restore(
            wire.payload.payload_id,
            wire.payload.digest,
            wire.payload.byte_len,
            wire.payload.media_type,
            wire.payload.sensitivity,
        )?;
        wire.retention.validate_at(wire.created_at)?;
        Ok(Self {
            artifact_ref: wire.artifact_ref,
            kind: wire.kind,
            payload,
            workspace: wire.workspace,
            execution: wire.execution,
            verification: wire.verification,
            retention: wire.retention,
            created_at: wire.created_at,
        })
    }

    pub fn artifact_ref(&self) -> &ArtifactRef {
        &self.artifact_ref
    }

    pub fn kind(&self) -> ArtifactKind {
        self.kind
    }

    pub fn payload(&self) -> &PayloadRef {
        &self.payload
    }

    pub fn workspace(&self) -> &ArtifactWorkspace {
        &self.workspace
    }

    pub fn execution(&self) -> &ExecutionCorrelation {
        &self.execution
    }

    pub fn verification(&self) -> VerificationStatus {
        self.verification
    }

    pub fn retention(&self) -> &RetentionPolicy {
        &self.retention
    }

    pub fn created_at(&self) -> UnixTimestamp {
        self.created_at
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactExecutionProjectionWire {
    schema_version: u16,
    artifact_ref: ArtifactRef,
    kind: ArtifactKind,
    payload: PayloadRefWire,
    #[serde(rename = "producer")]
    _producer: PolicyActor,
    workspace: ArtifactWorkspace,
    execution: ExecutionCorrelation,
    #[serde(rename = "resource")]
    _resource: ResourceCorrelation,
    #[serde(rename = "approval")]
    _approval: ApprovalCorrelation,
    #[serde(rename = "trace")]
    _trace: TraceContext,
    verification: VerificationStatus,
    retention: RetentionPolicy,
    created_at: UnixTimestamp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PayloadRefWire {
    payload_id: PayloadId,
    digest: PayloadDigest,
    byte_len: u64,
    media_type: MediaType,
    sensitivity: PayloadSensitivity,
}

fn invalid_manifest() -> ArtifactError {
    ArtifactError::new("manifestJson", ArtifactErrorKind::Mismatch)
}
