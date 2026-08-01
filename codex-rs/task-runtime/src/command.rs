use crate::AttemptId;
use crate::AttemptOrdinal;
use crate::CommandId;
use crate::EventId;
use crate::IdempotencyKey;
use crate::LeaseGrant;
use crate::ProposedTaskEvent;
use crate::ReduceOutcome;
use crate::SchedulerDecision::AwaitResume;
use crate::SchedulerDecision::AwaitRetryDecision;
use crate::SchedulerDecision::CancelAttempt;
use crate::SchedulerDecision::DispatchAttempt;
use crate::SchedulerDecision::EnqueueAttempt;
use crate::SchedulerDecision::NoAction;
use crate::SchedulerDecision::ReconcileAttempt;
use crate::TaskAggregate;
use crate::TaskAuthority;
use crate::TaskError;
use crate::TaskEventKind;
use crate::TaskId;
use crate::TaskStatus;
use crate::UnixTimestamp;
use crate::WorkerEvidence;
use crate::WorkerOutcome;
use crate::WorkerRunId;
use crate::reduce_event;
use serde::Deserialize;
use serde::Serialize;

/// Authority command and receipt metadata evaluated by the pure decision layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCommandEnvelope {
    pub command_id: CommandId,
    pub event_id: EventId,
    pub task_id: TaskId,
    pub authority: TaskAuthority,
    pub occurred_at: UnixTimestamp,
    pub received_at: UnixTimestamp,
    pub command: TaskCommand,
}

/// Closed first-version Task commands; Executors cannot create Attempts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskCommand {
    AcceptTask {
        attempt_id: AttemptId,
        idempotency_key: IdempotencyKey,
    },
    ClaimAttempt {
        attempt_id: AttemptId,
        worker_run_id: WorkerRunId,
        lease: LeaseGrant,
    },
    ReclaimAttempt {
        attempt_id: AttemptId,
        worker_run_id: WorkerRunId,
        lease: LeaseGrant,
    },
    ApplyWorkerEvent {
        evidence: WorkerEvidence,
        outcome: WorkerOutcome,
    },
    CancelTask,
    ScheduleRetry {
        attempt_id: AttemptId,
        idempotency_key: IdempotencyKey,
    },
    FailTask,
}

/// Side effect requested after the same transaction commits Event and Snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum SchedulerDecision {
    NoAction,
    EnqueueAttempt {
        attempt_id: AttemptId,
    },
    DispatchAttempt {
        attempt_id: AttemptId,
        worker_run_id: WorkerRunId,
    },
    CancelAttempt {
        attempt_id: AttemptId,
        worker_run_id: WorkerRunId,
    },
    AwaitResume {
        attempt_id: AttemptId,
    },
    AwaitRetryDecision {
        attempt_id: AttemptId,
    },
    ReconcileAttempt {
        attempt_id: AttemptId,
        worker_run_id: WorkerRunId,
    },
}

/// Pure command result; Store commit assigns the final stream cursor atomically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandDecision {
    pub(crate) event: ProposedTaskEvent,
    pub(crate) scheduler: SchedulerDecision,
}

impl CommandDecision {
    /// Returns the Event that must be committed before side effects execute.
    pub fn event(&self) -> &ProposedTaskEvent {
        &self.event
    }

    /// Returns the post-commit Scheduler decision.
    pub fn scheduler(&self) -> &SchedulerDecision {
        &self.scheduler
    }
}

/// Validates an Authority command and proposes one deterministic Event.
pub fn decide_command(
    aggregate: &TaskAggregate,
    envelope: &TaskCommandEnvelope,
) -> Result<CommandDecision, TaskError> {
    if envelope.task_id != *aggregate.contract.task_id() {
        return Err(TaskError::TaskMismatch);
    }
    if envelope.authority != aggregate.contract.authority() {
        return Err(TaskError::AuthorityMismatch);
    }
    if aggregate.status.is_terminal() {
        return Err(TaskError::TerminalTask);
    }

    let kind = event_kind(aggregate, &envelope.command)?;
    let event = ProposedTaskEvent {
        event_id: envelope.event_id.clone(),
        task_id: envelope.task_id.clone(),
        occurred_at: envelope.occurred_at,
        received_at: envelope.received_at,
        kind,
    };
    let next_offset = aggregate
        .task_stream_offset
        .checked_next()
        .ok_or(TaskError::StreamOffsetOverflow)?;
    let preview = crate::CommittedTaskEvent::new(event.clone(), next_offset);
    match reduce_event(aggregate, &preview)? {
        ReduceOutcome::Applied(_) => {}
        ReduceOutcome::Duplicate => return Err(TaskError::EventOffsetOutOfOrder),
    }
    let scheduler = scheduler_decision(aggregate, &envelope.command)?;
    Ok(CommandDecision { event, scheduler })
}

