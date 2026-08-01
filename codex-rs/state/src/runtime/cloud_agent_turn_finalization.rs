use super::StateRuntime;
use super::cloud_agent_turn_finalization_storage::FinishFinalizationRequest;
use super::cloud_agent_turn_finalization_storage::completed_event_matches;
use super::cloud_agent_turn_finalization_storage::completed_turn;
use super::cloud_agent_turn_finalization_storage::finalization_by_id;
use super::cloud_agent_turn_finalization_storage::finalization_in_tx;
use super::cloud_agent_turn_finalization_storage::finalization_matches;
use super::cloud_agent_turn_finalization_storage::finalizing_turn;
use super::cloud_agent_turn_finalization_storage::finish_finalization;
use super::cloud_agent_turn_finalization_storage::insert_finalization;
use super::cloud_agent_turn_finalization_storage::pending_finalization_matches;
use super::cloud_agent_turn_finalization_storage::replace_additional_outputs;
use super::cloud_agent_turn_finalization_storage::unavailable_turn;
use super::cloud_agent_turn_finalization_storage::update_turn_completed;
use super::cloud_agent_turn_finalization_storage::update_turn_finalizing;
use super::cloud_agent_turn_finalization_storage::update_turn_unavailable;
use super::cloud_agent_turn_finalization_storage::valid_error_code;
use super::cloud_agent_turn_finalization_storage::validate_event_request;
use super::cloud_agent_turn_finalization_storage::validate_outputs;
use super::cloud_agent_turn_projection::exact_event;
use super::cloud_agent_turn_projection::task_status_in_tx;
use super::cloud_agent_turn_projection::touch_summary;
use super::cloud_agent_turn_projection::turn_in_tx;
use super::cloud_agent_turn_projection::turn_matches_event;
use crate::CloudAgentTurnBeginFinalizationRequest;
use crate::CloudAgentTurnCompleteRequest;
use crate::CloudAgentTurnFinalizationRecord;
use crate::CloudAgentTurnFinalizationRetryRequest;
use crate::CloudAgentTurnFinalizationStatus;
use crate::CloudAgentTurnProjectionOutcome;
use crate::CloudAgentTurnResultUnavailableRequest;
use crate::CloudAgentTurnStatus;
use crate::MAX_CLOUD_AGENT_FINALIZATION_ATTEMPTS;

impl StateRuntime {
    /// Atomically advances a completed Provider event into durable finalizing state.
    pub async fn begin_cloud_agent_turn_finalization(
        &self,
        request: &CloudAgentTurnBeginFinalizationRequest,
    ) -> anyhow::Result<CloudAgentTurnProjectionOutcome> {
        validate_event_request(&request.turn_id, &request.event, request.available_at)?;
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
            || !completed_event_matches(&event, &request.event)?
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        if current.last_provider_sequence >= event.sequence {
            let duplicate = finalization_in_tx(&mut tx, &request.turn_id)
                .await?
                .is_some_and(|record| finalization_matches(&record, &request.event));
            tx.rollback().await?;
            return Ok(if duplicate {
                CloudAgentTurnProjectionOutcome::Duplicate
            } else {
                CloudAgentTurnProjectionOutcome::Conflict
            });
        }
        if current.last_provider_sequence.checked_add(1) != Some(event.sequence)
            || current.status.is_terminal()
            || current.status == CloudAgentTurnStatus::Finalizing
            || finalization_in_tx(&mut tx, &request.turn_id)
                .await?
                .is_some()
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        if task_status_in_tx(&mut tx, &request.event.key.task_id)
            .await?
            .as_deref()
            != Some("completed")
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let next = finalizing_turn(current, &event, request.available_at)?;
        insert_finalization(&mut tx, request, &event).await?;
        if !update_turn_finalizing(&mut tx, &next, event.sequence - 1).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        touch_summary(&mut tx, &next).await?;
        tx.commit().await?;
        Ok(CloudAgentTurnProjectionOutcome::Applied)
    }

    pub async fn get_cloud_agent_turn_finalization_record(
        &self,
        turn_id: &str,
    ) -> anyhow::Result<Option<CloudAgentTurnFinalizationRecord>> {
        if turn_id.trim().is_empty() {
            anyhow::bail!("invalid Cloud Agent Turn id");
        }
        finalization_by_id(self.pool.as_ref(), turn_id).await
    }

