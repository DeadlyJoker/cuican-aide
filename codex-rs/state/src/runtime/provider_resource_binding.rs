use sqlx::Row;

use super::StateRuntime;
use super::durable_workspace::root_by_workspace_key;
use super::provider_connection::connection_by_id;
use crate::ProviderResourceBindingMode;
use crate::ProviderResourceBindingRecord;
use crate::ProviderResourceBindingResolveOutcome;
use crate::ProviderResourceBindingStatus;
use crate::ProviderResourceBindingUnbindOutcome;
use crate::ProviderResourceBindingUnbindRequest;
use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::ProviderResourceWorkspaceScope;
use crate::provider_resource_binding_records::validate_binding_id;

const MAX_PROVIDER_RESOURCE_BINDINGS: i64 = 1_024;

impl StateRuntime {
    pub async fn resolve_provider_resource_binding_record(
        &self,
        proposed: &ProviderResourceBindingRecord,
    ) -> anyhow::Result<ProviderResourceBindingResolveOutcome> {
        proposed.validate()?;
        if proposed.status != ProviderResourceBindingStatus::Active
            || proposed.revision != 1
            || proposed.created_at != proposed.updated_at
            || proposed.unbound_at.is_some()
        {
            return Ok(ProviderResourceBindingResolveOutcome::Conflict);
        }

        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(connection) = connection_by_id(&mut tx, &proposed.connection_id).await? else {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingResolveOutcome::ConnectionNotFound);
        };
        if connection.local_actor_id != proposed.local_actor_id
            || connection.local_tenant_id != proposed.local_tenant_id
            || connection.local_space_id != proposed.local_space_id
            || connection.provider_id != proposed.provider_id
            || connection.protocol_version != proposed.protocol_version
        {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingResolveOutcome::ParentMismatch);
        }
        if root_by_workspace_key(&mut tx, &proposed.workspace_key)
            .await?
            .is_none()
        {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingResolveOutcome::WorkspaceNotFound);
        }

        if let Some(existing) = binding_by_id(&mut tx, &proposed.binding_id).await? {
            let outcome = resolve_existing_binding(&mut tx, existing, proposed).await?;
            if matches!(
                outcome,
                ProviderResourceBindingResolveOutcome::Reactivated(_)
            ) {
                tx.commit().await?;
            } else {
                tx.rollback().await?;
            }
            return Ok(outcome);
        }
        if let Some(existing) = binding_by_selection(&mut tx, proposed).await? {
            let outcome = resolve_existing_binding(&mut tx, existing, proposed).await?;
            if matches!(
                outcome,
                ProviderResourceBindingResolveOutcome::Reactivated(_)
            ) {
                tx.commit().await?;
            } else {
                tx.rollback().await?;
            }
            return Ok(outcome);
        }

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_resource_bindings")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_PROVIDER_RESOURCE_BINDINGS {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingResolveOutcome::CapacityExceeded);
        }
        insert_binding(&mut tx, proposed).await?;
        tx.commit().await?;
        Ok(ProviderResourceBindingResolveOutcome::Created(
            proposed.clone(),
        ))
    }

    pub async fn get_provider_resource_binding_record(
        &self,
        binding_id: &str,
    ) -> anyhow::Result<Option<ProviderResourceBindingRecord>> {
        validate_binding_id(binding_id)?;
        binding_query()
            .bind(binding_id)
            .fetch_optional(self.pool.as_ref())
            .await?
            .map(binding_from_row)
            .transpose()
    }

    pub async fn unbind_provider_resource_binding_record(
        &self,
        request: &ProviderResourceBindingUnbindRequest,
    ) -> anyhow::Result<ProviderResourceBindingUnbindOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = binding_by_id(&mut tx, &request.binding_id).await? else {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingUnbindOutcome::NotFound);
        };
        if current.local_actor_id != request.local_actor_id
            || current.local_tenant_id != request.local_tenant_id
            || current.local_space_id != request.local_space_id
        {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingUnbindOutcome::NotFound);
        }
        if current.status == ProviderResourceBindingStatus::Unbound {
            let same = request.expected_revision.checked_add(1) == Some(current.revision)
                && current.unbound_at == Some(request.unbound_at);
            tx.rollback().await?;
            return Ok(if same {
                ProviderResourceBindingUnbindOutcome::ExistingUnbound
            } else {
                ProviderResourceBindingUnbindOutcome::Conflict
            });
        }
        if current.revision != request.expected_revision || request.unbound_at < current.updated_at
        {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingUnbindOutcome::Conflict);
        }

        current.revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Provider resource binding revision overflow"))?;
        current.status = ProviderResourceBindingStatus::Unbound;
        current.updated_at = request.unbound_at;
        current.unbound_at = Some(request.unbound_at);
        current.record_hash = current.canonical_hash();
        current.validate()?;
        let updated = sqlx::query(
            r#"
UPDATE provider_resource_bindings
SET status = 'unbound', revision = ?, record_hash = ?, updated_at = ?, unbound_at = ?
WHERE binding_id = ? AND revision = ? AND status = 'active'
            "#,
        )
        .bind(storage_i64(current.revision, "revision")?)
        .bind(&current.record_hash)
        .bind(current.updated_at)
        .bind(current.unbound_at)
        .bind(&current.binding_id)
        .bind(storage_i64(request.expected_revision, "expectedRevision")?)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ProviderResourceBindingUnbindOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(ProviderResourceBindingUnbindOutcome::Unbound)
    }
}

