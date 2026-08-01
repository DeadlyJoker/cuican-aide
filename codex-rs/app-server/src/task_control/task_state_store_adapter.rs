use crewon_state::StateRuntime;
use crewon_state::TaskAttemptRecord;
use crewon_state::TaskCommitFencingRecord;
use crewon_state::TaskCommitRecord;
use crewon_state::TaskCreateRecordOutcome;
use crewon_state::TaskEventProducerRecord;
use crewon_state::TaskEventRecord;
use crewon_state::TaskInboxRecord;
use crewon_state::TaskInboxResultRecord;
use crewon_state::TaskLeaseRecord;
use crewon_state::TaskOutboxRecord as StateTaskOutboxRecord;
use crewon_state::TaskRecord;
use crewon_state::TaskRecordValidationError;
use crewon_state::TaskSnapshotRecord;
use crewon_state::TaskStateCommitOutcome;
use crewon_task_runtime::Attempt;
use crewon_task_runtime::InboxReceipt;
use crewon_task_runtime::SchedulerDecision;
use crewon_task_runtime::StrategyKind;
use crewon_task_runtime::TaskAggregate;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskContract;
use crewon_task_runtime::TaskContractSnapshot;
use crewon_task_runtime::TaskEventKind;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStatus;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::TaskStoreError;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::sync::Arc;

/// SQLite-backed Task Store adapter owned by app-server composition.
///
/// W1-06 intentionally leaves this adapter unregistered. Task Control composes
/// it in a later wave after authority routing and recovery ownership land.
pub(crate) struct TaskStateStoreAdapter {
    state: Arc<StateRuntime>,
}

impl TaskStateStoreAdapter {
    pub(crate) fn new(state: Arc<StateRuntime>) -> Self {
        Self { state }
    }
}

impl TaskStore for TaskStateStoreAdapter {
    async fn create(&self, aggregate: TaskAggregate) -> Result<(), TaskStoreError> {
        let record = task_record(&aggregate)?;
        match self
            .state
            .create_task_record(&record)
            .await
            .map_err(map_state_error)?
        {
            TaskCreateRecordOutcome::Created => Ok(()),
            TaskCreateRecordOutcome::AlreadyExists => Err(TaskStoreError::AlreadyExists),
        }
    }

    async fn read(&self, task_id: TaskId) -> Result<Option<TaskAggregate>, TaskStoreError> {
        self.state
            .get_task_record(task_id.as_str())
            .await
            .map_err(map_state_error)?
            .map(|record| restore_record(&record))
            .transpose()
    }

    async fn read_receipt(
        &self,
        task_id: TaskId,
        receipt: InboxReceipt,
    ) -> Result<Option<TaskAggregate>, TaskStoreError> {
        let (receipt_kind, receipt_id) = receipt_projection(&receipt);
        self.state
            .get_task_inbox_result(task_id.as_str(), receipt_kind, receipt_id)
            .await
            .map_err(map_state_error)?
            .map(|record| restore_inbox_record(&task_id, &receipt, &record))
            .transpose()
    }

    async fn commit(&self, commit: TaskCommit) -> Result<TaskCommitOutcome, TaskStoreError> {
        let record = task_commit_record(&commit)?;
        match self
            .state
            .commit_task_record(&record)
            .await
            .map_err(map_state_error)?
        {
            TaskStateCommitOutcome::Committed(record) => {
                restore_record(&record).map(TaskCommitOutcome::Committed)
            }
            TaskStateCommitOutcome::DuplicateInbox(record) => {
                restore_inbox_record(commit.task_id(), commit.receipt(), &record)
                    .map(TaskCommitOutcome::Duplicate)
            }
            TaskStateCommitOutcome::DuplicateEvent => Err(TaskStoreError::InvalidCommit),
            TaskStateCommitOutcome::Conflict => Err(TaskStoreError::Conflict),
            TaskStateCommitOutcome::Fenced => Err(TaskStoreError::Fenced),
            TaskStateCommitOutcome::NotFound => Err(TaskStoreError::NotFound),
        }
    }
}

