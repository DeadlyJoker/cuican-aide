use sqlx::Row;

use super::StateRuntime;
use super::provider_execution_storage::due_provider_run_supervision_query;
use super::provider_execution_storage::due_provider_run_supervision_query_with_cursor;
use super::provider_execution_storage::journal_from_row;
use super::provider_execution_storage::storage_i64;
use super::provider_execution_storage::storage_u64;
use crate::ProviderRunSupervisionQuery;
use crate::ProviderRunSupervisionRecord;
use crate::ProviderRunSupervisionUpdate;
use crate::ProviderRunSupervisionUpdateOutcome;

impl StateRuntime {
    /// Lists a bounded due page for the supervised Provider event pump.
    pub async fn list_due_provider_run_supervision_records(
        &self,
        query: &ProviderRunSupervisionQuery,
    ) -> anyhow::Result<Vec<ProviderRunSupervisionRecord>> {
        if query.now < 0 || query.limit == 0 || query.limit > 100 {
            anyhow::bail!("invalid Provider Run supervision query");
        }
        let rows = if let Some(after) = &query.after {
            after.validate()?;
            due_provider_run_supervision_query_with_cursor()
                .bind(query.now)
                .bind(&after.task_id)
                .bind(&after.task_id)
                .bind(&after.attempt_id)
                .bind(&after.task_id)
                .bind(&after.attempt_id)
                .bind(&after.worker_run_id)
                .bind(i64::from(query.limit))
                .fetch_all(self.pool.as_ref())
                .await?
        } else {
            due_provider_run_supervision_query()
                .bind(query.now)
                .bind(i64::from(query.limit))
                .fetch_all(self.pool.as_ref())
                .await?
        };
        rows.into_iter()
            .map(|row| {
                let poll_attempts =
                    storage_u64(row.try_get("poll_attempts")?, "providerRunPollAttempts")?;
                let available_at = row.try_get("supervision_available_at")?;
                let updated_at = row.try_get("supervision_updated_at")?;
                if available_at < 0 || updated_at < 0 || available_at < updated_at {
                    anyhow::bail!("invalid Provider Run supervision state");
                }
                Ok(ProviderRunSupervisionRecord {
                    journal: journal_from_row(row)?,
                    poll_attempts,
                    available_at,
                    updated_at,
                })
            })
            .collect()
    }

    /// Schedules the next Provider event poll under the observed supervision CAS.
    pub async fn schedule_provider_run_supervision(
        &self,
        update: &ProviderRunSupervisionUpdate,
    ) -> anyhow::Result<ProviderRunSupervisionUpdateOutcome> {
        update.key.validate()?;
        if update.expected_available_at < 0
            || update.available_at <= update.expected_available_at
            || update.updated_at < 0
            || update.available_at < update.updated_at
            || (update.next_poll_attempts != 0
                && update.next_poll_attempts
                    != update
                        .expected_poll_attempts
                        .checked_add(1)
                        .ok_or_else(|| anyhow::anyhow!("Provider Run poll attempts overflow"))?)
        {
            anyhow::bail!("invalid Provider Run supervision update");
        }
        let expected_attempts = storage_i64(
            update.expected_poll_attempts,
            "providerRunExpectedPollAttempts",
        )?;
        let next_attempts = storage_i64(update.next_poll_attempts, "providerRunNextPollAttempts")?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let current = sqlx::query(
            r#"
SELECT poll_attempts, available_at
FROM provider_run_supervision
WHERE task_id = ? AND attempt_id = ? AND worker_run_id = ?
            "#,
        )
        .bind(&update.key.task_id)
        .bind(&update.key.attempt_id)
        .bind(&update.key.worker_run_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(current) = current else {
            tx.rollback().await?;
            return Ok(ProviderRunSupervisionUpdateOutcome::NotFound);
        };
        if current.try_get::<i64, _>("poll_attempts")? != expected_attempts
            || current.try_get::<i64, _>("available_at")? != update.expected_available_at
        {
            tx.rollback().await?;
            return Ok(ProviderRunSupervisionUpdateOutcome::Conflict);
        }
        let result = sqlx::query(
            r#"
UPDATE provider_run_supervision
SET poll_attempts = ?, available_at = ?, updated_at = ?
WHERE task_id = ? AND attempt_id = ? AND worker_run_id = ?
  AND poll_attempts = ? AND available_at = ?
            "#,
        )
        .bind(next_attempts)
        .bind(update.available_at)
        .bind(update.updated_at)
        .bind(&update.key.task_id)
        .bind(&update.key.attempt_id)
        .bind(&update.key.worker_run_id)
        .bind(expected_attempts)
        .bind(update.expected_available_at)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ProviderRunSupervisionUpdateOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(ProviderRunSupervisionUpdateOutcome::Updated)
    }
}
