use sqlx::Row;

use super::StateRuntime;
use super::durable_workspace::root_by_workspace_key;
use super::provider_resource_binding::binding_by_id;
use crate::ProviderResourceBindingMode;
use crate::ProviderResourceBindingRecord;
use crate::ProviderResourceBindingStatus;
use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::ThreadExecutionContextBindingRef;
use crate::ThreadExecutionContextBindingUpdate;
use crate::ThreadExecutionContextCreateOutcome;
use crate::ThreadExecutionContextRecord;
use crate::ThreadExecutionContextUpdateOutcome;
use crate::thread_execution_context_records::validate_thread_execution_context_id;

const MAX_THREAD_EXECUTION_CONTEXTS: i64 = 4_096;

impl StateRuntime {
    pub async fn create_thread_execution_context_record(
        &self,
        record: &ThreadExecutionContextRecord,
    ) -> anyhow::Result<ThreadExecutionContextCreateOutcome> {
        record.validate()?;
        if record.revision != 1 || record.created_at != record.updated_at {
            return Ok(ThreadExecutionContextCreateOutcome::Conflict);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = context_by_thread_id(&mut tx, &record.thread_id).await? {
            tx.rollback().await?;
            return Ok(if existing == *record {
                ThreadExecutionContextCreateOutcome::ExistingSame
            } else {
                ThreadExecutionContextCreateOutcome::Conflict
            });
        }
        if !context_dependencies_exist(&mut tx, record).await? {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextCreateOutcome::DependencyMissing);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM thread_execution_contexts")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_THREAD_EXECUTION_CONTEXTS {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextCreateOutcome::CapacityExceeded);
        }
        insert_context(&mut tx, record).await?;
        tx.commit().await?;
        Ok(ThreadExecutionContextCreateOutcome::Created)
    }

    pub async fn get_thread_execution_context_record(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Option<ThreadExecutionContextRecord>> {
        validate_thread_execution_context_id(thread_id)?;
        let row = context_query()
            .bind(thread_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let bindings = binding_refs_for_thread(self.pool.as_ref(), thread_id).await?;
        let execution_binding =
            execution_binding_ref_for_thread(self.pool.as_ref(), thread_id).await?;
        let record = context_from_row(row, bindings, execution_binding)?;
        record.validate()?;
        Ok(Some(record))
    }

    pub async fn update_thread_execution_context_bindings(
        &self,
        update: &ThreadExecutionContextBindingUpdate,
    ) -> anyhow::Result<ThreadExecutionContextUpdateOutcome> {
        update.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(current) = context_by_thread_id(&mut tx, &update.thread_id).await? else {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextUpdateOutcome::NotFound);
        };
        if current.local_actor_id != update.local_actor_id
            || current.local_tenant_id != update.local_tenant_id
            || current.local_space_id != update.local_space_id
        {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextUpdateOutcome::NotFound);
        }
        if current.revision == update.expected_revision.saturating_add(1)
            && current.resource_bindings == update.resource_bindings
            && current.execution_binding == update.execution_binding
            && current.updated_at == update.updated_at
        {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextUpdateOutcome::ExistingSame);
        }
        if current.revision != update.expected_revision || update.updated_at < current.updated_at {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextUpdateOutcome::Conflict);
        }
        let Some(revision) = current.revision.checked_add(1) else {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextUpdateOutcome::Conflict);
        };
        let mut next = ThreadExecutionContextRecord {
            resource_bindings: update.resource_bindings.clone(),
            execution_binding: update.execution_binding.clone(),
            revision,
            updated_at: update.updated_at,
            record_hash: String::new(),
            ..current
        };
        next.record_hash = next.canonical_hash();
        next.validate()?;
        if !context_dependencies_exist(&mut tx, &next).await? {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextUpdateOutcome::DependencyMissing);
        }
        let result = sqlx::query(
            r#"
UPDATE thread_execution_contexts
SET revision = ?, record_hash = ?, updated_at = ?
WHERE thread_id = ? AND revision = ?
            "#,
        )
        .bind(storage_i64(next.revision, "revision")?)
        .bind(&next.record_hash)
        .bind(next.updated_at)
        .bind(&next.thread_id)
        .bind(storage_i64(update.expected_revision, "expectedRevision")?)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ThreadExecutionContextUpdateOutcome::Conflict);
        }
        sqlx::query("DELETE FROM thread_execution_context_bindings WHERE thread_id = ?")
            .bind(&next.thread_id)
            .execute(&mut *tx)
            .await?;
        insert_binding_refs(&mut tx, &next).await?;
        insert_execution_binding(&mut tx, &next).await?;
        tx.commit().await?;
        Ok(ThreadExecutionContextUpdateOutcome::Updated)
    }
}

pub(super) async fn context_dependencies_exist(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ThreadExecutionContextRecord,
) -> anyhow::Result<bool> {
    if root_by_workspace_key(tx, &record.workspace_key)
        .await?
        .is_none()
    {
        return Ok(false);
    }
    let mut execution_binding_valid = record.execution_binding.is_none();
    for reference in &record.resource_bindings {
        let Some(binding) = binding_by_id(tx, &reference.binding_id).await? else {
            return Ok(false);
        };
        if !binding_matches_context(&binding, reference, record) {
            return Ok(false);
        }
        if record.execution_binding.as_ref() == Some(reference) {
            execution_binding_valid = binding.resource_kind == ProviderResourceKind::Agent
                && binding.binding_mode == ProviderResourceBindingMode::ProviderManaged
                && binding.execution_location == ProviderResourceExecutionLocation::Provider;
        }
    }
    Ok(execution_binding_valid)
}

