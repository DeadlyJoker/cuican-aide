use super::StateRuntime;
use crate::TaskCommitFencingRecord;
use crate::TaskCommitRecord;
use crate::TaskCreateRecordOutcome;
use crate::TaskEventProducerRecord;
use crate::TaskRecord;
use crate::TaskStateCommitOutcome;
use crate::storage_i64;
use sqlx::Row;

impl StateRuntime {
    pub async fn create_task_record(
        &self,
        record: &TaskRecord,
    ) -> anyhow::Result<TaskCreateRecordOutcome> {
        record.validate()?;
        if record.aggregate_version != 0
            || record.stream_offset != 0
            || record.active_attempt_id.is_some()
            || record.lease.is_some()
        {
            anyhow::bail!("task genesis record is not version zero");
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let created = insert_task_genesis(&mut tx, record).await?;
        tx.commit().await?;
        Ok(if created {
            TaskCreateRecordOutcome::Created
        } else {
            TaskCreateRecordOutcome::AlreadyExists
        })
    }

    pub async fn commit_task_record(
        &self,
        commit: &TaskCommitRecord,
    ) -> anyhow::Result<TaskStateCommitOutcome> {
        commit.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;

        if sqlx::query_scalar::<_, i64>(
            r#"
SELECT 1 FROM task_runtime_inbox
WHERE task_id = ? AND receipt_kind = ? AND receipt_id = ?
            "#,
        )
        .bind(&commit.task_id)
        .bind(&commit.inbox.receipt_kind)
        .bind(&commit.inbox.receipt_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
        {
            tx.rollback().await?;
            let result = self
                .get_task_inbox_result(
                    &commit.task_id,
                    &commit.inbox.receipt_kind,
                    &commit.inbox.receipt_id,
                )
                .await?
                .ok_or_else(|| anyhow::anyhow!("task inbox result disappeared"))?;
            return Ok(TaskStateCommitOutcome::DuplicateInbox(result));
        }

        if event_already_exists(&mut tx, commit).await? {
            tx.rollback().await?;
            return Ok(TaskStateCommitOutcome::DuplicateEvent);
        }

        let current = sqlx::query(
            r#"
SELECT aggregate_version, stream_offset, active_attempt_id, worker_run_id,
       lease_epoch, fencing_token_hash, lease_expires_at
FROM task_runtime_tasks
WHERE task_id = ?
            "#,
        )
        .bind(&commit.task_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(current) = current else {
            tx.rollback().await?;
            return Ok(TaskStateCommitOutcome::NotFound);
        };
        let current_version: i64 = current.try_get("aggregate_version")?;
        let current_offset: i64 = current.try_get("stream_offset")?;
        let expected_version = storage_i64(commit.expected_version, "expectedVersion")?;
        let expected_offset = storage_i64(commit.event.stream_offset - 1, "expectedOffset")?;
        if current_version != expected_version || current_offset != expected_offset {
            tx.rollback().await?;
            return Ok(TaskStateCommitOutcome::Conflict);
        }
        if !fencing_matches(&current, commit)? {
            tx.rollback().await?;
            return Ok(TaskStateCommitOutcome::Fenced);
        }

        update_task_snapshot(&mut tx, commit).await?;
        if let Some(attempt) = &commit.attempt {
            upsert_attempt(&mut tx, attempt).await?;
        }
        insert_event(&mut tx, commit).await?;
        insert_inbox(&mut tx, commit).await?;
        insert_outbox(&mut tx, commit).await?;
        tx.commit().await?;

        let record = self
            .get_task_record(&commit.task_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("committed task record disappeared"))?;
        Ok(TaskStateCommitOutcome::Committed(record))
    }
}

pub(super) async fn insert_task_genesis(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &TaskRecord,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        r#"
INSERT INTO task_runtime_tasks (
    task_id, authority, strategy, status, contract_json, snapshot_json,
    aggregate_version, stream_offset, active_attempt_id, worker_run_id,
    lease_epoch, fencing_token_hash, lease_expires_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
ON CONFLICT(task_id) DO NOTHING
        "#,
    )
    .bind(&record.task_id)
    .bind(&record.authority)
    .bind(&record.strategy)
    .bind(&record.status)
    .bind(&record.contract_json)
    .bind(&record.snapshot_json)
    .bind(record.created_at)
    .bind(record.updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(super) async fn apply_initial_task_commit(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &TaskCommitRecord,
) -> anyhow::Result<()> {
    if commit.expected_version != 0 || commit.event.stream_offset != 1 {
        anyhow::bail!("initial task commit must accept version zero");
    }
    update_task_snapshot(tx, commit).await?;
    if let Some(attempt) = &commit.attempt {
        upsert_attempt(tx, attempt).await?;
    }
    insert_event(tx, commit).await?;
    insert_inbox(tx, commit).await?;
    insert_outbox(tx, commit).await
}

async fn event_already_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &TaskCommitRecord,
) -> anyhow::Result<bool> {
    if sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM task_runtime_events WHERE task_id = ? AND event_id = ?",
    )
    .bind(&commit.task_id)
    .bind(&commit.event.event_id)
    .fetch_optional(&mut **tx)
    .await?
    .is_some()
    {
        return Ok(true);
    }
    let TaskEventProducerRecord::Worker {
        attempt_id,
        worker_run_id,
        producer_sequence,
        ..
    } = &commit.event.producer
    else {
        return Ok(false);
    };
    Ok(sqlx::query_scalar::<_, i64>(
        r#"
SELECT 1 FROM task_runtime_events
WHERE task_id = ? AND attempt_id = ? AND worker_run_id = ? AND producer_sequence = ?
        "#,
    )
    .bind(&commit.task_id)
    .bind(attempt_id)
    .bind(worker_run_id)
    .bind(storage_i64(*producer_sequence, "producerSequence")?)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

fn fencing_matches(
    row: &sqlx::sqlite::SqliteRow,
    commit: &TaskCommitRecord,
) -> anyhow::Result<bool> {
    let TaskCommitFencingRecord::Worker {
        attempt_id,
        worker_run_id,
        lease_epoch,
        fencing_token_hash,
    } = &commit.fencing
    else {
        return Ok(true);
    };
    Ok(row
        .try_get::<Option<String>, _>("active_attempt_id")?
        .as_deref()
        == Some(attempt_id.as_str())
        && row
            .try_get::<Option<String>, _>("worker_run_id")?
            .as_deref()
            == Some(worker_run_id.as_str())
        && row.try_get::<Option<i64>, _>("lease_epoch")?
            == Some(storage_i64(*lease_epoch, "leaseEpoch")?)
        && row
            .try_get::<Option<String>, _>("fencing_token_hash")?
            .as_deref()
            == Some(fencing_token_hash.as_str())
        && row
            .try_get::<Option<i64>, _>("lease_expires_at")?
            .is_some_and(|expires_at| commit.event.received_at <= expires_at))
}

async fn update_task_snapshot(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &TaskCommitRecord,
) -> anyhow::Result<()> {
    let lease = commit.snapshot.lease.as_ref();
    let result = sqlx::query(
        r#"
UPDATE task_runtime_tasks
SET status = ?, snapshot_json = ?, aggregate_version = ?, stream_offset = ?,
    active_attempt_id = ?, worker_run_id = ?, lease_epoch = ?,
    fencing_token_hash = ?, lease_expires_at = ?, updated_at = ?
WHERE task_id = ? AND aggregate_version = ? AND stream_offset = ?
        "#,
    )
    .bind(&commit.snapshot.status)
    .bind(&commit.snapshot.snapshot_json)
    .bind(storage_i64(
        commit.snapshot.aggregate_version,
        "aggregateVersion",
    )?)
    .bind(storage_i64(commit.snapshot.stream_offset, "streamOffset")?)
    .bind(commit.snapshot.active_attempt_id.as_deref())
    .bind(lease.map(|lease| lease.worker_run_id.as_str()))
    .bind(
        lease
            .map(|lease| storage_i64(lease.lease_epoch, "leaseEpoch"))
            .transpose()?,
    )
    .bind(lease.map(|lease| lease.fencing_token_hash.as_str()))
    .bind(lease.map(|lease| lease.expires_at))
    .bind(commit.snapshot.updated_at)
    .bind(&commit.task_id)
    .bind(storage_i64(commit.expected_version, "expectedVersion")?)
    .bind(storage_i64(
        commit.event.stream_offset - 1,
        "expectedOffset",
    )?)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        anyhow::bail!("task snapshot compare-and-swap failed");
    }
    Ok(())
}

async fn upsert_attempt(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    attempt: &crate::TaskAttemptRecord,
) -> anyhow::Result<()> {
    let lease = attempt.lease.as_ref();
    sqlx::query(
        r#"
INSERT INTO task_runtime_attempts (
    task_id, attempt_id, ordinal, status, idempotency_key, worker_run_id,
    lease_epoch, fencing_token_hash, lease_expires_at, last_producer_sequence,
    attempt_json, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(task_id, attempt_id) DO UPDATE SET
    ordinal = excluded.ordinal,
    status = excluded.status,
    idempotency_key = excluded.idempotency_key,
    worker_run_id = excluded.worker_run_id,
    lease_epoch = excluded.lease_epoch,
    fencing_token_hash = excluded.fencing_token_hash,
    lease_expires_at = excluded.lease_expires_at,
    last_producer_sequence = excluded.last_producer_sequence,
    attempt_json = excluded.attempt_json,
    updated_at = excluded.updated_at
        "#,
    )
    .bind(&attempt.task_id)
    .bind(&attempt.attempt_id)
    .bind(i64::from(attempt.ordinal))
    .bind(&attempt.status)
    .bind(&attempt.idempotency_key)
    .bind(lease.map(|lease| lease.worker_run_id.as_str()))
    .bind(
        lease
            .map(|lease| storage_i64(lease.lease_epoch, "leaseEpoch"))
            .transpose()?,
    )
    .bind(lease.map(|lease| lease.fencing_token_hash.as_str()))
    .bind(lease.map(|lease| lease.expires_at))
    .bind(
        attempt
            .last_producer_sequence
            .map(|sequence| storage_i64(sequence, "producerSequence"))
            .transpose()?,
    )
    .bind(&attempt.attempt_json)
    .bind(attempt.updated_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &TaskCommitRecord,
) -> anyhow::Result<()> {
    let (attempt_id, worker_run_id, sequence, lease_epoch, token_hash) =
        match &commit.event.producer {
            TaskEventProducerRecord::Authority => (None, None, None, None, None),
            TaskEventProducerRecord::Worker {
                attempt_id,
                worker_run_id,
                producer_sequence,
                lease_epoch,
                fencing_token_hash,
            } => (
                Some(attempt_id.as_str()),
                Some(worker_run_id.as_str()),
                Some(storage_i64(*producer_sequence, "producerSequence")?),
                Some(storage_i64(*lease_epoch, "leaseEpoch")?),
                Some(fencing_token_hash.as_str()),
            ),
        };
    sqlx::query(
        r#"
INSERT INTO task_runtime_events (
    task_id, stream_offset, event_id, event_type, event_json, attempt_id,
    worker_run_id, producer_sequence, lease_epoch, fencing_token_hash,
    occurred_at, received_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&commit.task_id)
    .bind(storage_i64(commit.event.stream_offset, "streamOffset")?)
    .bind(&commit.event.event_id)
    .bind(&commit.event.event_type)
    .bind(&commit.event.event_json)
    .bind(attempt_id)
    .bind(worker_run_id)
    .bind(sequence)
    .bind(lease_epoch)
    .bind(token_hash)
    .bind(commit.event.occurred_at)
    .bind(commit.event.received_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_inbox(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &TaskCommitRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO task_runtime_inbox (
    task_id, receipt_kind, receipt_id, result_aggregate_version,
    result_stream_offset, result_snapshot_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&commit.task_id)
    .bind(&commit.inbox.receipt_kind)
    .bind(&commit.inbox.receipt_id)
    .bind(storage_i64(
        commit.inbox.result_aggregate_version,
        "resultAggregateVersion",
    )?)
    .bind(storage_i64(
        commit.inbox.result_stream_offset,
        "resultStreamOffset",
    )?)
    .bind(&commit.inbox.result_snapshot_json)
    .bind(commit.inbox.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_outbox(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    commit: &TaskCommitRecord,
) -> anyhow::Result<()> {
    for record in &commit.outbox {
        sqlx::query(
            r#"
INSERT INTO task_runtime_outbox (
    outbox_id, task_id, aggregate_version, decision_type, payload_json,
    status, delivery_attempts, available_at, created_at, delivered_at
) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL)
            "#,
        )
        .bind(&record.outbox_id)
        .bind(&commit.task_id)
        .bind(storage_i64(
            commit.snapshot.aggregate_version,
            "aggregateVersion",
        )?)
        .bind(&record.decision_type)
        .bind(&record.payload_json)
        .bind(record.available_at)
        .bind(record.created_at)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "task_runtime_tests.rs"]
mod tests;
