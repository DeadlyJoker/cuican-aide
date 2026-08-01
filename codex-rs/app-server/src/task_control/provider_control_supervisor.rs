use std::sync::Arc;
use std::time::Duration;

use crewon_state::ProviderRunSupervisionQuery;
use crewon_state::ProviderRunSupervisionRecord;
use crewon_state::ProviderRunSupervisionUpdate;
use crewon_state::ProviderRunSupervisionUpdateOutcome;
use crewon_state::StateRuntime;
use crewon_state::TaskOutboxDeferOutcome;
use crewon_state::TaskOutboxDeliveryOutcome;
use crewon_state::TaskStoredOutboxRecord;
use crewon_task_runtime::SchedulerDecision;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStatus;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerCancellation;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerExecutor;
use crewon_task_runtime::WorkerExecutorError;
use crewon_task_runtime::WorkerReconciliation;
use tokio::time::timeout;

use super::task_state_store_adapter::TaskStateStoreAdapter;

const MAX_OUTBOX_PAGE: u32 = 100;
const MAX_OPERATION_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_BACKOFF_SECONDS: i64 = 3_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ProviderControlSupervisorConfig {
    pub(super) outbox_limit: u32,
    pub(super) recovery_limit: u32,
    pub(super) operation_timeout: Duration,
    pub(super) base_backoff_seconds: i64,
    pub(super) max_backoff_seconds: i64,
    pub(super) successful_poll_seconds: i64,
}

