use sqlx::Row;

use crate::CloudExecutionArtifactRefRecord;
use crate::CloudExecutionSpecRecord;
use crate::ProviderRunJournalAdvanceRecord;
use crate::ProviderRunJournalKey;
use crate::ProviderRunJournalRecord;
use crate::ProviderRunJournalStatus;

pub(super) async fn cloud_execution_dependencies_exist(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &CloudExecutionSpecRecord,
) -> anyhow::Result<bool> {
    if sqlx::query_scalar::<_, i64>("SELECT 1 FROM task_runtime_tasks WHERE task_id = ?")
        .bind(&record.task_id)
        .fetch_optional(&mut **tx)
        .await?
        .is_none()
        || !artifact_exists(tx, &record.prompt_artifact).await?
    {
        return Ok(false);
    }
    for artifact in &record.context_artifacts {
        if !artifact_exists(tx, artifact).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn artifact_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    artifact: &CloudExecutionArtifactRefRecord,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM artifact_manifests WHERE artifact_id = ? AND revision = ?",
    )
    .bind(&artifact.artifact_id)
    .bind(storage_i64(artifact.revision, "artifactRevision")?)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

pub(super) async fn insert_cloud_execution_spec(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &CloudExecutionSpecRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO cloud_execution_specs (
    execution_spec_id, revision, digest, task_id, workspace_key, binding_id,
    provider_id, protocol_version, resource_kind, resource_id, resource_revision,
    credential_id, credential_revision, prompt_artifact_id,
    prompt_artifact_revision, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.execution_spec_id)
    .bind(storage_i64(record.revision, "executionSpecRevision")?)
    .bind(&record.digest)
    .bind(&record.task_id)
    .bind(&record.workspace_key)
    .bind(&record.binding_id)
    .bind(&record.provider_id)
    .bind(&record.protocol_version)
    .bind(&record.resource_kind)
    .bind(&record.resource_id)
    .bind(&record.resource_revision)
    .bind(&record.credential_id)
    .bind(storage_i64(
        record.credential_revision,
        "credentialRevision",
    )?)
    .bind(&record.prompt_artifact.artifact_id)
    .bind(storage_i64(
        record.prompt_artifact.revision,
        "promptArtifactRevision",
    )?)
    .bind(record.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) async fn insert_cloud_execution_spec_context_artifacts(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &CloudExecutionSpecRecord,
) -> anyhow::Result<()> {
    for (ordinal, artifact) in record.context_artifacts.iter().enumerate() {
        sqlx::query(
            r#"
INSERT INTO cloud_execution_spec_context_artifacts (
    execution_spec_id, execution_spec_revision, ordinal, artifact_id, artifact_revision
) VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&record.execution_spec_id)
        .bind(storage_i64(record.revision, "executionSpecRevision")?)
        .bind(i64::try_from(ordinal)?)
        .bind(&artifact.artifact_id)
        .bind(storage_i64(artifact.revision, "artifactRevision")?)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(super) async fn journal_matches_execution_spec(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderRunJournalRecord,
) -> anyhow::Result<bool> {
    let row = sqlx::query(
        r#"
SELECT task_id, digest, provider_id, protocol_version, resource_id,
       resource_revision, credential_id, credential_revision
FROM cloud_execution_specs
WHERE execution_spec_id = ? AND revision = ?
        "#,
    )
    .bind(&record.execution_spec_id)
    .bind(storage_i64(
        record.execution_spec_revision,
        "executionSpecRevision",
    )?)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    Ok(row.try_get::<&str, _>("task_id")? == record.key.task_id
        && row.try_get::<&str, _>("digest")? == record.execution_spec_digest
        && row.try_get::<&str, _>("provider_id")? == record.provider_id
        && row.try_get::<&str, _>("protocol_version")? == record.protocol_version
        && row.try_get::<&str, _>("resource_id")? == record.resource_id
        && row.try_get::<&str, _>("resource_revision")? == record.resource_revision
        && row.try_get::<&str, _>("credential_id")? == record.credential_id
        && storage_u64(row.try_get("credential_revision")?, "credentialRevision")?
            == record.credential_revision)
}

pub(super) async fn insert_provider_run_journal(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &ProviderRunJournalRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO provider_run_journal (
    task_id, attempt_id, worker_run_id, journal_version, execution_spec_id,
    execution_spec_revision, execution_spec_digest, provider_id, protocol_version,
    resource_id, resource_revision, credential_id, credential_revision,
    provider_run_id, provider_attempt_id, provider_revision, last_sequence,
    last_cursor, status, start_command_id, start_idempotency_key, request_digest,
    record_hash, created_at, updated_at
) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.key.task_id)
    .bind(&record.key.attempt_id)
    .bind(&record.key.worker_run_id)
    .bind(&record.execution_spec_id)
    .bind(storage_i64(
        record.execution_spec_revision,
        "executionSpecRevision",
    )?)
    .bind(&record.execution_spec_digest)
    .bind(&record.provider_id)
    .bind(&record.protocol_version)
    .bind(&record.resource_id)
    .bind(&record.resource_revision)
    .bind(&record.credential_id)
    .bind(storage_i64(
        record.credential_revision,
        "credentialRevision",
    )?)
    .bind(&record.provider_run_id)
    .bind(&record.provider_attempt_id)
    .bind(record.status.as_str())
    .bind(&record.start_command_id)
    .bind(&record.start_idempotency_key)
    .bind(&record.request_digest)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .bind(record.updated_at)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
INSERT INTO provider_run_supervision (
    task_id, attempt_id, worker_run_id, poll_attempts, available_at, updated_at
) VALUES (?, ?, ?, 0, ?, ?)
        "#,
    )
    .bind(&record.key.task_id)
    .bind(&record.key.attempt_id)
    .bind(&record.key.worker_run_id)
    .bind(record.updated_at)
    .bind(record.updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) fn journal_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT task_id, attempt_id, worker_run_id, journal_version, execution_spec_id,
       execution_spec_revision, execution_spec_digest, provider_id, protocol_version,
       resource_id, resource_revision, credential_id, credential_revision,
       provider_run_id, provider_attempt_id, provider_revision, last_sequence,
       last_cursor, status, start_command_id, start_idempotency_key, request_digest,
       record_hash, created_at, updated_at
FROM provider_run_journal
WHERE task_id = ? AND attempt_id = ? AND worker_run_id = ?
        "#,
    )
}

pub(super) fn journal_for_attempt_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT task_id, attempt_id, worker_run_id, journal_version, execution_spec_id,
       execution_spec_revision, execution_spec_digest, provider_id, protocol_version,
       resource_id, resource_revision, credential_id, credential_revision,
       provider_run_id, provider_attempt_id, provider_revision, last_sequence,
       last_cursor, status, start_command_id, start_idempotency_key, request_digest,
       record_hash, created_at, updated_at
FROM provider_run_journal
WHERE task_id = ? AND attempt_id = ?
        "#,
    )
}

