use sqlx::Row;

use super::StateRuntime;
use super::cloud_agent_turn::additional_outputs;
use super::cloud_agent_turn::turn_from_row;
use super::provider_execution_storage::journal_from_row;
use super::provider_execution_storage::journal_query;
use super::provider_run_event_projection::event_by_sequence;
use crate::CloudAgentProviderEventRef;
use crate::CloudAgentTurnFinalizationRecord;
use crate::CloudAgentTurnFinalizationStatus;
use crate::CloudAgentTurnOrigin;
use crate::CloudAgentTurnProjectionCandidate;
use crate::CloudAgentTurnProjectionOutcome;
use crate::CloudAgentTurnProjectionRequest;
use crate::CloudAgentTurnProjectionStatus;
use crate::CloudAgentTurnRecord;
use crate::CloudAgentTurnStatus;
use crate::ProviderRunEventProjection;
use crate::ProviderRunFailureCode;
use crate::ProviderRunJournalEventRecord;
use crate::ProviderRunJournalRecord;
use crate::storage_i64;
use crate::storage_u64;

const MAX_PROJECTION_CANDIDATES: u32 = 100;

impl StateRuntime {
    /// Reads the durable Cloud Agent Turn that owns one exact Task.
    pub async fn get_cloud_agent_turn_record_by_task_id(
        &self,
        task_id: &str,
    ) -> anyhow::Result<Option<CloudAgentTurnRecord>> {
        if task_id.trim().is_empty() {
            anyhow::bail!("invalid Cloud Agent Task id");
        }
        let mut tx = self.pool.begin().await?;
        let turn_id = sqlx::query_scalar::<_, String>(
            "SELECT turn_id FROM cloud_agent_turns WHERE task_id = ?",
        )
        .bind(task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let turn = match turn_id {
            Some(turn_id) => turn_in_tx(&mut tx, &turn_id).await?,
            None => None,
        };
        tx.commit().await?;
        Ok(turn)
    }

    /// Lists a bounded restart-safe page of Cloud Agent Turns that have durable Provider work.
    pub async fn list_cloud_agent_turn_projection_candidates(
        &self,
        now: i64,
        limit: u32,
    ) -> anyhow::Result<Vec<CloudAgentTurnProjectionCandidate>> {
        if now < 0 || limit == 0 || limit > MAX_PROJECTION_CANDIDATES {
            anyhow::bail!("invalid Cloud Agent Turn projection query");
        }
        sqlx::query(
            r#"
SELECT t.turn_id, t.task_id, t.last_provider_sequence,
       j.attempt_id, j.worker_run_id, j.provider_run_id, j.last_sequence,
       f.provider_event_id AS final_event_id,
       f.provider_event_sequence AS final_event_sequence,
       f.provider_event_payload_digest AS final_payload_digest,
       f.status AS final_status, f.attempts AS final_attempts,
       f.available_at AS final_available_at,
       f.last_error_code AS final_error_code,
       f.created_at AS final_created_at, f.updated_at AS final_updated_at,
       f.completed_at AS final_completed_at
FROM cloud_agent_turns t
JOIN task_runtime_tasks task ON task.task_id = t.task_id
JOIN provider_run_journal j
  ON j.task_id = task.task_id
 AND j.attempt_id = task.active_attempt_id
 AND j.worker_run_id = task.worker_run_id
LEFT JOIN cloud_agent_turn_finalizations f ON f.turn_id = t.turn_id
WHERE t.origin_kind = 'durableTask'
  AND (
      (
          t.status IN ('queued', 'running', 'suspended')
          AND j.last_sequence > t.last_provider_sequence
      )
      OR
      (
          t.status = 'finalizing'
          AND f.status = 'pending'
          AND f.available_at <= ?
      )
  )
ORDER BY t.updated_at ASC, t.turn_id ASC
LIMIT ?
            "#,
        )
        .bind(now)
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(candidate_from_row)
        .collect()
    }

    /// Atomically advances one non-completed Provider event into the durable Turn projection.
    pub async fn apply_cloud_agent_turn_projection(
        &self,
        request: &CloudAgentTurnProjectionRequest,
    ) -> anyhow::Result<CloudAgentTurnProjectionOutcome> {
        validate_request(request)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(current) = turn_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        let Some((journal, event)) = exact_event(&mut tx, &request.event).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        if !turn_matches_event(&current, &journal, &request.event)
            || !projection_matches_request(&event, request)?
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        if current.last_provider_sequence >= event.sequence {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Duplicate);
        }
        if current.last_provider_sequence.checked_add(1) != Some(event.sequence)
            || current.status.is_terminal()
            || current.status == CloudAgentTurnStatus::Finalizing
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let task_status = task_status_in_tx(&mut tx, &request.event.key.task_id).await?;
        if matches!(
            request.status,
            CloudAgentTurnProjectionStatus::Failed | CloudAgentTurnProjectionStatus::Cancelled
        ) && !matches!(task_status.as_deref(), Some("failed" | "cancelled"))
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let next = projected_turn(current, &event, request)?;
        if !update_turn(&mut tx, &next, event.sequence - 1).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        touch_summary(&mut tx, &next).await?;
        tx.commit().await?;
        Ok(CloudAgentTurnProjectionOutcome::Applied)
    }
}

