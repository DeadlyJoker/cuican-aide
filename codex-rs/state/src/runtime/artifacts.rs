use super::StateRuntime;
#[path = "artifact_storage_mapping.rs"]
pub(super) mod storage_mapping;

use crate::ArtifactCommitOutcome;
use crate::ArtifactCommitRecord;
use crate::ArtifactDeletionReason;
use crate::ArtifactPayloadDeleteOutcome;
use crate::ArtifactPayloadDeleteRecord;
use crate::ArtifactRetentionKind;
use crate::AuditAppendOutcome;
use crate::MAX_ARTIFACT_CLEANUP_BATCH;
use crate::PlatformAuditEventRecord;
use crate::StoredArtifactMetadataRecord;
use crate::StoredArtifactRecord;
use sqlx::Row;
use storage_mapping::artifact_commit_hash;
use storage_mapping::artifact_storage_i64;
use storage_mapping::audit_event_hash;
use storage_mapping::audit_payload_matches_row;
use storage_mapping::stored_artifact_from_row;
use storage_mapping::stored_artifact_metadata_from_row;

impl StateRuntime {
    /// Atomically persists payload, immutable Manifest, and creation Audit Event.
    pub async fn commit_artifact_record(
        &self,
        commit: &ArtifactCommitRecord,
    ) -> anyhow::Result<ArtifactCommitOutcome> {
        commit.validate()?;
        let commit_hash = artifact_commit_hash(commit);
        let event_hash = audit_event_hash(&commit.created_event);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;

        if let Some(existing_hash) = sqlx::query_scalar::<_, String>(
            "SELECT commit_hash FROM artifact_manifests WHERE idempotency_key = ?",
        )
        .bind(&commit.manifest.idempotency_key)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.rollback().await?;
            return Ok(if existing_hash == commit_hash {
                ArtifactCommitOutcome::ExistingSame
            } else {
                ArtifactCommitOutcome::Conflict
            });
        }

        if artifact_identity_exists(&mut tx, commit).await? {
            tx.rollback().await?;
            return Ok(ArtifactCommitOutcome::Conflict);
        }

        insert_payload(&mut tx, commit).await?;
        insert_manifest(&mut tx, commit, &commit_hash).await?;
        insert_audit_event(&mut tx, &commit.created_event, &event_hash).await?;
        tx.commit().await?;
        Ok(ArtifactCommitOutcome::Created)
    }

    /// Appends one metadata-only Audit Event with stable idempotency semantics.
    pub async fn append_platform_audit_event(
        &self,
        event: &PlatformAuditEventRecord,
    ) -> anyhow::Result<AuditAppendOutcome> {
        event.validate()?;
        let event_hash = audit_event_hash(event);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing_hash) = sqlx::query_scalar::<_, String>(
            "SELECT event_hash FROM platform_audit_events WHERE idempotency_key = ?",
        )
        .bind(&event.idempotency_key)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.rollback().await?;
            return Ok(if existing_hash == event_hash {
                AuditAppendOutcome::ExistingSame
            } else {
                AuditAppendOutcome::Conflict
            });
        }
        if sqlx::query_scalar::<_, i64>("SELECT 1 FROM platform_audit_events WHERE event_id = ?")
            .bind(&event.event_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some()
        {
            tx.rollback().await?;
            return Ok(AuditAppendOutcome::Conflict);
        }
        if !audit_payload_reference_is_valid(&mut tx, event).await? {
            tx.rollback().await?;
            return Ok(AuditAppendOutcome::Conflict);
        }
        insert_audit_event(&mut tx, event, &event_hash).await?;
        tx.commit().await?;
        Ok(AuditAppendOutcome::Created)
    }

    /// Reads one immutable Manifest and either available body or deleted tombstone.
    pub async fn get_artifact_record(
        &self,
        artifact_id: &str,
        revision: u64,
    ) -> anyhow::Result<Option<StoredArtifactRecord>> {
        let revision = artifact_storage_i64(revision, "revision")?;
        let row = sqlx::query(
            r#"
SELECT m.artifact_id, m.revision, m.idempotency_key, m.payload_id,
       m.manifest_json, m.created_at AS manifest_created_at,
       p.sha256, p.byte_len, p.media_type, p.sensitivity, p.retention_kind,
       p.expires_at, p.status, p.content, p.deletion_reason, p.deleted_at,
       p.created_at AS payload_created_at
FROM artifact_manifests m
JOIN artifact_payloads p ON p.payload_id = m.payload_id
WHERE m.artifact_id = ? AND m.revision = ?
  AND (
      (p.status = 'deleted' AND p.content IS NULL)
      OR
      (p.status = 'available' AND length(p.content) = p.byte_len)
  )
            "#,
        )
        .bind(artifact_id)
        .bind(revision)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(stored_artifact_from_row).transpose()
    }

    /// Reads immutable Manifest and payload metadata without loading body bytes.
    pub async fn get_artifact_metadata_record(
        &self,
        artifact_id: &str,
        revision: u64,
    ) -> anyhow::Result<Option<StoredArtifactMetadataRecord>> {
        let revision = artifact_storage_i64(revision, "revision")?;
        let row = sqlx::query(
            r#"
SELECT m.artifact_id, m.revision, m.idempotency_key, m.payload_id,
       m.manifest_json, m.created_at AS manifest_created_at,
       p.sha256, p.byte_len, p.media_type, p.sensitivity, p.retention_kind,
       p.expires_at, p.status, p.deletion_reason, p.deleted_at,
       p.created_at AS payload_created_at
FROM artifact_manifests m
JOIN artifact_payloads p ON p.payload_id = m.payload_id
WHERE m.artifact_id = ? AND m.revision = ?
            "#,
        )
        .bind(artifact_id)
        .bind(revision)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(stored_artifact_metadata_from_row).transpose()
    }

    /// Reads an Audit Event after any associated payload was tombstoned.
    pub async fn get_platform_audit_event(
        &self,
        event_id: &str,
    ) -> anyhow::Result<Option<PlatformAuditEventRecord>> {
        let row = sqlx::query(
            r#"
SELECT event_id, idempotency_key, event_hash, event_type, metadata_json,
       payload_id, occurred_at
FROM platform_audit_events
WHERE event_id = ?
            "#,
        )
        .bind(event_id)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(|row| {
            let record = PlatformAuditEventRecord {
                event_id: row.try_get("event_id")?,
                idempotency_key: row.try_get("idempotency_key")?,
                event_type: row.try_get("event_type")?,
                metadata_json: row.try_get("metadata_json")?,
                payload_id: row.try_get("payload_id")?,
                occurred_at: row.try_get("occurred_at")?,
            };
            record.validate()?;
            if row.try_get::<String, _>("event_hash")? != audit_event_hash(&record) {
                anyhow::bail!("Platform Audit Event hash mismatch");
            }
            Ok(record)
        })
        .transpose()
    }

    /// Atomically tombstones body bytes and appends the deletion Audit Event.
    pub async fn delete_artifact_payload(
        &self,
        request: &ArtifactPayloadDeleteRecord,
    ) -> anyhow::Result<ArtifactPayloadDeleteOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            r#"
