use crate::AttemptId;
use crate::AttemptStatus;
use crate::ExecutionSpecRef;
use crate::ExecutorRunRef;
use crate::IdempotencyKey;
use crate::LeaseGrant;
use crate::TaskAggregate;
use crate::TaskError;
use crate::TaskId;
use crate::TaskStatus;
use crate::UnixTimestamp;
use crate::WorkerRunId;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::WorkspaceKey;

/// Fenced identity embedded in a typed Worker operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerControl {
    task_id: TaskId,
    attempt_id: AttemptId,
    worker_run_id: WorkerRunId,
    lease: LeaseGrant,
}

impl WorkerControl {
    fn from_aggregate(aggregate: &TaskAggregate, now: UnixTimestamp) -> Result<Self, TaskError> {
        let control = Self::from_current_attempt(aggregate)?;
        if control.lease.is_expired_at(now) {
            return Err(TaskError::LeaseExpired);
        }
        Ok(control)
    }

    fn from_current_attempt(aggregate: &TaskAggregate) -> Result<Self, TaskError> {
        let attempt = aggregate
            .active_attempt()
            .ok_or(TaskError::AttemptMissing)?;
        let worker_run_id = attempt
            .worker_run_id()
            .ok_or(TaskError::WorkerRunMismatch)?;
        let lease = attempt.lease().ok_or(TaskError::LeaseMissing)?;
        Ok(Self {
            task_id: aggregate.contract().task_id().clone(),
            attempt_id: attempt.attempt_id().clone(),
            worker_run_id: worker_run_id.clone(),
            lease: lease.clone(),
        })
    }

    /// Returns the owning Task.
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    /// Returns the Authority-created Attempt.
    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }

    /// Returns the current Worker claim.
    pub fn worker_run_id(&self) -> &WorkerRunId {
        &self.worker_run_id
    }

    /// Returns the current fencing lease.
    pub fn lease(&self) -> &LeaseGrant {
        &self.lease
    }
}

/// Immutable dispatch sent only for an already claimed running Attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerDispatch {
    control: WorkerControl,
    idempotency_key: IdempotencyKey,
    workspace_key: WorkspaceKey,
    execution_spec: ExecutionSpecRef,
    bindings: Vec<ResolvedResourceBinding>,
}

impl WorkerDispatch {
    /// Builds a dispatch from current authoritative state and current time.
    pub fn from_aggregate(
        aggregate: &TaskAggregate,
        now: UnixTimestamp,
    ) -> Result<Self, TaskError> {
        if aggregate.status() != TaskStatus::Running {
            return Err(TaskError::InvalidTransition);
        }
        let attempt = aggregate
            .active_attempt()
            .ok_or(TaskError::AttemptMissing)?;
        if attempt.status() != AttemptStatus::Started {
            return Err(TaskError::InvalidTransition);
        }
        Ok(Self {
            control: WorkerControl::from_aggregate(aggregate, now)?,
            idempotency_key: attempt.idempotency_key().clone(),
            workspace_key: aggregate.contract().workspace_key().clone(),
            execution_spec: aggregate.contract().execution_spec().clone(),
            bindings: aggregate.contract().bindings().to_vec(),
        })
    }

    /// Rebuilds the exact current claim for Provider event supervision.
    ///
    /// Non-terminal Tasks still require a live lease. A terminal Task may retain its final
    /// expired claim so a restarted event pump can finish Provider journal audit without
    /// reopening Task authority or applying another Task transition.
    pub fn for_event_supervision(
        aggregate: &TaskAggregate,
        now: UnixTimestamp,
    ) -> Result<Self, TaskError> {
        if matches!(aggregate.status(), TaskStatus::Created | TaskStatus::Queued) {
            return Err(TaskError::InvalidTransition);
        }
        let control = if aggregate.status().is_terminal() {
            WorkerControl::from_current_attempt(aggregate)?
        } else {
            WorkerControl::from_aggregate(aggregate, now)?
        };
        let attempt = aggregate
            .active_attempt()
            .ok_or(TaskError::AttemptMissing)?;
        Ok(Self {
            control,
            idempotency_key: attempt.idempotency_key().clone(),
            workspace_key: aggregate.contract().workspace_key().clone(),
            execution_spec: aggregate.contract().execution_spec().clone(),
            bindings: aggregate.contract().bindings().to_vec(),
        })
    }

