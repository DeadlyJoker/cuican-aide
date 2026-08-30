use super::StateRuntime;
use crate::MAX_TASK_RECORD_PAGE_SIZE;
use crate::TaskEventPage;
use crate::TaskEventProducerRecord;
use crate::TaskEventRecord;
use crate::TaskInboxResultRecord;
use crate::TaskLeaseRecord;
use crate::TaskOutboxStatus;
use crate::TaskRecord;
use crate::TaskStoredOutboxRecord;
use crate::storage_u64;
use sqlx::Row;

impl StateRuntime {
    pub async fn get_task_record(&self, task_id: &str) -> anyhow::Result<Option<TaskRecord>> {
        let row = sqlx::query(
            r#"
SELECT task_id, authority, strategy, status, contract_json, snapshot_json,
       aggregate_version, stream_offset, active_attempt_id, worker_run_id,
       lease_epoch, fencing_token_hash, lease_expires_at, created_at, updated_at
FROM task_runtime_tasks
WHERE task_id = ?
            "#,
        )
        .bind(task_id)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(task_record_from_row).transpose()
    }

    pub async fn get_task_inbox_result(
        &self,
        task_id: &str,
        receipt_kind: &str,
        receipt_id: &str,
    ) -> anyhow::Result<Option<TaskInboxResultRecord>> {
        let row = sqlx::query(
            r#"
SELECT task_id, receipt_kind, receipt_id, result_aggregate_version,
       result_stream_offset, result_snapshot_json, created_at
FROM task_runtime_inbox
WHERE task_id = ? AND receipt_kind = ? AND receipt_id = ?
            "#,
        )
        .bind(task_id)
        .bind(receipt_kind)
        .bind(receipt_id)
        .fetch_optional(self.pool.as_ref())
        .await?;
        row.map(inbox_result_from_row).transpose()
    }

    pub async fn list_task_event_records(
        &self,
        task_id: &str,
        after_offset: u64,
        limit: u32,
    ) -> anyhow::Result<TaskEventPage> {
        validate_page_limit(limit)?;
        let fetch_limit = i64::from(limit) + 1;
        let mut rows = sqlx::query(
            r#"
SELECT task_id, stream_offset, event_id, event_type, event_json, attempt_id,
       worker_run_id, producer_sequence, lease_epoch, fencing_token_hash,
       occurred_at, received_at
FROM task_runtime_events
WHERE task_id = ? AND stream_offset > ?
ORDER BY stream_offset ASC
LIMIT ?
            "#,
        )
        .bind(task_id)
        .bind(crate::storage_i64(after_offset, "afterOffset")?)
        .bind(fetch_limit)
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(task_event_from_row)
        .collect::<anyhow::Result<Vec<_>>>()?;
        let next_offset = if rows.len() > limit as usize {
            rows.pop();
            rows.last().map(|record| record.stream_offset)
        } else {
            None
        };
        Ok(TaskEventPage {
            events: rows,
            next_offset,
        })
    }

