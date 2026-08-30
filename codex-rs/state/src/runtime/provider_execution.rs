use sqlx::Row;

use super::StateRuntime;
use super::provider_execution_storage::cloud_execution_dependencies_exist;
use super::provider_execution_storage::event_position_exists;
use super::provider_execution_storage::insert_cloud_execution_spec;
use super::provider_execution_storage::insert_cloud_execution_spec_context_artifacts;
use super::provider_execution_storage::insert_provider_event;
use super::provider_execution_storage::insert_provider_run_journal;
use super::provider_execution_storage::journal_for_attempt_query;
use super::provider_execution_storage::journal_from_row;
use super::provider_execution_storage::journal_matches_execution_spec;
use super::provider_execution_storage::journal_query;
use super::provider_execution_storage::recoverable_journals_query;
use super::provider_execution_storage::recoverable_journals_query_with_cursor;
use super::provider_execution_storage::revision_regresses;
use super::provider_execution_storage::storage_i64;
use super::provider_execution_storage::storage_u64;
use crate::CloudExecutionArtifactRefRecord;
use crate::CloudExecutionSpecCreateOutcome;
use crate::CloudExecutionSpecRecord;
use crate::ProviderRunJournalAdvanceOutcome;
use crate::ProviderRunJournalAdvanceRecord;
use crate::ProviderRunJournalCreateOutcome;
use crate::ProviderRunJournalKey;
use crate::ProviderRunJournalRecord;
use crate::ProviderRunJournalRecoveryQuery;
use crate::provider_status_transition_is_valid;

