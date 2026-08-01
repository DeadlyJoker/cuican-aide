use crate::Attempt;
use crate::AttemptOrdinal;
use crate::AttemptStatus;
use crate::CommittedTaskEvent;
use crate::MAX_TASK_ATTEMPTS;
use crate::ReduceOutcome::Applied;
use crate::ReduceOutcome::Duplicate;
use crate::SuspensionReason;
use crate::TaskAggregate;
use crate::TaskError;
use crate::TaskEventKind;
use crate::TaskStatus;
use crate::WorkerEvidence;
use crate::WorkerOutcome;

/// Result of applying one committed Event to a Task Aggregate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReduceOutcome {
    Applied(Box<TaskAggregate>),
    Duplicate,
}

/// Applies one committed Event as a deterministic pure function.
pub fn reduce_event(
    aggregate: &TaskAggregate,
    event: &CommittedTaskEvent,
) -> Result<ReduceOutcome, TaskError> {
    if event.task_id() != aggregate.contract.task_id() {
        return Err(TaskError::TaskMismatch);
    }
    if event.stream_offset() == aggregate.task_stream_offset {
        if aggregate.last_event_id.as_ref() == Some(event.event_id()) {
            return Ok(Duplicate);
        }
        return Err(TaskError::EventOffsetOutOfOrder);
    }
    let expected_offset = aggregate
        .task_stream_offset
        .checked_next()
        .ok_or(TaskError::StreamOffsetOverflow)?;
    if event.stream_offset() < expected_offset {
        return Err(TaskError::EventOffsetOutOfOrder);
    }
    if event.stream_offset() != expected_offset {
        return Err(TaskError::EventOffsetGap);
    }
    if aggregate.status.is_terminal() {
        return Err(TaskError::TerminalTask);
    }

    let mut next = aggregate.clone();
    apply_event_kind(&mut next, event)?;
    next.aggregate_version = next
        .aggregate_version
        .checked_next()
        .ok_or(TaskError::AggregateVersionOverflow)?;
    next.task_stream_offset = event.stream_offset();
    next.last_event_id = Some(event.event_id().clone());
    Ok(Applied(Box::new(next)))
}

fn apply_event_kind(
    aggregate: &mut TaskAggregate,
    event: &CommittedTaskEvent,
) -> Result<(), TaskError> {
    match event.kind() {
        TaskEventKind::TaskAccepted {
            attempt_id,
            ordinal,
            idempotency_key,
        } => apply_task_accepted(aggregate, attempt_id, *ordinal, idempotency_key),
        TaskEventKind::AttemptClaimed {
            attempt_id,
            worker_run_id,
            lease,
        } => apply_attempt_claimed(
            aggregate,
            attempt_id,
            worker_run_id,
            lease,
            event.received_at(),
        ),
        TaskEventKind::AttemptReclaimed {
            attempt_id,
            worker_run_id,
            lease,
        } => apply_attempt_reclaimed(
            aggregate,
            attempt_id,
            worker_run_id,
            lease,
            event.received_at(),
        ),
        TaskEventKind::WorkerReported { evidence, outcome } => {
            apply_worker_outcome(aggregate, evidence, outcome, event.received_at())
        }
        TaskEventKind::RetryScheduled {
            attempt_id,
            ordinal,
            idempotency_key,
        } => apply_retry_scheduled(aggregate, attempt_id, *ordinal, idempotency_key),
        TaskEventKind::TaskCancelled => apply_task_cancelled(aggregate),
        TaskEventKind::TaskFailed => apply_task_failed(aggregate),
    }
}

fn apply_task_accepted(
    aggregate: &mut TaskAggregate,
    attempt_id: &crate::AttemptId,
    ordinal: AttemptOrdinal,
    idempotency_key: &crate::IdempotencyKey,
) -> Result<(), TaskError> {
    if aggregate.status != TaskStatus::Created
        || !aggregate.attempts.is_empty()
        || ordinal != AttemptOrdinal::first()
    {
        return Err(TaskError::InvalidTransition);
    }
    aggregate.attempts.push(Attempt::created(
        attempt_id.clone(),
        ordinal,
        idempotency_key.clone(),
    ));
    aggregate.active_attempt_id = Some(attempt_id.clone());
    aggregate.status = TaskStatus::Queued;
    Ok(())
}

