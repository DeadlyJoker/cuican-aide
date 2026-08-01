use sqlx::Row;

use super::StateRuntime;
use crate::ProviderAccessGrantLookup;
use crate::ProviderAccessGrantOwnerLookup;
use crate::ProviderAccessGrantRecord;
use crate::ProviderAccessGrantRefreshOutcome;
use crate::ProviderAccessGrantRefreshRequest;
use crate::ProviderAccessGrantReplaceOutcome;
use crate::ProviderAccessGrantReplaceRequest;
use crate::ProviderAccessGrantResolveOutcome;
use crate::ProviderAccessGrantRevokeOutcome;
use crate::ProviderAccessGrantRevokeRequest;
use crate::ProviderAccessGrantStatus;
use crate::provider_access_grant_records::MAX_SCOPES_JSON_BYTES;
use crate::provider_access_grant_records::validate_grant_id;

const MAX_PROVIDER_ACCESS_GRANTS: i64 = 1_024;

impl StateRuntime {
    pub async fn resolve_provider_access_grant_record(
        &self,
        proposed: &ProviderAccessGrantRecord,
    ) -> anyhow::Result<ProviderAccessGrantResolveOutcome> {
        proposed.validate()?;
        if proposed.status != ProviderAccessGrantStatus::Active || proposed.revision != 1 {
            return Ok(ProviderAccessGrantResolveOutcome::Conflict);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = grant_by_id(&mut tx, &proposed.grant_id).await? {
            tx.rollback().await?;
            return Ok(if existing == *proposed {
                ProviderAccessGrantResolveOutcome::Existing(existing)
            } else {
                ProviderAccessGrantResolveOutcome::Conflict
            });
        }
        if let Some(existing) = active_grant_by_owner_provider(&mut tx, proposed).await? {
            tx.rollback().await?;
            return Ok(if same_authority(&existing, proposed) {
                ProviderAccessGrantResolveOutcome::Existing(existing)
            } else {
                ProviderAccessGrantResolveOutcome::Conflict
            });
        }
        if active_source_exists(&mut tx, proposed).await? {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantResolveOutcome::Conflict);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_access_grants")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_PROVIDER_ACCESS_GRANTS {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantResolveOutcome::CapacityExceeded);
        }
        insert_grant(&mut tx, proposed).await?;
        tx.commit().await?;
        Ok(ProviderAccessGrantResolveOutcome::Created(proposed.clone()))
    }

    pub async fn get_provider_access_grant_record(
        &self,
        grant_id: &str,
    ) -> anyhow::Result<Option<ProviderAccessGrantRecord>> {
        validate_grant_id(grant_id)?;
        grant_query()
            .bind(grant_id)
            .fetch_optional(self.pool.as_ref())
            .await?
            .map(grant_from_row)
            .transpose()
    }

    pub async fn get_active_provider_access_grant_record(
        &self,
        lookup: &ProviderAccessGrantLookup,
        now: i64,
    ) -> anyhow::Result<Option<ProviderAccessGrantRecord>> {
        lookup.validate()?;
        if now < 0 {
            anyhow::bail!("Provider access grant lookup time is invalid");
        }
        let source_revision = storage_i64(lookup.source_revision, "sourceRevision")?;
        let row = sqlx::query(
            r#"
SELECT grant_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       source_binding_id, source_revision, granted_scopes_json, status, expires_at,
       revision, record_hash, created_at, updated_at, revoked_at
FROM provider_access_grants
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND provider_id = ? AND source_binding_id = ? AND source_revision = ?
  AND status = 'active' AND expires_at > ?
            "#,
        )
        .bind(&lookup.local_actor_id)
        .bind(&lookup.local_tenant_id)
        .bind(&lookup.local_space_id)
        .bind(&lookup.provider_id)
        .bind(&lookup.source_binding_id)
        .bind(source_revision)
        .bind(now)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(grant_from_row).transpose()
    }

