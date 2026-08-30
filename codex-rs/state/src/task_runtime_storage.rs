use crate::TaskEventRecord;
use crate::TaskRecord;

pub const MAX_TASK_RECORD_PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskCreateRecordOutcome {
    Created,
    AlreadyExists,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskInboxResultRecord {
    pub task_id: String,
    pub receipt_kind: String,
    pub receipt_id: String,
    pub result_aggregate_version: u64,
    pub result_stream_offset: u64,
    pub result_snapshot_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutboxStatus {
    Pending,
    Delivered,
}

impl TaskOutboxStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Delivered => "delivered",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "delivered" => Ok(Self::Delivered),
            _ => anyhow::bail!("invalid task outbox status"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStoredOutboxRecord {
    pub outbox_id: String,
    pub task_id: String,
    pub aggregate_version: u64,
    pub decision_type: String,
    pub payload_json: String,
    pub status: TaskOutboxStatus,
    pub delivery_attempts: u64,
    pub available_at: i64,
    pub created_at: i64,
    pub delivered_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStateCommitOutcome {
    Committed(TaskRecord),
    DuplicateInbox(TaskInboxResultRecord),
    DuplicateEvent,
    Conflict,
    Fenced,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskCursorAdvanceOutcome {
    Advanced,
    Conflict,
    Gap,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutboxDeliveryOutcome {
    Delivered,
    AlreadyDelivered,
    Conflict,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutboxDeferOutcome {
    Deferred,
    AlreadyDelivered,
    Conflict,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskMigrationJournalCreateOutcome {
    Created,
    ExistingSame,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEventPage {
    pub events: Vec<TaskEventRecord>,
    pub next_offset: Option<u64>,
}

pub(crate) fn storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value).map_err(|_| anyhow::anyhow!("task storage field {field} is out of range"))
}

pub(crate) fn storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value).map_err(|_| anyhow::anyhow!("task storage field {field} is out of range"))
}