fn apply_attempt_claimed(
    aggregate: &mut TaskAggregate,
    attempt_id: &crate::AttemptId,
    worker_run_id: &crate::WorkerRunId,
    lease: &crate::LeaseGrant,
    received_at: crate::UnixTimestamp,
) -> Result<(), TaskError> {
    if aggregate.status != TaskStatus::Queued || lease.epoch().get() != 1 {
        return Err(TaskError::InvalidTransition);
    }
    if lease.is_expired_at(received_at) {
        return Err(TaskError::LeaseExpired);
    }
    let index = active_attempt_index(aggregate, attempt_id)?;
    let attempt = &mut aggregate.attempts[index];
    if attempt.status != AttemptStatus::Created {
        return Err(TaskError::InvalidTransition);
    }
    attempt.status = AttemptStatus::Started;
    attempt.worker_run_id = Some(worker_run_id.clone());
    attempt.lease = Some(lease.clone());
    attempt.last_producer_sequence = None;
    aggregate.status = TaskStatus::Running;
    Ok(())
}

fn apply_attempt_reclaimed(
    aggregate: &mut TaskAggregate,
    attempt_id: &crate::AttemptId,
    worker_run_id: &crate::WorkerRunId,
    lease: &crate::LeaseGrant,
    received_at: crate::UnixTimestamp,
) -> Result<(), TaskError> {
    if !matches!(
        aggregate.status,
        TaskStatus::Running | TaskStatus::Suspended | TaskStatus::Reconciling
    ) {
        return Err(TaskError::InvalidTransition);
    }
    let index = active_attempt_index(aggregate, attempt_id)?;
    let attempt = &aggregate.attempts[index];
    if attempt.status.is_terminal() {
        return Err(TaskError::InvalidTransition);
    }
    let old_worker_run_id = attempt
        .worker_run_id
        .as_ref()
        .ok_or(TaskError::WorkerRunMismatch)?;
    if old_worker_run_id == worker_run_id {
        return Err(TaskError::WorkerRunMustChange);
    }
    let old_lease = attempt.lease.as_ref().ok_or(TaskError::LeaseMissing)?;
    if !old_lease.is_expired_at(received_at) {
        return Err(TaskError::LeaseNotExpired);
    }
    let expected_epoch = old_lease
        .epoch()
        .checked_next()
        .ok_or(TaskError::StaleFencingToken)?;
    if lease.epoch() != expected_epoch {
        return Err(TaskError::StaleFencingToken);
    }
    if lease.is_expired_at(received_at) {
        return Err(TaskError::LeaseExpired);
    }

    let attempt = &mut aggregate.attempts[index];
    attempt.worker_run_id = Some(worker_run_id.clone());
    attempt.lease = Some(lease.clone());
    attempt.last_producer_sequence = None;
    attempt.status = match aggregate.status {
        TaskStatus::Running => AttemptStatus::Started,
        TaskStatus::Suspended => AttemptStatus::Suspended,
        TaskStatus::Reconciling => AttemptStatus::Unknown,
        TaskStatus::Created
        | TaskStatus::Queued
        | TaskStatus::Completed
        | TaskStatus::Failed
        | TaskStatus::Cancelled => return Err(TaskError::InvalidTransition),
    };
    Ok(())
}

