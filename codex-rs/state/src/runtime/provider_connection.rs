use sqlx::Row;

use super::StateRuntime;
use crate::ProviderConnectionRecord;
use crate::ProviderConnectionResolveOutcome;
use crate::provider_connection_records::validate_connection_id;

const MAX_PROVIDER_CONNECTIONS: i64 = 1_024;

impl StateRuntime {
    pub async fn resolve_provider_connection_record(
        &self,
        proposed: &ProviderConnectionRecord,
    ) -> anyhow::Result<ProviderConnectionResolveOutcome> {
        proposed.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = connection_by_id(&mut tx, &proposed.connection_id).await? {
            tx.rollback().await?;
            return Ok(if existing == *proposed {
                ProviderConnectionResolveOutcome::Existing(existing)
            } else {
                ProviderConnectionResolveOutcome::Conflict
            });
        }
        if let Some(existing) = connection_by_selection(&mut tx, proposed).await? {
            tx.rollback().await?;
            return Ok(ProviderConnectionResolveOutcome::Existing(existing));
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_connections")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_PROVIDER_CONNECTIONS {
            tx.rollback().await?;
            return Ok(ProviderConnectionResolveOutcome::CapacityExceeded);
        }
        insert_connection(&mut tx, proposed).await?;
        tx.commit().await?;
        Ok(ProviderConnectionResolveOutcome::Created(proposed.clone()))
    }

    pub async fn get_provider_connection_record(
        &self,
        connection_id: &str,
    ) -> anyhow::Result<Option<ProviderConnectionRecord>> {
        validate_connection_id(connection_id)?;
        let row = connection_query()
            .bind(connection_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        row.map(connection_from_row).transpose()
    }
}

pub(super) async fn connection_by_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    connection_id: &str,
) -> anyhow::Result<Option<ProviderConnectionRecord>> {
    let row = connection_query()
        .bind(connection_id)
        .fetch_optional(&mut **tx)
        .await?;
    row.map(connection_from_row).transpose()
}

async fn connection_by_selection(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    proposed: &ProviderConnectionRecord,
) -> anyhow::Result<Option<ProviderConnectionRecord>> {
    let credential_revision = i64::try_from(proposed.credential_revision)?;
    let row = sqlx::query(
        r#"
SELECT connection_id, local_actor_id, local_tenant_id, local_space_id,
       provider_id, protocol_version, credential_id, credential_revision,
       record_hash, created_at
FROM provider_connections
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND provider_id = ? AND protocol_version = ?
  AND credential_id = ? AND credential_revision = ?
        "#,
    )
    .bind(&proposed.local_actor_id)
    .bind(&proposed.local_tenant_id)
    .bind(&proposed.local_space_id)
    .bind(&proposed.provider_id)
    .bind(&proposed.protocol_version)
    .bind(&proposed.credential_id)
    .bind(credential_revision)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(connection_from_row).transpose()
}

async fn insert_connection(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderConnectionRecord,
) -> anyhow::Result<()> {
    let credential_revision = i64::try_from(record.credential_revision)?;
    let inserted = sqlx::query(
        r#"
INSERT INTO provider_connections (
    connection_id, local_actor_id, local_tenant_id, local_space_id,
    provider_id, protocol_version, credential_id, credential_revision,
    record_hash, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.connection_id)
    .bind(&record.local_actor_id)
    .bind(&record.local_tenant_id)
    .bind(&record.local_space_id)
    .bind(&record.provider_id)
    .bind(&record.protocol_version)
    .bind(&record.credential_id)
    .bind(credential_revision)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        anyhow::bail!("provider connection insert failed");
    }
    Ok(())
}

pub(in crate::runtime) fn connection_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT connection_id, local_actor_id, local_tenant_id, local_space_id,
       provider_id, protocol_version, credential_id, credential_revision,
       record_hash, created_at
FROM provider_connections
WHERE connection_id = ?
        "#,
    )
}

pub(in crate::runtime) fn connection_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<ProviderConnectionRecord> {
    let credential_revision = row.try_get::<i64, _>("credential_revision")?;
    let record = ProviderConnectionRecord {
        connection_id: row.try_get("connection_id")?,
        local_actor_id: row.try_get("local_actor_id")?,
        local_tenant_id: row.try_get("local_tenant_id")?,
        local_space_id: row.try_get("local_space_id")?,
        provider_id: row.try_get("provider_id")?,
        protocol_version: row.try_get("protocol_version")?,
        credential_id: row.try_get("credential_id")?,
        credential_revision: u64::try_from(credential_revision)?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
    };
    record.validate()?;
    Ok(record)
}