impl ProviderControlSupervisorConfig {
    pub(super) fn validate(self) -> Result<Self, ProviderControlSupervisorError> {
        if self.outbox_limit == 0
            || self.outbox_limit > MAX_OUTBOX_PAGE
            || self.recovery_limit == 0
            || self.recovery_limit > MAX_OUTBOX_PAGE
            || self.operation_timeout.is_zero()
            || self.operation_timeout > MAX_OPERATION_TIMEOUT
            || self.base_backoff_seconds <= 0
            || self.max_backoff_seconds < self.base_backoff_seconds
            || self.max_backoff_seconds > MAX_BACKOFF_SECONDS
            || self.successful_poll_seconds <= 0
            || self.successful_poll_seconds > MAX_BACKOFF_SECONDS
        {
            return Err(ProviderControlSupervisorError::InvalidConfiguration);
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ProviderControlSupervisorReport {
    pub(super) inspected: u32,
    pub(super) delivered: u32,
    pub(super) deferred: u32,
    pub(super) conflicted: u32,
    pub(super) recovery_inspected: u32,
    pub(super) pumped: u32,
    pub(super) recovery_deferred: u32,
    pub(super) recovery_conflicted: u32,
}

/// Executes one bounded Provider event page for an already admitted Worker claim.
///
/// Implementations must not create Attempts, choose retries, or bypass Task fencing.
pub(super) trait ProviderEventPump: Send + Sync {
    fn pump_event_page(
        &self,
        dispatch: WorkerDispatch,
    ) -> impl std::future::Future<Output = Result<(), WorkerExecutorError>> + Send;
}

pub(super) struct ProviderControlSupervisor<Executor> {
    state: Arc<StateRuntime>,
    executor: Arc<Executor>,
    config: ProviderControlSupervisorConfig,
}

impl<Executor> ProviderControlSupervisor<Executor>
where
    Executor: WorkerExecutor + ProviderEventPump,
{
    pub(super) fn new(
        state: Arc<StateRuntime>,
        executor: Arc<Executor>,
        config: ProviderControlSupervisorConfig,
    ) -> Self {
        Self {
            state,
            executor,
            config,
        }
    }

    pub(super) async fn run_once(
        &self,
        now: i64,
    ) -> Result<ProviderControlSupervisorReport, ProviderControlSupervisorError> {
        if now < 0 {
            return Err(ProviderControlSupervisorError::InvalidTime);
        }
        let records = self
            .state
            .list_pending_task_worker_outbox_records(now, self.config.outbox_limit)
            .await
            .map_err(|_| ProviderControlSupervisorError::StateUnavailable)?;
        let mut report = ProviderControlSupervisorReport::default();
        for record in records {
            report.inspected += 1;
            match self.deliver(&record, now).await {
                Ok(()) => self.mark_delivered(&record, now, &mut report).await?,
                Err(_) => self.defer(&record, now, &mut report).await?,
            }
        }
        let recoverable = self
            .state
            .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
                after: None,
                now,
                limit: self.config.recovery_limit,
            })
            .await
            .map_err(|_| ProviderControlSupervisorError::StateUnavailable)?;
        for record in recoverable {
            report.recovery_inspected += 1;
            let outcome = self.pump(&record, now).await;
            self.schedule_next_poll(&record, now, outcome.is_ok(), &mut report)
                .await?;
        }
        Ok(report)
    }

    async fn deliver(
        &self,
        record: &TaskStoredOutboxRecord,
        now: i64,
    ) -> Result<(), WorkerExecutorError> {
        let decision = serde_json::from_str::<SchedulerDecision>(&record.payload_json)
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        if decision_type(&decision) != record.decision_type {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        let task_id =
            TaskId::new(&record.task_id).map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let task = TaskStateStoreAdapter::new(self.state.clone())
            .read(task_id)
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        if task.status().is_terminal() {
            let current_cancel = task.status() == TaskStatus::Cancelled
                && matches!(decision, SchedulerDecision::CancelAttempt { .. });
            if !current_cancel {
                return Ok(());
            }
        }
        let now = UnixTimestamp::new(now).map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let operation = async {
            match decision {
                SchedulerDecision::DispatchAttempt {
                    attempt_id,
                    worker_run_id,
                } => {
                    let dispatch = WorkerDispatch::from_aggregate(&task, now)
                        .map_err(|_| WorkerExecutorError::InvalidResponse)?;
                    if dispatch.control().attempt_id() != &attempt_id
                        || dispatch.control().worker_run_id() != &worker_run_id
                    {
                        return Err(WorkerExecutorError::InvalidResponse);
                    }
                    self.executor.start(dispatch).await.map(|_| ())
                }
                SchedulerDecision::CancelAttempt {
                    attempt_id,
                    worker_run_id,
                } => {
                    let cancellation = WorkerCancellation::from_aggregate(&task, now)
                        .map_err(|_| WorkerExecutorError::InvalidResponse)?;
                    if cancellation.control().attempt_id() != &attempt_id
                        || cancellation.control().worker_run_id() != &worker_run_id
                    {
                        return Err(WorkerExecutorError::InvalidResponse);
                    }
                    self.executor.cancel(cancellation).await
                }
                SchedulerDecision::ReconcileAttempt {
                    attempt_id,
                    worker_run_id,
                } => {
                    let reconciliation = WorkerReconciliation::from_aggregate(&task, now)
                        .map_err(|_| WorkerExecutorError::InvalidResponse)?;
                    if reconciliation.control().attempt_id() != &attempt_id
                        || reconciliation.control().worker_run_id() != &worker_run_id
                    {
                        return Err(WorkerExecutorError::InvalidResponse);
                    }
                    self.executor.reconcile(reconciliation).await.map(|_| ())
                }
                SchedulerDecision::NoAction
                | SchedulerDecision::EnqueueAttempt { .. }
                | SchedulerDecision::AwaitResume { .. }
                | SchedulerDecision::AwaitRetryDecision { .. } => {
                    Err(WorkerExecutorError::InvalidResponse)
                }
            }
        };
        timeout(self.config.operation_timeout, operation)
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
    }

    async fn mark_delivered(
        &self,
        record: &TaskStoredOutboxRecord,
        now: i64,
        report: &mut ProviderControlSupervisorReport,
    ) -> Result<(), ProviderControlSupervisorError> {
        match self
            .state
            .mark_task_outbox_delivered_if_attempt(&record.outbox_id, record.delivery_attempts, now)
            .await
            .map_err(|_| ProviderControlSupervisorError::StateUnavailable)?
        {
            TaskOutboxDeliveryOutcome::Delivered | TaskOutboxDeliveryOutcome::AlreadyDelivered => {
                report.delivered += 1
            }
            TaskOutboxDeliveryOutcome::Conflict | TaskOutboxDeliveryOutcome::NotFound => {
                report.conflicted += 1;
            }
        }
        Ok(())
    }

    async fn defer(
        &self,
        record: &TaskStoredOutboxRecord,
        now: i64,
        report: &mut ProviderControlSupervisorReport,
    ) -> Result<(), ProviderControlSupervisorError> {
        let available_at = now.saturating_add(self.backoff_seconds(record.delivery_attempts));
        match self
            .state
            .defer_task_outbox_record(&record.outbox_id, record.delivery_attempts, available_at)
            .await
            .map_err(|_| ProviderControlSupervisorError::StateUnavailable)?
        {
            TaskOutboxDeferOutcome::Deferred => report.deferred += 1,
            TaskOutboxDeferOutcome::AlreadyDelivered => report.delivered += 1,
            TaskOutboxDeferOutcome::Conflict | TaskOutboxDeferOutcome::NotFound => {
                report.conflicted += 1;
            }
        }
        Ok(())
    }

    async fn pump(
        &self,
        record: &ProviderRunSupervisionRecord,
        now: i64,
    ) -> Result<(), WorkerExecutorError> {
        let task_id = TaskId::new(&record.journal.key.task_id)
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let task = TaskStateStoreAdapter::new(self.state.clone())
            .read(task_id)
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        let now = UnixTimestamp::new(now).map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let dispatch = WorkerDispatch::for_event_supervision(&task, now)
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        if dispatch.control().attempt_id().as_str() != record.journal.key.attempt_id
            || dispatch.control().worker_run_id().as_str() != record.journal.key.worker_run_id
        {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        timeout(
            self.config.operation_timeout,
            self.executor.pump_event_page(dispatch),
        )
        .await
        .map_err(|_| WorkerExecutorError::Unavailable)?
    }

    async fn schedule_next_poll(
        &self,
        record: &ProviderRunSupervisionRecord,
        now: i64,
        succeeded: bool,
        report: &mut ProviderControlSupervisorReport,
    ) -> Result<(), ProviderControlSupervisorError> {
        let (next_poll_attempts, delay) = if succeeded {
            (0, self.config.successful_poll_seconds)
        } else {
            (
                record.poll_attempts.saturating_add(1),
                self.backoff_seconds(record.poll_attempts),
            )
        };
        let update = ProviderRunSupervisionUpdate {
            key: record.journal.key.clone(),
            expected_poll_attempts: record.poll_attempts,
            expected_available_at: record.available_at,
            next_poll_attempts,
            available_at: now.saturating_add(delay),
            updated_at: now,
        };
        match self
            .state
            .schedule_provider_run_supervision(&update)
            .await
            .map_err(|_| ProviderControlSupervisorError::StateUnavailable)?
        {
            ProviderRunSupervisionUpdateOutcome::Updated if succeeded => report.pumped += 1,
            ProviderRunSupervisionUpdateOutcome::Updated => report.recovery_deferred += 1,
            ProviderRunSupervisionUpdateOutcome::Conflict
            | ProviderRunSupervisionUpdateOutcome::NotFound => {
                report.recovery_conflicted += 1;
            }
        }
        Ok(())
    }

    fn backoff_seconds(&self, delivery_attempts: u64) -> i64 {
        let exponent = u32::try_from(delivery_attempts.min(30)).unwrap_or(30);
        self.config
            .base_backoff_seconds
            .saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
            .min(self.config.max_backoff_seconds)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(super) enum ProviderControlSupervisorError {
    #[error("Provider control supervisor configuration is invalid")]
    InvalidConfiguration,
    #[error("Provider control supervisor time is invalid")]
    InvalidTime,
    #[error("Provider control supervisor State is unavailable")]
    StateUnavailable,
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
