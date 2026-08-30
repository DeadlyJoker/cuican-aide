use sqlx::Row;

use super::StateRuntime;
use crate::DurableWorkspaceRootRecord;
use crate::DurableWorkspaceRootResolveOutcome;
use crate::durable_workspace_records::validate_workspace_key;

const MAX_DURABLE_WORKSPACE_ROOTS: i64 = 1_024;

impl StateRuntime {
    pub async fn resolve_durable_workspace_root_record(
        &self,
        proposed: &DurableWorkspaceRootRecord,
    ) -> anyhow::Result<DurableWorkspaceRootResolveOutcome> {
        proposed.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = root_by_workspace_key(&mut tx, &proposed.workspace_key).await? {
            tx.rollback().await?;
            return Ok(if existing == *proposed {
                DurableWorkspaceRootResolveOutcome::Existing(existing)
            } else {
                DurableWorkspaceRootResolveOutcome::Conflict
            });
        }
        if let Some(existing) = root_by_identity(&mut tx, proposed).await? {
            tx.rollback().await?;
            return Ok(DurableWorkspaceRootResolveOutcome::Existing(existing));
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM durable_workspace_roots")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_DURABLE_WORKSPACE_ROOTS {
            tx.rollback().await?;
            return Ok(DurableWorkspaceRootResolveOutcome::CapacityExceeded);
        }
        insert_root(&mut tx, proposed).await?;
        tx.commit().await?;
        Ok(DurableWorkspaceRootResolveOutcome::Created(
            proposed.clone(),
        ))
    }

    pub async fn get_durable_workspace_root_record(
        &self,
        workspace_key: &str,
    ) -> anyhow::Result<Option<DurableWorkspaceRootRecord>> {
        validate_workspace_key(workspace_key)?;
        let row = root_query()
            .bind(workspace_key)
            .fetch_optional(self.pool.as_ref())
            .await?;
        row.map(root_from_row).transpose()
    }
}

pub(super) async fn root_by_workspace_key(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    workspace_key: &str,
) -> anyhow::Result<Option<DurableWorkspaceRootRecord>> {
    let row = root_query()
        .bind(workspace_key)
        .fetch_optional(&mut **tx)
        .await?;
    row.map(root_from_row).transpose()
}

async fn root_by_identity(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    proposed: &DurableWorkspaceRootRecord,
) -> anyhow::Result<Option<DurableWorkspaceRootRecord>> {
    let row = sqlx::query(
        r#"
SELECT workspace_key, node_id, environment_id, root_fingerprint, record_hash, created_at
FROM durable_workspace_roots
WHERE node_id = ? AND environment_id = ? AND root_fingerprint = ?
        "#,
    )
    .bind(&proposed.node_id)
    .bind(&proposed.environment_id)
    .bind(&proposed.root_fingerprint)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(root_from_row).transpose()
}

async fn insert_root(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &DurableWorkspaceRootRecord,
) -> anyhow::Result<()> {
    let inserted = sqlx::query(
        r#"
INSERT INTO durable_workspace_roots (
    workspace_key, node_id, environment_id, root_fingerprint, record_hash, created_at
) VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.workspace_key)
    .bind(&record.node_id)
    .bind(&record.environment_id)
    .bind(&record.root_fingerprint)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        anyhow::bail!("durable workspace root insert failed");
    }
    Ok(())
}

fn root_query() -> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT workspace_key, node_id, environment_id, root_fingerprint, record_hash, created_at
FROM durable_workspace_roots
WHERE workspace_key = ?
        "#,
    )
}

fn root_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<DurableWorkspaceRootRecord> {
    let record = DurableWorkspaceRootRecord {
        workspace_key: row.try_get("workspace_key")?,
        node_id: row.try_get("node_id")?,
        environment_id: row.try_get("environment_id")?,
        root_fingerprint: row.try_get("root_fingerprint")?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
    };
    record.validate()?;
    Ok(record)
}
