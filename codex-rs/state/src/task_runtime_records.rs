use serde_json::Value;
use std::fmt;

pub const MAX_TASK_RECORD_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_TASK_RECORD_ID_BYTES: usize = 512;
pub const MAX_TASK_RECORD_TYPE_BYTES: usize = 128;
pub const MAX_TASK_OUTBOX_PER_COMMIT: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskRecordValidationErrorKind {
    Empty,
    TooLong,
    InvalidJson,
    InvalidHash,
    OutOfRange,
    TooManyItems,
    InconsistentFields,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRecordValidationError {
    field: &'static str,
    kind: TaskRecordValidationErrorKind,
}

impl TaskRecordValidationError {
    pub(crate) fn new(field: &'static str, kind: TaskRecordValidationErrorKind) -> Self {
        Self { field, kind }
    }

    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> TaskRecordValidationErrorKind {
        self.kind
    }
}

impl fmt::Display for TaskRecordValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid task record field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for TaskRecordValidationError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskLeaseRecord {
    pub worker_run_id: String,
    pub lease_epoch: u64,
    pub fencing_token_hash: String,
    pub expires_at: i64,
}

impl TaskLeaseRecord {
    fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.worker_run_id, "workerRunId")?;
        if self.lease_epoch == 0 || self.expires_at < 0 {
            return Err(TaskRecordValidationError::new(
                "lease",
                TaskRecordValidationErrorKind::OutOfRange,
            ));
        }
        validate_hash(&self.fencing_token_hash, "fencingTokenHash")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRecord {
    pub task_id: String,
    pub authority: String,
    pub strategy: String,
    pub status: String,
    pub contract_json: String,
    pub snapshot_json: String,
    pub aggregate_version: u64,
    pub stream_offset: u64,
    pub active_attempt_id: Option<String>,
    pub lease: Option<TaskLeaseRecord>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl TaskRecord {
    pub fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.task_id, "taskId")?;
        validate_type(&self.authority, "authority")?;
        validate_type(&self.strategy, "strategy")?;
        validate_type(&self.status, "status")?;
        validate_json(&self.contract_json, "contractJson")?;
        validate_json(&self.snapshot_json, "snapshotJson")?;
        validate_optional_id(self.active_attempt_id.as_deref(), "activeAttemptId")?;
        validate_time(self.created_at, "createdAt")?;
        validate_time(self.updated_at, "updatedAt")?;
        if let Some(lease) = &self.lease {
            if self.active_attempt_id.is_none() {
                return Err(TaskRecordValidationError::new(
                    "activeAttemptId",
                    TaskRecordValidationErrorKind::InconsistentFields,
                ));
            }
            lease.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSnapshotRecord {
    pub task_id: String,
    pub status: String,
    pub snapshot_json: String,
    pub aggregate_version: u64,
    pub stream_offset: u64,
    pub active_attempt_id: Option<String>,
    pub lease: Option<TaskLeaseRecord>,
    pub updated_at: i64,
}

impl TaskSnapshotRecord {
    fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.task_id, "taskId")?;
        validate_type(&self.status, "status")?;
        validate_json(&self.snapshot_json, "snapshotJson")?;
        validate_optional_id(self.active_attempt_id.as_deref(), "activeAttemptId")?;
        validate_time(self.updated_at, "updatedAt")?;
        if let Some(lease) = &self.lease {
            if self.active_attempt_id.is_none() {
                return Err(TaskRecordValidationError::new(
                    "activeAttemptId",
                    TaskRecordValidationErrorKind::InconsistentFields,
                ));
            }
            lease.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskAttemptRecord {
    pub task_id: String,
    pub attempt_id: String,
    pub ordinal: u16,
    pub status: String,
    pub idempotency_key: String,
    pub lease: Option<TaskLeaseRecord>,
    pub last_producer_sequence: Option<u64>,
    pub attempt_json: String,
    pub updated_at: i64,
}

impl TaskAttemptRecord {
    fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.task_id, "taskId")?;
        validate_id(&self.attempt_id, "attemptId")?;
        validate_id(&self.idempotency_key, "idempotencyKey")?;
        validate_type(&self.status, "attemptStatus")?;
        validate_json(&self.attempt_json, "attemptJson")?;
        validate_time(self.updated_at, "updatedAt")?;
        if self.ordinal == 0 || self.last_producer_sequence == Some(0) {
            return Err(TaskRecordValidationError::new(
                "attempt",
                TaskRecordValidationErrorKind::OutOfRange,
            ));
        }
        if let Some(lease) = &self.lease {
            lease.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEventProducerRecord {
    Authority,
    Worker {
        attempt_id: String,
        worker_run_id: String,
        producer_sequence: u64,
        lease_epoch: u64,
        fencing_token_hash: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEventRecord {
    pub task_id: String,
    pub stream_offset: u64,
    pub event_id: String,
    pub event_type: String,
    pub event_json: String,
    pub producer: TaskEventProducerRecord,
    pub occurred_at: i64,
    pub received_at: i64,
}

impl TaskEventRecord {
    pub fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.task_id, "taskId")?;
        validate_id(&self.event_id, "eventId")?;
        validate_type(&self.event_type, "eventType")?;
        validate_json(&self.event_json, "eventJson")?;
        validate_time(self.occurred_at, "occurredAt")?;
        validate_time(self.received_at, "receivedAt")?;
        if self.stream_offset == 0 {
            return Err(TaskRecordValidationError::new(
                "streamOffset",
                TaskRecordValidationErrorKind::OutOfRange,
            ));
        }
        if let TaskEventProducerRecord::Worker {
            attempt_id,
            worker_run_id,
            producer_sequence,
            lease_epoch,
            fencing_token_hash,
        } = &self.producer
        {
            validate_id(attempt_id, "attemptId")?;
            validate_id(worker_run_id, "workerRunId")?;
            validate_hash(fencing_token_hash, "fencingTokenHash")?;
            if *producer_sequence == 0 || *lease_epoch == 0 {
                return Err(TaskRecordValidationError::new(
                    "producer",
                    TaskRecordValidationErrorKind::OutOfRange,
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskInboxRecord {
    pub receipt_kind: String,
    pub receipt_id: String,
    pub result_aggregate_version: u64,
    pub result_stream_offset: u64,
    pub result_snapshot_json: String,
    pub created_at: i64,
}

impl TaskInboxRecord {
    fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_type(&self.receipt_kind, "receiptKind")?;
        validate_id(&self.receipt_id, "receiptId")?;
        validate_json(&self.result_snapshot_json, "resultSnapshotJson")?;
        validate_time(self.created_at, "createdAt")?;
        if self.result_aggregate_version == 0 || self.result_stream_offset == 0 {
            return Err(TaskRecordValidationError::new(
                "inboxResult",
                TaskRecordValidationErrorKind::OutOfRange,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskOutboxRecord {
    pub outbox_id: String,
    pub decision_type: String,
    pub payload_json: String,
    pub available_at: i64,
    pub created_at: i64,
}

impl TaskOutboxRecord {
    fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.outbox_id, "outboxId")?;
        validate_type(&self.decision_type, "decisionType")?;
        validate_json(&self.payload_json, "outboxPayloadJson")?;
        validate_time(self.available_at, "availableAt")?;
        validate_time(self.created_at, "createdAt")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskCommitFencingRecord {
    Authority,
    Worker {
        attempt_id: String,
        worker_run_id: String,
        lease_epoch: u64,
        fencing_token_hash: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCommitRecord {
    pub task_id: String,
    pub expected_version: u64,
    pub snapshot: TaskSnapshotRecord,
    pub attempt: Option<TaskAttemptRecord>,
    pub event: TaskEventRecord,
    pub inbox: TaskInboxRecord,
    pub outbox: Vec<TaskOutboxRecord>,
    pub fencing: TaskCommitFencingRecord,
}

impl TaskCommitRecord {
    pub fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.task_id, "taskId")?;
        self.snapshot.validate()?;
        self.event.validate()?;
        self.inbox.validate()?;
        if let Some(attempt) = &self.attempt {
            attempt.validate()?;
            if attempt.task_id != self.task_id {
                return Err(inconsistent("attemptTaskId"));
            }
        }
        if self.outbox.len() > MAX_TASK_OUTBOX_PER_COMMIT {
            return Err(TaskRecordValidationError::new(
                "outbox",
                TaskRecordValidationErrorKind::TooManyItems,
            ));
        }
        for record in &self.outbox {
            record.validate()?;
        }
        let expected_version = self
            .expected_version
            .checked_add(1)
            .ok_or_else(|| inconsistent("aggregateVersion"))?;
        if self.snapshot.task_id != self.task_id
            || self.event.task_id != self.task_id
            || self.snapshot.aggregate_version != expected_version
            || self.snapshot.stream_offset != self.event.stream_offset
            || self.inbox.result_aggregate_version != self.snapshot.aggregate_version
            || self.inbox.result_stream_offset != self.snapshot.stream_offset
            || self.inbox.result_snapshot_json != self.snapshot.snapshot_json
        {
            return Err(inconsistent("commit"));
        }
        match (&self.fencing, &self.event.producer) {
            (TaskCommitFencingRecord::Authority, TaskEventProducerRecord::Authority) => Ok(()),
            (
                TaskCommitFencingRecord::Worker {
                    attempt_id,
                    worker_run_id,
                    lease_epoch,
                    fencing_token_hash,
                },
                TaskEventProducerRecord::Worker {
                    attempt_id: event_attempt,
                    worker_run_id: event_worker,
                    lease_epoch: event_epoch,
                    fencing_token_hash: event_hash,
                    ..
                },
            ) if attempt_id == event_attempt
                && worker_run_id == event_worker
                && lease_epoch == event_epoch
                && fencing_token_hash == event_hash =>
            {
                Ok(())
            }
            _ => Err(inconsistent("fencing")),
        }
    }
}

pub(crate) fn validate_id(
    value: &str,
    field: &'static str,
) -> Result<(), TaskRecordValidationError> {
    validate_text(value, field, MAX_TASK_RECORD_ID_BYTES)
}

fn validate_optional_id(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), TaskRecordValidationError> {
    value.map_or(Ok(()), |value| validate_id(value, field))
}

pub(crate) fn validate_type(
    value: &str,
    field: &'static str,
) -> Result<(), TaskRecordValidationError> {
    validate_text(value, field, MAX_TASK_RECORD_TYPE_BYTES)
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), TaskRecordValidationError> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(TaskRecordValidationError::new(
            field,
            TaskRecordValidationErrorKind::Empty,
        ));
    }
    if value.len() > max_bytes {
        return Err(TaskRecordValidationError::new(
            field,
            TaskRecordValidationErrorKind::TooLong,
        ));
    }
    Ok(())
}

fn validate_json(value: &str, field: &'static str) -> Result<(), TaskRecordValidationError> {
    if value.len() > MAX_TASK_RECORD_JSON_BYTES {
        return Err(TaskRecordValidationError::new(
            field,
            TaskRecordValidationErrorKind::TooLong,
        ));
    }
    serde_json::from_str::<Value>(value)
        .map(|_| ())
        .map_err(|_| {
            TaskRecordValidationError::new(field, TaskRecordValidationErrorKind::InvalidJson)
        })
}

pub(crate) fn validate_hash(
    value: &str,
    field: &'static str,
) -> Result<(), TaskRecordValidationError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(TaskRecordValidationError::new(
            field,
            TaskRecordValidationErrorKind::InvalidHash,
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(TaskRecordValidationError::new(
            field,
            TaskRecordValidationErrorKind::InvalidHash,
        ));
    }
    Ok(())
}

pub(crate) fn validate_time(
    value: i64,
    field: &'static str,
) -> Result<(), TaskRecordValidationError> {
    if value < 0 {
        return Err(TaskRecordValidationError::new(
            field,
            TaskRecordValidationErrorKind::OutOfRange,
        ));
    }
    Ok(())
}

fn inconsistent(field: &'static str) -> TaskRecordValidationError {
    TaskRecordValidationError::new(field, TaskRecordValidationErrorKind::InconsistentFields)
}
