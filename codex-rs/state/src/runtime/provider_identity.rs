use sqlx::Row;

use super::StateRuntime;
use crate::ProviderIdentityBindingCreateOutcome;
use crate::ProviderIdentityBindingLookup;
use crate::ProviderIdentityBindingPage;
use crate::ProviderIdentityBindingRecord;
use crate::ProviderIdentityBindingRefreshOutcome;
use crate::ProviderIdentityBindingRefreshRequest;
use crate::ProviderIdentityBindingRevokeOutcome;
use crate::ProviderIdentityBindingRevokeRequest;
use crate::ProviderIdentityBindingStatus;
use crate::provider_identity_records::validate_binding_id;

impl StateRuntime {
    pub async fn create_provider_identity_binding_record(
        &self,
        record: &ProviderIdentityBindingRecord,
    ) -> anyhow::Result<ProviderIdentityBindingCreateOutcome> {
        record.validate()?;
        if record.status != ProviderIdentityBindingStatus::Active
            || record.revision != 1
            || record.source_fresh_until <= record.updated_at
        {
            return Ok(ProviderIdentityBindingCreateOutcome::Conflict);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = binding_by_id(&mut tx, &record.binding_id).await? {
            tx.rollback().await?;
            return Ok(if existing == *record {
                ProviderIdentityBindingCreateOutcome::ExistingSame
            } else {
                ProviderIdentityBindingCreateOutcome::Conflict
            });
        }
        if active_owner_exists(&mut tx, record).await?
            || active_target_exists(&mut tx, record).await?
            || source_binding_exists(&mut tx, record).await?
        {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingCreateOutcome::Conflict);
        }
        insert_binding(&mut tx, record).await?;
        tx.commit().await?;
        Ok(ProviderIdentityBindingCreateOutcome::Created)
    }