pub(crate) fn task_record(aggregate: &TaskAggregate) -> Result<TaskRecord, TaskStoreError> {
    let snapshot = aggregate.to_snapshot();
    let contract = aggregate.contract().to_snapshot();
    let created_at = aggregate.contract().created_at().get();
    Ok(TaskRecord {
        task_id: aggregate.contract().task_id().as_str().to_string(),
        authority: authority_type(aggregate.contract().authority()).to_string(),
        strategy: strategy_type(aggregate.contract().strategy()).to_string(),
        status: status_type(aggregate.status()).to_string(),
        contract_json: serialize_json(&contract)?,
        snapshot_json: serialize_json(&snapshot)?,
        aggregate_version: aggregate.aggregate_version().get(),
        stream_offset: aggregate.task_stream_offset().get(),
        active_attempt_id: aggregate
            .active_attempt()
            .map(|attempt| attempt.attempt_id().as_str().to_string()),
        lease: aggregate
            .active_attempt()
            .map(lease_record)
            .transpose()?
            .flatten(),
        created_at,
        updated_at: created_at,
    })
}

pub(crate) fn task_commit_record(commit: &TaskCommit) -> Result<TaskCommitRecord, TaskStoreError> {
    ensure_storage_range(commit.expected_version().get())?;
    let aggregate = commit.resulting_aggregate();
    ensure_storage_range(aggregate.aggregate_version().get())?;
    ensure_storage_range(aggregate.task_stream_offset().get())?;
    let snapshot_json = serialize_json(&aggregate.to_snapshot())?;
    let active_attempt = aggregate.active_attempt();
    let updated_at = commit.event().received_at().get();
    let producer = event_producer(commit.event().kind())?;
    let fencing = commit_fencing(commit.event().kind())?;
    let (receipt_kind, receipt_id) = receipt_projection(commit.receipt());

    Ok(TaskCommitRecord {
        task_id: commit.task_id().as_str().to_string(),
        expected_version: commit.expected_version().get(),
        snapshot: TaskSnapshotRecord {
            task_id: commit.task_id().as_str().to_string(),
            status: status_type(aggregate.status()).to_string(),
            snapshot_json: snapshot_json.clone(),
            aggregate_version: aggregate.aggregate_version().get(),
            stream_offset: aggregate.task_stream_offset().get(),
            active_attempt_id: active_attempt
                .map(|attempt| attempt.attempt_id().as_str().to_string()),
            lease: active_attempt.map(lease_record).transpose()?.flatten(),
            updated_at,
        },
        attempt: active_attempt
            .map(|attempt| attempt_record(commit.task_id(), attempt, updated_at))
            .transpose()?,
        event: TaskEventRecord {
            task_id: commit.task_id().as_str().to_string(),
            stream_offset: commit.event().stream_offset().get(),
            event_id: commit.event().event_id().as_str().to_string(),
            event_type: event_type(commit.event().kind()).to_string(),
            event_json: serialize_json(commit.event().kind())?,
            producer,
            occurred_at: commit.event().occurred_at().get(),
            received_at: updated_at,
        },
        inbox: TaskInboxRecord {
            receipt_kind: receipt_kind.to_string(),
            receipt_id: receipt_id.to_string(),
            result_aggregate_version: aggregate.aggregate_version().get(),
            result_stream_offset: aggregate.task_stream_offset().get(),
            result_snapshot_json: snapshot_json,
            created_at: updated_at,
        },
        outbox: commit
            .outbox()
            .iter()
            .map(|record| {
                Ok(StateTaskOutboxRecord {
                    outbox_id: record.outbox_id().as_str().to_string(),
                    decision_type: decision_type(record.decision()).to_string(),
                    payload_json: serialize_json(record.decision())?,
                    available_at: updated_at,
                    created_at: updated_at,
                })
            })
            .collect::<Result<Vec<_>, TaskStoreError>>()?,
        fencing,
    })
}

fn attempt_record(
    task_id: &TaskId,
    attempt: &Attempt,
    updated_at: i64,
) -> Result<TaskAttemptRecord, TaskStoreError> {
    if let Some(sequence) = attempt.last_producer_sequence() {
        ensure_storage_range(sequence.get())?;
    }
    Ok(TaskAttemptRecord {
        task_id: task_id.as_str().to_string(),
        attempt_id: attempt.attempt_id().as_str().to_string(),
        ordinal: attempt.ordinal().get(),
        status: attempt_status_type(attempt.status()).to_string(),
        idempotency_key: attempt.idempotency_key().as_str().to_string(),
        lease: lease_record(attempt)?,
        last_producer_sequence: attempt
            .last_producer_sequence()
            .map(crewon_task_runtime::ProducerSequence::get),
        attempt_json: serialize_json(&crewon_task_runtime::AttemptSnapshot::from(attempt))?,
        updated_at,
    })
}