    pub async fn get_current_provider_access_grant_record(
        &self,
        lookup: &ProviderAccessGrantOwnerLookup,
    ) -> anyhow::Result<Option<ProviderAccessGrantRecord>> {
        lookup.validate()?;
        let row = sqlx::query(
            r#"
SELECT grant_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       source_binding_id, source_revision, granted_scopes_json, status, expires_at,
       revision, record_hash, created_at, updated_at, revoked_at
FROM provider_access_grants
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND provider_id = ? AND status = 'active'
            "#,
        )
        .bind(&lookup.local_actor_id)
        .bind(&lookup.local_tenant_id)
        .bind(&lookup.local_space_id)
        .bind(&lookup.provider_id)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(grant_from_row).transpose()
    }

    pub async fn refresh_provider_access_grant_record(
        &self,
        request: &ProviderAccessGrantRefreshRequest,
    ) -> anyhow::Result<ProviderAccessGrantRefreshOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = grant_by_id(&mut tx, &request.grant_id).await? else {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRefreshOutcome::Conflict);
        };
        if current.status != ProviderAccessGrantStatus::Active
            || current.revision != request.expected_revision
        {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRefreshOutcome::Conflict);
        }
        if current.expires_at >= request.refreshed_expires_at {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRefreshOutcome::Existing(current));
        }
        if current.expires_at != request.expected_expires_at
            || current.expires_at <= request.refreshed_at
        {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRefreshOutcome::Conflict);
        }

        let expected_record_hash = current.record_hash.clone();
        current.expires_at = request.refreshed_expires_at;
        current.record_hash = current.canonical_hash();
        current.validate()?;
        let updated = sqlx::query(
            r#"
UPDATE provider_access_grants
SET expires_at = ?, record_hash = ?
WHERE grant_id = ? AND revision = ? AND status = 'active'
  AND expires_at = ? AND record_hash = ?
            "#,
        )
        .bind(current.expires_at)
        .bind(&current.record_hash)
        .bind(&current.grant_id)
        .bind(storage_i64(request.expected_revision, "expectedRevision")?)
        .bind(request.expected_expires_at)
        .bind(expected_record_hash)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRefreshOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(ProviderAccessGrantRefreshOutcome::Refreshed(current))
    }

    pub async fn revoke_provider_access_grant_record(
        &self,
        request: &ProviderAccessGrantRevokeRequest,
    ) -> anyhow::Result<ProviderAccessGrantRevokeOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = grant_by_id(&mut tx, &request.grant_id).await? else {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRevokeOutcome::NotFound);
        };
        if current.status == ProviderAccessGrantStatus::Revoked {
            let same = request.expected_revision.checked_add(1) == Some(current.revision)
                && current.revoked_at == Some(request.revoked_at);
            tx.rollback().await?;
            return Ok(if same {
                ProviderAccessGrantRevokeOutcome::ExistingRevoked
            } else {
                ProviderAccessGrantRevokeOutcome::Conflict
            });
        }
        if current.revision != request.expected_revision || request.revoked_at < current.updated_at
        {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRevokeOutcome::Conflict);
        }
        current.revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Provider access grant revision overflow"))?;
        current.status = ProviderAccessGrantStatus::Revoked;
        current.updated_at = request.revoked_at;
        current.revoked_at = Some(request.revoked_at);
        current.record_hash = current.canonical_hash();
        current.validate()?;
        let updated = sqlx::query(
            r#"
UPDATE provider_access_grants
SET status = 'revoked', revision = ?, record_hash = ?, updated_at = ?, revoked_at = ?
WHERE grant_id = ? AND revision = ? AND status = 'active'
            "#,
        )
        .bind(storage_i64(current.revision, "revision")?)
        .bind(&current.record_hash)
        .bind(current.updated_at)
        .bind(current.revoked_at)
        .bind(&current.grant_id)
        .bind(storage_i64(request.expected_revision, "expectedRevision")?)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantRevokeOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(ProviderAccessGrantRevokeOutcome::Revoked)
    }

    pub async fn replace_provider_access_grant_record(
        &self,
        request: &ProviderAccessGrantReplaceRequest,
    ) -> anyhow::Result<ProviderAccessGrantReplaceOutcome> {
        request.validate()?;
        let proposed = &request.replacement;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = grant_by_id(&mut tx, &request.current_grant_id).await? else {
            let outcome = existing_replacement(&mut tx, proposed).await?;
            tx.rollback().await?;
            return Ok(outcome.unwrap_or(ProviderAccessGrantReplaceOutcome::Conflict));
        };
        if current.status != ProviderAccessGrantStatus::Active {
            let outcome = existing_replacement(&mut tx, proposed).await?;
            tx.rollback().await?;
            return Ok(outcome.unwrap_or(ProviderAccessGrantReplaceOutcome::Conflict));
        }
        if current.revision != request.expected_revision
            || request.replaced_at < current.updated_at
            || current.local_actor_id != proposed.local_actor_id
            || current.local_tenant_id != proposed.local_tenant_id
            || current.local_space_id != proposed.local_space_id
            || current.provider_id != proposed.provider_id
            || current.granted_scopes != proposed.granted_scopes
            || (current.source_binding_id == proposed.source_binding_id
                && proposed.source_revision < current.source_revision)
        {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantReplaceOutcome::Conflict);
        }
        if let Some(existing) = grant_by_id(&mut tx, &proposed.grant_id).await? {
            tx.rollback().await?;
            return Ok(
                if existing.status == ProviderAccessGrantStatus::Active
                    && same_authority(&existing, proposed)
                {
                    ProviderAccessGrantReplaceOutcome::Existing(existing)
                } else {
                    ProviderAccessGrantReplaceOutcome::Conflict
                },
            );
        }
        if active_source_exists_except(&mut tx, proposed, &current.grant_id).await? {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantReplaceOutcome::Conflict);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_access_grants")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_PROVIDER_ACCESS_GRANTS {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantReplaceOutcome::CapacityExceeded);
        }

        current.revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Provider access grant revision overflow"))?;
        current.status = ProviderAccessGrantStatus::Revoked;
        current.updated_at = request.replaced_at;
        current.revoked_at = Some(request.replaced_at);
        current.record_hash = current.canonical_hash();
        current.validate()?;
        let updated = update_revoked_grant(&mut tx, &current, request.expected_revision).await?;
        if !updated {
            tx.rollback().await?;
            return Ok(ProviderAccessGrantReplaceOutcome::Conflict);
        }
        insert_grant(&mut tx, proposed).await?;
        tx.commit().await?;
        Ok(ProviderAccessGrantReplaceOutcome::Replaced(
            proposed.clone(),
        ))
    }
}

