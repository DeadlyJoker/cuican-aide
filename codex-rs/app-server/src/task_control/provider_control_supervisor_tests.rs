use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use crewon_state::ProviderRunJournalKey;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::ProviderRunJournalStatus;
use crewon_state::ProviderRunSupervisionQuery;
use crewon_state::TaskOutboxStatus;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::ExecutorRunRef;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerCancellation;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerExecutor;
use crewon_task_runtime::WorkerExecutorError;
use crewon_task_runtime::WorkerReconciliation;
use crewon_task_runtime::decide_command;
use pretty_assertions::assert_eq;

use super::cloud_execution_resolver::tests::FixtureOptions;
use super::cloud_execution_resolver::tests::fixture;
use super::provider_control_supervisor::ProviderControlSupervisor;
use super::provider_control_supervisor::ProviderControlSupervisorConfig;
use super::provider_control_supervisor::ProviderControlSupervisorReport;
use super::provider_control_supervisor::ProviderEventPump;
use super::task_state_store_adapter::TaskStateStoreAdapter;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn successful_dispatch_is_delivered_after_exact_worker_call() {
    let fixture = fixture(FixtureOptions::default()).await;
    let executor = Arc::new(RecordingExecutor::new(Ok(())));
    let supervisor = ProviderControlSupervisor::new(
        fixture.state.clone(),
        executor.clone(),
        ProviderControlSupervisorConfig {
            outbox_limit: 10,
            recovery_limit: 10,
            operation_timeout: Duration::from_secs(30),
            base_backoff_seconds: 1,
            max_backoff_seconds: 60,
            successful_poll_seconds: 1,
        }
        .validate()
        .expect("supervisor config"),
    );

    assert_eq!(
        supervisor
            .run_once(/*now*/ 150)
            .await
            .expect("supervisor tick"),
        ProviderControlSupervisorReport {
            inspected: 1,
            delivered: 1,
            deferred: 0,
            conflicted: 0,
            recovery_inspected: 0,
            pumped: 0,
            recovery_deferred: 0,
            recovery_conflicted: 0,
        }
    );
    assert_eq!(executor.dispatches(), vec![fixture.dispatch]);
    let records = fixture
        .state
        .list_task_outbox_records("task-1", /*limit*/ 100)
        .await
        .expect("list outbox");
    assert_eq!(
        records
            .into_iter()
            .map(|record| (record.outbox_id, record.status))
            .collect::<Vec<_>>(),
        vec![
            ("accept-outbox".to_string(), TaskOutboxStatus::Pending),
            ("claim-outbox".to_string(), TaskOutboxStatus::Delivered),
        ]
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn unavailable_dispatch_is_durably_deferred_with_bounded_backoff() {
    let fixture = fixture(FixtureOptions::default()).await;
    let supervisor = ProviderControlSupervisor::new(
        fixture.state.clone(),
        Arc::new(RecordingExecutor::new(Err(
            WorkerExecutorError::Unavailable,
        ))),
        ProviderControlSupervisorConfig {
            outbox_limit: 10,
            recovery_limit: 10,
            operation_timeout: Duration::from_secs(30),
            base_backoff_seconds: 2,
            max_backoff_seconds: 60,
            successful_poll_seconds: 1,
        }
        .validate()
        .expect("supervisor config"),
    );

    assert_eq!(
        supervisor
            .run_once(/*now*/ 150)
            .await
            .expect("supervisor tick"),
        ProviderControlSupervisorReport {
            inspected: 1,
            delivered: 0,
            deferred: 1,
            conflicted: 0,
            recovery_inspected: 0,
            pumped: 0,
            recovery_deferred: 0,
            recovery_conflicted: 0,
        }
    );
    assert!(
        fixture
            .state
            .list_pending_task_worker_outbox_records(/*now*/ 151, /*limit*/ 100)
            .await
            .expect("outbox remains delayed")
            .is_empty()
    );
    let pending = fixture
        .state
        .list_pending_task_worker_outbox_records(/*now*/ 152, /*limit*/ 100)
        .await
        .expect("outbox becomes available");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].outbox_id, "claim-outbox");
    assert_eq!(pending[0].delivery_attempts, 1);
    assert_eq!(pending[0].available_at, 152);

    fixture.state.close().await;
}