fn apply_worker_outcome(
    aggregate: &mut TaskAggregate,
    evidence: &WorkerEvidence,
    outcome: &WorkerOutcome,
    received_at: crate::UnixTimestamp,
) -> Result<(), TaskError> {
    let index = validate_worker_evidence(aggregate, evidence, received_at)?;
    let attempt_status = aggregate.attempts[index].status;
    match outcome {
        WorkerOutcome::Progressed => {
            require_state(
                aggregate,
                attempt_status,
                TaskStatus::Running,
                AttemptStatus::Started,
            )?;
            aggregate.progress_count = aggregate
                .progress_count
                .checked_add(1)
                .ok_or(TaskError::ProgressOverflow)?;
        }
        WorkerOutcome::Suspended { reason } => {
            if *reason == SuspensionReason::RetryDecision {
                return Err(TaskError::InvalidTransition);
            }
            require_state(
                aggregate,
                attempt_status,
                TaskStatus::Running,
                AttemptStatus::Started,
            )?;
            aggregate.status = TaskStatus::Suspended;
            aggregate.suspension_reason = Some(*reason);
            aggregate.attempts[index].status = AttemptStatus::Suspended;
        }
        WorkerOutcome::Resumed => {
            if aggregate.status != TaskStatus::Suspended
                || attempt_status != AttemptStatus::Suspended
                || !matches!(
                    aggregate.suspension_reason,
                    Some(SuspensionReason::ProviderPaused | SuspensionReason::ApprovalRequired)
                )
            {
                return Err(TaskError::InvalidTransition);
            }
            aggregate.status = TaskStatus::Running;
            aggregate.suspension_reason = None;
            aggregate.attempts[index].status = AttemptStatus::Started;
        }
        WorkerOutcome::Succeeded => {
            require_running_or_reconciling(aggregate, attempt_status)?;
            aggregate.status = TaskStatus::Completed;
            aggregate.suspension_reason = None;
            aggregate.attempts[index].status = AttemptStatus::Succeeded;
        }
        WorkerOutcome::Failed => {
            require_running_or_reconciling(aggregate, attempt_status)?;
            aggregate.status = TaskStatus::Suspended;
            aggregate.suspension_reason = Some(SuspensionReason::RetryDecision);
            aggregate.attempts[index].status = AttemptStatus::Failed;
        }
        WorkerOutcome::Cancelled => {
            require_active_worker_attempt(aggregate, attempt_status)?;
            aggregate.status = TaskStatus::Suspended;
            aggregate.suspension_reason = Some(SuspensionReason::RetryDecision);
            aggregate.attempts[index].status = AttemptStatus::Cancelled;
        }
        WorkerOutcome::OutcomeUnknown => {
            require_state(
                aggregate,
                attempt_status,
                TaskStatus::Running,
                AttemptStatus::Started,
            )?;
            aggregate.status = TaskStatus::Reconciling;
            aggregate.suspension_reason = None;
            aggregate.attempts[index].status = AttemptStatus::Unknown;
        }
    }
    aggregate.attempts[index].last_producer_sequence = Some(evidence.producer_sequence);
    Ok(())
}

fn apply_retry_scheduled(
    aggregate: &mut TaskAggregate,
    attempt_id: &crate::AttemptId,
    ordinal: AttemptOrdinal,
    idempotency_key: &crate::IdempotencyKey,
) -> Result<(), TaskError> {
    if aggregate.status != TaskStatus::Suspended
        || aggregate.suspension_reason != Some(SuspensionReason::RetryDecision)
    {
        return Err(TaskError::InvalidTransition);
    }
    let active_index = active_attempt_index_from_current(aggregate)?;
    if !matches!(
        aggregate.attempts[active_index].status,
        AttemptStatus::Failed | AttemptStatus::Cancelled
    ) {
        return Err(TaskError::InvalidTransition);
    }
    if aggregate.attempts.len() >= MAX_TASK_ATTEMPTS {
        return Err(TaskError::AttemptLimitReached);
    }
    let expected_ordinal = aggregate.attempts[active_index]
        .ordinal
        .checked_next()
        .ok_or(TaskError::AttemptOrdinalOverflow)?;
    if ordinal != expected_ordinal
        || aggregate
            .attempts
            .iter()
            .any(|attempt| &attempt.attempt_id == attempt_id)
    {
        return Err(TaskError::InvalidTransition);
    }
    aggregate.attempts.push(Attempt::created(
        attempt_id.clone(),
        ordinal,
        idempotency_key.clone(),
    ));
    aggregate.active_attempt_id = Some(attempt_id.clone());
    aggregate.status = TaskStatus::Queued;
    aggregate.suspension_reason = None;
    Ok(())
}

fn apply_task_cancelled(aggregate: &mut TaskAggregate) -> Result<(), TaskError> {
    if let Some(index) = aggregate.active_attempt_id.as_ref().and_then(|id| {
        aggregate
            .attempts
            .iter()
            .position(|attempt| &attempt.attempt_id == id)
    }) && !aggregate.attempts[index].status.is_terminal()
    {
        aggregate.attempts[index].status = AttemptStatus::Cancelled;
    }
    aggregate.status = TaskStatus::Cancelled;
    aggregate.suspension_reason = None;
    Ok(())
}

