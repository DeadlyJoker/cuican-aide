use sqlx::Row;

use super::StateRuntime;
use super::cloud_agent_turn_projection::touch_summary;
use super::cloud_agent_turn_projection::turn_in_tx;
use crate::CloudAgentTurnCancellationCandidate;
use crate::CloudAgentTurnCancellationProjectionRequest;
use crate::CloudAgentTurnOrigin;
use crate::CloudAgentTurnProjectionOutcome;
use crate::CloudAgentTurnRecord;
use crate::CloudAgentTurnStatus;
use crate::storage_i64;

const MAX_CANCELLATION_CANDIDATES: u32 = 100;

impl StateRuntime {
    /// Lists a bounded page of active Cloud Turns whose authoritative Task was cancelled.
    pub async fn list_cloud_agent_turn_cancellation_candidates(
        &self,
        limit: u32,
    ) -> anyhow::Result<Vec<CloudAgentTurnCancellationCandidate>> {
        if limit == 0 || limit > MAX_CANCELLATION_CANDIDATES {
            anyhow::bail!("invalid Cloud Agent cancellation projection query");
        }
        sqlx::query(
            r#"
SELECT t.turn_id, t.task_id
FROM cloud_agent_turns t
JOIN task_runtime_tasks task ON task.task_id = t.task_id
WHERE t.origin_kind = 'durableTask'
  AND t.status IN ('queued', 'running', 'suspended')
  AND task.authority = 'localAppServer'
  AND task.strategy = 'single'
  AND task.status = 'cancelled'
ORDER BY t.updated_at ASC, t.turn_id ASC
LIMIT ?
            "#,
        )
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(|row| {
            Ok(CloudAgentTurnCancellationCandidate {
                turn_id: row.try_get("turn_id")?,
                task_id: row.try_get("task_id")?,
            })
        })
        .collect()
    }

    /// Atomically derives a terminal cancelled Turn from the immutable Task terminal fact.
    pub async fn project_cloud_agent_turn_cancellation(
        &self,
        request: &CloudAgentTurnCancellationProjectionRequest,
    ) -> anyhow::Result<CloudAgentTurnProjectionOutcome> {
        validate_request(request)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(current) = turn_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        if !matches!(
            &current.origin,
            CloudAgentTurnOrigin::DurableTask { task_id } if task_id == &request.task_id
        ) {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        if current.status == CloudAgentTurnStatus::Cancelled {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Duplicate);
        }
        if current.status.is_terminal() || current.status == CloudAgentTurnStatus::Finalizing {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let task = sqlx::query(
            r#"
SELECT authority, strategy, status
FROM task_runtime_tasks
WHERE task_id = ?
            "#,
        )
        .bind(&request.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(task) = task else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        if task.try_get::<String, _>("authority")? != "localAppServer"
            || task.try_get::<String, _>("strategy")? != "single"
            || task.try_get::<String, _>("status")? != "cancelled"
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let next = cancelled_turn(current, request.projected_at)?;
        if !update_cancelled_turn(&mut tx, &next).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        touch_summary(&mut tx, &next).await?;
        tx.commit().await?;
        Ok(CloudAgentTurnProjectionOutcome::Applied)
    }
}

fn validate_request(request: &CloudAgentTurnCancellationProjectionRequest) -> anyhow::Result<()> {
    if request.turn_id.trim().is_empty()
        || request.task_id.trim().is_empty()
        || request.projected_at < 0
    {
        anyhow::bail!("invalid Cloud Agent cancellation projection request");
    }
    Ok(())
}

fn cancelled_turn(
    mut turn: CloudAgentTurnRecord,
    projected_at: i64,
) -> anyhow::Result<CloudAgentTurnRecord> {
    turn.status = CloudAgentTurnStatus::Cancelled;
    turn.error_code = None;
    turn.revision = turn
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Cloud Agent Turn revision exhausted"))?;
    turn.updated_at = turn.updated_at.max(projected_at);
    turn.completed_at = Some(turn.updated_at);
    turn.record_hash = turn.canonical_hash();
    turn.validate()?;
    Ok(turn)
}

async fn update_cancelled_turn(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    next: &CloudAgentTurnRecord,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        r#"
UPDATE cloud_agent_turns
SET status = 'cancelled', error_code = NULL, revision = ?, record_hash = ?,
    updated_at = ?, completed_at = ?
WHERE turn_id = ? AND task_id = ? AND revision = ?
  AND status IN ('queued', 'running', 'suspended')
        "#,
    )
    .bind(storage_i64(next.revision, "turnRevision")?)
    .bind(&next.record_hash)
    .bind(next.updated_at)
    .bind(next.completed_at)
    .bind(&next.turn_id)
    .bind(next.origin.task_id())
    .bind(storage_i64(next.revision - 1, "expectedTurnRevision")?)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}
