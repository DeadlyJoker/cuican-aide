use super::StateRuntime;
use super::task_runtime_read::outbox_record_from_row;
use crate::MAX_TASK_RECORD_PAGE_SIZE;
use crate::TaskCursorAdvanceOutcome;
use crate::TaskCursorAdvanceRecord;
use crate::TaskMigrationJournalCreateOutcome;
use crate::TaskMigrationJournalRecord;
use crate::TaskOutboxDeferOutcome;
use crate::TaskOutboxDeliveryOutcome;
use crate::TaskOutboxStatus;
use crate::TaskStoredOutboxRecord;
use crate::storage_i64;
use crate::storage_u64;
use sqlx::Row;

impl StateRuntime {
    pub async fn get_task_cursor(
        &self,
        consumer_id: &str,
        task_id: &str,
    ) -> anyhow::Result<Option<u64>> {
        sqlx::query_scalar::<_, i64>(
            "SELECT stream_offset FROM task_runtime_cursors WHERE consumer_id = ? AND task_id = ?",
        )
        .bind(consumer_id)
        .bind(task_id)
        .fetch_optional(self.pool.as_ref())
        .await?
        .map(|offset| storage_u64(offset, "streamOffset"))
        .transpose()
    }

    pub async fn advance_task_cursor(
        &self,
        record: &TaskCursorAdvanceRecord,
    ) -> anyhow::Result<TaskCursorAdvanceOutcome> {
        record.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let task_offset = sqlx::query_scalar::<_, i64>(
            "SELECT stream_offset FROM task_runtime_tasks WHERE task_id = ?",
        )
        .bind(&record.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(task_offset) = task_offset else {
            tx.rollback().await?;
            return Ok(TaskCursorAdvanceOutcome::NotFound);
        };
        if storage_u64(task_offset, "taskStreamOffset")? < record.next_offset
            || sqlx::query_scalar::<_, i64>(
                "SELECT 1 FROM task_runtime_events WHERE task_id = ? AND stream_offset = ?",
            )
            .bind(&record.task_id)
            .bind(storage_i64(record.next_offset, "nextOffset")?)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
        {
            tx.rollback().await?;
            return Ok(TaskCursorAdvanceOutcome::Gap);
        }
        let current = sqlx::query_scalar::<_, i64>(
            "SELECT stream_offset FROM task_runtime_cursors WHERE consumer_id = ? AND task_id = ?",
        )
        .bind(&record.consumer_id)
        .bind(&record.task_id)
        .fetch_optional(&mut *tx)
        .await?
        .map(|offset| storage_u64(offset, "cursorOffset"))
        .transpose()?
        .unwrap_or(0);
        if current != record.expected_offset {
            tx.rollback().await?;
            return Ok(TaskCursorAdvanceOutcome::Conflict);
        }
        sqlx::query(
            r#"
INSERT INTO task_runtime_cursors (consumer_id, task_id, stream_offset, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(consumer_id, task_id) DO UPDATE SET
    stream_offset = excluded.stream_offset,
    updated_at = excluded.updated_at
            "#,
        )
        .bind(&record.consumer_id)
        .bind(&record.task_id)
        .bind(storage_i64(record.next_offset, "nextOffset")?)
        .bind(record.updated_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(TaskCursorAdvanceOutcome::Advanced)
    }

    pub async fn list_pending_task_outbox_records(
        &self,
        now: i64,
        limit: u32,
    ) -> anyhow::Result<Vec<TaskStoredOutboxRecord>> {
        if now < 0 || limit == 0 || limit > MAX_TASK_RECORD_PAGE_SIZE {
            anyhow::bail!("invalid pending task outbox query");
        }
        sqlx::query(
            r#"
SELECT outbox_id, task_id, aggregate_version, decision_type, payload_json,
       status, delivery_attempts, available_at, created_at, delivered_at
FROM task_runtime_outbox
WHERE status = 'pending' AND available_at <= ?
ORDER BY available_at ASC, created_at ASC, outbox_id ASC
LIMIT ?
            "#,
        )
        .bind(now)
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(outbox_record_from_row)
        .collect()
    }

    /// Lists a bounded page of WorkerExecutor decisions without authority-policy rows.
    pub async fn list_pending_task_worker_outbox_records(
        &self,
        now: i64,
        limit: u32,
    ) -> anyhow::Result<Vec<TaskStoredOutboxRecord>> {
        if now < 0 || limit == 0 || limit > MAX_TASK_RECORD_PAGE_SIZE {
            anyhow::bail!("invalid pending task worker outbox query");
        }
        sqlx::query(
            r#"
SELECT outbox_id, task_id, aggregate_version, decision_type, payload_json,
       status, delivery_attempts, available_at, created_at, delivered_at
FROM task_runtime_outbox
WHERE status = 'pending' AND available_at <= ?
  AND decision_type IN ('dispatchAttempt', 'cancelAttempt', 'reconcileAttempt')
ORDER BY available_at ASC, created_at ASC, outbox_id ASC
LIMIT ?
            "#,
        )
        .bind(now)
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(outbox_record_from_row)
        .collect()
    }

    /// Lists bounded Cloud Agent decisions owned by the local Single Task authority.
    pub async fn list_pending_cloud_agent_authority_outbox_records(
        &self,
        now: i64,
        limit: u32,
    ) -> anyhow::Result<Vec<TaskStoredOutboxRecord>> {
        if now < 0 || limit == 0 || limit > MAX_TASK_RECORD_PAGE_SIZE {
            anyhow::bail!("invalid pending Cloud Agent authority outbox query");
        }
        sqlx::query(
            r#"
SELECT o.outbox_id, o.task_id, o.aggregate_version, o.decision_type, o.payload_json,
       o.status, o.delivery_attempts, o.available_at, o.created_at, o.delivered_at
FROM task_runtime_outbox o
JOIN cloud_agent_turns t
  ON t.task_id = o.task_id AND t.origin_kind = 'durableTask'
WHERE o.status = 'pending' AND o.available_at <= ?
  AND o.decision_type IN ('enqueueAttempt', 'awaitRetryDecision')
ORDER BY o.available_at ASC, o.created_at ASC, o.outbox_id ASC
LIMIT ?
            "#,
        )
        .bind(now)
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(outbox_record_from_row)
        .collect()
    }

    pub async fn mark_task_outbox_delivered(
        &self,
        outbox_id: &str,
        delivered_at: i64,
    ) -> anyhow::Result<TaskOutboxDeliveryOutcome> {
        if delivered_at < 0 {
            anyhow::bail!("invalid task outbox delivery timestamp");
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let status = sqlx::query_scalar::<_, String>(
            "SELECT status FROM task_runtime_outbox WHERE outbox_id = ?",
        )
        .bind(outbox_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(status) = status else {
            tx.rollback().await?;
            return Ok(TaskOutboxDeliveryOutcome::NotFound);
        };
        if TaskOutboxStatus::from_str(&status)? == TaskOutboxStatus::Delivered {
            tx.rollback().await?;
            return Ok(TaskOutboxDeliveryOutcome::AlreadyDelivered);
        }
        sqlx::query(
            r#"
UPDATE task_runtime_outbox
SET status = ?, delivered_at = ?, delivery_attempts = delivery_attempts + 1
WHERE outbox_id = ? AND status = 'pending'
            "#,
        )
        .bind(TaskOutboxStatus::Delivered.as_str())
        .bind(delivered_at)
        .bind(outbox_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(TaskOutboxDeliveryOutcome::Delivered)
    }

    /// Marks one pending outbox row delivered only for the observed delivery attempt.
    pub async fn mark_task_outbox_delivered_if_attempt(
        &self,
        outbox_id: &str,
        expected_delivery_attempts: u64,
        delivered_at: i64,
    ) -> anyhow::Result<TaskOutboxDeliveryOutcome> {
        if delivered_at < 0 {
            anyhow::bail!("invalid task outbox delivery timestamp");
        }
        let expected_attempts = storage_i64(expected_delivery_attempts, "deliveryAttempts")?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT status, delivery_attempts, available_at FROM task_runtime_outbox WHERE outbox_id = ?",
        )
        .bind(outbox_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(TaskOutboxDeliveryOutcome::NotFound);
        };
        if TaskOutboxStatus::from_str(row.try_get("status")?)? == TaskOutboxStatus::Delivered {
            tx.rollback().await?;
            return Ok(TaskOutboxDeliveryOutcome::AlreadyDelivered);
        }
        if row.try_get::<i64, _>("delivery_attempts")? != expected_attempts
            || delivered_at < row.try_get::<i64, _>("available_at")?
        {
            tx.rollback().await?;
            return Ok(TaskOutboxDeliveryOutcome::Conflict);
        }
        let result = sqlx::query(
            r#"
UPDATE task_runtime_outbox
SET status = ?, delivered_at = ?, delivery_attempts = delivery_attempts + 1
WHERE outbox_id = ? AND status = 'pending' AND delivery_attempts = ?
            "#,
        )
        .bind(TaskOutboxStatus::Delivered.as_str())
        .bind(delivered_at)
        .bind(outbox_id)
        .bind(expected_attempts)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(TaskOutboxDeliveryOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(TaskOutboxDeliveryOutcome::Delivered)
    }

    /// Defers one pending outbox row with monotonic availability and attempt CAS.
    pub async fn defer_task_outbox_record(
        &self,
        outbox_id: &str,
        expected_delivery_attempts: u64,
        available_at: i64,
    ) -> anyhow::Result<TaskOutboxDeferOutcome> {
        if available_at < 0 {
            anyhow::bail!("invalid task outbox availability timestamp");
        }
        let expected_attempts = storage_i64(expected_delivery_attempts, "deliveryAttempts")?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT status, delivery_attempts, available_at FROM task_runtime_outbox WHERE outbox_id = ?",
        )
        .bind(outbox_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(TaskOutboxDeferOutcome::NotFound);
        };
        if TaskOutboxStatus::from_str(row.try_get("status")?)? == TaskOutboxStatus::Delivered {
            tx.rollback().await?;
            return Ok(TaskOutboxDeferOutcome::AlreadyDelivered);
        }
        if row.try_get::<i64, _>("delivery_attempts")? != expected_attempts
            || available_at <= row.try_get::<i64, _>("available_at")?
        {
            tx.rollback().await?;
            return Ok(TaskOutboxDeferOutcome::Conflict);
        }
        let result = sqlx::query(
            r#"
UPDATE task_runtime_outbox
SET available_at = ?, delivery_attempts = delivery_attempts + 1
WHERE outbox_id = ? AND status = 'pending' AND delivery_attempts = ?
            "#,
        )
        .bind(available_at)
        .bind(outbox_id)
        .bind(expected_attempts)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(TaskOutboxDeferOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(TaskOutboxDeferOutcome::Deferred)
    }

    pub async fn create_task_migration_journal(
        &self,
        record: &TaskMigrationJournalRecord,
    ) -> anyhow::Result<TaskMigrationJournalCreateOutcome> {
        record.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = sqlx::query(
            r#"
SELECT migration_hash, task_id, status, updated_at
FROM task_runtime_migration_journal
WHERE source_kind = ? AND source_id = ? AND source_revision = ?
            "#,
        )
        .bind(&record.source_kind)
        .bind(&record.source_id)
        .bind(&record.source_revision)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(existing) = existing {
            let same = existing.try_get::<String, _>("migration_hash")? == record.migration_hash
                && existing.try_get::<String, _>("task_id")? == record.task_id
                && existing.try_get::<String, _>("status")? == record.status
                && existing.try_get::<i64, _>("updated_at")? == record.updated_at;
            tx.rollback().await?;
            return Ok(if same {
                TaskMigrationJournalCreateOutcome::ExistingSame
            } else {
                TaskMigrationJournalCreateOutcome::Conflict
            });
        }
        sqlx::query(
            r#"
INSERT INTO task_runtime_migration_journal (
    source_kind, source_id, source_revision, migration_hash, task_id, status, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&record.source_kind)
        .bind(&record.source_id)
        .bind(&record.source_revision)
        .bind(&record.migration_hash)
        .bind(&record.task_id)
        .bind(&record.status)
        .bind(record.updated_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(TaskMigrationJournalCreateOutcome::Created)
    }

    pub async fn get_task_migration_journal(
        &self,
        source_kind: &str,
        source_id: &str,
        source_revision: &str,
    ) -> anyhow::Result<Option<TaskMigrationJournalRecord>> {
        sqlx::query(
            r#"
SELECT source_kind, source_id, source_revision, migration_hash, task_id, status, updated_at
FROM task_runtime_migration_journal
WHERE source_kind = ? AND source_id = ? AND source_revision = ?
            "#,
        )
        .bind(source_kind)
        .bind(source_id)
        .bind(source_revision)
        .fetch_optional(self.pool.as_ref())
        .await?
        .map(|row| {
            Ok(TaskMigrationJournalRecord {
                source_kind: row.try_get("source_kind")?,
                source_id: row.try_get("source_id")?,
                source_revision: row.try_get("source_revision")?,
                migration_hash: row.try_get("migration_hash")?,
                task_id: row.try_get("task_id")?,
                status: row.try_get("status")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .transpose()
    }
}

#[cfg(test)]
#[path = "task_runtime_recovery_tests.rs"]
mod tests;