fn binding_matches_context(
    binding: &ProviderResourceBindingRecord,
    reference: &ThreadExecutionContextBindingRef,
    context: &ThreadExecutionContextRecord,
) -> bool {
    binding.status == ProviderResourceBindingStatus::Active
        && binding.revision == reference.revision
        && binding.local_actor_id == context.local_actor_id
        && binding.local_tenant_id == context.local_tenant_id
        && binding.local_space_id == context.local_space_id
        && binding.workspace_key == context.workspace_key
        && binding.workspace_scope == context.workspace_scope
        && binding.workspace_scope_id == context.workspace_scope_id
}

async fn insert_context(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ThreadExecutionContextRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO thread_execution_contexts (
    thread_id, local_actor_id, local_tenant_id, local_space_id,
    workspace_key, workspace_scope, workspace_scope_id,
    revision, record_hash, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.thread_id)
    .bind(&record.local_actor_id)
    .bind(&record.local_tenant_id)
    .bind(&record.local_space_id)
    .bind(&record.workspace_key)
    .bind(record.workspace_scope.as_str())
    .bind(&record.workspace_scope_id)
    .bind(storage_i64(record.revision, "revision")?)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .bind(record.updated_at)
    .execute(&mut **tx)
    .await?;
    insert_binding_refs(tx, record).await?;
    insert_execution_binding(tx, record).await
}

async fn insert_binding_refs(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ThreadExecutionContextRecord,
) -> anyhow::Result<()> {
    for (ordinal, binding) in record.resource_bindings.iter().enumerate() {
        sqlx::query(
            r#"
INSERT INTO thread_execution_context_bindings (
    thread_id, ordinal, binding_id, binding_revision
) VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(&record.thread_id)
        .bind(i64::try_from(ordinal)?)
        .bind(&binding.binding_id)
        .bind(storage_i64(binding.revision, "bindingRevision")?)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn insert_execution_binding(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ThreadExecutionContextRecord,
) -> anyhow::Result<()> {
    let Some(binding) = &record.execution_binding else {
        return Ok(());
    };
    sqlx::query(
        r#"
INSERT INTO thread_execution_context_execution_binding (
    thread_id, binding_id, binding_revision
) VALUES (?, ?, ?)
        "#,
    )
    .bind(&record.thread_id)
    .bind(&binding.binding_id)
    .bind(storage_i64(binding.revision, "executionBindingRevision")?)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) async fn context_by_thread_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    thread_id: &str,
) -> anyhow::Result<Option<ThreadExecutionContextRecord>> {
    let row = context_query()
        .bind(thread_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let bindings = binding_refs_for_thread(&mut **tx, thread_id).await?;
    let execution_binding = execution_binding_ref_for_thread(&mut **tx, thread_id).await?;
    let record = context_from_row(row, bindings, execution_binding)?;
    record.validate()?;
    Ok(Some(record))
}

fn context_query() -> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT thread_id, local_actor_id, local_tenant_id, local_space_id,
       workspace_key, workspace_scope, workspace_scope_id,
       revision, record_hash, created_at, updated_at
FROM thread_execution_contexts
WHERE thread_id = ?
        "#,
    )
}

async fn binding_refs_for_thread<'e, Executor>(
    executor: Executor,
    thread_id: &str,
) -> anyhow::Result<Vec<ThreadExecutionContextBindingRef>>
where
    Executor: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        r#"
SELECT binding_id, binding_revision
FROM thread_execution_context_bindings
WHERE thread_id = ?
ORDER BY ordinal ASC
        "#,
    )
    .bind(thread_id)
    .fetch_all(executor)
    .await?
    .into_iter()
    .map(|row| {
        Ok(ThreadExecutionContextBindingRef {
            binding_id: row.try_get("binding_id")?,
            revision: storage_u64(row.try_get("binding_revision")?, "bindingRevision")?,
        })
    })
    .collect()
}

async fn execution_binding_ref_for_thread<'e, Executor>(
    executor: Executor,
    thread_id: &str,
) -> anyhow::Result<Option<ThreadExecutionContextBindingRef>>
where
    Executor: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        r#"
SELECT binding_id, binding_revision
FROM thread_execution_context_execution_binding
WHERE thread_id = ?
        "#,
    )
    .bind(thread_id)
    .fetch_optional(executor)
    .await?
    .map(|row| {
        Ok(ThreadExecutionContextBindingRef {
            binding_id: row.try_get("binding_id")?,
            revision: storage_u64(row.try_get("binding_revision")?, "executionBindingRevision")?,
        })
    })
    .transpose()
}

fn context_from_row(
    row: sqlx::sqlite::SqliteRow,
    resource_bindings: Vec<ThreadExecutionContextBindingRef>,
    execution_binding: Option<ThreadExecutionContextBindingRef>,
) -> anyhow::Result<ThreadExecutionContextRecord> {
    Ok(ThreadExecutionContextRecord {
        thread_id: row.try_get("thread_id")?,
        local_actor_id: row.try_get("local_actor_id")?,
        local_tenant_id: row.try_get("local_tenant_id")?,
        local_space_id: row.try_get("local_space_id")?,
        workspace_key: row.try_get("workspace_key")?,
        workspace_scope: crate::ProviderResourceWorkspaceScope::from_str(
            row.try_get("workspace_scope")?,
        )?,
        workspace_scope_id: row.try_get("workspace_scope_id")?,
        resource_bindings,
        execution_binding,
        revision: storage_u64(row.try_get("revision")?, "revision")?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Thread execution context field {field} is out of range"))
}

fn storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Thread execution context field {field} is out of range"))
}