#[tokio::test]
async fn due_provider_run_pumps_exact_claim_and_schedules_next_page() {
    let fixture = fixture(FixtureOptions::default()).await;
    let journal = starting_journal(&fixture);
    fixture
        .state
        .create_provider_run_journal_record(&journal)
        .await
        .expect("create Provider Run journal");
    fixture
        .state
        .mark_task_outbox_delivered_if_attempt(
            "claim-outbox",
            /*expected_delivery_attempts*/ 0,
            /*delivered_at*/ 150,
        )
        .await
        .expect("deliver dispatch outbox");
    let executor = Arc::new(RecordingExecutor::new(Ok(())));
    let supervisor = ProviderControlSupervisor::new(
        fixture.state.clone(),
        executor.clone(),
        ProviderControlSupervisorConfig {
            outbox_limit: 10,
            recovery_limit: 10,
            operation_timeout: Duration::from_secs(30),
            base_backoff_seconds: 2,
            max_backoff_seconds: 60,
            successful_poll_seconds: 1,
        }
        .validate()
        .expect("supervisor config"),
    );

    assert_eq!(
        supervisor
            .run_once(/*now*/ 150)
            .await
            .expect("supervisor tick"),
        ProviderControlSupervisorReport {
            inspected: 0,
            delivered: 0,
            deferred: 0,
            conflicted: 0,
            recovery_inspected: 1,
            pumped: 1,
            recovery_deferred: 0,
            recovery_conflicted: 0,
        }
    );
    assert_eq!(executor.pumps(), vec![fixture.dispatch]);
    assert!(
        fixture
            .state
            .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
                after: None,
                now: 150,
                limit: 100,
            })
            .await
            .expect("poll is scheduled")
            .is_empty()
    );
    let due = fixture
        .state
        .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
            after: None,
            now: 151,
            limit: 100,
        })
        .await
        .expect("next poll becomes due");
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].poll_attempts, 0);

    fixture.state.close().await;
}

#[tokio::test]
async fn unavailable_event_page_is_durably_deferred_without_losing_run() {
    let fixture = fixture(FixtureOptions::default()).await;
    fixture
        .state
        .create_provider_run_journal_record(&starting_journal(&fixture))
        .await
        .expect("create Provider Run journal");
    fixture
        .state
        .mark_task_outbox_delivered_if_attempt(
            "claim-outbox",
            /*expected_delivery_attempts*/ 0,
            /*delivered_at*/ 150,
        )
        .await
        .expect("deliver dispatch outbox");
    let supervisor = ProviderControlSupervisor::new(
        fixture.state.clone(),
        Arc::new(RecordingExecutor::new(Err(
            WorkerExecutorError::Unavailable,
        ))),
        ProviderControlSupervisorConfig {
            outbox_limit: 10,
            recovery_limit: 10,
            operation_timeout: Duration::from_secs(30),
            base_backoff_seconds: 2,
            max_backoff_seconds: 60,
            successful_poll_seconds: 1,
        }
        .validate()
        .expect("supervisor config"),
    );

    assert_eq!(
        supervisor
            .run_once(/*now*/ 150)
            .await
            .expect("supervisor tick"),
        ProviderControlSupervisorReport {
            inspected: 0,
            delivered: 0,
            deferred: 0,
            conflicted: 0,
            recovery_inspected: 1,
            pumped: 0,
            recovery_deferred: 1,
            recovery_conflicted: 0,
        }
    );
    assert!(
        fixture
            .state
            .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
                after: None,
                now: 151,
                limit: 100,
            })
            .await
            .expect("poll remains delayed")
            .is_empty()
    );
    let due = fixture
        .state
        .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
            after: None,
            now: 152,
            limit: 100,
        })
        .await
        .expect("retry becomes due");
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].poll_attempts, 1);

    fixture.state.close().await;
}

#[tokio::test]
async fn cancelled_task_skips_stale_dispatch_and_delivers_exact_cancel() {
    let fixture = fixture(FixtureOptions::default()).await;
    let store = TaskStateStoreAdapter::new(fixture.state.clone());
    let current = store
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read running Task")
        .expect("Task exists");
    let command = TaskCommandEnvelope {
        command_id: CommandId::new("supervisor-cancel-command").expect("command id"),
        event_id: EventId::new("supervisor-cancel-event").expect("event id"),
        task_id: fixture.dispatch.control().task_id().clone(),
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(/*value*/ 145).expect("occurred at"),
        received_at: UnixTimestamp::new(/*value*/ 145).expect("received at"),
        command: TaskCommand::CancelTask,
    };
    let decision = decide_command(&current, &command).expect("cancel decision");
    let commit = TaskCommit::from_decision(
        &current,
        &command,
        OutboxId::new("supervisor-cancel-outbox").expect("outbox id"),
        decision,
    )
    .expect("cancel commit");
    assert!(matches!(
        store.commit(commit).await.expect("commit cancellation"),
        TaskCommitOutcome::Committed(_)
    ));

    let executor = Arc::new(RecordingExecutor::new(Ok(())));
    let supervisor = ProviderControlSupervisor::new(
        fixture.state.clone(),
        executor.clone(),
        ProviderControlSupervisorConfig {
            outbox_limit: 10,
            recovery_limit: 10,
            operation_timeout: Duration::from_secs(30),
            base_backoff_seconds: 1,
            max_backoff_seconds: 60,
            successful_poll_seconds: 1,
        }
        .validate()
        .expect("supervisor config"),
    );

    assert_eq!(
        supervisor
            .run_once(/*now*/ 150)
            .await
            .expect("supervisor tick"),
        ProviderControlSupervisorReport {
            inspected: 2,
            delivered: 2,
            deferred: 0,
            conflicted: 0,
            recovery_inspected: 0,
            pumped: 0,
            recovery_deferred: 0,
            recovery_conflicted: 0,
        }
    );
    assert!(executor.dispatches().is_empty());
    assert_eq!(executor.cancellations().len(), 1);
    let records = fixture
        .state
        .list_task_outbox_records("task-1", /*limit*/ 100)
        .await
        .expect("list outbox");
    assert_eq!(
        records
            .iter()
            .filter(|record| matches!(
                record.outbox_id.as_str(),
                "claim-outbox" | "supervisor-cancel-outbox"
            ))
            .map(|record| (record.outbox_id.as_str(), record.status))
            .collect::<Vec<_>>(),
        vec![
            ("claim-outbox", TaskOutboxStatus::Delivered),
            ("supervisor-cancel-outbox", TaskOutboxStatus::Delivered),
        ]
    );
    fixture.state.close().await;
}

