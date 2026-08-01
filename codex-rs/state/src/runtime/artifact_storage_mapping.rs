use crate::ArtifactCommitRecord;
use crate::ArtifactDeletionReason;
use crate::ArtifactManifestRecord;
use crate::ArtifactPayloadSensitivity;
use crate::ArtifactPayloadStatus;
use crate::ArtifactRetentionKind;
use crate::PlatformAuditEventRecord;
use crate::StoredArtifactMetadataRecord;
use crate::StoredArtifactPayloadMetadataRecord;
use crate::StoredArtifactPayloadRecord;
use crate::StoredArtifactRecord;
use crate::digest_parts;
use sqlx::Row;

pub(super) fn stored_artifact_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<StoredArtifactRecord> {
    let status = ArtifactPayloadStatus::from_str(row.try_get("status")?)?;
    let deletion_reason = row
        .try_get::<Option<String>, _>("deletion_reason")?
        .as_deref()
        .map(ArtifactDeletionReason::from_str)
        .transpose()?;
    let manifest = ArtifactManifestRecord {
        artifact_id: row.try_get("artifact_id")?,
        revision: artifact_storage_u64(row.try_get("revision")?, "revision")?,
        idempotency_key: row.try_get("idempotency_key")?,
        payload_id: row.try_get("payload_id")?,
        manifest_json: row.try_get("manifest_json")?,
        created_at: row.try_get("manifest_created_at")?,
    };
    manifest.validate()?;
    let payload = StoredArtifactPayloadRecord {
        payload_id: manifest.payload_id.clone(),
        sha256: row.try_get("sha256")?,
        byte_len: artifact_storage_u64(row.try_get("byte_len")?, "byteLen")?,
        media_type: row.try_get("media_type")?,
        sensitivity: ArtifactPayloadSensitivity::from_str(row.try_get("sensitivity")?)?,
        retention_kind: ArtifactRetentionKind::from_str(row.try_get("retention_kind")?)?,
        expires_at: row.try_get("expires_at")?,
        status,
        content: row.try_get("content")?,
        deletion_reason,
        deleted_at: row.try_get("deleted_at")?,
        created_at: row.try_get("payload_created_at")?,
    };
    Ok(StoredArtifactRecord { manifest, payload })
}

pub(super) fn stored_artifact_metadata_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<StoredArtifactMetadataRecord> {
    let status = ArtifactPayloadStatus::from_str(row.try_get("status")?)?;
    let deletion_reason = row
        .try_get::<Option<String>, _>("deletion_reason")?
        .as_deref()
        .map(ArtifactDeletionReason::from_str)
        .transpose()?;
    let manifest = ArtifactManifestRecord {
        artifact_id: row.try_get("artifact_id")?,
        revision: artifact_storage_u64(row.try_get("revision")?, "revision")?,
        idempotency_key: row.try_get("idempotency_key")?,
        payload_id: row.try_get("payload_id")?,
        manifest_json: row.try_get("manifest_json")?,
        created_at: row.try_get("manifest_created_at")?,
    };
    manifest.validate()?;
    let payload = StoredArtifactPayloadMetadataRecord {
        payload_id: manifest.payload_id.clone(),
        sha256: row.try_get("sha256")?,
        byte_len: artifact_storage_u64(row.try_get("byte_len")?, "byteLen")?,
        media_type: row.try_get("media_type")?,
        sensitivity: ArtifactPayloadSensitivity::from_str(row.try_get("sensitivity")?)?,
        retention_kind: ArtifactRetentionKind::from_str(row.try_get("retention_kind")?)?,
        expires_at: row.try_get("expires_at")?,
        status,
        deletion_reason,
        deleted_at: row.try_get("deleted_at")?,
        created_at: row.try_get("payload_created_at")?,
    };
    Ok(StoredArtifactMetadataRecord { manifest, payload })
}

pub(super) fn audit_payload_matches_row(
    row: &sqlx::sqlite::SqliteRow,
    event: &PlatformAuditEventRecord,
) -> anyhow::Result<bool> {
    let metadata: serde_json::Value = serde_json::from_str(&event.metadata_json)?;
    let sensitivity = ArtifactPayloadSensitivity::from_str(row.try_get("sensitivity")?)?;
    let wire_sensitivity = match sensitivity {
        ArtifactPayloadSensitivity::Public => "public",
        ArtifactPayloadSensitivity::Internal => "internal",
        ArtifactPayloadSensitivity::WorkspaceSensitive => "workspaceSensitive",
    };
    Ok(metadata
        .pointer("/payload/payload/digest")
        .and_then(serde_json::Value::as_str)
        == Some(row.try_get::<&str, _>("sha256")?)
        && metadata
            .pointer("/payload/payload/byteLen")
            .and_then(serde_json::Value::as_i64)
            == Some(row.try_get("byte_len")?)
        && metadata
            .pointer("/payload/payload/mediaType")
            .and_then(serde_json::Value::as_str)
            == Some(row.try_get::<&str, _>("media_type")?)
        && metadata
            .pointer("/payload/payload/sensitivity")
            .and_then(serde_json::Value::as_str)
            == Some(wire_sensitivity))
}

pub(super) fn artifact_commit_hash(commit: &ArtifactCommitRecord) -> String {
    let revision = commit.manifest.revision.to_string();
    let created_at = commit.payload.created_at.to_string();
    let expires_at = commit
        .payload
        .expires_at
        .map(|value| value.to_string())
        .unwrap_or_default();
    let event_hash = audit_event_hash(&commit.created_event);
    digest_parts(&[
        commit.manifest.artifact_id.as_bytes(),
        revision.as_bytes(),
        commit.manifest.idempotency_key.as_bytes(),
        commit.payload.payload_id.as_bytes(),
        commit.payload.sha256.as_bytes(),
        commit.payload.media_type.as_bytes(),
        commit.payload.sensitivity.as_str().as_bytes(),
        commit.payload.retention_kind.as_str().as_bytes(),
        expires_at.as_bytes(),
        created_at.as_bytes(),
        commit.manifest.manifest_json.as_bytes(),
        event_hash.as_bytes(),
    ])
}

pub(in crate::runtime) fn audit_event_hash(event: &PlatformAuditEventRecord) -> String {
    let occurred_at = event.occurred_at.to_string();
    digest_parts(&[
        event.event_id.as_bytes(),
        event.idempotency_key.as_bytes(),
        event.event_type.as_bytes(),
        event.metadata_json.as_bytes(),
        event.payload_id.as_deref().unwrap_or_default().as_bytes(),
        occurred_at.as_bytes(),
    ])
}

pub(super) fn artifact_storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Artifact storage field {field} is out of range"))
}

fn artifact_storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Artifact storage field {field} is out of range"))
}