fn event_kind(
    aggregate: &TaskAggregate,
    command: &TaskCommand,
) -> Result<TaskEventKind, TaskError> {
    match command {
        TaskCommand::AcceptTask {
            attempt_id,
            idempotency_key,
        } => Ok(TaskEventKind::TaskAccepted {
            attempt_id: attempt_id.clone(),
            ordinal: AttemptOrdinal::first(),
            idempotency_key: idempotency_key.clone(),
        }),
        TaskCommand::ClaimAttempt {
            attempt_id,
            worker_run_id,
            lease,
        } => Ok(TaskEventKind::AttemptClaimed {
            attempt_id: attempt_id.clone(),
            worker_run_id: worker_run_id.clone(),
            lease: lease.clone(),
        }),
        TaskCommand::ReclaimAttempt {
            attempt_id,
            worker_run_id,
            lease,
        } => Ok(TaskEventKind::AttemptReclaimed {
            attempt_id: attempt_id.clone(),
            worker_run_id: worker_run_id.clone(),
            lease: lease.clone(),
        }),
        TaskCommand::ApplyWorkerEvent { evidence, outcome } => Ok(TaskEventKind::WorkerReported {
            evidence: evidence.clone(),
            outcome: outcome.clone(),
        }),
        TaskCommand::CancelTask => Ok(TaskEventKind::TaskCancelled),
        TaskCommand::ScheduleRetry {
            attempt_id,
            idempotency_key,
        } => {
            let active = aggregate
                .active_attempt()
                .ok_or(TaskError::AttemptMissing)?;
            let ordinal = active
                .ordinal()
                .checked_next()
                .ok_or(TaskError::AttemptOrdinalOverflow)?;
            Ok(TaskEventKind::RetryScheduled {
                attempt_id: attempt_id.clone(),
                ordinal,
                idempotency_key: idempotency_key.clone(),
            })
        }
        TaskCommand::FailTask => Ok(TaskEventKind::TaskFailed),
    }
}

fn scheduler_decision(
    aggregate: &TaskAggregate,
    command: &TaskCommand,
) -> Result<SchedulerDecision, TaskError> {
    match command {
        TaskCommand::AcceptTask { attempt_id, .. }
        | TaskCommand::ScheduleRetry { attempt_id, .. } => Ok(EnqueueAttempt {
            attempt_id: attempt_id.clone(),
        }),
        TaskCommand::ClaimAttempt {
            attempt_id,
            worker_run_id,
            ..
        } => Ok(DispatchAttempt {
            attempt_id: attempt_id.clone(),
            worker_run_id: worker_run_id.clone(),
        }),
        TaskCommand::ReclaimAttempt {
            attempt_id,
            worker_run_id,
            ..
        } => match aggregate.status {
            TaskStatus::Running => Ok(DispatchAttempt {
                attempt_id: attempt_id.clone(),
                worker_run_id: worker_run_id.clone(),
            }),
            TaskStatus::Suspended => Ok(AwaitResume {
                attempt_id: attempt_id.clone(),
            }),
            TaskStatus::Reconciling => Ok(ReconcileAttempt {
                attempt_id: attempt_id.clone(),
                worker_run_id: worker_run_id.clone(),
            }),
            TaskStatus::Created
            | TaskStatus::Queued
            | TaskStatus::Completed
            | TaskStatus::Failed
            | TaskStatus::Cancelled => Err(TaskError::InvalidTransition),
        },
        TaskCommand::ApplyWorkerEvent { evidence, outcome } => match outcome {
            WorkerOutcome::Progressed | WorkerOutcome::Resumed | WorkerOutcome::Succeeded => {
                Ok(NoAction)
            }
            WorkerOutcome::Suspended { .. } => Ok(AwaitResume {
                attempt_id: evidence.attempt_id.clone(),
            }),
            WorkerOutcome::Failed => Ok(AwaitRetryDecision {
                attempt_id: evidence.attempt_id.clone(),
            }),
            WorkerOutcome::Cancelled => Ok(AwaitRetryDecision {
                attempt_id: evidence.attempt_id.clone(),
            }),
            WorkerOutcome::OutcomeUnknown => Ok(ReconcileAttempt {
                attempt_id: evidence.attempt_id.clone(),
                worker_run_id: evidence.worker_run_id.clone(),
            }),
        },
        TaskCommand::CancelTask => {
            let Some(attempt) = aggregate.active_attempt() else {
                return Ok(NoAction);
            };
            if attempt.status().is_terminal() {
                return Ok(NoAction);
            }
            let Some(worker_run_id) = attempt.worker_run_id() else {
                return Ok(NoAction);
            };
            Ok(CancelAttempt {
                attempt_id: attempt.attempt_id().clone(),
                worker_run_id: worker_run_id.clone(),
            })
        }
        TaskCommand::FailTask => Ok(NoAction),
    }
}
