use sqlx::Row;

use super::StateRuntime;
use super::cloud_agent_turn_authority::cloud_agent_authority_is_current;
use super::provider_execution_storage::cloud_execution_dependencies_exist;
use super::provider_execution_storage::insert_cloud_execution_spec;
use super::provider_execution_storage::insert_cloud_execution_spec_context_artifacts;
use super::provider_resource_binding::binding_by_id;
use super::task_runtime::apply_initial_task_commit;
use super::task_runtime::insert_task_genesis;
use super::thread_execution_context::context_by_thread_id;
use super::thread_execution_context::context_dependencies_exist;
use crate::CloudAgentTurnCreateBundle;
use crate::CloudAgentTurnCreateOutcome;
use crate::CloudAgentTurnOrigin;
use crate::CloudAgentTurnRecord;
use crate::CloudAgentTurnStatus;
use crate::CloudExecutionArtifactRefRecord;
use crate::ThreadExecutionContextBindingRef;

pub(super) const MAX_CLOUD_AGENT_TURNS: i64 = 65_536;

impl StateRuntime {
    /// Atomically creates one accepted Single Task, immutable execution spec, and visible Turn.
    pub async fn create_cloud_agent_turn_bundle(
        &self,
        bundle: &CloudAgentTurnCreateBundle,
        authorized_at: i64,
    ) -> anyhow::Result<CloudAgentTurnCreateOutcome> {
        bundle.validate()?;
        if authorized_at < bundle.turn.created_at {
            return Ok(CloudAgentTurnCreateOutcome::DependencyMissing);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(context) = context_by_thread_id(&mut tx, &bundle.turn.thread_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::DependencyMissing);
        };
        if context.local_actor_id != bundle.turn.local_actor_id
            || context.local_tenant_id != bundle.turn.local_tenant_id
            || context.local_space_id != bundle.turn.local_space_id
            || context.workspace_key != bundle.turn.workspace_key
            || context.execution_binding.as_ref() != Some(&bundle.turn.execution_binding)
            || !context_dependencies_exist(&mut tx, &context).await?
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::DependencyMissing);
        }
        let Some(execution_binding) =
            binding_by_id(&mut tx, &bundle.turn.execution_binding.binding_id).await?
        else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::DependencyMissing);
        };
        if execution_binding.revision != bundle.turn.execution_binding.revision
            || execution_binding.provider_id != bundle.execution_spec.provider_id
            || execution_binding.protocol_version != bundle.execution_spec.protocol_version
            || execution_binding.resource_kind.as_str() != bundle.execution_spec.resource_kind
            || execution_binding.resource_id != bundle.execution_spec.resource_id
            || execution_binding.resource_revision != bundle.execution_spec.resource_revision
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::DependencyMissing);
        }
        if !cloud_agent_authority_is_current(&mut tx, &execution_binding, bundle, authorized_at)
            .await?
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::DependencyMissing);
        }
        if let Some(existing) = turn_by_client_identity(
            &mut tx,
            &bundle.turn.thread_id,
            &bundle.turn.client_user_message_id,
        )
        .await?
        {
            tx.rollback().await?;
            return Ok(if existing.creation_digest == bundle.turn.creation_digest {
                CloudAgentTurnCreateOutcome::ExistingSame(existing)
            } else {
                CloudAgentTurnCreateOutcome::Conflict
            });
        }
        if identity_collision(&mut tx, bundle).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::Conflict);
        }
        if active_turn_exists(&mut tx, &bundle.turn.thread_id).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::ActiveTurnExists);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cloud_agent_turns")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_CLOUD_AGENT_TURNS {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::CapacityExceeded);
        }
        if !insert_task_genesis(&mut tx, &bundle.task_genesis).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::Conflict);
        }
        if !cloud_execution_dependencies_exist(&mut tx, &bundle.execution_spec).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnCreateOutcome::DependencyMissing);
        }
        apply_initial_task_commit(&mut tx, &bundle.accepted_commit).await?;
        insert_cloud_execution_spec(&mut tx, &bundle.execution_spec).await?;
        insert_cloud_execution_spec_context_artifacts(&mut tx, &bundle.execution_spec).await?;
        insert_turn(&mut tx, &bundle.turn).await?;
        upsert_initial_summary(&mut tx, &bundle.turn).await?;
        tx.commit().await?;
        Ok(CloudAgentTurnCreateOutcome::Created(bundle.turn.clone()))
    }

    pub async fn get_cloud_agent_turn_record(
        &self,
        turn_id: &str,
    ) -> anyhow::Result<Option<CloudAgentTurnRecord>> {
        validate_lookup_id(turn_id)?;
        let row = sqlx::query(
            r#"
SELECT turn_id, thread_id, client_user_message_id, origin_kind, task_id, import_id,
       local_actor_id, local_tenant_id, local_space_id, workspace_key,
       execution_binding_id, execution_binding_revision,
       prompt_artifact_id, prompt_artifact_revision, status, last_provider_sequence,
       primary_output_artifact_id, primary_output_artifact_revision,
       error_code, trace_id, revision, creation_digest, record_hash,
       created_at, updated_at, completed_at
FROM cloud_agent_turns
WHERE turn_id = ?
            "#,
        )
        .bind(turn_id)
        .fetch_optional(self.pool.as_ref())
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let additional = additional_outputs(self.pool.as_ref(), turn_id).await?;
        let record = turn_from_row(row, additional)?;
        record.validate()?;
        Ok(Some(record))
    }

    pub async fn get_cloud_agent_turn_record_by_client_message(
        &self,
        thread_id: &str,
        client_user_message_id: &str,
    ) -> anyhow::Result<Option<CloudAgentTurnRecord>> {
        validate_lookup_id(thread_id)?;
        validate_lookup_id(client_user_message_id)?;
        let row = sqlx::query(
            r#"
SELECT turn_id, thread_id, client_user_message_id, origin_kind, task_id, import_id,
       local_actor_id, local_tenant_id, local_space_id, workspace_key,
       execution_binding_id, execution_binding_revision,
       prompt_artifact_id, prompt_artifact_revision, status, last_provider_sequence,
       primary_output_artifact_id, primary_output_artifact_revision,
       error_code, trace_id, revision, creation_digest, record_hash,
       created_at, updated_at, completed_at
FROM cloud_agent_turns
WHERE thread_id = ? AND client_user_message_id = ?
            "#,
        )
        .bind(thread_id)
        .bind(client_user_message_id)
        .fetch_optional(self.pool.as_ref())
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let turn_id: String = row.try_get("turn_id")?;
        let additional = additional_outputs(self.pool.as_ref(), &turn_id).await?;
        let record = turn_from_row(row, additional)?;
        record.validate()?;
        Ok(Some(record))
    }
}