pub(super) fn recoverable_journals_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT task_id, attempt_id, worker_run_id, journal_version, execution_spec_id,
       execution_spec_revision, execution_spec_digest, provider_id, protocol_version,
       resource_id, resource_revision, credential_id, credential_revision,
       provider_run_id, provider_attempt_id, provider_revision, last_sequence,
       last_cursor, status, start_command_id, start_idempotency_key, request_digest,
       record_hash, created_at, updated_at
FROM provider_run_journal
WHERE status IN ('starting', 'running', 'suspended', 'reconciling')
ORDER BY task_id ASC, attempt_id ASC, worker_run_id ASC
LIMIT ?
        "#,
    )
}

pub(super) fn recoverable_journals_query_with_cursor()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT task_id, attempt_id, worker_run_id, journal_version, execution_spec_id,
       execution_spec_revision, execution_spec_digest, provider_id, protocol_version,
       resource_id, resource_revision, credential_id, credential_revision,
       provider_run_id, provider_attempt_id, provider_revision, last_sequence,
       last_cursor, status, start_command_id, start_idempotency_key, request_digest,
       record_hash, created_at, updated_at
FROM provider_run_journal
WHERE status IN ('starting', 'running', 'suspended', 'reconciling')
  AND (
    task_id > ?
    OR (task_id = ? AND attempt_id > ?)
    OR (task_id = ? AND attempt_id = ? AND worker_run_id > ?)
  )
ORDER BY task_id ASC, attempt_id ASC, worker_run_id ASC
LIMIT ?
        "#,
    )
}

pub(super) fn due_provider_run_supervision_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT j.task_id, j.attempt_id, j.worker_run_id, j.journal_version,
       j.execution_spec_id, j.execution_spec_revision, j.execution_spec_digest,
       j.provider_id, j.protocol_version, j.resource_id, j.resource_revision,
       j.credential_id, j.credential_revision, j.provider_run_id,
       j.provider_attempt_id, j.provider_revision, j.last_sequence, j.last_cursor,
       j.status, j.start_command_id, j.start_idempotency_key, j.request_digest,
       j.record_hash, j.created_at, j.updated_at,
       s.poll_attempts, s.available_at AS supervision_available_at,
       s.updated_at AS supervision_updated_at
FROM provider_run_journal AS j
JOIN provider_run_supervision AS s
  ON s.task_id = j.task_id
 AND s.attempt_id = j.attempt_id
 AND s.worker_run_id = j.worker_run_id
WHERE j.status IN ('starting', 'running', 'reconciling')
  AND s.available_at <= ?