fn apply_task_failed(aggregate: &mut TaskAggregate) -> Result<(), TaskError> {
    if aggregate.status != TaskStatus::Suspended
        || aggregate.suspension_reason != Some(SuspensionReason::RetryDecision)
    {
        return Err(TaskError::InvalidTransition);
    }
    let index = active_attempt_index_from_current(aggregate)?;
    if !matches!(
        aggregate.attempts[index].status,
        AttemptStatus::Failed | AttemptStatus::Cancelled
    ) {
        return Err(TaskError::InvalidTransition);
    }
    aggregate.status = TaskStatus::Failed;
    aggregate.suspension_reason = None;
    Ok(())
}

fn validate_worker_evidence(
    aggregate: &TaskAggregate,
    evidence: &WorkerEvidence,
    received_at: crate::UnixTimestamp,
) -> Result<usize, TaskError> {
    let index = active_attempt_index(aggregate, &evidence.attempt_id)?;
    let attempt = &aggregate.attempts[index];
    if attempt.worker_run_id.as_ref() != Some(&evidence.worker_run_id) {
        return Err(TaskError::WorkerRunMismatch);
    }
    let lease = attempt.lease.as_ref().ok_or(TaskError::LeaseMissing)?;
    if lease.epoch() != evidence.lease_epoch
        || lease.fencing_token_hash() != &evidence.fencing_token_hash
    {
        return Err(TaskError::StaleFencingToken);
    }
    if lease.is_expired_at(received_at) {
        return Err(TaskError::LeaseExpired);
    }
    if attempt
        .last_producer_sequence
        .is_some_and(|last| evidence.producer_sequence <= last)
    {
        return Err(TaskError::ProducerSequenceOutOfOrder);
    }
    Ok(index)
}

fn active_attempt_index(
    aggregate: &TaskAggregate,
    attempt_id: &crate::AttemptId,
) -> Result<usize, TaskError> {
    let active_id = aggregate
        .active_attempt_id
        .as_ref()
        .ok_or(TaskError::AttemptMissing)?;
    if active_id != attempt_id {
        return Err(TaskError::AttemptMismatch);
    }
    active_attempt_index_from_current(aggregate)
}

fn active_attempt_index_from_current(aggregate: &TaskAggregate) -> Result<usize, TaskError> {
    let active_id = aggregate
        .active_attempt_id
        .as_ref()
        .ok_or(TaskError::AttemptMissing)?;
    aggregate
        .attempts
        .iter()
        .position(|attempt| &attempt.attempt_id == active_id)
        .ok_or(TaskError::AttemptMissing)
}

fn require_state(
    aggregate: &TaskAggregate,
    actual_attempt: AttemptStatus,
    expected_task: TaskStatus,
    expected_attempt: AttemptStatus,
) -> Result<(), TaskError> {
    if aggregate.status != expected_task || actual_attempt != expected_attempt {
        return Err(TaskError::InvalidTransition);
    }
    Ok(())
}

fn require_running_or_reconciling(
    aggregate: &TaskAggregate,
    attempt_status: AttemptStatus,
) -> Result<(), TaskError> {
    match (aggregate.status, attempt_status) {
        (TaskStatus::Running, AttemptStatus::Started)
        | (TaskStatus::Reconciling, AttemptStatus::Unknown) => Ok(()),
        (TaskStatus::Created, _)
        | (TaskStatus::Queued, _)
        | (TaskStatus::Running, _)
        | (TaskStatus::Suspended, _)
        | (TaskStatus::Reconciling, _)
        | (TaskStatus::Completed, _)
        | (TaskStatus::Failed, _)
        | (TaskStatus::Cancelled, _) => Err(TaskError::InvalidTransition),
    }
}

fn require_active_worker_attempt(
    aggregate: &TaskAggregate,
    attempt_status: AttemptStatus,
) -> Result<(), TaskError> {
    match (aggregate.status, attempt_status) {
        (TaskStatus::Running, AttemptStatus::Started)
        | (TaskStatus::Suspended, AttemptStatus::Suspended)
        | (TaskStatus::Reconciling, AttemptStatus::Unknown) => Ok(()),
        (TaskStatus::Created, _)
        | (TaskStatus::Queued, _)
        | (TaskStatus::Running, _)
        | (TaskStatus::Suspended, _)
        | (TaskStatus::Reconciling, _)
        | (TaskStatus::Completed, _)
        | (TaskStatus::Failed, _)
        | (TaskStatus::Cancelled, _) => Err(TaskError::InvalidTransition),
    }
}