struct RecordingExecutor {
    dispatch_result: Result<(), WorkerExecutorError>,
    dispatches: Mutex<Vec<WorkerDispatch>>,
    cancellations: Mutex<Vec<WorkerCancellation>>,
    pumps: Mutex<Vec<WorkerDispatch>>,
}

impl RecordingExecutor {
    fn new(dispatch_result: Result<(), WorkerExecutorError>) -> Self {
        Self {
            dispatch_result,
            dispatches: Mutex::new(Vec::new()),
            cancellations: Mutex::new(Vec::new()),
            pumps: Mutex::new(Vec::new()),
        }
    }

    fn dispatches(&self) -> Vec<WorkerDispatch> {
        self.dispatches.lock().expect("dispatch lock").clone()
    }

    fn pumps(&self) -> Vec<WorkerDispatch> {
        self.pumps.lock().expect("pump lock").clone()
    }

    fn cancellations(&self) -> Vec<WorkerCancellation> {
        self.cancellations
            .lock()
            .expect("cancellation lock")
            .clone()
    }
}

impl ProviderEventPump for RecordingExecutor {
    async fn pump_event_page(&self, dispatch: WorkerDispatch) -> Result<(), WorkerExecutorError> {
        self.pumps.lock().expect("pump lock").push(dispatch);
        self.dispatch_result
    }
}

fn starting_journal(
    fixture: &super::cloud_execution_resolver::tests::Fixture,
) -> ProviderRunJournalRecord {
    let mut record = ProviderRunJournalRecord {
        key: ProviderRunJournalKey {
            task_id: "task-1".to_string(),
            attempt_id: "attempt-1".to_string(),
            worker_run_id: "worker-1".to_string(),
        },
        journal_version: 0,
        execution_spec_id: fixture.spec.execution_spec_id.clone(),
        execution_spec_revision: fixture.spec.revision,
        execution_spec_digest: fixture.spec.digest.clone(),
        provider_id: fixture.spec.provider_id.clone(),
        protocol_version: fixture.spec.protocol_version.clone(),
        resource_id: fixture.spec.resource_id.clone(),
        resource_revision: fixture.spec.resource_revision.clone(),
        credential_id: fixture.spec.credential_id.clone(),
        credential_revision: fixture.spec.credential_revision,
        provider_run_id: "provider-run-supervised".to_string(),
        provider_attempt_id: "provider-attempt-supervised".to_string(),
        provider_revision: None,
        last_sequence: 0,
        last_cursor: None,
        status: ProviderRunJournalStatus::Starting,
        start_command_id: "supervised-start-command".to_string(),
        start_idempotency_key: "supervised-start-idempotency".to_string(),
        request_digest: HASH_A.to_string(),
        record_hash: String::new(),
        created_at: 140,
        updated_at: 140,
    };
    record.record_hash = record.canonical_hash();
    record
}

impl WorkerExecutor for RecordingExecutor {
    async fn start(&self, dispatch: WorkerDispatch) -> Result<ExecutorRunRef, WorkerExecutorError> {
        self.dispatches
            .lock()
            .expect("dispatch lock")
            .push(dispatch);
        self.dispatch_result?;
        ExecutorRunRef::new("provider-run-1").map_err(|_| WorkerExecutorError::InvalidResponse)
    }

    async fn cancel(&self, cancellation: WorkerCancellation) -> Result<(), WorkerExecutorError> {
        self.cancellations
            .lock()
            .expect("cancellation lock")
            .push(cancellation);
        self.dispatch_result
    }

    async fn reconcile(
        &self,
        _reconciliation: WorkerReconciliation,
    ) -> Result<ExecutorRunRef, WorkerExecutorError> {
        Err(WorkerExecutorError::Unsupported)
    }
}