async fn resolve_existing_binding(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    existing: ProviderResourceBindingRecord,
    proposed: &ProviderResourceBindingRecord,
) -> anyhow::Result<ProviderResourceBindingResolveOutcome> {
    if !same_immutable_selection(&existing, proposed) {
        return Ok(ProviderResourceBindingResolveOutcome::Conflict);
    }
    match existing.status {
        ProviderResourceBindingStatus::Active => {
            Ok(ProviderResourceBindingResolveOutcome::Existing(existing))
        }
        ProviderResourceBindingStatus::Unbound => {
            reactivate_binding(tx, existing, proposed.created_at).await
        }
    }
}

async fn reactivate_binding(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    mut existing: ProviderResourceBindingRecord,
    reactivated_at: i64,
) -> anyhow::Result<ProviderResourceBindingResolveOutcome> {
    if reactivated_at < existing.updated_at {
        return Ok(ProviderResourceBindingResolveOutcome::Conflict);
    }
    let expected_revision = existing.revision;
    existing.revision = existing
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Provider resource binding revision overflow"))?;
    existing.status = ProviderResourceBindingStatus::Active;
    existing.updated_at = reactivated_at;
    existing.unbound_at = None;
    existing.record_hash = existing.canonical_hash();
    existing.validate()?;
    let updated = sqlx::query(
        r#"
UPDATE provider_resource_bindings
SET status = 'active', revision = ?, record_hash = ?, updated_at = ?, unbound_at = NULL
WHERE binding_id = ? AND revision = ? AND status = 'unbound'
        "#,
    )
    .bind(storage_i64(existing.revision, "revision")?)
    .bind(&existing.record_hash)
    .bind(existing.updated_at)
    .bind(&existing.binding_id)
    .bind(storage_i64(expected_revision, "expectedRevision")?)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Ok(ProviderResourceBindingResolveOutcome::Conflict);
    }
    Ok(ProviderResourceBindingResolveOutcome::Reactivated(existing))
}

pub(super) async fn binding_by_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    binding_id: &str,
) -> anyhow::Result<Option<ProviderResourceBindingRecord>> {
    binding_query()
        .bind(binding_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(binding_from_row)
        .transpose()
}

async fn binding_by_selection(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    proposed: &ProviderResourceBindingRecord,
) -> anyhow::Result<Option<ProviderResourceBindingRecord>> {
    let row = sqlx::query(
        r#"
SELECT binding_id, local_actor_id, local_tenant_id, local_space_id,
       connection_id, workspace_key, workspace_scope, workspace_scope_id,
       provider_id, protocol_version, resource_kind, resource_id, resource_revision,
       binding_mode, execution_location, manifest_schema_version, content_digest,
       source_revision, source_digest, local_revision, local_content_digest,
       status, revision, record_hash, created_at, updated_at, unbound_at
FROM provider_resource_bindings
WHERE local_actor_id = ? AND local_tenant_id = ? AND local_space_id = ?
  AND connection_id = ? AND workspace_key = ?
  AND workspace_scope = ? AND workspace_scope_id = ?
  AND provider_id = ? AND protocol_version = ?
  AND resource_kind = ? AND resource_id = ? AND resource_revision = ?
  AND binding_mode = ? AND execution_location = ?
        "#,
    )
    .bind(&proposed.local_actor_id)
    .bind(&proposed.local_tenant_id)
    .bind(&proposed.local_space_id)
    .bind(&proposed.connection_id)
    .bind(&proposed.workspace_key)
    .bind(proposed.workspace_scope.as_str())
    .bind(&proposed.workspace_scope_id)
    .bind(&proposed.provider_id)
    .bind(&proposed.protocol_version)
    .bind(proposed.resource_kind.as_str())
    .bind(&proposed.resource_id)
    .bind(&proposed.resource_revision)
    .bind(proposed.binding_mode.as_str())
    .bind(proposed.execution_location.as_str())
    .fetch_optional(&mut **tx)
    .await?;
    row.map(binding_from_row).transpose()
}

async fn insert_binding(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderResourceBindingRecord,
) -> anyhow::Result<()> {
    let inserted = sqlx::query(
        r#"
INSERT INTO provider_resource_bindings (
    binding_id, local_actor_id, local_tenant_id, local_space_id,
    connection_id, workspace_key, workspace_scope, workspace_scope_id,
    provider_id, protocol_version, resource_kind, resource_id, resource_revision,
    binding_mode, execution_location, manifest_schema_version, content_digest,
    source_revision, source_digest, local_revision, local_content_digest,
    status, revision, record_hash, created_at, updated_at, unbound_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.binding_id)
    .bind(&record.local_actor_id)
    .bind(&record.local_tenant_id)
    .bind(&record.local_space_id)
    .bind(&record.connection_id)
    .bind(&record.workspace_key)
    .bind(record.workspace_scope.as_str())
    .bind(&record.workspace_scope_id)
    .bind(&record.provider_id)
    .bind(&record.protocol_version)
    .bind(record.resource_kind.as_str())
    .bind(&record.resource_id)
    .bind(&record.resource_revision)
    .bind(record.binding_mode.as_str())
    .bind(record.execution_location.as_str())
    .bind(&record.manifest_schema_version)
    .bind(&record.content_digest)
    .bind(&record.source_revision)
    .bind(&record.source_digest)
    .bind(&record.local_revision)
    .bind(&record.local_content_digest)
    .bind(record.status.as_str())
    .bind(storage_i64(record.revision, "revision")?)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .bind(record.updated_at)
    .bind(record.unbound_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        anyhow::bail!("Provider resource binding insert failed");
    }
    Ok(())
}

pub(in crate::runtime) fn binding_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT binding_id, local_actor_id, local_tenant_id, local_space_id,
       connection_id, workspace_key, workspace_scope, workspace_scope_id,
       provider_id, protocol_version, resource_kind, resource_id, resource_revision,
       binding_mode, execution_location, manifest_schema_version, content_digest,
       source_revision, source_digest, local_revision, local_content_digest,
       status, revision, record_hash, created_at, updated_at, unbound_at
FROM provider_resource_bindings
WHERE binding_id = ?
        "#,
    )
}