pub(in crate::runtime) fn grant_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT grant_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       source_binding_id, source_revision, granted_scopes_json, status, expires_at,
       revision, record_hash, created_at, updated_at, revoked_at
FROM provider_access_grants
WHERE grant_id = ?
        "#,
    )
}

async fn grant_by_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    grant_id: &str,
) -> anyhow::Result<Option<ProviderAccessGrantRecord>> {
    grant_query()
        .bind(grant_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(grant_from_row)
        .transpose()
}

async fn active_grant_by_owner_provider(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    proposed: &ProviderAccessGrantRecord,
) -> anyhow::Result<Option<ProviderAccessGrantRecord>> {
    let row = sqlx::query(
        r#"
SELECT grant_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
       source_binding_id, source_revision, granted_scopes_json, status, expires_at,
       revision, record_hash, created_at, updated_at, revoked_at
FROM provider_access_grants
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND provider_id = ? AND status = 'active'
        "#,
    )
    .bind(&proposed.local_actor_id)
    .bind(&proposed.local_tenant_id)
    .bind(&proposed.local_space_id)
    .bind(&proposed.provider_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(grant_from_row).transpose()
}

async fn active_source_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    proposed: &ProviderAccessGrantRecord,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1 FROM provider_access_grants
WHERE provider_id = ? AND source_binding_id = ? AND source_revision = ?
  AND status = 'active'
        "#,
    )
    .bind(&proposed.provider_id)
    .bind(&proposed.source_binding_id)
    .bind(storage_i64(proposed.source_revision, "sourceRevision")?)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn active_source_exists_except(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    proposed: &ProviderAccessGrantRecord,
    excluded_grant_id: &str,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1 FROM provider_access_grants
WHERE provider_id = ? AND source_binding_id = ? AND source_revision = ?
  AND status = 'active' AND grant_id != ?
        "#,
    )
    .bind(&proposed.provider_id)
    .bind(&proposed.source_binding_id)
    .bind(storage_i64(proposed.source_revision, "sourceRevision")?)
    .bind(excluded_grant_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn existing_replacement(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    proposed: &ProviderAccessGrantRecord,
) -> anyhow::Result<Option<ProviderAccessGrantReplaceOutcome>> {
    Ok(active_grant_by_owner_provider(tx, proposed)
        .await?
        .map(|existing| {
            if same_authority(&existing, proposed) {
                ProviderAccessGrantReplaceOutcome::Existing(existing)
            } else {
                ProviderAccessGrantReplaceOutcome::Conflict
            }
        }))
}

fn same_authority(
    current: &ProviderAccessGrantRecord,
    proposed: &ProviderAccessGrantRecord,
) -> bool {
    current.local_actor_id == proposed.local_actor_id
        && current.local_tenant_id == proposed.local_tenant_id
        && current.local_space_id == proposed.local_space_id
        && current.provider_id == proposed.provider_id
        && current.source_binding_id == proposed.source_binding_id
        && current.source_revision == proposed.source_revision
        && current.granted_scopes == proposed.granted_scopes
        && current.expires_at == proposed.expires_at
}

async fn insert_grant(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderAccessGrantRecord,
) -> anyhow::Result<()> {
    let granted_scopes_json = serde_json::to_string(&record.granted_scopes)?;
    let inserted = sqlx::query(
        r#"
INSERT INTO provider_access_grants (
    grant_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
    source_binding_id, source_revision, granted_scopes_json, status, expires_at,
    revision, record_hash, created_at, updated_at, revoked_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.grant_id)
    .bind(&record.local_actor_id)
    .bind(&record.local_tenant_id)
    .bind(&record.local_space_id)
    .bind(&record.provider_id)
    .bind(&record.source_binding_id)
    .bind(storage_i64(record.source_revision, "sourceRevision")?)
    .bind(granted_scopes_json)
    .bind(record.status.as_str())
    .bind(record.expires_at)
    .bind(storage_i64(record.revision, "revision")?)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .bind(record.updated_at)
    .bind(record.revoked_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        anyhow::bail!("Provider access grant insert failed");
    }
    Ok(())
}

async fn update_revoked_grant(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderAccessGrantRecord,
    expected_revision: u64,
) -> anyhow::Result<bool> {
    let updated = sqlx::query(
        r#"
UPDATE provider_access_grants
SET status = 'revoked', revision = ?, record_hash = ?, updated_at = ?, revoked_at = ?
WHERE grant_id = ? AND revision = ? AND status = 'active'
        "#,
    )
    .bind(storage_i64(record.revision, "revision")?)
    .bind(&record.record_hash)
    .bind(record.updated_at)
    .bind(record.revoked_at)
    .bind(&record.grant_id)
    .bind(storage_i64(expected_revision, "expectedRevision")?)
    .execute(&mut **tx)
    .await?;
    Ok(updated.rows_affected() == 1)
}

pub(in crate::runtime) fn grant_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<ProviderAccessGrantRecord> {
    let granted_scopes_json = row.try_get::<String, _>("granted_scopes_json")?;
    if granted_scopes_json.len() > MAX_SCOPES_JSON_BYTES {
        anyhow::bail!("Provider access grant scopes exceed storage bound");
    }
    let record = ProviderAccessGrantRecord {
        grant_id: row.try_get("grant_id")?,
        local_actor_id: row.try_get("local_actor_id")?,
        local_tenant_id: row.try_get("local_tenant_id")?,
        local_space_id: row.try_get("local_space_id")?,
        provider_id: row.try_get("provider_id")?,
        source_binding_id: row.try_get("source_binding_id")?,
        source_revision: storage_u64(row.try_get("source_revision")?, "sourceRevision")?,
        granted_scopes: serde_json::from_str(&granted_scopes_json)?,
        status: ProviderAccessGrantStatus::from_str(row.try_get("status")?)?,
        expires_at: row.try_get("expires_at")?,
        revision: storage_u64(row.try_get("revision")?, "revision")?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        revoked_at: row.try_get("revoked_at")?,
    };
    record.validate()?;
    Ok(record)
}

fn storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("{field} exceeds SQLite range"))
}

fn storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value).map_err(|_| anyhow::anyhow!("{field} is negative"))
}