    /// Returns the fenced Worker identity.
    pub fn control(&self) -> &WorkerControl {
        &self.control
    }

    /// Returns the stable start idempotency key.
    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    /// Returns the authoritative workspace registry key.
    pub fn workspace_key(&self) -> &WorkspaceKey {
        &self.workspace_key
    }

    /// Returns the immutable execution input reference bound into the Task Contract.
    pub fn execution_spec(&self) -> &ExecutionSpecRef {
        &self.execution_spec
    }

    /// Returns exact resolved resource bindings.
    pub fn bindings(&self) -> &[ResolvedResourceBinding] {
        &self.bindings
    }
}

/// Typed cancellation request for a current non-terminal Worker Attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerCancellation(WorkerControl);

impl WorkerCancellation {
    /// Builds cancellation evidence for an active or Authority-cancelled Worker Attempt.
    ///
    /// A committed `CancelTask` retains the final claim so its durable Outbox can deliver
    /// Provider cancellation after restart, even after the former lease expires.
    pub fn from_aggregate(
        aggregate: &TaskAggregate,
        now: UnixTimestamp,
    ) -> Result<Self, TaskError> {
        if aggregate.status() == TaskStatus::Cancelled
            && aggregate
                .active_attempt()
                .map(super::aggregate::Attempt::status)
                == Some(AttemptStatus::Cancelled)
        {
            return WorkerControl::from_current_attempt(aggregate).map(Self);
        }
        if !matches!(
            aggregate.status(),
            TaskStatus::Running | TaskStatus::Suspended | TaskStatus::Reconciling
        ) {
            return Err(TaskError::InvalidTransition);
        }
        let attempt = aggregate
            .active_attempt()
            .ok_or(TaskError::AttemptMissing)?;
        if attempt.status().is_terminal() {
            return Err(TaskError::InvalidTransition);
        }
        WorkerControl::from_aggregate(aggregate, now).map(Self)
    }

    /// Returns the fenced Worker identity being cancelled.
    pub fn control(&self) -> &WorkerControl {
        &self.0
    }
}

/// Typed read of the same Worker run after an unknown outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerReconciliation(WorkerControl);

impl WorkerReconciliation {
    /// Builds reconciliation evidence only for the current Unknown Attempt.
    pub fn from_aggregate(
        aggregate: &TaskAggregate,
        now: UnixTimestamp,
    ) -> Result<Self, TaskError> {
        if aggregate.status() != TaskStatus::Reconciling
            || aggregate
                .active_attempt()
                .map(super::aggregate::Attempt::status)
                != Some(AttemptStatus::Unknown)
        {
            return Err(TaskError::InvalidTransition);
        }
        WorkerControl::from_aggregate(aggregate, now).map(Self)
    }

    /// Returns the fenced Worker identity being reconciled.
    pub fn control(&self) -> &WorkerControl {
        &self.0
    }
}

/// Safe failure categories returned by a Worker adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerExecutorError {
    Unauthorized,
    Unsupported,
    Unavailable,
    InvalidResponse,
    OutcomeUnknown,
}

/// Transport-neutral Worker execution port.
///
/// Implementations start, cancel, or reconcile an Authority-created Attempt.
/// They must never create an Attempt, choose retry, or mutate Task state.
pub trait WorkerExecutor: Send + Sync {
    /// Starts the already claimed Attempt idempotently.
    fn start(
        &self,
        dispatch: WorkerDispatch,
    ) -> impl std::future::Future<Output = Result<ExecutorRunRef, WorkerExecutorError>> + Send;

    /// Requests cancellation of the current fenced Worker run.
    fn cancel(
        &self,
        cancellation: WorkerCancellation,
    ) -> impl std::future::Future<Output = Result<(), WorkerExecutorError>> + Send;

    /// Reads the same run after an unknown outcome; it does not start a retry.
    fn reconcile(
        &self,
        reconciliation: WorkerReconciliation,
    ) -> impl std::future::Future<Output = Result<ExecutorRunRef, WorkerExecutorError>> + Send;
}
