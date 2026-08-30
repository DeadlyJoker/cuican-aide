use crate::AggregateVersion;
use crate::Attempt;
use crate::AttemptId;
use crate::AttemptOrdinal;
use crate::AttemptStatus;
use crate::EventId;
use crate::ExecutionSpecRef;
use crate::IdempotencyKey;
use crate::LeaseGrant;
use crate::MAX_TASK_ATTEMPTS;
use crate::ModelError;
use crate::ProducerSequence;
use crate::StrategyKind;
use crate::SuspensionReason;
use crate::TaskAggregate;
use crate::TaskAuthority;
use crate::TaskContract;
use crate::TaskContractSchemaVersion;
use crate::TaskContractSpec;
use crate::TaskId;
use crate::TaskStatus;
use crate::TaskStreamOffset;
use crate::UnixTimestamp;
use crate::WorkerRunId;
use crewon_resource_federation::BindingError;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResolvedResourceBindingSnapshot;
use crewon_resource_federation::WorkspaceKey;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fmt;

/// Persistence DTO for the immutable Task Contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskContractSnapshot {
    pub task_id: TaskId,
    pub authority: TaskAuthority,
    pub strategy: StrategyKind,
    pub workspace_key: WorkspaceKey,
    pub schema_version: TaskContractSchemaVersion,
    pub contract_hash: crate::ContractHash,
    pub execution_spec: ExecutionSpecRef,
    pub bindings: Vec<ResolvedResourceBindingSnapshot>,
    pub created_at: UnixTimestamp,
}

/// Persistence DTO for one Authority-created Attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptSnapshot {
    pub attempt_id: AttemptId,
    pub ordinal: AttemptOrdinal,
    pub idempotency_key: IdempotencyKey,
    pub status: AttemptStatus,
    pub worker_run_id: Option<WorkerRunId>,
    pub lease: Option<LeaseGrant>,
    pub last_producer_sequence: Option<ProducerSequence>,
}

/// Persistence DTO for a complete Task Aggregate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskAggregateSnapshot {
    pub contract: TaskContractSnapshot,
    pub status: TaskStatus,
    pub suspension_reason: Option<SuspensionReason>,
    pub attempts: Vec<AttemptSnapshot>,
    pub active_attempt_id: Option<AttemptId>,
    pub aggregate_version: AggregateVersion,
    pub task_stream_offset: TaskStreamOffset,
    pub last_event_id: Option<EventId>,
    pub progress_count: u64,
}

/// Closed rejection set for persisted data that violates Task invariants.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskSnapshotError {
    Binding(BindingError),
    Contract(ModelError),
    ContractHashMismatch,
    TooManyAttempts,
    DuplicateAttemptId,
    AttemptOrdinalMismatch,
    ActiveAttemptMismatch,
    AttemptShapeMismatch,
    LifecycleMismatch,
    VersionOffsetMismatch,
    EventCursorMismatch,
    HistoryCardinalityMismatch,
    ProgressCountOutOfRange,
}

impl fmt::Display for TaskSnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid task aggregate snapshot: {self:?}")
    }
}

impl std::error::Error for TaskSnapshotError {}

impl From<BindingError> for TaskSnapshotError {
    fn from(error: BindingError) -> Self {
        Self::Binding(error)
    }
}

impl From<ModelError> for TaskSnapshotError {
    fn from(error: ModelError) -> Self {
        Self::Contract(error)
    }
}

impl TaskContract {
    /// Produces the persistence DTO for this immutable Contract.
    pub fn to_snapshot(&self) -> TaskContractSnapshot {
        TaskContractSnapshot {
            task_id: self.task_id().clone(),
            authority: self.authority(),
            strategy: self.strategy(),
            workspace_key: self.workspace_key().clone(),
            schema_version: self.schema_version().clone(),
            contract_hash: self.contract_hash().clone(),
            execution_spec: self.execution_spec().clone(),
            bindings: self
                .bindings()
                .iter()
                .map(ResolvedResourceBinding::to_snapshot)
                .collect(),
            created_at: self.created_at(),
        }
    }