ORDER BY j.task_id ASC, j.attempt_id ASC, j.worker_run_id ASC
LIMIT ?
        "#,
    )
}

pub(super) fn due_provider_run_supervision_query_with_cursor()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT j.task_id, j.attempt_id, j.worker_run_id, j.journal_version,
       j.execution_spec_id, j.execution_spec_revision, j.execution_spec_digest,
       j.provider_id, j.protocol_version, j.resource_id, j.resource_revision,
       j.credential_id, j.credential_revision, j.provider_run_id,
       j.provider_attempt_id, j.provider_revision, j.last_sequence, j.last_cursor,
       j.status, j.start_command_id, j.start_idempotency_key, j.request_digest,
       j.record_hash, j.created_at, j.updated_at,
       s.poll_attempts, s.available_at AS supervision_available_at,
       s.updated_at AS supervision_updated_at
FROM provider_run_journal AS j
JOIN provider_run_supervision AS s
  ON s.task_id = j.task_id
 AND s.attempt_id = j.attempt_id
 AND s.worker_run_id = j.worker_run_id
WHERE j.status IN ('starting', 'running', 'reconciling')
  AND s.available_at <= ?
  AND (
    j.task_id > ?
    OR (j.task_id = ? AND j.attempt_id > ?)
    OR (j.task_id = ? AND j.attempt_id = ? AND j.worker_run_id > ?)
  )
ORDER BY j.task_id ASC, j.attempt_id ASC, j.worker_run_id ASC
LIMIT ?
        "#,
    )
}

pub(super) fn journal_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<ProviderRunJournalRecord> {
    let record = ProviderRunJournalRecord {
        key: ProviderRunJournalKey {
            task_id: row.try_get("task_id")?,
            attempt_id: row.try_get("attempt_id")?,
            worker_run_id: row.try_get("worker_run_id")?,
        },
        journal_version: storage_u64(row.try_get("journal_version")?, "journalVersion")?,
        execution_spec_id: row.try_get("execution_spec_id")?,
        execution_spec_revision: storage_u64(
            row.try_get("execution_spec_revision")?,
            "executionSpecRevision",
        )?,
        execution_spec_digest: row.try_get("execution_spec_digest")?,
        provider_id: row.try_get("provider_id")?,
        protocol_version: row.try_get("protocol_version")?,
        resource_id: row.try_get("resource_id")?,
        resource_revision: row.try_get("resource_revision")?,
        credential_id: row.try_get("credential_id")?,
        credential_revision: storage_u64(
            row.try_get("credential_revision")?,
            "credentialRevision",
        )?,
        provider_run_id: row.try_get("provider_run_id")?,
        provider_attempt_id: row.try_get("provider_attempt_id")?,
        provider_revision: row
            .try_get::<Option<i64>, _>("provider_revision")?
            .map(|value| storage_u64(value, "providerRevision"))
            .transpose()?,
        last_sequence: storage_u64(row.try_get("last_sequence")?, "providerSequence")?,
        last_cursor: row.try_get("last_cursor")?,
        status: ProviderRunJournalStatus::from_str(row.try_get("status")?)?,
        start_command_id: row.try_get("start_command_id")?,
        start_idempotency_key: row.try_get("start_idempotency_key")?,
        request_digest: row.try_get("request_digest")?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    };
    record.validate()?;
    Ok(record)
}

pub(super) async fn event_position_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    journal: &ProviderRunJournalRecord,
    advance: &ProviderRunJournalAdvanceRecord,
) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1 FROM provider_run_journal_events
WHERE provider_id = ? AND provider_run_id = ? AND (sequence = ? OR cursor = ?)
        "#,
    )
    .bind(&journal.provider_id)
    .bind(&journal.provider_run_id)
    .bind(storage_i64(advance.event.sequence, "providerSequence")?)
    .bind(&advance.event.cursor)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

pub(super) async fn insert_provider_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    journal: &ProviderRunJournalRecord,
    advance: &ProviderRunJournalAdvanceRecord,
    event_hash: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO provider_run_journal_events (
    provider_id, provider_run_id, event_id, sequence, cursor,
    event_type, event_hash, payload_digest, projection_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&journal.provider_id)
    .bind(&journal.provider_run_id)
    .bind(&advance.event.event_id)
    .bind(storage_i64(advance.event.sequence, "providerSequence")?)
    .bind(&advance.event.cursor)
    .bind(&advance.event.event_type)
    .bind(event_hash)
    .bind(&advance.event.projection.payload_digest)
    .bind(&advance.event.projection.projection_json)
    .bind(advance.event.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) fn revision_regresses(current: Option<u64>, next: Option<u64>) -> bool {
    matches!((current, next), (Some(current), Some(next)) if next < current)
}

pub(super) fn storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Provider execution storage field {field} is out of range"))
}

pub(super) fn storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Provider execution storage field {field} is out of range"))
}