fn lease_record(attempt: &Attempt) -> Result<Option<TaskLeaseRecord>, TaskStoreError> {
    match (attempt.worker_run_id(), attempt.lease()) {
        (None, None) => Ok(None),
        (Some(worker_run_id), Some(lease)) => {
            ensure_storage_range(lease.epoch().get())?;
            Ok(Some(TaskLeaseRecord {
                worker_run_id: worker_run_id.as_str().to_string(),
                lease_epoch: lease.epoch().get(),
                fencing_token_hash: lease.fencing_token_hash().as_str().to_string(),
                expires_at: lease.expires_at().get(),
            }))
        }
        (None, Some(_)) | (Some(_), None) => Err(TaskStoreError::InvalidCommit),
    }
}

fn event_producer(kind: &TaskEventKind) -> Result<TaskEventProducerRecord, TaskStoreError> {
    match kind {
        TaskEventKind::WorkerReported { evidence, .. } => {
            ensure_storage_range(evidence.producer_sequence.get())?;
            ensure_storage_range(evidence.lease_epoch.get())?;
            Ok(TaskEventProducerRecord::Worker {
                attempt_id: evidence.attempt_id.as_str().to_string(),
                worker_run_id: evidence.worker_run_id.as_str().to_string(),
                producer_sequence: evidence.producer_sequence.get(),
                lease_epoch: evidence.lease_epoch.get(),
                fencing_token_hash: evidence.fencing_token_hash.as_str().to_string(),
            })
        }
        TaskEventKind::TaskAccepted { .. }
        | TaskEventKind::AttemptClaimed { .. }
        | TaskEventKind::AttemptReclaimed { .. }
        | TaskEventKind::RetryScheduled { .. }
        | TaskEventKind::TaskCancelled
        | TaskEventKind::TaskFailed => Ok(TaskEventProducerRecord::Authority),
    }
}

fn commit_fencing(kind: &TaskEventKind) -> Result<TaskCommitFencingRecord, TaskStoreError> {
    match event_producer(kind)? {
        TaskEventProducerRecord::Authority => Ok(TaskCommitFencingRecord::Authority),
        TaskEventProducerRecord::Worker {
            attempt_id,
            worker_run_id,
            lease_epoch,
            fencing_token_hash,
            ..
        } => Ok(TaskCommitFencingRecord::Worker {
            attempt_id,
            worker_run_id,
            lease_epoch,
            fencing_token_hash,
        }),
    }
}

fn restore_record(record: &TaskRecord) -> Result<TaskAggregate, TaskStoreError> {
    let aggregate = TaskAggregate::restore(deserialize_json(&record.snapshot_json)?)
        .map_err(|_| TaskStoreError::InvalidCommit)?;
    let contract = TaskContract::restore(deserialize_json::<TaskContractSnapshot>(
        &record.contract_json,
    )?)
    .map_err(|_| TaskStoreError::InvalidCommit)?;
    let active_attempt = aggregate.active_attempt();
    if &contract != aggregate.contract()
        || record.task_id != aggregate.contract().task_id().as_str()
        || record.authority != authority_type(aggregate.contract().authority())
        || record.strategy != strategy_type(aggregate.contract().strategy())
        || record.status != status_type(aggregate.status())
        || record.aggregate_version != aggregate.aggregate_version().get()
        || record.stream_offset != aggregate.task_stream_offset().get()
        || record.active_attempt_id.as_deref()
            != active_attempt.map(|attempt| attempt.attempt_id().as_str())
        || record.lease != active_attempt.map(lease_record).transpose()?.flatten()
        || record.created_at != aggregate.contract().created_at().get()
    {
        return Err(TaskStoreError::InvalidCommit);
    }
    Ok(aggregate)
}