pub(in crate::runtime) fn binding_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<ProviderResourceBindingRecord> {
    let workspace_scope = row.try_get::<String, _>("workspace_scope")?;
    let resource_kind = row.try_get::<String, _>("resource_kind")?;
    let binding_mode = row.try_get::<String, _>("binding_mode")?;
    let execution_location = row.try_get::<String, _>("execution_location")?;
    let status = row.try_get::<String, _>("status")?;
    let revision = row.try_get::<i64, _>("revision")?;
    let record = ProviderResourceBindingRecord {
        binding_id: row.try_get("binding_id")?,
        local_actor_id: row.try_get("local_actor_id")?,
        local_tenant_id: row.try_get("local_tenant_id")?,
        local_space_id: row.try_get("local_space_id")?,
        connection_id: row.try_get("connection_id")?,
        workspace_key: row.try_get("workspace_key")?,
        workspace_scope: ProviderResourceWorkspaceScope::from_str(&workspace_scope)?,
        workspace_scope_id: row.try_get("workspace_scope_id")?,
        provider_id: row.try_get("provider_id")?,
        protocol_version: row.try_get("protocol_version")?,
        resource_kind: ProviderResourceKind::from_str(&resource_kind)?,
        resource_id: row.try_get("resource_id")?,
        resource_revision: row.try_get("resource_revision")?,
        binding_mode: ProviderResourceBindingMode::from_str(&binding_mode)?,
        execution_location: ProviderResourceExecutionLocation::from_str(&execution_location)?,
        manifest_schema_version: row.try_get("manifest_schema_version")?,
        content_digest: row.try_get("content_digest")?,
        source_revision: row.try_get("source_revision")?,
        source_digest: row.try_get("source_digest")?,
        local_revision: row.try_get("local_revision")?,
        local_content_digest: row.try_get("local_content_digest")?,
        status: ProviderResourceBindingStatus::from_str(&status)?,
        revision: u64::try_from(revision)?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        unbound_at: row.try_get("unbound_at")?,
    };
    record.validate()?;
    Ok(record)
}

fn same_immutable_selection(
    current: &ProviderResourceBindingRecord,
    proposed: &ProviderResourceBindingRecord,
) -> bool {
    current.local_actor_id == proposed.local_actor_id
        && current.local_tenant_id == proposed.local_tenant_id
        && current.local_space_id == proposed.local_space_id
        && current.connection_id == proposed.connection_id
        && current.workspace_key == proposed.workspace_key
        && current.workspace_scope == proposed.workspace_scope
        && current.workspace_scope_id == proposed.workspace_scope_id
        && current.provider_id == proposed.provider_id
        && current.protocol_version == proposed.protocol_version
        && current.resource_kind == proposed.resource_kind
        && current.resource_id == proposed.resource_id
        && current.resource_revision == proposed.resource_revision
        && current.binding_mode == proposed.binding_mode
        && current.execution_location == proposed.execution_location
        && current.manifest_schema_version == proposed.manifest_schema_version
        && current.content_digest == proposed.content_digest
        && current.source_revision == proposed.source_revision
        && current.source_digest == proposed.source_digest
        && current.local_revision == proposed.local_revision
        && current.local_content_digest == proposed.local_content_digest
}

fn storage_i64(value: u64, field: &str) -> anyhow::Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("{field} exceeds SQLite integer range"))
}
