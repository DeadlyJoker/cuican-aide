use crate::ArtifactDeletionReason;
use crate::ArtifactManifestRecord;
use crate::ArtifactPayloadSensitivity;
use crate::ArtifactPayloadStatus;
use crate::ArtifactRecordError;
use crate::ArtifactRecordErrorKind;
use crate::ArtifactRetentionKind;
use crate::PlatformAuditEventRecord;
use crate::artifact_record_validation::validate_id;
use crate::artifact_record_validation::validate_time;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredArtifactPayloadRecord {
    pub payload_id: String,
    pub sha256: String,
    pub byte_len: u64,
    pub media_type: String,
    pub sensitivity: ArtifactPayloadSensitivity,
    pub retention_kind: ArtifactRetentionKind,
    pub expires_at: Option<i64>,
    pub status: ArtifactPayloadStatus,
    pub content: Option<Vec<u8>>,
    pub deletion_reason: Option<ArtifactDeletionReason>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredArtifactRecord {
    pub manifest: ArtifactManifestRecord,
    pub payload: StoredArtifactPayloadRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredArtifactPayloadMetadataRecord {
    pub payload_id: String,
    pub sha256: String,
    pub byte_len: u64,
    pub media_type: String,
    pub sensitivity: ArtifactPayloadSensitivity,
    pub retention_kind: ArtifactRetentionKind,
    pub expires_at: Option<i64>,
    pub status: ArtifactPayloadStatus,
    pub deletion_reason: Option<ArtifactDeletionReason>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredArtifactMetadataRecord {
    pub manifest: ArtifactManifestRecord,
    pub payload: StoredArtifactPayloadMetadataRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactPayloadDeleteRecord {
    pub payload_id: String,
    pub reason: ArtifactDeletionReason,
    pub deleted_at: i64,
    pub audit_event: PlatformAuditEventRecord,
}

impl ArtifactPayloadDeleteRecord {
    pub fn validate(&self) -> Result<(), ArtifactRecordError> {
        validate_id(&self.payload_id, "payloadId")?;
        validate_time(self.deleted_at, "deletedAt")?;
        self.audit_event.validate()?;
        let expected_type = if self.reason == ArtifactDeletionReason::RetentionExpired {
            "retentionExpired"
        } else {
            "payloadDeleted"
        };
        if self.audit_event.payload_id.as_deref() != Some(self.payload_id.as_str())
            || self.audit_event.occurred_at != self.deleted_at
            || self.audit_event.event_type != expected_type
        {
            return Err(ArtifactRecordError::new(
                "deleteRecord",
                ArtifactRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactCommitOutcome {
    Created,
    ExistingSame,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditAppendOutcome {
    Created,
    ExistingSame,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactPayloadDeleteOutcome {
    Deleted,
    AlreadyDeleted,
    NotFound,
    AuthorityDenied,
    AuditConflict,
}