impl StateRuntime {
    /// Creates one immutable metadata-only execution specification.
    pub async fn create_cloud_execution_spec_record(
        &self,
        record: &CloudExecutionSpecRecord,
    ) -> anyhow::Result<CloudExecutionSpecCreateOutcome> {
        record.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing_digest) = sqlx::query_scalar::<_, String>(
            "SELECT digest FROM cloud_execution_specs WHERE execution_spec_id = ? AND revision = ?",
        )
        .bind(&record.execution_spec_id)
        .bind(storage_i64(record.revision, "executionSpecRevision")?)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.rollback().await?;
            return Ok(if existing_digest == record.digest {
                CloudExecutionSpecCreateOutcome::ExistingSame
            } else {
                CloudExecutionSpecCreateOutcome::Conflict
            });
        }
        if sqlx::query_scalar::<_, i64>("SELECT 1 FROM cloud_execution_specs WHERE task_id = ?")
            .bind(&record.task_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some()
        {
            tx.rollback().await?;
            return Ok(CloudExecutionSpecCreateOutcome::Conflict);
        }
        if !cloud_execution_dependencies_exist(&mut tx, record).await? {
            tx.rollback().await?;
            return Ok(CloudExecutionSpecCreateOutcome::DependencyMissing);
        }

        insert_cloud_execution_spec(&mut tx, record).await?;
        insert_cloud_execution_spec_context_artifacts(&mut tx, record).await?;
        tx.commit().await?;
        Ok(CloudExecutionSpecCreateOutcome::Created)
    }

    /// Reads one exact immutable execution specification revision.
    pub async fn get_cloud_execution_spec_record(
        &self,
        execution_spec_id: &str,
        revision: u64,
    ) -> anyhow::Result<Option<CloudExecutionSpecRecord>> {
        let row = sqlx::query(
            r#"
SELECT execution_spec_id, revision, digest, task_id, workspace_key, binding_id,
       provider_id, protocol_version, resource_kind, resource_id, resource_revision,
       credential_id, credential_revision, prompt_artifact_id,
       prompt_artifact_revision, created_at
FROM cloud_execution_specs
WHERE execution_spec_id = ? AND revision = ?
            "#,
        )
        .bind(execution_spec_id)
        .bind(storage_i64(revision, "executionSpecRevision")?)
        .fetch_optional(self.pool.as_ref())
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let contexts = sqlx::query(
            r#"
SELECT artifact_id, artifact_revision
FROM cloud_execution_spec_context_artifacts
WHERE execution_spec_id = ? AND execution_spec_revision = ?
ORDER BY ordinal ASC
            "#,
        )
        .bind(execution_spec_id)
        .bind(storage_i64(revision, "executionSpecRevision")?)
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(|row| {
            Ok(CloudExecutionArtifactRefRecord {
                artifact_id: row.try_get("artifact_id")?,
                revision: storage_u64(row.try_get("artifact_revision")?, "artifactRevision")?,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
        let record = CloudExecutionSpecRecord {
            execution_spec_id: row.try_get("execution_spec_id")?,
            revision: storage_u64(row.try_get("revision")?, "executionSpecRevision")?,
            digest: row.try_get("digest")?,
            task_id: row.try_get("task_id")?,
            workspace_key: row.try_get("workspace_key")?,
            binding_id: row.try_get("binding_id")?,
            provider_id: row.try_get("provider_id")?,
            protocol_version: row.try_get("protocol_version")?,
            resource_kind: row.try_get("resource_kind")?,
            resource_id: row.try_get("resource_id")?,
            resource_revision: row.try_get("resource_revision")?,
            credential_id: row.try_get("credential_id")?,
            credential_revision: storage_u64(
                row.try_get("credential_revision")?,
                "credentialRevision",
            )?,
            prompt_artifact: CloudExecutionArtifactRefRecord {
                artifact_id: row.try_get("prompt_artifact_id")?,
                revision: storage_u64(
                    row.try_get("prompt_artifact_revision")?,
                    "promptArtifactRevision",
                )?,
            },
            context_artifacts: contexts,
            created_at: row.try_get("created_at")?,
        };
        record.validate()?;
        Ok(Some(record))
    }

    /// Stores the exact Provider Run identity returned by one idempotent start.
    pub async fn create_provider_run_journal_record(
        &self,
        record: &ProviderRunJournalRecord,
    ) -> anyhow::Result<ProviderRunJournalCreateOutcome> {
        record.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing_hash) = sqlx::query_scalar::<_, String>(
            r#"
SELECT record_hash FROM provider_run_journal
WHERE task_id = ? AND attempt_id = ? AND worker_run_id = ?
            "#,
        )
        .bind(&record.key.task_id)
        .bind(&record.key.attempt_id)
        .bind(&record.key.worker_run_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            tx.rollback().await?;
            return Ok(if existing_hash == record.record_hash {
                ProviderRunJournalCreateOutcome::ExistingSame
            } else {
                ProviderRunJournalCreateOutcome::Conflict
            });
        }
        if sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM provider_run_journal WHERE task_id = ? AND attempt_id = ?",
        )
        .bind(&record.key.task_id)
        .bind(&record.key.attempt_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
        {
            tx.rollback().await?;
            return Ok(ProviderRunJournalCreateOutcome::Conflict);
        }
        if !journal_matches_execution_spec(&mut tx, record).await? {
            tx.rollback().await?;
            return Ok(ProviderRunJournalCreateOutcome::ExecutionSpecNotFound);
        }
        if sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM provider_run_journal WHERE provider_id = ? AND provider_run_id = ?",
        )
        .bind(&record.provider_id)
        .bind(&record.provider_run_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
        {
            tx.rollback().await?;
            return Ok(ProviderRunJournalCreateOutcome::Conflict);
        }
        insert_provider_run_journal(&mut tx, record).await?;
        tx.commit().await?;
        Ok(ProviderRunJournalCreateOutcome::Created)
    }

    /// Reads the current durable Provider Run mapping for one Worker claim.
    pub async fn get_provider_run_journal_record(
        &self,
        key: &ProviderRunJournalKey,
    ) -> anyhow::Result<Option<ProviderRunJournalRecord>> {
        let row = journal_query()
            .bind(&key.task_id)
            .bind(&key.attempt_id)
            .bind(&key.worker_run_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        row.map(journal_from_row).transpose()
    }

    /// Reads the single Provider Run admitted for an Authority-created Attempt.
    pub async fn get_provider_run_journal_record_for_attempt(
        &self,
        task_id: &str,
        attempt_id: &str,
    ) -> anyhow::Result<Option<ProviderRunJournalRecord>> {
        let row = journal_for_attempt_query()
            .bind(task_id)
            .bind(attempt_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        row.map(journal_from_row).transpose()
    }

    /// Lists a bounded page of non-terminal Provider Runs without replaying side effects.
    pub async fn list_recoverable_provider_run_journal_records(
        &self,
        query: &ProviderRunJournalRecoveryQuery,
    ) -> anyhow::Result<Vec<ProviderRunJournalRecord>> {
        if query.limit == 0 || query.limit > 100 {
            anyhow::bail!("invalid Provider Run recovery query limit");
        }
        let rows = if let Some(after) = &query.after {
            after.validate()?;
            recoverable_journals_query_with_cursor()
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
            recoverable_journals_query()
                .bind(i64::from(query.limit))
                .fetch_all(self.pool.as_ref())
                .await?
        };
        rows.into_iter().map(journal_from_row).collect()
    }

    /// Atomically records one accepted Provider event and advances its cursor by one.
    pub async fn advance_provider_run_journal(
        &self,
        advance: &ProviderRunJournalAdvanceRecord,
    ) -> anyhow::Result<ProviderRunJournalAdvanceOutcome> {
        advance.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = journal_query()
            .bind(&advance.key.task_id)
            .bind(&advance.key.attempt_id)
            .bind(&advance.key.worker_run_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(ProviderRunJournalAdvanceOutcome::NotFound);
        };
        let current = journal_from_row(row)?;
        let event_hash = advance.event.canonical_hash(&current.provider_run_id);
        if let Some(existing) = sqlx::query(
            r#"
SELECT event_hash, payload_digest, projection_json
FROM provider_run_journal_events
WHERE provider_id = ? AND provider_run_id = ? AND event_id = ?
            "#,
        )
        .bind(&current.provider_id)
        .bind(&current.provider_run_id)
        .bind(&advance.event.event_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            let existing_hash: String = existing.try_get("event_hash")?;
            let existing_payload_digest: Option<String> = existing.try_get("payload_digest")?;
            let existing_projection_json: Option<String> = existing.try_get("projection_json")?;
            tx.rollback().await?;
            return Ok(
                if existing_hash == event_hash
                    && existing_payload_digest.as_deref()
                        == Some(advance.event.projection.payload_digest.as_str())
                    && existing_projection_json.as_deref()
                        == Some(advance.event.projection.projection_json.as_str())
                    && current.last_sequence >= advance.event.sequence
                {
                    ProviderRunJournalAdvanceOutcome::Duplicate(current)
                } else {
                    ProviderRunJournalAdvanceOutcome::Conflict
                },
            );
        }
        if current.journal_version != advance.expected_journal_version
            || current.last_sequence != advance.expected_sequence
            || current.last_cursor != advance.expected_cursor
            || !provider_status_transition_is_valid(current.status, advance.status)
            || advance.updated_at < current.updated_at
            || revision_regresses(current.provider_revision, advance.provider_revision)
            || event_position_exists(&mut tx, &current, advance).await?
        {
            tx.rollback().await?;
            return Ok(ProviderRunJournalAdvanceOutcome::Conflict);
        }

        let next_version = current
            .journal_version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Provider Run journal version exhausted"))?;
        let provider_revision = advance.provider_revision.or(current.provider_revision);
        let result = sqlx::query(
            r#"
UPDATE provider_run_journal
SET journal_version = ?, provider_revision = ?, last_sequence = ?, last_cursor = ?,
    status = ?, updated_at = ?
WHERE task_id = ? AND attempt_id = ? AND worker_run_id = ? AND journal_version = ?
            "#,
        )
        .bind(storage_i64(next_version, "journalVersion")?)
        .bind(
            provider_revision
                .map(|revision| storage_i64(revision, "providerRevision"))
                .transpose()?,
        )
        .bind(storage_i64(advance.event.sequence, "providerSequence")?)
        .bind(&advance.event.cursor)
        .bind(advance.status.as_str())
        .bind(advance.updated_at)
        .bind(&advance.key.task_id)
        .bind(&advance.key.attempt_id)
        .bind(&advance.key.worker_run_id)
        .bind(storage_i64(
            advance.expected_journal_version,
            "expectedJournalVersion",
        )?)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(ProviderRunJournalAdvanceOutcome::Conflict);
        }
        insert_provider_event(&mut tx, &current, advance, &event_hash).await?;
        tx.commit().await?;
        let updated = self
            .get_provider_run_journal_record(&advance.key)
            .await?
            .ok_or_else(|| anyhow::anyhow!("advanced Provider Run journal disappeared"))?;
        Ok(ProviderRunJournalAdvanceOutcome::Advanced(updated))
    }
}

#[cfg(test)]
#[path = "provider_execution_tests.rs"]
mod tests;