    /// Restores a Contract only after every resource binding is revalidated.
    pub fn restore(snapshot: TaskContractSnapshot) -> Result<Self, TaskSnapshotError> {
        let bindings = snapshot
            .bindings
            .into_iter()
            .map(ResolvedResourceBinding::restore)
            .collect::<Result<Vec<_>, _>>()?;
        let expected_hash = snapshot.contract_hash;
        let contract = Self::new(TaskContractSpec {
            task_id: snapshot.task_id,
            authority: snapshot.authority,
            strategy: snapshot.strategy,
            workspace_key: snapshot.workspace_key,
            schema_version: snapshot.schema_version,
            execution_spec: snapshot.execution_spec,
            bindings,
            created_at: snapshot.created_at,
        })?;
        if contract.contract_hash() != &expected_hash {
            return Err(TaskSnapshotError::ContractHashMismatch);
        }
        Ok(contract)
    }
}

impl TaskAggregate {
    /// Produces the complete persistence DTO for this Aggregate.
    pub fn to_snapshot(&self) -> TaskAggregateSnapshot {
        TaskAggregateSnapshot {
            contract: self.contract().to_snapshot(),
            status: self.status(),
            suspension_reason: self.suspension_reason(),
            attempts: self.attempts().iter().map(AttemptSnapshot::from).collect(),
            active_attempt_id: self
                .active_attempt()
                .map(|attempt| attempt.attempt_id().clone()),
            aggregate_version: self.aggregate_version(),
            task_stream_offset: self.task_stream_offset(),
            last_event_id: self.last_event_id().cloned(),
            progress_count: self.progress_count(),
        }
    }

    /// Restores a persisted Aggregate only after checking all state invariants.
    pub fn restore(snapshot: TaskAggregateSnapshot) -> Result<Self, TaskSnapshotError> {
        if snapshot.attempts.len() > MAX_TASK_ATTEMPTS {
            return Err(TaskSnapshotError::TooManyAttempts);
        }
        let aggregate = Self {
            contract: TaskContract::restore(snapshot.contract)?,
            status: snapshot.status,
            suspension_reason: snapshot.suspension_reason,
            attempts: snapshot.attempts.into_iter().map(Attempt::from).collect(),
            active_attempt_id: snapshot.active_attempt_id,
            aggregate_version: snapshot.aggregate_version,
            task_stream_offset: snapshot.task_stream_offset,
            last_event_id: snapshot.last_event_id,
            progress_count: snapshot.progress_count,
        };
        validate_aggregate(&aggregate)?;
        Ok(aggregate)
    }
}

impl From<&Attempt> for AttemptSnapshot {
    fn from(attempt: &Attempt) -> Self {
        Self {
            attempt_id: attempt.attempt_id().clone(),
            ordinal: attempt.ordinal(),
            idempotency_key: attempt.idempotency_key().clone(),
            status: attempt.status(),
            worker_run_id: attempt.worker_run_id().cloned(),
            lease: attempt.lease().cloned(),
            last_producer_sequence: attempt.last_producer_sequence(),
        }
    }
}

impl From<AttemptSnapshot> for Attempt {
    fn from(snapshot: AttemptSnapshot) -> Self {
        Self {
            attempt_id: snapshot.attempt_id,
            ordinal: snapshot.ordinal,
            idempotency_key: snapshot.idempotency_key,
            status: snapshot.status,
            worker_run_id: snapshot.worker_run_id,
            lease: snapshot.lease,
            last_producer_sequence: snapshot.last_producer_sequence,
        }
    }
}

fn validate_aggregate(aggregate: &TaskAggregate) -> Result<(), TaskSnapshotError> {
    if aggregate.aggregate_version.get() != aggregate.task_stream_offset.get() {
        return Err(TaskSnapshotError::VersionOffsetMismatch);
    }
    let is_genesis = aggregate.aggregate_version == AggregateVersion::initial();
    if is_genesis != aggregate.last_event_id.is_none() {
        return Err(TaskSnapshotError::EventCursorMismatch);
    }
    if aggregate.progress_count > aggregate.aggregate_version.get() {
        return Err(TaskSnapshotError::ProgressCountOutOfRange);
    }

    validate_attempts(aggregate)?;
    if aggregate.aggregate_version.get() < minimum_event_count(aggregate) {
        return Err(TaskSnapshotError::HistoryCardinalityMismatch);
    }
    validate_lifecycle(aggregate)
}

fn minimum_event_count(aggregate: &TaskAggregate) -> u64 {
    let attempt_events = aggregate.attempts.iter().fold(0_u64, |count, attempt| {
        let transitions = match attempt.status {
            AttemptStatus::Created => 0,
            AttemptStatus::Started => 1,
            AttemptStatus::Suspended
            | AttemptStatus::Unknown
            | AttemptStatus::Succeeded
            | AttemptStatus::Failed => 2,
            AttemptStatus::Cancelled => {
                if attempt.last_producer_sequence.is_some() {
                    2
                } else {
                    u64::from(attempt.worker_run_id.is_some())
                }
            }
        };
        count + 1 + transitions
    });
    attempt_events
        + u64::from(matches!(
            aggregate.status,
            TaskStatus::Failed | TaskStatus::Cancelled
        ))
}