pub(super) async fn task_status_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    task_id: &str,
) -> anyhow::Result<Option<String>> {
    sqlx::query_scalar("SELECT status FROM task_runtime_tasks WHERE task_id = ?")
        .bind(task_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Into::into)
}

fn candidate_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<CloudAgentTurnProjectionCandidate> {
    let turn_id: String = row.try_get("turn_id")?;
    let task_id: String = row.try_get("task_id")?;
    let key = crate::ProviderRunJournalKey {
        task_id: task_id.clone(),
        attempt_id: row.try_get("attempt_id")?,
        worker_run_id: row.try_get("worker_run_id")?,
    };
    let provider_run_id: String = row.try_get("provider_run_id")?;
    let final_status: Option<String> = row.try_get("final_status")?;
    let finalization = final_status
        .map(|status| {
            Ok::<_, anyhow::Error>(CloudAgentTurnFinalizationRecord {
                turn_id: turn_id.clone(),
                task_id: task_id.clone(),
                event: CloudAgentProviderEventRef {
                    key: key.clone(),
                    provider_run_id: provider_run_id.clone(),
                    event_id: row.try_get("final_event_id")?,
                    sequence: storage_u64(
                        row.try_get("final_event_sequence")?,
                        "providerEventSequence",
                    )?,
                    payload_digest: row.try_get("final_payload_digest")?,
                },
                status: CloudAgentTurnFinalizationStatus::from_str(&status)?,
                attempts: u32::try_from(row.try_get::<i64, _>("final_attempts")?)?,
                available_at: row.try_get("final_available_at")?,
                last_error_code: row.try_get("final_error_code")?,
                created_at: row.try_get("final_created_at")?,
                updated_at: row.try_get("final_updated_at")?,
                completed_at: row.try_get("final_completed_at")?,
            })
        })
        .transpose()?;
    Ok(CloudAgentTurnProjectionCandidate {
        turn_id,
        task_id,
        key,
        provider_run_id,
        last_provider_sequence: storage_u64(
            row.try_get("last_provider_sequence")?,
            "lastProviderSequence",
        )?,
        journal_last_sequence: storage_u64(row.try_get("last_sequence")?, "providerLastSequence")?,
        finalization,
    })
}

pub(super) async fn turn_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    turn_id: &str,
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
WHERE turn_id = ?
        "#,
    )
    .bind(turn_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let additional = additional_outputs(&mut **tx, turn_id).await?;
    let turn = turn_from_row(row, additional)?;
    turn.validate()?;
    Ok(Some(turn))
}