    /// Durably schedules the next bounded Artifact finalization attempt.
    pub async fn reschedule_cloud_agent_turn_finalization(
        &self,
        request: &CloudAgentTurnFinalizationRetryRequest,
    ) -> anyhow::Result<CloudAgentTurnProjectionOutcome> {
        validate_event_request(&request.turn_id, &request.event, request.updated_at)?;
        if request.expected_attempts >= MAX_CLOUD_AGENT_FINALIZATION_ATTEMPTS
            || request.available_at < request.updated_at
            || !valid_error_code(&request.error_code)
        {
            anyhow::bail!("invalid Cloud Agent Turn finalization retry");
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(finalization) = finalization_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        let Some(turn) = turn_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        if !pending_finalization_matches(
            &finalization,
            &turn,
            request.expected_attempts,
            &request.event,
        ) {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        if task_status_in_tx(&mut tx, &request.event.key.task_id)
            .await?
            .as_deref()
            != Some("completed")
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let next_attempts = request.expected_attempts + 1;
        let result = sqlx::query(
            r#"
UPDATE cloud_agent_turn_finalizations
SET attempts = ?, available_at = ?, last_error_code = ?, updated_at = ?
WHERE turn_id = ? AND status = 'pending' AND attempts = ?
            "#,
        )
        .bind(i64::from(next_attempts))
        .bind(request.available_at)
        .bind(&request.error_code)
        .bind(request.updated_at)
        .bind(&request.turn_id)
        .bind(i64::from(request.expected_attempts))
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(CloudAgentTurnProjectionOutcome::Applied)
    }

    /// Atomically publishes verified local output refs and completes the Turn.
    pub async fn complete_cloud_agent_turn_finalization(
        &self,
        request: &CloudAgentTurnCompleteRequest,
    ) -> anyhow::Result<CloudAgentTurnProjectionOutcome> {
        validate_event_request(&request.turn_id, &request.event, request.completed_at)?;
        validate_outputs(request)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(finalization) = finalization_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        let Some(current) = turn_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        if finalization.status == CloudAgentTurnFinalizationStatus::Completed
            && current.status == CloudAgentTurnStatus::Completed
            && current.primary_output_artifact.as_ref() == Some(&request.primary_output_artifact)
            && current.additional_output_artifacts == request.additional_output_artifacts
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Duplicate);
        }
        if !pending_finalization_matches(
            &finalization,
            &current,
            request.expected_attempts,
            &request.event,
        ) {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        if task_status_in_tx(&mut tx, &request.event.key.task_id)
            .await?
            .as_deref()
            != Some("completed")
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let next = completed_turn(current, request)?;
        if !update_turn_completed(&mut tx, &next, request.expected_attempts).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        replace_additional_outputs(&mut tx, &next).await?;
        finish_finalization(
            &mut tx,
            FinishFinalizationRequest {
                turn_id: &request.turn_id,
                expected_attempts: request.expected_attempts,
                status: CloudAgentTurnFinalizationStatus::Completed,
                final_attempts: request.expected_attempts,
                error_code: None,
                completed_at: request.completed_at,
            },
        )
        .await?;
        touch_summary(&mut tx, &next).await?;
        tx.commit().await?;
        Ok(CloudAgentTurnProjectionOutcome::Applied)
    }

    /// Atomically terminates a permanently unavailable Provider result without empty completion.
    pub async fn mark_cloud_agent_turn_result_unavailable(
        &self,
        request: &CloudAgentTurnResultUnavailableRequest,
    ) -> anyhow::Result<CloudAgentTurnProjectionOutcome> {
        validate_event_request(&request.turn_id, &request.event, request.completed_at)?;
        if request.final_attempts < request.expected_attempts
            || request.final_attempts > MAX_CLOUD_AGENT_FINALIZATION_ATTEMPTS
            || !valid_error_code(&request.error_code)
        {
            anyhow::bail!("invalid Cloud Agent result unavailable request");
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(finalization) = finalization_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        let Some(current) = turn_in_tx(&mut tx, &request.turn_id).await? else {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::NotFound);
        };
        if finalization.status == CloudAgentTurnFinalizationStatus::ResultUnavailable
            && current.status == CloudAgentTurnStatus::ResultUnavailable
            && current.error_code.as_deref() == Some(request.error_code.as_str())
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Duplicate);
        }
        if !pending_finalization_matches(
            &finalization,
            &current,
            request.expected_attempts,
            &request.event,
        ) {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        if task_status_in_tx(&mut tx, &request.event.key.task_id)
            .await?
            .as_deref()
            != Some("completed")
        {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        let next = unavailable_turn(current, request)?;
        if !update_turn_unavailable(&mut tx, &next, request.expected_attempts).await? {
            tx.rollback().await?;
            return Ok(CloudAgentTurnProjectionOutcome::Conflict);
        }
        finish_finalization(
            &mut tx,
            FinishFinalizationRequest {
                turn_id: &request.turn_id,
                expected_attempts: request.expected_attempts,
                status: CloudAgentTurnFinalizationStatus::ResultUnavailable,
                final_attempts: request.final_attempts,
                error_code: Some(&request.error_code),
                completed_at: request.completed_at,
            },
        )
        .await?;
        touch_summary(&mut tx, &next).await?;
        tx.commit().await?;
        Ok(CloudAgentTurnProjectionOutcome::Applied)
    }
}
