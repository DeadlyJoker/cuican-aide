use crate::TaskRecordValidationError;
use crate::TaskRecordValidationErrorKind;
use crate::validate_hash;
use crate::validate_id;
use crate::validate_time;
use crate::validate_type;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCursorAdvanceRecord {
    pub consumer_id: String,
    pub task_id: String,
    pub expected_offset: u64,
    pub next_offset: u64,
    pub updated_at: i64,
}

impl TaskCursorAdvanceRecord {
    pub fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_id(&self.consumer_id, "consumerId")?;
        validate_id(&self.task_id, "taskId")?;
        validate_time(self.updated_at, "updatedAt")?;
        if self.expected_offset.checked_add(1) != Some(self.next_offset) {
            return Err(TaskRecordValidationError::new(
                "nextOffset",
                TaskRecordValidationErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskMigrationJournalRecord {
    pub source_kind: String,
    pub source_id: String,
    pub source_revision: String,
    pub migration_hash: String,
    pub task_id: String,
    pub status: String,
    pub updated_at: i64,
}

impl TaskMigrationJournalRecord {
    pub fn validate(&self) -> Result<(), TaskRecordValidationError> {
        validate_type(&self.source_kind, "sourceKind")?;
        validate_id(&self.source_id, "sourceId")?;
        validate_id(&self.source_revision, "sourceRevision")?;
        validate_hash(&self.migration_hash, "migrationHash")?;
        validate_id(&self.task_id, "taskId")?;
        validate_type(&self.status, "migrationStatus")?;
        validate_time(self.updated_at, "updatedAt")
    }
}
