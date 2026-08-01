use std::collections::BTreeSet;

use sqlx::Row;

use super::cloud_agent_turn_projection::event_ref_matches;
use crate::CloudAgentProviderEventRef;
use crate::CloudAgentTurnBeginFinalizationRequest;
use crate::CloudAgentTurnCompleteRequest;
use crate::CloudAgentTurnFinalizationRecord;
use crate::CloudAgentTurnFinalizationStatus;
use crate::CloudAgentTurnRecord;
use crate::CloudAgentTurnResultUnavailableRequest;
use crate::CloudAgentTurnStatus;
use crate::ProviderRunEventProjection;
use crate::ProviderRunJournalEventRecord;
use crate::storage_i64;
use crate::storage_u64;

pub(super) struct FinishFinalizationRequest<'a> {
    pub(super) turn_id: &'a str,
    pub(super) expected_attempts: u32,
    pub(super) status: CloudAgentTurnFinalizationStatus,
    pub(super) final_attempts: u32,
    pub(super) error_code: Option<&'a str>,
    pub(super) completed_at: i64,
}

pub(super) async fn insert_finalization(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request: &CloudAgentTurnBeginFinalizationRequest,
    event: &ProviderRunJournalEventRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO cloud_agent_turn_finalizations (
    turn_id, task_id, attempt_id, worker_run_id, provider_run_id,
    provider_event_id, provider_event_sequence, provider_event_payload_digest,
    status, attempts, available_at, last_error_code,
    created_at, updated_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL)
        "#,
    )
    .bind(&request.turn_id)
    .bind(&request.event.key.task_id)
    .bind(&request.event.key.attempt_id)
    .bind(&request.event.key.worker_run_id)
    .bind(&request.event.provider_run_id)
    .bind(&request.event.event_id)
    .bind(storage_i64(event.sequence, "providerEventSequence")?)
    .bind(&request.event.payload_digest)
    .bind(request.available_at)
    .bind(request.available_at)
    .bind(request.available_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) async fn finalization_by_id(
    pool: &sqlx::SqlitePool,
    turn_id: &str,
) -> anyhow::Result<Option<CloudAgentTurnFinalizationRecord>> {
    sqlx::query(finalization_query())
        .bind(turn_id)
        .fetch_optional(pool)
        .await?
        .map(finalization_from_row)
        .transpose()
}

pub(super) async fn finalization_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    turn_id: &str,
) -> anyhow::Result<Option<CloudAgentTurnFinalizationRecord>> {
    sqlx::query(finalization_query())
        .bind(turn_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(finalization_from_row)
        .transpose()
}

fn finalization_query() -> &'static str {
    r#"
SELECT turn_id, task_id, attempt_id, worker_run_id, provider_run_id,
       provider_event_id, provider_event_sequence, provider_event_payload_digest,
       status, attempts, available_at, last_error_code,
       created_at, updated_at, completed_at
FROM cloud_agent_turn_finalizations
WHERE turn_id = ?
    "#
}

fn finalization_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<CloudAgentTurnFinalizationRecord> {
    let task_id: String = row.try_get("task_id")?;
    Ok(CloudAgentTurnFinalizationRecord {
        turn_id: row.try_get("turn_id")?,
        task_id: task_id.clone(),
        event: CloudAgentProviderEventRef {
            key: crate::ProviderRunJournalKey {
                task_id,
                attempt_id: row.try_get("attempt_id")?,
                worker_run_id: row.try_get("worker_run_id")?,
            },
            provider_run_id: row.try_get("provider_run_id")?,
            event_id: row.try_get("provider_event_id")?,
            sequence: storage_u64(
                row.try_get("provider_event_sequence")?,
                "providerEventSequence",
            )?,
            payload_digest: row.try_get("provider_event_payload_digest")?,
        },
        status: CloudAgentTurnFinalizationStatus::from_str(&row.try_get::<String, _>("status")?)?,
        attempts: u32::try_from(row.try_get::<i64, _>("attempts")?)?,
        available_at: row.try_get("available_at")?,
        last_error_code: row.try_get("last_error_code")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        completed_at: row.try_get("completed_at")?,
    })
}

pub(super) fn finalization_matches(
    record: &CloudAgentTurnFinalizationRecord,
    event: &CloudAgentProviderEventRef,
) -> bool {
    record.event == *event
}