pub(super) async fn exact_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    expected: &CloudAgentProviderEventRef,
) -> anyhow::Result<Option<(ProviderRunJournalRecord, ProviderRunJournalEventRecord)>> {
    let journal = journal_query()
        .bind(&expected.key.task_id)
        .bind(&expected.key.attempt_id)
        .bind(&expected.key.worker_run_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(journal_from_row)
        .transpose()?;
    let Some(journal) = journal else {
        return Ok(None);
    };
    if journal.provider_run_id != expected.provider_run_id {
        return Ok(None);
    }
    let event = event_by_sequence(tx, &journal, expected.sequence).await?;
    Ok(event.map(|event| (journal, event)))
}

pub(super) fn event_ref_matches(
    event: &ProviderRunJournalEventRecord,
    expected: &CloudAgentProviderEventRef,
) -> bool {
    event.event_id == expected.event_id
        && event.sequence == expected.sequence
        && event.projection.payload_digest == expected.payload_digest
}

pub(super) fn turn_matches_event(
    turn: &CloudAgentTurnRecord,
    journal: &ProviderRunJournalRecord,
    expected: &CloudAgentProviderEventRef,
) -> bool {
    matches!(
        &turn.origin,
        CloudAgentTurnOrigin::DurableTask { task_id } if task_id == &expected.key.task_id
    ) && journal.key == expected.key
        && journal.provider_run_id == expected.provider_run_id
}

async fn update_turn(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    next: &CloudAgentTurnRecord,
    expected_sequence: u64,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        r#"
UPDATE cloud_agent_turns
SET status = ?, last_provider_sequence = ?, error_code = ?, trace_id = ?,
    revision = ?, record_hash = ?, updated_at = ?, completed_at = ?
WHERE turn_id = ? AND revision = ? AND last_provider_sequence = ?
        "#,
    )
    .bind(next.status.as_str())
    .bind(storage_i64(
        next.last_provider_sequence,
        "lastProviderSequence",
    )?)
    .bind(next.error_code.as_deref())
    .bind(next.trace_id.as_deref())
    .bind(storage_i64(next.revision, "turnRevision")?)
    .bind(&next.record_hash)
    .bind(next.updated_at)
    .bind(next.completed_at)
    .bind(&next.turn_id)
    .bind(storage_i64(next.revision - 1, "expectedTurnRevision")?)
    .bind(storage_i64(expected_sequence, "expectedProviderSequence")?)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn touch_summary(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    turn: &CloudAgentTurnRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
UPDATE cloud_agent_thread_summaries
SET last_turn_id = ?, projection_revision = projection_revision + 1, updated_at = ?
WHERE thread_id = ?
        "#,
    )
    .bind(&turn.turn_id)
    .bind(turn.updated_at)
    .bind(&turn.thread_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn projected_turn(
    mut turn: CloudAgentTurnRecord,
    event: &ProviderRunJournalEventRecord,
    request: &CloudAgentTurnProjectionRequest,
) -> anyhow::Result<CloudAgentTurnRecord> {
    turn.status = match request.status {
        CloudAgentTurnProjectionStatus::Running => CloudAgentTurnStatus::Running,
        CloudAgentTurnProjectionStatus::Suspended => CloudAgentTurnStatus::Suspended,
        CloudAgentTurnProjectionStatus::Failed => CloudAgentTurnStatus::Failed,
        CloudAgentTurnProjectionStatus::Cancelled => CloudAgentTurnStatus::Cancelled,
    };
    turn.last_provider_sequence = event.sequence;
    turn.error_code = request.error_code.clone();
    if request.trace_id.is_some() {
        turn.trace_id.clone_from(&request.trace_id);
    }
    turn.revision = turn
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Cloud Agent Turn revision exhausted"))?;
    turn.updated_at = turn
        .updated_at
        .max(event.created_at)
        .max(request.projected_at);
    turn.completed_at = turn.status.is_terminal().then_some(turn.updated_at);
    turn.record_hash = turn.canonical_hash();
    turn.validate()?;
    Ok(turn)
}

fn projection_matches_request(
    event: &ProviderRunJournalEventRecord,
    request: &CloudAgentTurnProjectionRequest,
) -> anyhow::Result<bool> {
    if !event_ref_matches(event, &request.event) {
        return Ok(false);
    }
    let projection = event
        .projection
        .decode(&event.event_type, &request.event.key.task_id)?;
    Ok(match (&projection, request.status) {
        (
            ProviderRunEventProjection::RunStarted { .. }
            | ProviderRunEventProjection::Progress { .. },
            CloudAgentTurnProjectionStatus::Running,
        ) => request.error_code.is_none() && request.trace_id.is_none(),
        (
            ProviderRunEventProjection::Failed {
                code: ProviderRunFailureCode::UnknownOutcome,
                ..
            },
            CloudAgentTurnProjectionStatus::Running,
        ) => request.error_code.is_none() && request.trace_id.is_none(),
        (
            ProviderRunEventProjection::ApprovalRequired { .. }
            | ProviderRunEventProjection::ToolResultRequired { .. }
            | ProviderRunEventProjection::ToolResultAccepted { .. },
            CloudAgentTurnProjectionStatus::Suspended,
        ) => request.error_code.is_none() && request.trace_id.is_none(),
        (
            ProviderRunEventProjection::Failed {
                code,
                provider_run_id,
                trace_id,
                ..
            },
            CloudAgentTurnProjectionStatus::Failed,
        ) if *code != ProviderRunFailureCode::UnknownOutcome => {
            provider_run_id == &request.event.provider_run_id
                && request.error_code.as_deref() == Some(failure_code(*code))
                && request.trace_id.as_deref() == Some(trace_id.as_str())
        }
        (
            ProviderRunEventProjection::Cancelled { .. },
            CloudAgentTurnProjectionStatus::Cancelled,
        ) => request.error_code.is_none() && request.trace_id.is_none(),
        _ => false,
    })
}

fn validate_request(request: &CloudAgentTurnProjectionRequest) -> anyhow::Result<()> {
    if request.turn_id.trim().is_empty()
        || request.projected_at < 0
        || request.event.sequence == 0
        || request
            .error_code
            .as_ref()
            .is_some_and(|code| code.len() > 128)
    {
        anyhow::bail!("invalid Cloud Agent Turn projection request");
    }
    Ok(())
}

pub const fn failure_code(code: ProviderRunFailureCode) -> &'static str {
    match code {
        ProviderRunFailureCode::InvalidRequest => "invalidRequest",
        ProviderRunFailureCode::Unauthorized => "unauthorized",
        ProviderRunFailureCode::Forbidden => "forbidden",
        ProviderRunFailureCode::NotFound => "notFound",
        ProviderRunFailureCode::Conflict => "conflict",
        ProviderRunFailureCode::CapabilityUnsupported => "capabilityUnsupported",
        ProviderRunFailureCode::ProviderUnavailable => "providerUnavailable",
        ProviderRunFailureCode::Timeout => "timeout",
        ProviderRunFailureCode::UnknownOutcome => "unknownOutcome",
        ProviderRunFailureCode::Internal => "internal",
    }
}