    pub async fn get_provider_identity_binding_record(
        &self,
        binding_id: &str,
    ) -> anyhow::Result<Option<ProviderIdentityBindingRecord>> {
        validate_binding_id(binding_id)?;
        let row = binding_query()
            .bind(binding_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        row.map(binding_from_row).transpose()
    }

    pub async fn get_active_provider_identity_binding_record(
        &self,
        lookup: &ProviderIdentityBindingLookup,
        now: i64,
    ) -> anyhow::Result<Option<ProviderIdentityBindingRecord>> {
        lookup.validate()?;
        if now < 0 {
            anyhow::bail!("Provider identity lookup time is invalid");
        }
        let row = sqlx::query(
            r#"
SELECT binding_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       provider_subject, provider_tenant_id, provider_space_id, authority_id,
       source_binding_id, source_revision, source_fresh_until, revision, status, record_hash,
       created_at, updated_at
FROM provider_identity_bindings
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND provider_id = ? AND status = 'active' AND source_fresh_until > ?
            "#,
        )
        .bind(&lookup.local_actor_id)
        .bind(&lookup.local_tenant_id)
        .bind(&lookup.local_space_id)
        .bind(&lookup.provider_id)
        .bind(now)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(binding_from_row).transpose()
    }

    pub async fn refresh_provider_identity_binding_record(
        &self,
        request: &ProviderIdentityBindingRefreshRequest,
    ) -> anyhow::Result<ProviderIdentityBindingRefreshOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = binding_by_id(&mut tx, &request.binding_id).await? else {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingRefreshOutcome::NotFound);
        };
        let identity_matches = current.status == ProviderIdentityBindingStatus::Active
            && current.authority_id == request.authority_id
            && current.source_binding_id == request.source_binding_id
            && current.source_revision == request.source_revision;
        if !identity_matches || request.source_fresh_until < current.source_fresh_until {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingRefreshOutcome::Conflict);
        }
        if request.source_fresh_until == current.source_fresh_until {
            let same_revision = request.expected_revision == current.revision
                || request.expected_revision.checked_add(1) == Some(current.revision);
            tx.rollback().await?;
            return Ok(if same_revision {
                ProviderIdentityBindingRefreshOutcome::ExistingFresh
            } else {
                ProviderIdentityBindingRefreshOutcome::Conflict
            });
        }
        if current.revision != request.expected_revision
            || request.source_fresh_until <= current.updated_at
        {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingRefreshOutcome::Conflict);
        }
        let next_revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Provider identity binding revision overflow"))?;
        current.revision = next_revision;
        current.source_fresh_until = request.source_fresh_until;
        current.record_hash = current.canonical_hash();
        current.validate()?;
        let updated = sqlx::query(
            r#"
UPDATE provider_identity_bindings
SET source_fresh_until = ?, revision = ?, record_hash = ?
WHERE binding_id = ? AND revision = ? AND status = 'active'
            "#,
        )
        .bind(current.source_fresh_until)
        .bind(storage_i64(current.revision, "revision")?)
        .bind(&current.record_hash)
        .bind(&current.binding_id)
        .bind(storage_i64(request.expected_revision, "expectedRevision")?)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingRefreshOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(ProviderIdentityBindingRefreshOutcome::Refreshed)
    }

    pub async fn list_active_provider_identity_binding_records(
        &self,
        after_binding_id: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<ProviderIdentityBindingPage> {
        if limit == 0 || limit > 100 {
            anyhow::bail!("Provider identity page limit is invalid");
        }
        if let Some(cursor) = after_binding_id {
            validate_binding_id(cursor)?;
        }
        let rows = sqlx::query(
            r#"
SELECT binding_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       provider_subject, provider_tenant_id, provider_space_id, authority_id,
       source_binding_id, source_revision, source_fresh_until, revision, status, record_hash,
       created_at, updated_at
FROM provider_identity_bindings
WHERE status = 'active' AND (? IS NULL OR binding_id > ?)
ORDER BY binding_id ASC
LIMIT ?
            "#,
        )
        .bind(after_binding_id)
        .bind(after_binding_id)
        .bind(i64::from(limit) + 1)
        .fetch_all(self.pool.as_ref())
        .await?;
        let mut data = rows
            .into_iter()
            .map(binding_from_row)
            .collect::<anyhow::Result<Vec<_>>>()?;
        let has_more = data.len() > limit as usize;
        if has_more {
            data.pop();
        }
        let next_cursor = if has_more {
            Some(
                data.last()
                    .ok_or_else(|| anyhow::anyhow!("Provider identity page is inconsistent"))?
                    .binding_id
                    .clone(),
            )
        } else {
            None
        };
        Ok(ProviderIdentityBindingPage { data, next_cursor })
    }

    pub async fn revoke_provider_identity_binding_record(
        &self,
        request: &ProviderIdentityBindingRevokeRequest,
    ) -> anyhow::Result<ProviderIdentityBindingRevokeOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = binding_by_id(&mut tx, &request.binding_id).await? else {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingRevokeOutcome::NotFound);
        };
        if current.status == ProviderIdentityBindingStatus::Revoked {
            let expected_revoked_revision = request.expected_revision.checked_add(1);
            let same = expected_revoked_revision == Some(current.revision)
                && current.authority_id == request.authority_id
                && current.source_revision == request.source_revision
                && current.source_fresh_until == request.source_fresh_until
                && current.updated_at == request.updated_at;
            tx.rollback().await?;
            return Ok(if same {
                ProviderIdentityBindingRevokeOutcome::ExistingRevoked
            } else {
                ProviderIdentityBindingRevokeOutcome::Conflict
            });
        }
        if current.revision != request.expected_revision
            || current.authority_id != request.authority_id
            || request.source_revision <= current.source_revision
            || request.updated_at < current.updated_at
        {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingRevokeOutcome::Conflict);
        }
        let next_revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Provider identity binding revision overflow"))?;
        current.revision = next_revision;
        current.source_revision = request.source_revision;
        current.source_fresh_until = request.source_fresh_until;
        current.status = ProviderIdentityBindingStatus::Revoked;
        current.updated_at = request.updated_at;
        current.record_hash = current.canonical_hash();
        current.validate()?;
        let updated = sqlx::query(
            r#"
UPDATE provider_identity_bindings
SET source_revision = ?, source_fresh_until = ?, revision = ?, status = 'revoked',
    record_hash = ?, updated_at = ?
WHERE binding_id = ? AND revision = ? AND status = 'active'
            "#,
        )
        .bind(storage_i64(current.source_revision, "sourceRevision")?)
        .bind(current.source_fresh_until)
        .bind(storage_i64(current.revision, "revision")?)
        .bind(&current.record_hash)
        .bind(current.updated_at)
        .bind(&current.binding_id)
        .bind(storage_i64(request.expected_revision, "expectedRevision")?)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ProviderIdentityBindingRevokeOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(ProviderIdentityBindingRevokeOutcome::Revoked)
    }
}

