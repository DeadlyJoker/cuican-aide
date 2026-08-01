use std::collections::BTreeSet;

use sqlx::Row;

use super::StateRuntime;
use super::cloud_agent_turn::MAX_CLOUD_AGENT_TURNS;
use super::cloud_agent_turn::insert_turn;
use super::thread_execution_context::context_by_thread_id;
use super::thread_execution_context::context_dependencies_exist;
use crate::CloudAgentLegacyImportCommit;
use crate::CloudAgentLegacyImportCommitOutcome;
use crate::CloudAgentLegacyImportRecord;
use crate::CloudAgentLegacyImportStart;
use crate::CloudAgentLegacyImportStartOutcome;
use crate::CloudAgentLegacyImportStatus;
use crate::CloudAgentTurnOrigin;
use crate::CloudAgentTurnRecord;
use crate::CloudAgentTurnStatus;
use crate::ThreadExecutionContextRecord;

const MAX_CLOUD_AGENT_LEGACY_IMPORTS: i64 = 1_000;

impl StateRuntime {
    /// Starts or resumes one bounded legacy session import without reading legacy files.
    pub async fn start_cloud_agent_legacy_import(
        &self,
        request: &CloudAgentLegacyImportStart,
    ) -> anyhow::Result<CloudAgentLegacyImportStartOutcome> {
        request.validate()?;
        let expected = request.pending_record();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = import_by_identity(&mut tx, request).await? {
            tx.rollback().await?;
            if !same_import_identity(&existing, &expected) {
                return Ok(CloudAgentLegacyImportStartOutcome::Conflict);
            }
            return Ok(match existing.status {
                CloudAgentLegacyImportStatus::Pending => {
                    CloudAgentLegacyImportStartOutcome::ExistingPending(existing)
                }
                CloudAgentLegacyImportStatus::Completed => {
                    CloudAgentLegacyImportStartOutcome::ExistingCompleted(existing)
                }
            });
        }
        let Some(context) = context_by_thread_id(&mut tx, &request.thread_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportStartOutcome::DependencyMissing);
        };
        if !context_matches_import(&context, &expected)
            || !context_dependencies_exist(&mut tx, &context).await?
        {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportStartOutcome::DependencyMissing);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cloud_agent_legacy_imports")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_CLOUD_AGENT_LEGACY_IMPORTS {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportStartOutcome::CapacityExceeded);
        }
        insert_import(&mut tx, &expected).await?;
        tx.commit().await?;
        Ok(CloudAgentLegacyImportStartOutcome::Started(expected))
    }

    /// Atomically commits all legacy Turns and completes their durable journal.
    pub async fn commit_cloud_agent_legacy_import(
        &self,
        request: &CloudAgentLegacyImportCommit,
    ) -> anyhow::Result<CloudAgentLegacyImportCommitOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(journal) = import_by_journal_id(&mut tx, &request.journal_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::DependencyMissing);
        };
        if journal.source_digest != request.source_digest
            || journal.expected_turn_count != request.turns.len()
            || !turns_match_journal(&request.turns, &journal)
        {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::Conflict);
        }
        if journal.status == CloudAgentLegacyImportStatus::Completed {
            let same = completed_turns_match(&mut tx, &journal, &request.turns).await?;
            tx.rollback().await?;
            return Ok(if same {
                CloudAgentLegacyImportCommitOutcome::ExistingSame
            } else {
                CloudAgentLegacyImportCommitOutcome::Conflict
            });
        }
        let Some(context) = context_by_thread_id(&mut tx, &journal.thread_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::DependencyMissing);
        };
        if !context_matches_import(&context, &journal)
            || !context_dependencies_exist(&mut tx, &context).await?
        {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::DependencyMissing);
        }
        if !turns_match_context(&request.turns, &context) {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::Conflict);
        }
        let turn_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cloud_agent_turns")
            .fetch_one(&mut *tx)
            .await?;
        if turn_count > MAX_CLOUD_AGENT_TURNS - i64::try_from(request.turns.len())? {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::CapacityExceeded);
        }
        if import_turn_identity_exists(&mut tx, &request.turns).await? {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::Conflict);
        }
        for (ordinal, turn) in request.turns.iter().enumerate() {
            insert_turn(&mut tx, turn).await?;
            let Some(import_id) = turn.origin.import_id() else {
                tx.rollback().await?;
                return Ok(CloudAgentLegacyImportCommitOutcome::Conflict);
            };
            sqlx::query(
                r#"
INSERT INTO cloud_agent_legacy_import_turns (
    journal_id, ordinal, turn_id, import_id
) VALUES (?, ?, ?, ?)
                "#,
            )
            .bind(&journal.journal_id)
            .bind(i64::try_from(ordinal)?)
            .bind(&turn.turn_id)
            .bind(import_id)
            .execute(&mut *tx)
            .await?;
        }
        let Some(last_turn) = request.turns.last() else {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::Conflict);
        };
        update_summary_if_not_newer(&mut tx, last_turn).await?;
        let result = sqlx::query(
            r#"
UPDATE cloud_agent_legacy_imports
SET status = 'completed', completed_at = imported_at
WHERE journal_id = ? AND status = 'pending'
            "#,
        )
        .bind(&journal.journal_id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(CloudAgentLegacyImportCommitOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(CloudAgentLegacyImportCommitOutcome::Committed)
    }

    pub async fn get_cloud_agent_legacy_import(
        &self,
        journal_id: &str,
    ) -> anyhow::Result<Option<CloudAgentLegacyImportRecord>> {
        validate_lookup_id(journal_id)?;
        let row = import_query()
            .bind(journal_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        row.map(import_from_row).transpose()
    }
}

async fn import_by_identity(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request: &CloudAgentLegacyImportStart,
) -> anyhow::Result<Option<CloudAgentLegacyImportRecord>> {
    let row = sqlx::query(
        r#"
SELECT journal_id, source_key, source_digest, source_bytes, thread_id,
       execution_binding_id, execution_binding_revision, expected_turn_count,
       status, imported_at, completed_at
FROM cloud_agent_legacy_imports
WHERE journal_id = ? OR source_key = ?
        "#,
    )
    .bind(&request.journal_id)
    .bind(&request.source_key)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(import_from_row).transpose()
}

async fn import_by_journal_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    journal_id: &str,
) -> anyhow::Result<Option<CloudAgentLegacyImportRecord>> {
    let row = import_query()
        .bind(journal_id)
        .fetch_optional(&mut **tx)
        .await?;
    row.map(import_from_row).transpose()
}