    pub async fn list_task_outbox_records(
        &self,
        task_id: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<TaskStoredOutboxRecord>> {
        validate_page_limit(limit)?;
        sqlx::query(
            r#"
SELECT outbox_id, task_id, aggregate_version, decision_type, payload_json,
       status, delivery_attempts, available_at, created_at, delivered_at
FROM task_runtime_outbox
WHERE task_id = ?
ORDER BY created_at ASC, outbox_id ASC
LIMIT ?
            "#,
        )
        .bind(task_id)
        .bind(i64::from(limit))
        .fetch_all(self.pool.as_ref())
        .await?
        .into_iter()
        .map(outbox_record_from_row)
        .collect()
    }
}

pub(super) fn task_record_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<TaskRecord> {
    let worker_run_id = row.try_get::<Option<String>, _>("worker_run_id")?;
    let lease_epoch = row.try_get::<Option<i64>, _>("lease_epoch")?;
    let fencing_token_hash = row.try_get::<Option<String>, _>("fencing_token_hash")?;
    let lease_expires_at = row.try_get::<Option<i64>, _>("lease_expires_at")?;
    let lease = lease_from_columns(
        worker_run_id,
        lease_epoch,
        fencing_token_hash,
        lease_expires_at,
    )?;
    let record = TaskRecord {
        task_id: row.try_get("task_id")?,
        authority: row.try_get("authority")?,
        strategy: row.try_get("strategy")?,
        status: row.try_get("status")?,
        contract_json: row.try_get("contract_json")?,
        snapshot_json: row.try_get("snapshot_json")?,
        aggregate_version: storage_u64(row.try_get("aggregate_version")?, "aggregateVersion")?,
        stream_offset: storage_u64(row.try_get("stream_offset")?, "streamOffset")?,
        active_attempt_id: row.try_get("active_attempt_id")?,
        lease,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    };
    record.validate()?;
    Ok(record)
}

fn inbox_result_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<TaskInboxResultRecord> {
    Ok(TaskInboxResultRecord {
        task_id: row.try_get("task_id")?,
        receipt_kind: row.try_get("receipt_kind")?,
        receipt_id: row.try_get("receipt_id")?,
        result_aggregate_version: storage_u64(
            row.try_get("result_aggregate_version")?,
            "resultAggregateVersion",
        )?,
        result_stream_offset: storage_u64(
            row.try_get("result_stream_offset")?,
            "resultStreamOffset",
        )?,
        result_snapshot_json: row.try_get("result_snapshot_json")?,
        created_at: row.try_get("created_at")?,
    })
}

fn task_event_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<TaskEventRecord> {
    let attempt_id = row.try_get::<Option<String>, _>("attempt_id")?;
    let worker_run_id = row.try_get::<Option<String>, _>("worker_run_id")?;
    let producer_sequence = row.try_get::<Option<i64>, _>("producer_sequence")?;
    let lease_epoch = row.try_get::<Option<i64>, _>("lease_epoch")?;
    let fencing_token_hash = row.try_get::<Option<String>, _>("fencing_token_hash")?;
    let producer = match (
        attempt_id,
        worker_run_id,
        producer_sequence,
        lease_epoch,
        fencing_token_hash,
    ) {
        (None, None, None, None, None) => TaskEventProducerRecord::Authority,
        (Some(attempt_id), Some(worker_run_id), Some(sequence), Some(epoch), Some(hash)) => {
            TaskEventProducerRecord::Worker {
                attempt_id,
                worker_run_id,
                producer_sequence: storage_u64(sequence, "producerSequence")?,
                lease_epoch: storage_u64(epoch, "leaseEpoch")?,
                fencing_token_hash: hash,
            }
        }
        _ => anyhow::bail!("inconsistent task event producer columns"),
    };
    let record = TaskEventRecord {
        task_id: row.try_get("task_id")?,
        stream_offset: storage_u64(row.try_get("stream_offset")?, "streamOffset")?,
        event_id: row.try_get("event_id")?,
        event_type: row.try_get("event_type")?,
        event_json: row.try_get("event_json")?,
        producer,
        occurred_at: row.try_get("occurred_at")?,
        received_at: row.try_get("received_at")?,
    };
    record.validate()?;
    Ok(record)
}

pub(super) fn outbox_record_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<TaskStoredOutboxRecord> {
    Ok(TaskStoredOutboxRecord {
        outbox_id: row.try_get("outbox_id")?,
        task_id: row.try_get("task_id")?,
        aggregate_version: storage_u64(row.try_get("aggregate_version")?, "aggregateVersion")?,
        decision_type: row.try_get("decision_type")?,
        payload_json: row.try_get("payload_json")?,
        status: TaskOutboxStatus::from_str(&row.try_get::<String, _>("status")?)?,
        delivery_attempts: storage_u64(row.try_get("delivery_attempts")?, "deliveryAttempts")?,
        available_at: row.try_get("available_at")?,
        created_at: row.try_get("created_at")?,
        delivered_at: row.try_get("delivered_at")?,
    })
}

pub(super) fn lease_from_columns(
    worker_run_id: Option<String>,
    lease_epoch: Option<i64>,
    fencing_token_hash: Option<String>,
    lease_expires_at: Option<i64>,
) -> anyhow::Result<Option<TaskLeaseRecord>> {
    match (
        worker_run_id,
        lease_epoch,
        fencing_token_hash,
        lease_expires_at,
    ) {
        (None, None, None, None) => Ok(None),
        (Some(worker_run_id), Some(epoch), Some(hash), Some(expires_at)) => {
            Ok(Some(TaskLeaseRecord {
                worker_run_id,
                lease_epoch: storage_u64(epoch, "leaseEpoch")?,
                fencing_token_hash: hash,
                expires_at,
            }))
        }
        _ => anyhow::bail!("inconsistent task lease columns"),
    }
}

fn validate_page_limit(limit: u32) -> anyhow::Result<()> {
    if limit == 0 || limit > MAX_TASK_RECORD_PAGE_SIZE {
        anyhow::bail!("invalid task record page limit");
    }
    Ok(())
}