pub(super) fn pending_finalization_matches(
    finalization: &CloudAgentTurnFinalizationRecord,
    turn: &CloudAgentTurnRecord,
    expected_attempts: u32,
    event: &CloudAgentProviderEventRef,
) -> bool {
    finalization.status == CloudAgentTurnFinalizationStatus::Pending
        && finalization.attempts == expected_attempts
        && finalization_matches(finalization, event)
        && turn.status == CloudAgentTurnStatus::Finalizing
        && turn.last_provider_sequence == event.sequence
}

pub(super) fn completed_event_matches(
    event: &ProviderRunJournalEventRecord,
    expected: &CloudAgentProviderEventRef,
) -> anyhow::Result<bool> {
    if !event_ref_matches(event, expected) || event.event_type != "completed" {
        return Ok(false);
    }
    Ok(matches!(
        event
            .projection
            .decode(&event.event_type, &expected.key.task_id)?,
        ProviderRunEventProjection::Completed { .. }
    ))
}

pub(super) fn finalizing_turn(
    mut turn: CloudAgentTurnRecord,
    event: &ProviderRunJournalEventRecord,
    projected_at: i64,
) -> anyhow::Result<CloudAgentTurnRecord> {
    turn.status = CloudAgentTurnStatus::Finalizing;
    turn.last_provider_sequence = event.sequence;
    turn.error_code = None;
    turn.revision = turn
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Cloud Agent Turn revision exhausted"))?;
    turn.updated_at = turn.updated_at.max(event.created_at).max(projected_at);
    turn.completed_at = None;
    turn.record_hash = turn.canonical_hash();
    turn.validate()?;
    Ok(turn)
}

pub(super) fn completed_turn(
    mut turn: CloudAgentTurnRecord,
    request: &CloudAgentTurnCompleteRequest,
) -> anyhow::Result<CloudAgentTurnRecord> {
    turn.status = CloudAgentTurnStatus::Completed;
    turn.primary_output_artifact = Some(request.primary_output_artifact.clone());
    turn.additional_output_artifacts = request.additional_output_artifacts.clone();
    turn.error_code = None;
    turn.revision = turn
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Cloud Agent Turn revision exhausted"))?;
    turn.updated_at = turn.updated_at.max(request.completed_at);
    turn.completed_at = Some(turn.updated_at);
    turn.record_hash = turn.canonical_hash();
    turn.validate()?;
    Ok(turn)
}

pub(super) fn unavailable_turn(
    mut turn: CloudAgentTurnRecord,
    request: &CloudAgentTurnResultUnavailableRequest,
) -> anyhow::Result<CloudAgentTurnRecord> {
    turn.status = CloudAgentTurnStatus::ResultUnavailable;
    turn.error_code = Some(request.error_code.clone());
    turn.revision = turn
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Cloud Agent Turn revision exhausted"))?;
    turn.updated_at = turn.updated_at.max(request.completed_at);
    turn.completed_at = Some(turn.updated_at);
    turn.record_hash = turn.canonical_hash();
    turn.validate()?;
    Ok(turn)
}