async fn identity_collision(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    bundle: &CloudAgentTurnCreateBundle,
) -> anyhow::Result<bool> {
    let task_id = bundle
        .turn
        .origin
        .task_id()
        .ok_or_else(|| anyhow::anyhow!("durable bundle has no task id"))?;
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1
WHERE EXISTS(SELECT 1 FROM cloud_agent_turns WHERE turn_id = ?)
   OR EXISTS(SELECT 1 FROM task_runtime_tasks WHERE task_id = ?)
   OR EXISTS(
       SELECT 1 FROM cloud_execution_specs
       WHERE execution_spec_id = ? AND revision = ?
   )
        "#,
    )
    .bind(&bundle.turn.turn_id)
    .bind(task_id)
    .bind(&bundle.execution_spec.execution_spec_id)
    .bind(storage_i64(
        bundle.execution_spec.revision,
        "executionSpecRevision",
    )?)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn active_turn_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    thread_id: &str,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1 FROM cloud_agent_turns
WHERE thread_id = ? AND status IN ('queued', 'running', 'suspended', 'finalizing')
        "#,
    )
    .bind(thread_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

pub(super) async fn insert_turn(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &CloudAgentTurnRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO cloud_agent_turns (
    turn_id, thread_id, client_user_message_id, origin_kind, task_id, import_id,
    local_actor_id, local_tenant_id, local_space_id, workspace_key,
    execution_binding_id, execution_binding_revision,
    prompt_artifact_id, prompt_artifact_revision, status, last_provider_sequence,
    primary_output_artifact_id, primary_output_artifact_revision,
    error_code, trace_id, revision, creation_digest, record_hash,
    created_at, updated_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.turn_id)
    .bind(&record.thread_id)
    .bind(&record.client_user_message_id)
    .bind(record.origin.kind())
    .bind(record.origin.task_id())
    .bind(record.origin.import_id())
    .bind(&record.local_actor_id)
    .bind(&record.local_tenant_id)
    .bind(&record.local_space_id)
    .bind(&record.workspace_key)
    .bind(&record.execution_binding.binding_id)
    .bind(storage_i64(
        record.execution_binding.revision,
        "executionBindingRevision",
    )?)
    .bind(&record.prompt_artifact.artifact_id)
    .bind(storage_i64(
        record.prompt_artifact.revision,
        "promptArtifactRevision",
    )?)
    .bind(record.status.as_str())
    .bind(storage_i64(
        record.last_provider_sequence,
        "lastProviderSequence",
    )?)
    .bind(
        record
            .primary_output_artifact
            .as_ref()
            .map(|artifact| artifact.artifact_id.as_str()),
    )
    .bind(
        record
            .primary_output_artifact
            .as_ref()
            .map(|artifact| storage_i64(artifact.revision, "primaryOutputRevision"))
            .transpose()?,
    )
    .bind(record.error_code.as_deref())
    .bind(record.trace_id.as_deref())
    .bind(storage_i64(record.revision, "turnRevision")?)
    .bind(&record.creation_digest)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .bind(record.updated_at)
    .bind(record.completed_at)
    .execute(&mut **tx)
    .await?;
    for (ordinal, artifact) in record.additional_output_artifacts.iter().enumerate() {
        sqlx::query(
            r#"
INSERT INTO cloud_agent_turn_output_artifacts (
    turn_id, ordinal, artifact_id, artifact_revision
) VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(&record.turn_id)
        .bind(i64::try_from(ordinal)?)
        .bind(&artifact.artifact_id)
        .bind(storage_i64(artifact.revision, "additionalOutputRevision")?)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn upsert_initial_summary(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &CloudAgentTurnRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO cloud_agent_thread_summaries (
    thread_id, last_turn_id, preview, projection_revision,
    metadata_sync_revision, updated_at
) VALUES (?, ?, NULL, 1, 0, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    last_turn_id = excluded.last_turn_id,
    projection_revision = cloud_agent_thread_summaries.projection_revision + 1,
    updated_at = excluded.updated_at
        "#,
    )
    .bind(&record.thread_id)
    .bind(&record.turn_id)
    .bind(record.updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn turn_by_client_identity(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    thread_id: &str,
    client_user_message_id: &str,
) -> anyhow::Result<Option<CloudAgentTurnRecord>> {
    let row = sqlx::query(
        r#"
SELECT turn_id, thread_id, client_user_message_id, origin_kind, task_id, import_id,
       local_actor_id, local_tenant_id, local_space_id, workspace_key,
       execution_binding_id, execution_binding_revision,
       prompt_artifact_id, prompt_artifact_revision, status, last_provider_sequence,
       primary_output_artifact_id, primary_output_artifact_revision,
       error_code, trace_id, revision, creation_digest, record_hash,
       created_at, updated_at, completed_at
FROM cloud_agent_turns
WHERE thread_id = ? AND client_user_message_id = ?
        "#,
    )
    .bind(thread_id)
    .bind(client_user_message_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let turn_id: String = row.try_get("turn_id")?;
    let additional = additional_outputs(&mut **tx, &turn_id).await?;
    let record = turn_from_row(row, additional)?;
    record.validate()?;
    Ok(Some(record))
}

pub(super) async fn additional_outputs<'e, Executor>(
    executor: Executor,
    turn_id: &str,
) -> anyhow::Result<Vec<CloudExecutionArtifactRefRecord>>
where
    Executor: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        r#"
SELECT artifact_id, artifact_revision
FROM cloud_agent_turn_output_artifacts
WHERE turn_id = ?
ORDER BY ordinal ASC
        "#,
    )
    .bind(turn_id)
    .fetch_all(executor)
    .await?
    .into_iter()
    .map(|row| {
        Ok(CloudExecutionArtifactRefRecord {
            artifact_id: row.try_get("artifact_id")?,
            revision: storage_u64(
                row.try_get("artifact_revision")?,
                "additionalOutputRevision",
            )?,
        })
    })
    .collect()
}

pub(super) fn turn_from_row(
    row: sqlx::sqlite::SqliteRow,
    additional_output_artifacts: Vec<CloudExecutionArtifactRefRecord>,
) -> anyhow::Result<CloudAgentTurnRecord> {
    let origin_kind: String = row.try_get("origin_kind")?;
    let task_id: Option<String> = row.try_get("task_id")?;
    let import_id: Option<String> = row.try_get("import_id")?;
    let origin = match (origin_kind.as_str(), task_id, import_id) {
        ("durableTask", Some(task_id), None) => CloudAgentTurnOrigin::DurableTask { task_id },
        ("legacyImport", None, Some(import_id)) => CloudAgentTurnOrigin::LegacyImport { import_id },
        _ => anyhow::bail!("invalid stored Cloud Agent Turn origin"),
    };
    let primary_id: Option<String> = row.try_get("primary_output_artifact_id")?;
    let primary_revision: Option<i64> = row.try_get("primary_output_artifact_revision")?;
    let primary_output_artifact = match (primary_id, primary_revision) {
        (None, None) => None,
        (Some(artifact_id), Some(revision)) => Some(CloudExecutionArtifactRefRecord {
            artifact_id,
            revision: storage_u64(revision, "primaryOutputRevision")?,
        }),
        _ => anyhow::bail!("invalid stored primary output Artifact"),
    };
    Ok(CloudAgentTurnRecord {
        thread_id: row.try_get("thread_id")?,
        turn_id: row.try_get("turn_id")?,
        client_user_message_id: row.try_get("client_user_message_id")?,
        origin,
        local_actor_id: row.try_get("local_actor_id")?,
        local_tenant_id: row.try_get("local_tenant_id")?,
        local_space_id: row.try_get("local_space_id")?,
        workspace_key: row.try_get("workspace_key")?,
        execution_binding: ThreadExecutionContextBindingRef {
            binding_id: row.try_get("execution_binding_id")?,
            revision: storage_u64(
                row.try_get("execution_binding_revision")?,
                "executionBindingRevision",
            )?,
        },
        prompt_artifact: CloudExecutionArtifactRefRecord {
            artifact_id: row.try_get("prompt_artifact_id")?,
            revision: storage_u64(
                row.try_get("prompt_artifact_revision")?,
                "promptArtifactRevision",
            )?,
        },
        status: CloudAgentTurnStatus::from_str(row.try_get("status")?)?,
        last_provider_sequence: storage_u64(
            row.try_get("last_provider_sequence")?,
            "lastProviderSequence",
        )?,
        primary_output_artifact,
        additional_output_artifacts,
        error_code: row.try_get("error_code")?,
        trace_id: row.try_get("trace_id")?,
        revision: storage_u64(row.try_get("revision")?, "turnRevision")?,
        creation_digest: row.try_get("creation_digest")?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        completed_at: row.try_get("completed_at")?,
    })
}

fn validate_lookup_id(value: &str) -> anyhow::Result<()> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        anyhow::bail!("invalid Cloud Agent Turn lookup id");
    }
    Ok(())
}

fn storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Cloud Agent Turn field {field} is out of range"))
}

fn storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Cloud Agent Turn field {field} is out of range"))
}