SELECT status, retention_kind, expires_at, deletion_reason, deleted_at,
       sha256, byte_len, media_type, sensitivity
FROM artifact_payloads
WHERE payload_id = ?
            "#,
        )
        .bind(&request.payload_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(ArtifactPayloadDeleteOutcome::NotFound);
        };
        if row.try_get::<String, _>("status")? == "deleted" {
            tx.rollback().await?;
            let deletion_reason = row
                .try_get::<Option<String>, _>("deletion_reason")?
                .as_deref()
                .map(ArtifactDeletionReason::from_str)
                .transpose()?;
            let deleted_at: Option<i64> = row.try_get("deleted_at")?;
            let existing_hash = sqlx::query_scalar::<_, String>(
                "SELECT event_hash FROM platform_audit_events WHERE idempotency_key = ?",
            )
            .bind(&request.audit_event.idempotency_key)
            .fetch_optional(self.pool.as_ref())
            .await?;
            if deletion_reason != Some(request.reason)
                || deleted_at != Some(request.deleted_at)
                || existing_hash.as_deref() != Some(audit_event_hash(&request.audit_event).as_str())
            {
                return Ok(ArtifactPayloadDeleteOutcome::AuditConflict);
            }
            checkpoint_artifact_deletion(self.pool.as_ref()).await?;
            return Ok(ArtifactPayloadDeleteOutcome::AlreadyDeleted);
        }
        let retention = ArtifactRetentionKind::from_str(row.try_get("retention_kind")?)?;
        let expires_at: Option<i64> = row.try_get("expires_at")?;
        if deletion_is_denied(retention, expires_at, request) {
            tx.rollback().await?;
            return Ok(ArtifactPayloadDeleteOutcome::AuthorityDenied);
        }
        if !audit_payload_matches_row(&row, &request.audit_event)? {
            tx.rollback().await?;
            return Ok(ArtifactPayloadDeleteOutcome::AuditConflict);
        }
        if audit_identity_exists(&mut tx, &request.audit_event).await? {
            tx.rollback().await?;
            return Ok(ArtifactPayloadDeleteOutcome::AuditConflict);
        }

        let result = sqlx::query(
            r#"
UPDATE artifact_payloads
SET status = 'deleted', content = NULL, deletion_reason = ?, deleted_at = ?
WHERE payload_id = ? AND status = 'available'
            "#,
        )
        .bind(request.reason.as_str())
        .bind(request.deleted_at)
        .bind(&request.payload_id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            anyhow::bail!("Artifact payload tombstone compare-and-swap failed");
        }
        let event_hash = audit_event_hash(&request.audit_event);
        insert_audit_event(&mut tx, &request.audit_event, &event_hash).await?;
        tx.commit().await?;
        checkpoint_artifact_deletion(self.pool.as_ref()).await?;
        Ok(ArtifactPayloadDeleteOutcome::Deleted)
    }

    /// Lists a bounded set of available expired payloads for an authority worker.
    pub async fn list_expired_artifact_payload_ids(
        &self,
        now: i64,
        limit: u32,
    ) -> anyhow::Result<Vec<String>> {
        if now < 0 || limit == 0 || limit > MAX_ARTIFACT_CLEANUP_BATCH {
            anyhow::bail!("invalid Artifact cleanup bounds");
        }
        sqlx::query_scalar::<_, String>(
            r#"
SELECT payload_id
FROM artifact_payloads
WHERE status = 'available' AND expires_at IS NOT NULL AND expires_at <= ?
ORDER BY expires_at ASC, created_at ASC, payload_id ASC
LIMIT ?
            "#,
        )
        .bind(now)
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await
        .map_err(Into::into)
    }
}