pub(in crate::runtime) fn binding_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT binding_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       provider_subject, provider_tenant_id, provider_space_id, authority_id,
       source_binding_id, source_revision, source_fresh_until, revision, status, record_hash,
       created_at, updated_at
FROM provider_identity_bindings
WHERE binding_id = ?
        "#,
    )
}

async fn binding_by_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    binding_id: &str,
) -> anyhow::Result<Option<ProviderIdentityBindingRecord>> {
    binding_query()
        .bind(binding_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(binding_from_row)
        .transpose()
}

pub(in crate::runtime) fn binding_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<ProviderIdentityBindingRecord> {
    let record = ProviderIdentityBindingRecord {
        binding_id: row.try_get("binding_id")?,
        local_actor_id: row.try_get("local_actor_id")?,
        local_tenant_id: row.try_get("local_tenant_id")?,
        local_space_id: row.try_get("local_space_id")?,
        provider_id: row.try_get("provider_id")?,
        provider_subject: row.try_get("provider_subject")?,
        provider_tenant_id: row.try_get("provider_tenant_id")?,
        provider_space_id: row.try_get("provider_space_id")?,
        authority_id: row.try_get("authority_id")?,
        source_binding_id: row.try_get("source_binding_id")?,
        source_revision: storage_u64(row.try_get("source_revision")?, "sourceRevision")?,
        source_fresh_until: row.try_get("source_fresh_until")?,
        revision: storage_u64(row.try_get("revision")?, "revision")?,
        status: ProviderIdentityBindingStatus::from_str(row.try_get("status")?)?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    };
    record.validate()?;
    Ok(record)
}

async fn active_owner_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderIdentityBindingRecord,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1 FROM provider_identity_bindings
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND provider_id = ? AND status = 'active'
        "#,
    )
    .bind(&record.local_actor_id)
    .bind(&record.local_tenant_id)
    .bind(&record.local_space_id)
    .bind(&record.provider_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn active_target_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderIdentityBindingRecord,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1 FROM provider_identity_bindings
WHERE provider_id = ? AND provider_tenant_id = ? AND provider_space_id = ?
  AND provider_subject = ? AND status = 'active'
        "#,
    )
    .bind(&record.provider_id)
    .bind(&record.provider_tenant_id)
    .bind(&record.provider_space_id)
    .bind(&record.provider_subject)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn source_binding_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderIdentityBindingRecord,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM provider_identity_bindings WHERE authority_id = ? AND source_binding_id = ?",
    )
    .bind(&record.authority_id)
    .bind(&record.source_binding_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn insert_binding(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderIdentityBindingRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO provider_identity_bindings (
    binding_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
    provider_subject, provider_tenant_id, provider_space_id, authority_id,
    source_binding_id, source_revision, source_fresh_until, revision, status, record_hash,
    created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.binding_id)
    .bind(&record.local_actor_id)
    .bind(&record.local_tenant_id)
    .bind(&record.local_space_id)
    .bind(&record.provider_id)
    .bind(&record.provider_subject)
    .bind(&record.provider_tenant_id)
    .bind(&record.provider_space_id)
    .bind(&record.authority_id)
    .bind(&record.source_binding_id)
    .bind(storage_i64(record.source_revision, "sourceRevision")?)
    .bind(record.source_fresh_until)
    .bind(storage_i64(record.revision, "revision")?)
    .bind(record.status.as_str())
    .bind(&record.record_hash)
    .bind(record.created_at)
    .bind(record.updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("{field} exceeds SQLite range"))
}

fn storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value).map_err(|_| anyhow::anyhow!("{field} is negative"))
}
