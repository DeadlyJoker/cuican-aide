use chrono::DateTime;
use chrono::Utc;
use crewon_protocol::ThreadId;
use sqlx::Row;

use super::StateRuntime;
use crate::CloudAgentThreadSummarySyncCandidate;
use crate::CloudAgentThreadSummarySyncOutcome;
use crate::CloudAgentThreadSummarySyncPage;
use crate::CloudAgentThreadSummarySyncRequest;
use crate::MAX_CLOUD_AGENT_THREAD_SUMMARY_SYNC_PAGE_SIZE;
use crate::model::datetime_to_epoch_millis;
use crate::storage_i64;
use crate::storage_u64;

impl StateRuntime {
    /// Returns whether one Thread has Cloud Agent-owned summary metadata.
    pub async fn is_cloud_agent_thread_summary_managed(
        &self,
        thread_id: ThreadId,
    ) -> anyhow::Result<bool> {
        Ok(sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM cloud_agent_thread_summaries WHERE thread_id = ? LIMIT 1",
        )
        .bind(thread_id.to_string())
        .fetch_optional(self.pool.as_ref())
        .await?
        .is_some())
    }

    /// Returns whether the local Thread index contains any Cloud Agent-owned summary metadata.
    pub async fn has_cloud_agent_thread_summaries(&self) -> anyhow::Result<bool> {
        Ok(
            sqlx::query_scalar::<_, i64>("SELECT 1 FROM cloud_agent_thread_summaries LIMIT 1")
                .fetch_optional(self.pool.as_ref())
                .await?
                .is_some(),
        )
    }

    /// Lists one bounded page of Cloud Agent Thread summaries not yet reflected in ThreadStore.
    pub async fn list_cloud_agent_thread_summary_sync_candidates(
        &self,
        limit: u32,
    ) -> anyhow::Result<CloudAgentThreadSummarySyncPage> {
        if limit == 0 || limit > MAX_CLOUD_AGENT_THREAD_SUMMARY_SYNC_PAGE_SIZE {
            anyhow::bail!("invalid Cloud Agent Thread summary sync page limit");
        }
        let mut rows = sqlx::query(
            r#"
SELECT thread_id, last_turn_id, preview, projection_revision,
       metadata_sync_revision, updated_at
FROM cloud_agent_thread_summaries
WHERE metadata_sync_revision < projection_revision
ORDER BY updated_at ASC, thread_id ASC
LIMIT ?
            "#,
        )
        .bind(i64::from(limit) + 1)
        .fetch_all(self.pool.as_ref())
        .await?;
        let has_more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let data = rows
            .into_iter()
            .map(summary_candidate_from_row)
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(CloudAgentThreadSummarySyncPage { data, has_more })
    }

    /// Atomically applies one exact summary revision to local ThreadStore metadata and acks it.
    pub async fn mark_cloud_agent_thread_summary_synced(
        &self,
        request: &CloudAgentThreadSummarySyncRequest,
    ) -> anyhow::Result<CloudAgentThreadSummarySyncOutcome> {
        request.validate()?;
        let expected_revision = storage_i64(
            request.expected_projection_revision,
            "expectedProjectionRevision",
        )?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let result = sqlx::query(
            r#"
UPDATE cloud_agent_thread_summaries
SET preview = ?, metadata_sync_revision = ?
WHERE thread_id = ?
  AND last_turn_id = ?
  AND projection_revision = ?
  AND metadata_sync_revision < ?
            "#,
        )
        .bind(&request.preview)
        .bind(expected_revision)
        .bind(&request.thread_id)
        .bind(&request.last_turn_id)
        .bind(expected_revision)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 1 {
            let projected_at = DateTime::<Utc>::from_timestamp(request.expected_updated_at, 0)
                .ok_or_else(|| anyhow::anyhow!("invalid Cloud Agent Thread summary updatedAt"))?;
            let thread_updated_at_ms =
                sqlx::query_scalar::<_, i64>("SELECT updated_at_ms FROM threads WHERE id = ?")
                    .bind(&request.thread_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let Some(thread_updated_at_ms) = thread_updated_at_ms else {
                tx.rollback().await?;
                return Ok(CloudAgentThreadSummarySyncOutcome::ThreadMetadataMissing);
            };
            let projected_at_ms = datetime_to_epoch_millis(projected_at);
            let updated_at_ms = if projected_at_ms > thread_updated_at_ms {
                datetime_to_epoch_millis(self.allocate_thread_updated_at(projected_at)?)
            } else {
                thread_updated_at_ms
            };
            let thread_update = sqlx::query(
                r#"
UPDATE threads
SET preview = ?, updated_at = ?, updated_at_ms = ?
WHERE id = ?
                "#,
            )
            .bind(&request.preview)
            .bind(updated_at_ms.div_euclid(1000))
            .bind(updated_at_ms)
            .bind(&request.thread_id)
            .execute(&mut *tx)
            .await?;
            if thread_update.rows_affected() != 1 {
                tx.rollback().await?;
                return Ok(CloudAgentThreadSummarySyncOutcome::ThreadMetadataMissing);
            }
            tx.commit().await?;
            return Ok(CloudAgentThreadSummarySyncOutcome::Applied);
        }
        let current = sqlx::query(
            r#"
SELECT last_turn_id, preview, projection_revision, metadata_sync_revision
FROM cloud_agent_thread_summaries
WHERE thread_id = ?
            "#,
        )
        .bind(&request.thread_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.rollback().await?;
        let Some(current) = current else {
            return Ok(CloudAgentThreadSummarySyncOutcome::NotFound);
        };
        let current_projection_revision = storage_u64(
            current.try_get("projection_revision")?,
            "projectionRevision",
        )?;
        let current_sync_revision = storage_u64(
            current.try_get("metadata_sync_revision")?,
            "metadataSyncRevision",
        )?;
        if current.try_get::<String, _>("last_turn_id")? == request.last_turn_id
            && current.try_get::<Option<String>, _>("preview")?.as_deref()
                == Some(request.preview.as_str())
            && current_projection_revision == request.expected_projection_revision
            && current_sync_revision >= request.expected_projection_revision
        {
            Ok(CloudAgentThreadSummarySyncOutcome::ExistingSame)
        } else {
            Ok(CloudAgentThreadSummarySyncOutcome::Stale)
        }
    }
}

fn summary_candidate_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<CloudAgentThreadSummarySyncCandidate> {
    let candidate = CloudAgentThreadSummarySyncCandidate {
        thread_id: row.try_get("thread_id")?,
        last_turn_id: row.try_get("last_turn_id")?,
        preview: row.try_get("preview")?,
        projection_revision: storage_u64(
            row.try_get("projection_revision")?,
            "projectionRevision",
        )?,
        metadata_sync_revision: storage_u64(
            row.try_get("metadata_sync_revision")?,
            "metadataSyncRevision",
        )?,
        updated_at: row.try_get("updated_at")?,
    };
    candidate.validate()?;
    Ok(candidate)
}

#[cfg(test)]
#[path = "cloud_agent_thread_summary_tests.rs"]
mod tests;