async fn artifact_identity_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &ArtifactCommitRecord,
) -> anyhow::Result<bool> {
    let manifest_exists = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM artifact_manifests WHERE artifact_id = ? AND revision = ?",
    )
    .bind(&commit.manifest.artifact_id)
    .bind(artifact_storage_i64(commit.manifest.revision, "revision")?)
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if manifest_exists {
        return Ok(true);
    }
    let payload_exists =
        sqlx::query_scalar::<_, i64>("SELECT 1 FROM artifact_payloads WHERE payload_id = ?")
            .bind(&commit.payload.payload_id)
            .fetch_optional(&mut **tx)
            .await?
            .is_some();
    Ok(payload_exists || audit_identity_exists(tx, &commit.created_event).await?)
}

async fn audit_identity_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &PlatformAuditEventRecord,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM platform_audit_events WHERE event_id = ? OR idempotency_key = ?",
    )
    .bind(&event.event_id)
    .bind(&event.idempotency_key)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn audit_payload_reference_is_valid(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &PlatformAuditEventRecord,
) -> anyhow::Result<bool> {
    let Some(payload_id) = event.payload_id.as_deref() else {
        return Ok(true);
    };
    let row = sqlx::query(
        "SELECT sha256, byte_len, media_type, sensitivity FROM artifact_payloads WHERE payload_id = ?",
    )
    .bind(payload_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.as_ref()
        .map(|row| audit_payload_matches_row(row, event))
        .transpose()
        .map(Option::unwrap_or_default)
}

async fn insert_payload(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &ArtifactCommitRecord,
) -> anyhow::Result<()> {
    let payload = &commit.payload;
    sqlx::query(
        r#"
INSERT INTO artifact_payloads (
    payload_id, sha256, byte_len, media_type, sensitivity, retention_kind,
    expires_at, status, content, deletion_reason, deleted_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, NULL, NULL, ?)
        "#,
    )
    .bind(&payload.payload_id)
    .bind(&payload.sha256)
    .bind(artifact_storage_i64(
        payload.content.len() as u64,
        "byteLen",
    )?)
    .bind(&payload.media_type)
    .bind(payload.sensitivity.as_str())
    .bind(payload.retention_kind.as_str())
    .bind(payload.expires_at)
    .bind(&payload.content)
    .bind(payload.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_manifest(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &ArtifactCommitRecord,
    commit_hash: &str,
) -> anyhow::Result<()> {
    let manifest = &commit.manifest;
    sqlx::query(
        r#"
INSERT INTO artifact_manifests (
    artifact_id, revision, idempotency_key, commit_hash, payload_id,
    manifest_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&manifest.artifact_id)
    .bind(artifact_storage_i64(manifest.revision, "revision")?)
    .bind(&manifest.idempotency_key)
    .bind(commit_hash)
    .bind(&manifest.payload_id)
    .bind(&manifest.manifest_json)
    .bind(manifest.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) async fn insert_audit_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &PlatformAuditEventRecord,
    event_hash: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO platform_audit_events (
    event_id, idempotency_key, event_hash, event_type, metadata_json,
    payload_id, occurred_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&event.event_id)
    .bind(&event.idempotency_key)
    .bind(event_hash)
    .bind(&event.event_type)
    .bind(&event.metadata_json)
    .bind(event.payload_id.as_deref())
    .bind(event.occurred_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn deletion_is_denied(
    retention: ArtifactRetentionKind,
    expires_at: Option<i64>,
    request: &ArtifactPayloadDeleteRecord,
) -> bool {
    if retention == ArtifactRetentionKind::Compliance
        && request.reason == ArtifactDeletionReason::UserRequested
    {
        return true;
    }
    request.reason == ArtifactDeletionReason::RetentionExpired
        && expires_at.is_none_or(|expires_at| expires_at > request.deleted_at)
}

async fn checkpoint_artifact_deletion(pool: &sqlx::SqlitePool) -> anyhow::Result<()> {
    let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(pool)
        .await?;
    if busy != 0 {
        anyhow::bail!("Artifact payload deletion WAL checkpoint is busy");
    }
    Ok(())
}

#[cfg(test)]
#[path = "artifacts_tests.rs"]
mod tests;
