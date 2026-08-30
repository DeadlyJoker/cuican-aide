use crate::artifact_record_schema::validate_audit_schema;
use crate::artifact_record_schema::validate_manifest_schema;
use crate::artifact_record_validation::json_value;
use crate::artifact_record_validation::manifest_sensitivity;
use crate::artifact_record_validation::retention_matches_manifest;
use crate::artifact_record_validation::validate_digest;
use crate::artifact_record_validation::validate_id;
use crate::artifact_record_validation::validate_json;
use crate::artifact_record_validation::validate_time;
use crate::artifact_record_validation::validate_type;
use crate::digest_bytes;
use std::fmt;

pub const MAX_ARTIFACT_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ARTIFACT_RECORD_JSON_BYTES: usize = 256 * 1024;
pub const MAX_ARTIFACT_CLEANUP_BATCH: u32 = 100;

const MANIFEST_FIELDS: [&str; 13] = [
    "approval",
    "artifactRef",
    "createdAt",
    "execution",
    "kind",
    "payload",
    "producer",
    "resource",
    "retention",
    "schemaVersion",
    "trace",
    "verification",
    "workspace",
];
const AUDIT_FIELDS: [&str; 15] = [
    "action",
    "approval",
    "actor",
    "artifacts",
    "cost",
    "eventId",
    "execution",
    "idempotencyKey",
    "occurredAt",
    "outcome",
    "payload",
    "resource",
    "schemaVersion",
    "trace",
    "workspace",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactRecordErrorKind {
    Empty,
    TooLong,
    InvalidJson,
    InvalidDigest,
    OutOfRange,
    InconsistentFields,
    SensitiveMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactRecordError {
    field: &'static str,
    kind: ArtifactRecordErrorKind,
}

impl ArtifactRecordError {
    pub(crate) fn new(field: &'static str, kind: ArtifactRecordErrorKind) -> Self {
        Self { field, kind }
    }

    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> ArtifactRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for ArtifactRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid artifact storage field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ArtifactRecordError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactPayloadSensitivity {
    Public,
    Internal,
    WorkspaceSensitive,
}

impl ArtifactPayloadSensitivity {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Internal => "internal",
            Self::WorkspaceSensitive => "workspace_sensitive",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "public" => Ok(Self::Public),
            "internal" => Ok(Self::Internal),
            "workspace_sensitive" => Ok(Self::WorkspaceSensitive),
            _ => anyhow::bail!("invalid stored Artifact payload sensitivity"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactRetentionKind {
    Session,
    Task,
    UserManaged,
    Compliance,
}

impl ArtifactRetentionKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Task => "task",
            Self::UserManaged => "user_managed",
            Self::Compliance => "compliance",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "session" => Ok(Self::Session),
            "task" => Ok(Self::Task),
            "user_managed" => Ok(Self::UserManaged),
            "compliance" => Ok(Self::Compliance),
            _ => anyhow::bail!("invalid stored Artifact retention kind"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactPayloadStatus {
    Available,
    Deleted,
}

impl ArtifactPayloadStatus {
    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "available" => Ok(Self::Available),
            "deleted" => Ok(Self::Deleted),
            _ => anyhow::bail!("invalid stored Artifact payload status"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactDeletionReason {
    UserRequested,
    RetentionExpired,
    TenantCompliance,
    ProviderWithdrawal,
    AuthorityPolicy,
}

impl ArtifactDeletionReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::UserRequested => "user_requested",
            Self::RetentionExpired => "retention_expired",
            Self::TenantCompliance => "tenant_compliance",
            Self::ProviderWithdrawal => "provider_withdrawal",
            Self::AuthorityPolicy => "authority_policy",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "user_requested" => Ok(Self::UserRequested),
            "retention_expired" => Ok(Self::RetentionExpired),
            "tenant_compliance" => Ok(Self::TenantCompliance),
            "provider_withdrawal" => Ok(Self::ProviderWithdrawal),
            "authority_policy" => Ok(Self::AuthorityPolicy),
            _ => anyhow::bail!("invalid stored Artifact deletion reason"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactPayloadRecord {
    pub payload_id: String,
    pub sha256: String,
    pub media_type: String,
    pub sensitivity: ArtifactPayloadSensitivity,
    pub retention_kind: ArtifactRetentionKind,
    pub expires_at: Option<i64>,
    pub content: Vec<u8>,
    pub created_at: i64,
}

impl ArtifactPayloadRecord {
    pub fn validate(&self) -> Result<(), ArtifactRecordError> {
        validate_id(&self.payload_id, "payloadId")?;
        validate_id(&self.media_type, "mediaType")?;
        validate_digest(&self.sha256)?;
        validate_time(self.created_at, "createdAt")?;
        if self.content.len() > MAX_ARTIFACT_PAYLOAD_BYTES
            || self
                .expires_at
                .is_some_and(|expiry| expiry <= self.created_at)
            || (self.retention_kind == ArtifactRetentionKind::UserManaged)
                != self.expires_at.is_none()
        {
            return Err(ArtifactRecordError::new(
                "payload",
                ArtifactRecordErrorKind::OutOfRange,
            ));
        }
        if self.sha256 != digest_bytes(&self.content) {
            return Err(ArtifactRecordError::new(
                "payload.sha256",
                ArtifactRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactManifestRecord {
    pub artifact_id: String,
    pub revision: u64,
    pub idempotency_key: String,
    pub payload_id: String,
    pub manifest_json: String,
    pub created_at: i64,
}

impl ArtifactManifestRecord {
    pub fn validate(&self) -> Result<(), ArtifactRecordError> {
        validate_id(&self.artifact_id, "artifactId")?;
        validate_id(&self.idempotency_key, "artifactIdempotencyKey")?;
        validate_id(&self.payload_id, "payloadId")?;
        validate_time(self.created_at, "createdAt")?;
        if self.revision == 0 {
            return Err(ArtifactRecordError::new(
                "revision",
                ArtifactRecordErrorKind::OutOfRange,
            ));
        }
        validate_json(&self.manifest_json, "manifestJson", &MANIFEST_FIELDS)?;
        let json = json_value(&self.manifest_json, "manifestJson")?;
        validate_manifest_schema(&json)?;
        if json
            .pointer("/artifactRef/artifactId")
            .and_then(|value| value.as_str())
            != Some(self.artifact_id.as_str())
            || json
                .pointer("/artifactRef/revision")
                .and_then(serde_json::Value::as_u64)
                != Some(self.revision)
            || json
                .pointer("/payload/payloadId")
                .and_then(|value| value.as_str())
                != Some(self.payload_id.as_str())
            || json
                .pointer("/createdAt")
                .and_then(serde_json::Value::as_i64)
                != Some(self.created_at)
            || json
                .pointer("/schemaVersion")
                .and_then(serde_json::Value::as_u64)
                != Some(1)
        {
            return Err(ArtifactRecordError::new(
                "manifestJson",
                ArtifactRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformAuditEventRecord {
    pub event_id: String,
    pub idempotency_key: String,
    pub event_type: String,
    pub metadata_json: String,
    pub payload_id: Option<String>,
    pub occurred_at: i64,
}

impl PlatformAuditEventRecord {
    pub fn validate(&self) -> Result<(), ArtifactRecordError> {
        validate_id(&self.event_id, "eventId")?;
        validate_id(&self.idempotency_key, "auditIdempotencyKey")?;
        validate_type(&self.event_type, "eventType")?;
        if let Some(payload_id) = &self.payload_id {
            validate_id(payload_id, "payloadId")?;
        }
        validate_time(self.occurred_at, "occurredAt")?;
        validate_json(&self.metadata_json, "metadataJson", &AUDIT_FIELDS)?;
        let json = json_value(&self.metadata_json, "metadataJson")?;
        validate_audit_schema(&json)?;
        let payload_matches = match self.payload_id.as_deref() {
            Some(payload_id) => {
                json.pointer("/payload/type")
                    .and_then(|value| value.as_str())
                    == Some("payload")
                    && json
                        .pointer("/payload/payload/payloadId")
                        .and_then(|value| value.as_str())
                        == Some(payload_id)
            }
            None => {
                json.pointer("/payload/type")
                    .and_then(|value| value.as_str())
                    == Some("none")
            }
        };
        if json.pointer("/eventId").and_then(|value| value.as_str()) != Some(self.event_id.as_str())
            || json
                .pointer("/schemaVersion")
                .and_then(serde_json::Value::as_u64)
                != Some(1)
            || json
                .pointer("/idempotencyKey")
                .and_then(|value| value.as_str())
                != Some(self.idempotency_key.as_str())
            || json.pointer("/action").and_then(|value| value.as_str())
                != Some(self.event_type.as_str())
            || json
                .pointer("/occurredAt")
                .and_then(serde_json::Value::as_i64)
                != Some(self.occurred_at)
            || !payload_matches
        {
            return Err(ArtifactRecordError::new(
                "metadataJson",
                ArtifactRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactCommitRecord {
    pub payload: ArtifactPayloadRecord,
    pub manifest: ArtifactManifestRecord,
    pub created_event: PlatformAuditEventRecord,
}

impl ArtifactCommitRecord {
    pub fn validate(&self) -> Result<(), ArtifactRecordError> {
        self.payload.validate()?;
        self.manifest.validate()?;
        self.created_event.validate()?;
        if self.manifest.payload_id != self.payload.payload_id
            || self.created_event.payload_id.as_deref() != Some(self.payload.payload_id.as_str())
            || self.manifest.created_at != self.payload.created_at
            || self.created_event.occurred_at != self.payload.created_at
            || self.created_event.event_type != "artifactCreated"
        {
            return Err(ArtifactRecordError::new(
                "commit",
                ArtifactRecordErrorKind::InconsistentFields,
            ));
        }
        let manifest = json_value(&self.manifest.manifest_json, "manifestJson")?;
        let event = json_value(&self.created_event.metadata_json, "metadataJson")?;
        let artifact = event
            .pointer("/artifacts")
            .and_then(|value| value.as_array())
            .filter(|items| items.len() == 1)
            .and_then(|items| items.first());
        let retention_matches = retention_matches_manifest(&self.payload, &manifest);
        if manifest
            .pointer("/payload/digest")
            .and_then(|value| value.as_str())
            != Some(self.payload.sha256.as_str())
            || manifest
                .pointer("/payload/byteLen")
                .and_then(serde_json::Value::as_u64)
                != Some(self.payload.content.len() as u64)
            || manifest
                .pointer("/payload/mediaType")
                .and_then(|value| value.as_str())
                != Some(self.payload.media_type.as_str())
            || manifest
                .pointer("/payload/sensitivity")
                .and_then(|value| value.as_str())
                != Some(manifest_sensitivity(self.payload.sensitivity))
            || !retention_matches
            || artifact
                .and_then(|value| value.pointer("/artifactId"))
                .and_then(|value| value.as_str())
                != Some(self.manifest.artifact_id.as_str())
            || artifact
                .and_then(|value| value.pointer("/revision"))
                .and_then(serde_json::Value::as_u64)
                != Some(self.manifest.revision)
            || event
                .pointer("/payload/payload/digest")
                .and_then(|value| value.as_str())
                != Some(self.payload.sha256.as_str())
            || event
                .pointer("/payload/payload/byteLen")
                .and_then(serde_json::Value::as_u64)
                != Some(self.payload.content.len() as u64)
            || event
                .pointer("/payload/payload/mediaType")
                .and_then(|value| value.as_str())
                != Some(self.payload.media_type.as_str())
            || event
                .pointer("/payload/payload/sensitivity")
                .and_then(|value| value.as_str())
                != Some(manifest_sensitivity(self.payload.sensitivity))
        {
            return Err(ArtifactRecordError::new(
                "commit",
                ArtifactRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}