fn import_query() -> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT journal_id, source_key, source_digest, source_bytes, thread_id,
       execution_binding_id, execution_binding_revision, expected_turn_count,
       status, imported_at, completed_at
FROM cloud_agent_legacy_imports
WHERE journal_id = ?
        "#,
    )
}

fn import_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<CloudAgentLegacyImportRecord> {
    let record = CloudAgentLegacyImportRecord {
        journal_id: row.try_get("journal_id")?,
        source_key: row.try_get("source_key")?,
        source_digest: row.try_get("source_digest")?,
        source_bytes: u64::try_from(row.try_get::<i64, _>("source_bytes")?)?,
        thread_id: row.try_get("thread_id")?,
        execution_binding: crate::ThreadExecutionContextBindingRef {
            binding_id: row.try_get("execution_binding_id")?,
            revision: u64::try_from(row.try_get::<i64, _>("execution_binding_revision")?)?,
        },
        expected_turn_count: usize::try_from(row.try_get::<i64, _>("expected_turn_count")?)?,
        status: CloudAgentLegacyImportStatus::from_str(row.try_get("status")?)?,
        imported_at: row.try_get("imported_at")?,
        completed_at: row.try_get("completed_at")?,
    };
    record.validate()?;
    Ok(record)
}

async fn insert_import(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &CloudAgentLegacyImportRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO cloud_agent_legacy_imports (
    journal_id, source_key, source_digest, source_bytes, thread_id,
    execution_binding_id, execution_binding_revision, expected_turn_count,
    status, imported_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.journal_id)
    .bind(&record.source_key)
    .bind(&record.source_digest)
    .bind(i64::try_from(record.source_bytes)?)
    .bind(&record.thread_id)
    .bind(&record.execution_binding.binding_id)
    .bind(i64::try_from(record.execution_binding.revision)?)
    .bind(i64::try_from(record.expected_turn_count)?)
    .bind(record.status.as_str())
    .bind(record.imported_at)
    .bind(record.completed_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn same_import_identity(
    existing: &CloudAgentLegacyImportRecord,
    expected: &CloudAgentLegacyImportRecord,
) -> bool {
    existing.journal_id == expected.journal_id
        && existing.source_key == expected.source_key
        && existing.source_digest == expected.source_digest
        && existing.source_bytes == expected.source_bytes
        && existing.thread_id == expected.thread_id
        && existing.execution_binding == expected.execution_binding
        && existing.expected_turn_count == expected.expected_turn_count
}

fn context_matches_import(
    context: &ThreadExecutionContextRecord,
    import: &CloudAgentLegacyImportRecord,
) -> bool {
    context.thread_id == import.thread_id
        && context.execution_binding.as_ref() == Some(&import.execution_binding)
}

fn turns_match_context(
    turns: &[CloudAgentTurnRecord],
    context: &ThreadExecutionContextRecord,
) -> bool {
    turns.iter().all(|turn| {
        turn.local_actor_id == context.local_actor_id
            && turn.local_tenant_id == context.local_tenant_id
            && turn.local_space_id == context.local_space_id
            && turn.workspace_key == context.workspace_key
    })
}

fn turns_match_journal(
    turns: &[CloudAgentTurnRecord],
    journal: &CloudAgentLegacyImportRecord,
) -> bool {
    let mut turn_ids = BTreeSet::new();
    let mut client_ids = BTreeSet::new();
    let mut import_ids = BTreeSet::new();
    turns.iter().all(|turn| {
        let CloudAgentTurnOrigin::LegacyImport { import_id } = &turn.origin else {
            return false;
        };
        turn.thread_id == journal.thread_id
            && turn.execution_binding == journal.execution_binding
            && turn.status.is_terminal()
            && matches!(
                turn.status,
                CloudAgentTurnStatus::Completed | CloudAgentTurnStatus::Failed
            )
            && turn.created_at == journal.imported_at
            && turn.updated_at == journal.imported_at
            && turn.completed_at == Some(journal.imported_at)
            && turn_ids.insert(&turn.turn_id)
            && client_ids.insert(&turn.client_user_message_id)
            && import_ids.insert(import_id)
    })
}

async fn import_turn_identity_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    turns: &[CloudAgentTurnRecord],
) -> anyhow::Result<bool> {
    for turn in turns {
        let import_id = turn
            .origin
            .import_id()
            .ok_or_else(|| anyhow::anyhow!("legacy import Turn has no import identity"))?;
        if sqlx::query_scalar::<_, i64>(
            r#"
SELECT 1 FROM cloud_agent_turns
WHERE turn_id = ?
   OR (thread_id = ? AND client_user_message_id = ?)
   OR (thread_id = ? AND import_id = ?)
            "#,
        )
        .bind(&turn.turn_id)
        .bind(&turn.thread_id)
        .bind(&turn.client_user_message_id)
        .bind(&turn.thread_id)
        .bind(import_id)
        .fetch_optional(&mut **tx)
        .await?
        .is_some()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn completed_turns_match(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    journal: &CloudAgentLegacyImportRecord,
    turns: &[CloudAgentTurnRecord],
) -> anyhow::Result<bool> {
    let rows = sqlx::query(
        r#"
SELECT m.ordinal, m.turn_id, m.import_id, t.record_hash
FROM cloud_agent_legacy_import_turns m
JOIN cloud_agent_turns t ON t.turn_id = m.turn_id
WHERE m.journal_id = ?
ORDER BY m.ordinal ASC
        "#,
    )
    .bind(&journal.journal_id)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() != turns.len() {
        return Ok(false);
    }
    Ok(rows.iter().zip(turns).all(|(row, turn)| {
        row.try_get::<String, _>("turn_id").ok().as_deref() == Some(turn.turn_id.as_str())
            && row.try_get::<String, _>("import_id").ok().as_deref() == turn.origin.import_id()
            && row.try_get::<String, _>("record_hash").ok().as_deref()
                == Some(turn.record_hash.as_str())
    }))
}

async fn update_summary_if_not_newer(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    turn: &CloudAgentTurnRecord,
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
WHERE cloud_agent_thread_summaries.updated_at < excluded.updated_at
        "#,
    )
    .bind(&turn.thread_id)
    .bind(&turn.turn_id)
    .bind(turn.updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn validate_lookup_id(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        anyhow::bail!("invalid Cloud Agent legacy import journal id");
    }
    Ok(())
}