fn validate_attempts(aggregate: &TaskAggregate) -> Result<(), TaskSnapshotError> {
    let mut ids = BTreeSet::new();
    for (index, attempt) in aggregate.attempts.iter().enumerate() {
        if !ids.insert(&attempt.attempt_id) {
            return Err(TaskSnapshotError::DuplicateAttemptId);
        }
        if attempt.ordinal.get() != u16::try_from(index + 1).unwrap_or(u16::MAX) {
            return Err(TaskSnapshotError::AttemptOrdinalMismatch);
        }
        validate_attempt_shape(attempt)?;
        if index + 1 < aggregate.attempts.len()
            && !matches!(
                attempt.status,
                AttemptStatus::Failed | AttemptStatus::Cancelled
            )
        {
            return Err(TaskSnapshotError::LifecycleMismatch);
        }
    }

    match (
        aggregate.attempts.last(),
        aggregate.active_attempt_id.as_ref(),
    ) {
        (None, None) => Ok(()),
        (Some(last), Some(active)) if &last.attempt_id == active => Ok(()),
        (None, Some(_)) | (Some(_), None) | (Some(_), Some(_)) => {
            Err(TaskSnapshotError::ActiveAttemptMismatch)
        }
    }
}

fn validate_attempt_shape(attempt: &Attempt) -> Result<(), TaskSnapshotError> {
    let has_worker = attempt.worker_run_id.is_some();
    let has_lease = attempt.lease.is_some();
    let has_sequence = attempt.last_producer_sequence.is_some();
    let valid = match attempt.status {
        AttemptStatus::Created => !has_worker && !has_lease && !has_sequence,
        AttemptStatus::Started => has_worker && has_lease,
        AttemptStatus::Suspended
        | AttemptStatus::Unknown
        | AttemptStatus::Succeeded
        | AttemptStatus::Failed => has_worker && has_lease && has_sequence,
        AttemptStatus::Cancelled => has_worker == has_lease && (!has_sequence || has_worker),
    };
    if valid {
        Ok(())
    } else {
        Err(TaskSnapshotError::AttemptShapeMismatch)
    }
}

fn validate_lifecycle(aggregate: &TaskAggregate) -> Result<(), TaskSnapshotError> {
    let active_status = aggregate.active_attempt().map(Attempt::status);
    let valid = match aggregate.status {
        TaskStatus::Created => {
            aggregate.aggregate_version == AggregateVersion::initial()
                && aggregate.attempts.is_empty()
                && aggregate.suspension_reason.is_none()
        }
        TaskStatus::Queued => {
            active_status == Some(AttemptStatus::Created) && aggregate.suspension_reason.is_none()
        }
        TaskStatus::Running => {
            active_status == Some(AttemptStatus::Started) && aggregate.suspension_reason.is_none()
        }
        TaskStatus::Suspended => match aggregate.suspension_reason {
            Some(SuspensionReason::RetryDecision) => matches!(
                active_status,
                Some(AttemptStatus::Failed | AttemptStatus::Cancelled)
            ),
            Some(SuspensionReason::ProviderPaused | SuspensionReason::ApprovalRequired) => {
                active_status == Some(AttemptStatus::Suspended)
            }
            None => false,
        },
        TaskStatus::Reconciling => {
            active_status == Some(AttemptStatus::Unknown) && aggregate.suspension_reason.is_none()
        }
        TaskStatus::Completed => {
            active_status == Some(AttemptStatus::Succeeded) && aggregate.suspension_reason.is_none()
        }
        TaskStatus::Failed => {
            matches!(
                active_status,
                Some(AttemptStatus::Failed | AttemptStatus::Cancelled)
            ) && aggregate.suspension_reason.is_none()
        }
        TaskStatus::Cancelled => {
            matches!(
                active_status,
                None | Some(AttemptStatus::Cancelled | AttemptStatus::Failed)
            ) && aggregate.suspension_reason.is_none()
        }
    };
    if valid {
        Ok(())
    } else {
        Err(TaskSnapshotError::LifecycleMismatch)
    }
}