fn restore_inbox_record(
    task_id: &TaskId,
    receipt: &InboxReceipt,
    record: &TaskInboxResultRecord,
) -> Result<TaskAggregate, TaskStoreError> {
    let aggregate = TaskAggregate::restore(deserialize_json(&record.result_snapshot_json)?)
        .map_err(|_| TaskStoreError::InvalidCommit)?;
    let (receipt_kind, receipt_id) = receipt_projection(receipt);
    if record.task_id != task_id.as_str()
        || record.receipt_kind != receipt_kind
        || record.receipt_id != receipt_id
        || record.result_aggregate_version != aggregate.aggregate_version().get()
        || record.result_stream_offset != aggregate.task_stream_offset().get()
        || aggregate.contract().task_id() != task_id
    {
        return Err(TaskStoreError::InvalidCommit);
    }
    Ok(aggregate)
}

fn serialize_json<T: Serialize + ?Sized>(value: &T) -> Result<String, TaskStoreError> {
    serde_json::to_string(value).map_err(|_| TaskStoreError::InvalidCommit)
}

fn deserialize_json<T: DeserializeOwned>(value: &str) -> Result<T, TaskStoreError> {
    serde_json::from_str(value).map_err(|_| TaskStoreError::InvalidCommit)
}

fn ensure_storage_range(value: u64) -> Result<(), TaskStoreError> {
    i64::try_from(value)
        .map(|_| ())
        .map_err(|_| TaskStoreError::InvalidCommit)
}

fn map_state_error(error: anyhow::Error) -> TaskStoreError {
    if error.downcast_ref::<TaskRecordValidationError>().is_some() {
        TaskStoreError::InvalidCommit
    } else {
        TaskStoreError::BackendUnavailable
    }
}

fn receipt_projection(receipt: &InboxReceipt) -> (&'static str, &str) {
    match receipt {
        InboxReceipt::Command(id) => ("command", id.as_str()),
        InboxReceipt::WorkerEvent(id) => ("workerEvent", id.as_str()),
    }
}

fn authority_type(authority: TaskAuthority) -> &'static str {
    match authority {
        TaskAuthority::LocalAppServer => "localAppServer",
        TaskAuthority::CloudTaskControl => "cloudTaskControl",
    }
}

fn strategy_type(strategy: StrategyKind) -> &'static str {
    match strategy {
        StrategyKind::Single => "single",
        StrategyKind::Office => "office",
    }
}

fn status_type(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Created => "created",
        TaskStatus::Queued => "queued",
        TaskStatus::Running => "running",
        TaskStatus::Suspended => "suspended",
        TaskStatus::Reconciling => "reconciling",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn attempt_status_type(status: crewon_task_runtime::AttemptStatus) -> &'static str {
    match status {
        crewon_task_runtime::AttemptStatus::Created => "created",
        crewon_task_runtime::AttemptStatus::Started => "started",
        crewon_task_runtime::AttemptStatus::Suspended => "suspended",
        crewon_task_runtime::AttemptStatus::Unknown => "unknown",
        crewon_task_runtime::AttemptStatus::Succeeded => "succeeded",
        crewon_task_runtime::AttemptStatus::Failed => "failed",
        crewon_task_runtime::AttemptStatus::Cancelled => "cancelled",
    }
}

fn event_type(kind: &TaskEventKind) -> &'static str {
    match kind {
        TaskEventKind::TaskAccepted { .. } => "taskAccepted",
        TaskEventKind::AttemptClaimed { .. } => "attemptClaimed",
        TaskEventKind::AttemptReclaimed { .. } => "attemptReclaimed",
        TaskEventKind::WorkerReported { .. } => "workerReported",
        TaskEventKind::RetryScheduled { .. } => "retryScheduled",
        TaskEventKind::TaskCancelled => "taskCancelled",
        TaskEventKind::TaskFailed => "taskFailed",
    }
}

fn decision_type(decision: &SchedulerDecision) -> &'static str {
    match decision {
        SchedulerDecision::NoAction => "noAction",
        SchedulerDecision::EnqueueAttempt { .. } => "enqueueAttempt",
        SchedulerDecision::DispatchAttempt { .. } => "dispatchAttempt",
        SchedulerDecision::CancelAttempt { .. } => "cancelAttempt",
        SchedulerDecision::AwaitResume { .. } => "awaitResume",
        SchedulerDecision::AwaitRetryDecision { .. } => "awaitRetryDecision",
        SchedulerDecision::ReconcileAttempt { .. } => "reconcileAttempt",
    }
}

#[cfg(test)]
#[path = "task_state_store_adapter_tests.rs"]
mod tests;
