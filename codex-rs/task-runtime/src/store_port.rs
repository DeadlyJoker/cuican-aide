use crate::AggregateVersion;
use crate::CommandDecision;
use crate::CommandId;
use crate::CommittedTaskEvent;
use crate::EventId;
use crate::OutboxId;
use crate::ReduceOutcome;
use crate::SchedulerDecision;
use crate::TaskAggregate;
use crate::TaskCommand;
use crate::TaskCommandEnvelope;
use crate::TaskError;
use crate::TaskId;
use crate::reduce_event;

/// Unique Inbox receipt used to deduplicate Authority and Worker inputs.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum InboxReceipt {
    Command(CommandId),
    WorkerEvent(EventId),
}

impl InboxReceipt {
    /// Derives the correct receipt authority from a normalized command.
    pub fn from_command(command: &TaskCommandEnvelope) -> Self {
        match &command.command {
            TaskCommand::ApplyWorkerEvent { .. } => Self::WorkerEvent(command.event_id.clone()),
            TaskCommand::AcceptTask { .. }
            | TaskCommand::ClaimAttempt { .. }
            | TaskCommand::ReclaimAttempt { .. }
            | TaskCommand::CancelTask
            | TaskCommand::ScheduleRetry { .. }
            | TaskCommand::FailTask => Self::Command(command.command_id.clone()),
        }
    }
}

/// Side effect record written only after Event, Snapshot, and Inbox receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRecord {
    outbox_id: OutboxId,
    task_id: TaskId,
    aggregate_version: AggregateVersion,
    decision: SchedulerDecision,
}

impl OutboxRecord {
    /// Returns the stable delivery identifier.
    pub fn outbox_id(&self) -> &OutboxId {
        &self.outbox_id
    }

    /// Returns the Task whose committed state authorized this side effect.
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    /// Returns the exact Aggregate version that produced the decision.
    pub fn aggregate_version(&self) -> AggregateVersion {
        self.aggregate_version
    }

    /// Returns the bounded Scheduler decision.
    pub fn decision(&self) -> &SchedulerDecision {
        &self.decision
    }
}

/// Atomic Store write prepared from one validated command decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCommit {
    task_id: TaskId,
    expected_version: AggregateVersion,
    receipt: InboxReceipt,
    event: CommittedTaskEvent,
    resulting_aggregate: TaskAggregate,
    outbox: Vec<OutboxRecord>,
}

impl TaskCommit {
    /// Builds a complete atomic write from current state and pure decision.
    pub fn from_decision(
        current: &TaskAggregate,
        command: &TaskCommandEnvelope,
        outbox_id: OutboxId,
        decision: CommandDecision,
    ) -> Result<Self, TaskError> {
        if decision.event.event_id() != &command.event_id
            || decision.event.task_id() != &command.task_id
        {
            return Err(TaskError::TaskMismatch);
        }
        let stream_offset = current
            .task_stream_offset()
            .checked_next()
            .ok_or(TaskError::StreamOffsetOverflow)?;
        let event = CommittedTaskEvent::new(decision.event, stream_offset);
        let resulting_aggregate = match reduce_event(current, &event)? {
            ReduceOutcome::Applied(aggregate) => *aggregate,
            ReduceOutcome::Duplicate => return Err(TaskError::EventOffsetOutOfOrder),
        };
        let outbox = match decision.scheduler {
            SchedulerDecision::NoAction => Vec::new(),
            scheduler => vec![OutboxRecord {
                outbox_id,
                task_id: command.task_id.clone(),
                aggregate_version: resulting_aggregate.aggregate_version(),
                decision: scheduler,
            }],
        };
        Ok(Self {
            task_id: command.task_id.clone(),
            expected_version: current.aggregate_version(),
            receipt: InboxReceipt::from_command(command),
            event,
            resulting_aggregate,
            outbox,
        })
    }

    /// Returns the Task being atomically updated.
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    /// Returns the optimistic-concurrency version required at commit time.
    pub fn expected_version(&self) -> AggregateVersion {
        self.expected_version
    }

    /// Returns the Inbox receipt inserted by the same transaction.
    pub fn receipt(&self) -> &InboxReceipt {
        &self.receipt
    }

    /// Returns the one committed Event.
    pub fn event(&self) -> &CommittedTaskEvent {
        &self.event
    }

    /// Returns the complete post-reducer Snapshot.
    pub fn resulting_aggregate(&self) -> &TaskAggregate {
        &self.resulting_aggregate
    }

    /// Returns zero or one post-commit Scheduler Outbox record.
    pub fn outbox(&self) -> &[OutboxRecord] {
        &self.outbox
    }
}

/// Result of an atomic Store commit, including a deduplicated replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskCommitOutcome {
    Committed(TaskAggregate),
    Duplicate(TaskAggregate),
}

/// Store failures that do not leak persistence implementation details.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStoreError {
    AlreadyExists,
    NotFound,
    Conflict,
    Fenced,
    InvalidCommit,
    BackendUnavailable,
}

/// Durable Task Store port implemented by Local SQLite or Cloud persistence.
///
/// Implementations must atomically persist Event, resulting Snapshot, Inbox
/// receipt, and Outbox records under expected-version CAS. A duplicate receipt
/// returns the already committed Aggregate without writing another side effect.
pub trait TaskStore: Send + Sync {
    /// Creates a version-zero Aggregate if its Task ID does not already exist.
    fn create(
        &self,
        aggregate: TaskAggregate,
    ) -> impl std::future::Future<Output = Result<(), TaskStoreError>> + Send;

    /// Reads the current authoritative Task Snapshot.
    fn read(
        &self,
        task_id: TaskId,
    ) -> impl std::future::Future<Output = Result<Option<TaskAggregate>, TaskStoreError>> + Send;

    /// Reads the Aggregate previously committed for an Inbox receipt.
    fn read_receipt(
        &self,
        task_id: TaskId,
        receipt: InboxReceipt,
    ) -> impl std::future::Future<Output = Result<Option<TaskAggregate>, TaskStoreError>> + Send;

    /// Performs one all-or-nothing CAS commit.
    fn commit(
        &self,
        commit: TaskCommit,
    ) -> impl std::future::Future<Output = Result<TaskCommitOutcome, TaskStoreError>> + Send;
}
