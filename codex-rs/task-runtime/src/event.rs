use crate::AttemptId;
use crate::AttemptOrdinal;
use crate::EventId;
use crate::FencingTokenHash;
use crate::IdempotencyKey;
use crate::LeaseEpoch;
use crate::LeaseGrant;
use crate::ProducerSequence;
use crate::SuspensionReason;
use crate::TaskId;
use crate::TaskStreamOffset;
use crate::UnixTimestamp;
use crate::WorkerRunId;
use serde::Deserialize;
use serde::Serialize;

/// Worker identity and fencing evidence attached to one execution fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerEvidence {
    pub attempt_id: AttemptId,
    pub worker_run_id: WorkerRunId,
    pub producer_sequence: ProducerSequence,
    pub lease_epoch: LeaseEpoch,
    pub fencing_token_hash: FencingTokenHash,
}

/// Closed set of facts an Executor may report; it cannot request retry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum WorkerOutcome {
    Progressed,
    Suspended { reason: SuspensionReason },
    Resumed,
    Succeeded,
    Failed,
    Cancelled,
    OutcomeUnknown,
}

/// Event payloads accepted by the deterministic Task Reducer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TaskEventKind {
    TaskAccepted {
        attempt_id: AttemptId,
        ordinal: AttemptOrdinal,
        idempotency_key: IdempotencyKey,
    },
    AttemptClaimed {
        attempt_id: AttemptId,
        worker_run_id: WorkerRunId,
        lease: LeaseGrant,
    },
    AttemptReclaimed {
        attempt_id: AttemptId,
        worker_run_id: WorkerRunId,
        lease: LeaseGrant,
    },
    WorkerReported {
        evidence: WorkerEvidence,
        outcome: WorkerOutcome,
    },
    RetryScheduled {
        attempt_id: AttemptId,
        ordinal: AttemptOrdinal,
        idempotency_key: IdempotencyKey,
    },
    TaskCancelled,
    TaskFailed,
}

/// Event proposed by command decision before Store stream assignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposedTaskEvent {
    pub(crate) event_id: EventId,
    pub(crate) task_id: TaskId,
    pub(crate) occurred_at: UnixTimestamp,
    pub(crate) received_at: UnixTimestamp,
    pub(crate) kind: TaskEventKind,
}

impl ProposedTaskEvent {
    /// Returns the stable Event identifier used for Inbox deduplication.
    pub fn event_id(&self) -> &EventId {
        &self.event_id
    }

    /// Returns the Task that owns the proposed event.
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    /// Returns the closed event payload.
    pub fn kind(&self) -> &TaskEventKind {
        &self.kind
    }
}

/// Authority-committed Event with a monotonic Task stream cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedTaskEvent {
    proposed: ProposedTaskEvent,
    stream_offset: TaskStreamOffset,
}

impl CommittedTaskEvent {
    /// Attaches the Store-assigned monotonic cursor to a proposed event.
    pub fn new(proposed: ProposedTaskEvent, stream_offset: TaskStreamOffset) -> Self {
        Self {
            proposed,
            stream_offset,
        }
    }

    /// Returns the stable Event identifier.
    pub fn event_id(&self) -> &EventId {
        &self.proposed.event_id
    }

    /// Returns the owning Task identifier.
    pub fn task_id(&self) -> &TaskId {
        &self.proposed.task_id
    }

    /// Returns when the fact occurred at its producer.
    pub fn occurred_at(&self) -> UnixTimestamp {
        self.proposed.occurred_at
    }

    /// Returns when the Authority received the fact.
    pub fn received_at(&self) -> UnixTimestamp {
        self.proposed.received_at
    }

    /// Returns the committed payload.
    pub fn kind(&self) -> &TaskEventKind {
        &self.proposed.kind
    }

    /// Returns the monotonic Task stream cursor.
    pub fn stream_offset(&self) -> TaskStreamOffset {
        self.stream_offset
    }
}

/// Stable Task Runtime rejection categories without external payload text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskError {
    AuthorityMismatch,
    TaskMismatch,
    TerminalTask,
    InvalidTransition,
    AttemptMissing,
    AttemptMismatch,
    AttemptLimitReached,
    WorkerRunMismatch,
    WorkerRunMustChange,
    LeaseMissing,
    LeaseNotExpired,
    LeaseExpired,
    StaleFencingToken,
    ProducerSequenceOutOfOrder,
    EventOffsetOutOfOrder,
    EventOffsetGap,
    AggregateVersionOverflow,
    StreamOffsetOverflow,
    AttemptOrdinalOverflow,
    ProgressOverflow,
}