pub(super) async fn update_turn_finalizing(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    next: &CloudAgentTurnRecord,
    expected_sequence: u64,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        r#"
UPDATE cloud_agent_turns
SET status = 'finalizing', last_provider_sequence = ?, revision = ?,
    record_hash = ?, updated_at = ?
WHERE turn_id = ? AND revision = ? AND last_provider_sequence = ?
        "#,
    )
    .bind(storage_i64(
        next.last_provider_sequence,
        "lastProviderSequence",
    )?)
    .bind(storage_i64(next.revision, "turnRevision")?)
    .bind(&next.record_hash)
    .bind(next.updated_at)
    .bind(&next.turn_id)
    .bind(storage_i64(next.revision - 1, "expectedTurnRevision")?)
    .bind(storage_i64(expected_sequence, "expectedProviderSequence")?)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn update_turn_completed(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    next: &CloudAgentTurnRecord,
    expected_attempts: u32,
) -> anyhow::Result<bool> {
    let primary = next
        .primary_output_artifact
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("completed Turn has no primary output"))?;
    let result = sqlx::query(
        r#"
UPDATE cloud_agent_turns
SET status = 'completed', primary_output_artifact_id = ?,
    primary_output_artifact_revision = ?, error_code = NULL,
    revision = ?, record_hash = ?, updated_at = ?, completed_at = ?
WHERE turn_id = ? AND status = 'finalizing' AND revision = ?
  AND EXISTS(
      SELECT 1 FROM cloud_agent_turn_finalizations f
      WHERE f.turn_id = cloud_agent_turns.turn_id
        AND f.status = 'pending' AND f.attempts = ?
  )
        "#,
    )
    .bind(&primary.artifact_id)
    .bind(storage_i64(primary.revision, "primaryOutputRevision")?)
    .bind(storage_i64(next.revision, "turnRevision")?)
    .bind(&next.record_hash)
    .bind(next.updated_at)
    .bind(next.completed_at)
    .bind(&next.turn_id)
    .bind(storage_i64(next.revision - 1, "expectedTurnRevision")?)
    .bind(i64::from(expected_attempts))
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn replace_additional_outputs(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    next: &CloudAgentTurnRecord,
) -> anyhow::Result<()> {
    for (ordinal, artifact) in next.additional_output_artifacts.iter().enumerate() {
        sqlx::query(
            r#"
INSERT INTO cloud_agent_turn_output_artifacts (
    turn_id, ordinal, artifact_id, artifact_revision
) VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(&next.turn_id)
        .bind(i64::try_from(ordinal)?)
        .bind(&artifact.artifact_id)
        .bind(storage_i64(artifact.revision, "additionalOutputRevision")?)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(super) async fn update_turn_unavailable(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    next: &CloudAgentTurnRecord,
    expected_attempts: u32,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        r#"
UPDATE cloud_agent_turns
SET status = 'resultUnavailable', error_code = ?, revision = ?,
    record_hash = ?, updated_at = ?, completed_at = ?
WHERE turn_id = ? AND status = 'finalizing' AND revision = ?
  AND EXISTS(
      SELECT 1 FROM cloud_agent_turn_finalizations f
      WHERE f.turn_id = cloud_agent_turns.turn_id
        AND f.status = 'pending' AND f.attempts = ?
  )
        "#,
    )
    .bind(next.error_code.as_deref())
    .bind(storage_i64(next.revision, "turnRevision")?)
    .bind(&next.record_hash)
    .bind(next.updated_at)
    .bind(next.completed_at)
    .bind(&next.turn_id)
    .bind(storage_i64(next.revision - 1, "expectedTurnRevision")?)
    .bind(i64::from(expected_attempts))
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn finish_finalization(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request: FinishFinalizationRequest<'_>,
) -> anyhow::Result<()> {
    let result = sqlx::query(
        r#"
UPDATE cloud_agent_turn_finalizations
SET status = ?, attempts = ?, last_error_code = ?, updated_at = ?, completed_at = ?
WHERE turn_id = ? AND status = 'pending' AND attempts = ?
        "#,
    )
    .bind(request.status.as_str())
    .bind(i64::from(request.final_attempts))
    .bind(request.error_code)
    .bind(request.completed_at)
    .bind(request.completed_at)
    .bind(request.turn_id)
    .bind(i64::from(request.expected_attempts))
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        anyhow::bail!("Cloud Agent Turn finalization changed during completion");
    }
    Ok(())
}

pub(super) fn validate_outputs(request: &CloudAgentTurnCompleteRequest) -> anyhow::Result<()> {
    if request.additional_output_artifacts.len() > crate::MAX_CLOUD_AGENT_TURN_OUTPUT_ARTIFACTS {
        anyhow::bail!("too many Cloud Agent Turn output Artifacts");
    }
    let mut seen = BTreeSet::new();
    seen.insert(request.primary_output_artifact.clone());
    if request
        .additional_output_artifacts
        .iter()
        .any(|artifact| !seen.insert(artifact.clone()))
    {
        anyhow::bail!("duplicate Cloud Agent Turn output Artifact");
    }
    Ok(())
}

pub(super) fn validate_event_request(
    turn_id: &str,
    event: &CloudAgentProviderEventRef,
    timestamp: i64,
) -> anyhow::Result<()> {
    if turn_id.trim().is_empty()
        || event.sequence == 0
        || event.provider_run_id.trim().is_empty()
        || event.event_id.trim().is_empty()
        || !event.payload_digest.starts_with("sha256:")
        || timestamp < 0
    {
        anyhow::bail!("invalid Cloud Agent finalization event");
    }
    Ok(())
}

pub(super) fn valid_error_code(error_code: &str) -> bool {
    !error_code.is_empty() && error_code.len() <= 128 && !error_code.chars().any(char::is_control)
}
