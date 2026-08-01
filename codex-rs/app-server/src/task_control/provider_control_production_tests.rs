use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crewon_task_runtime::ExecutorRunRef;
use crewon_task_runtime::WorkerCancellation;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerExecutor;
use crewon_task_runtime::WorkerExecutorError;
use crewon_task_runtime::WorkerReconciliation;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::cloud_execution_resolver::tests::FixtureOptions;
use super::cloud_execution_resolver::tests::fixture;
use super::provider_control_production::ProviderControlRuntime;
use super::provider_control_production::durable_cloud_agent_enabled;
use super::provider_control_production::prepare_provider_control_runtime;
use super::provider_control_supervisor::ProviderControlSupervisor;
use super::provider_control_supervisor::ProviderControlSupervisorConfig;
use super::provider_control_supervisor::ProviderEventPump;

#[test]
fn provider_control_is_default_off_and_rejects_invalid_flags() {
    assert!(
        prepare_provider_control_runtime(
            &HashMap::new(),
            /*state*/ None,
            /*provider_runtime*/ None
        )
        .expect("disabled Provider control")
        .is_none()
    );
    assert!(
        prepare_provider_control_runtime(
            &HashMap::from([(
                "CREWON_PROVIDER_CONTROL_ENABLED".to_string(),
                "sometimes".to_string(),
            )]),
            /*state*/ None,
            /*provider_runtime*/ None,
        )
        .is_err()
    );
}

#[test]
fn enabled_provider_control_requires_all_prepared_dependencies() {
    let enabled = HashMap::from([(
        "CREWON_PROVIDER_CONTROL_ENABLED".to_string(),
        "true".to_string(),
    )]);
    assert!(
        prepare_provider_control_runtime(
            &enabled, /*state*/ None, /*provider_runtime*/ None
        )
        .is_err()
    );
}

#[test]
fn durable_cloud_agent_is_default_off_and_requires_provider_control() {
    assert!(
        !durable_cloud_agent_enabled(&HashMap::new(), /*provider_control_available*/ false,)
            .expect("default disabled")
    );
    let enabled = HashMap::from([(
        "CREWON_DURABLE_CLOUD_AGENT_ENABLED".to_string(),
        "true".to_string(),
    )]);
    assert!(durable_cloud_agent_enabled(&enabled, /*provider_control_available*/ false).is_err());
    assert!(
        durable_cloud_agent_enabled(&enabled, /*provider_control_available*/ true)
            .expect("enabled with Task Control")
    );
    assert!(
        durable_cloud_agent_enabled(
            &HashMap::from([(
                "CREWON_DURABLE_CLOUD_AGENT_ENABLED".to_string(),
                "sometimes".to_string(),
            )]),
            /*provider_control_available*/ true,
        )
        .is_err()
    );
}

#[tokio::test]
async fn shutdown_cancels_in_flight_tick_and_leaves_outbox_recoverable() {
    let fixture = fixture(FixtureOptions::default()).await;
    let started = Arc::new(Notify::new());
    let executor = Arc::new(BlockingExecutor {
        started: started.clone(),
    });
    let supervisor = Arc::new(ProviderControlSupervisor::new(
        fixture.state.clone(),
        executor,
        ProviderControlSupervisorConfig {
            outbox_limit: 1,
            recovery_limit: 1,
            operation_timeout: Duration::from_secs(30),
            base_backoff_seconds: 1,
            max_backoff_seconds: 60,
            successful_poll_seconds: 1,
        }
        .validate()
        .expect("supervisor config"),
    ));
    let shutdown = CancellationToken::new();
    let handle = ProviderControlRuntime::new(supervisor, Arc::new(|| 150)).start(shutdown.clone());
    started.notified().await;
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(1), handle)
        .await
        .expect("Provider control stops promptly")
        .expect("Provider control task joins");

    let pending = fixture
        .state
        .list_pending_task_worker_outbox_records(i64::MAX, /*limit*/ 100)
        .await
        .expect("outbox remains recoverable");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].outbox_id, "claim-outbox");
    assert_eq!(pending[0].delivery_attempts, 0);

    fixture.state.close().await;
}

struct BlockingExecutor {
    started: Arc<Notify>,
}

impl WorkerExecutor for BlockingExecutor {
    async fn start(
        &self,
        _dispatch: WorkerDispatch,
    ) -> Result<ExecutorRunRef, WorkerExecutorError> {
        self.started.notify_one();
        std::future::pending().await
    }

    async fn cancel(&self, _cancellation: WorkerCancellation) -> Result<(), WorkerExecutorError> {
        Err(WorkerExecutorError::Unsupported)
    }

    async fn reconcile(
        &self,
        _reconciliation: WorkerReconciliation,
    ) -> Result<ExecutorRunRef, WorkerExecutorError> {
        Err(WorkerExecutorError::Unsupported)
    }
}

impl ProviderEventPump for BlockingExecutor {
    async fn pump_event_page(&self, _dispatch: WorkerDispatch) -> Result<(), WorkerExecutorError> {
        Err(WorkerExecutorError::Unsupported)
    }
}
