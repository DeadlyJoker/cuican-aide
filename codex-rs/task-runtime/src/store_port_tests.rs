use super::*;
use crewon_resource_federation::WorkspaceKey;
use pretty_assertions::assert_eq;
use std::collections::BTreeMap;
use std::sync::Mutex;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn duplicate_command_receipt_reuses_snapshot_without_event_or_outbox_side_effect() {
    let store = InMemoryFakeStore::default();
    store
        .create_sync(TaskAggregate::new(contract()))
        .expect("create task");
    let command = command(
        "command-1",
        "event-1",
        TaskCommand::AcceptTask {
            attempt_id: attempt_id("attempt-1"),
            idempotency_key: idempotency_key("task-1:attempt-1"),
        },
    );

    let first = store
        .process_sync(command.clone(), outbox_id("outbox-1"))
        .expect("first commit");
    let after_first = store.domain_snapshot();
    let duplicate = store
        .process_sync(command, outbox_id("outbox-duplicate"))
        .expect("duplicate commit");

    assert!(matches!(first, TaskCommitOutcome::Committed(_)));
    assert!(matches!(duplicate, TaskCommitOutcome::Duplicate(_)));
    assert_eq!(store.domain_snapshot(), after_first);
    assert_eq!(after_first.events.len(), 1);
    assert_eq!(after_first.receipts.len(), 1);
    assert_eq!(after_first.outbox.len(), 1);
}

#[test]
fn duplicate_worker_event_uses_event_receipt_even_when_command_id_changes() {
    let store = running_store();
    let worker = worker_command("worker-command-1", "worker-event-1", 1);
    store
        .process_sync(worker.clone(), outbox_id("worker-outbox-1"))
        .expect("first worker event");
    let after_first = store.domain_snapshot();
    let mut retried_delivery = worker;
    retried_delivery.command_id = CommandId::new("worker-command-2").expect("command id");

    let duplicate = store
        .process_sync(retried_delivery, outbox_id("worker-outbox-2"))
        .expect("duplicate worker event");

    assert!(matches!(duplicate, TaskCommitOutcome::Duplicate(_)));
    assert_eq!(store.domain_snapshot(), after_first);
    assert_eq!(after_first.events.len(), 3);
    assert_eq!(after_first.outbox.len(), 2);
}

#[test]
fn worker_cancellation_commits_once_with_authority_decision_outbox() {
    let store = running_store();
    let worker = worker_command_with_outcome(
        "worker-cancel-command-1",
        "worker-cancel-event-1",
        1,
        WorkerOutcome::Cancelled,
    );
    let first = store
        .process_sync(worker.clone(), outbox_id("worker-cancel-outbox-1"))
        .expect("first worker cancellation");
    let after_first = store.domain_snapshot();
    let mut retried_delivery = worker;
    retried_delivery.command_id = CommandId::new("worker-cancel-command-2").expect("command id");
    let duplicate = store
        .process_sync(
            retried_delivery,
            outbox_id("worker-cancel-outbox-duplicate"),
        )
        .expect("duplicate worker cancellation");

    let TaskCommitOutcome::Committed(aggregate) = first else {
        panic!("first worker cancellation must commit");
    };
    assert_eq!(aggregate.status(), TaskStatus::Suspended);
    assert_eq!(
        aggregate.active_attempt().expect("attempt").status(),
        AttemptStatus::Cancelled
    );
    assert!(matches!(duplicate, TaskCommitOutcome::Duplicate(_)));
    assert_eq!(store.domain_snapshot(), after_first);
    assert_eq!(after_first.events.len(), 3);
    assert_eq!(after_first.receipts.len(), 3);
    assert_eq!(after_first.outbox.len(), 3);
    assert_eq!(
        after_first.outbox.last().expect("cancel outbox").decision(),
        &SchedulerDecision::AwaitRetryDecision {
            attempt_id: attempt_id("attempt-1")
        }
    );
}

#[test]
fn expected_version_cas_allows_only_one_concurrent_decision() {
    let store = InMemoryFakeStore::default();
    let genesis = TaskAggregate::new(contract());
    store.create_sync(genesis.clone()).expect("create task");
    let command_a = command(
        "command-a",
        "event-a",
        TaskCommand::AcceptTask {
            attempt_id: attempt_id("attempt-a"),
            idempotency_key: idempotency_key("task-1:attempt-a"),
        },
    );
    let command_b = command(
        "command-b",
        "event-b",
        TaskCommand::AcceptTask {
            attempt_id: attempt_id("attempt-b"),
            idempotency_key: idempotency_key("task-1:attempt-b"),
        },
    );
    let commit_a = prepared_commit(&genesis, &command_a, "outbox-a");
    let commit_b = prepared_commit(&genesis, &command_b, "outbox-b");

    assert!(matches!(
        store.commit_sync(commit_a),
        Ok(TaskCommitOutcome::Committed(_))
    ));
    assert_eq!(store.commit_sync(commit_b), Err(TaskStoreError::Conflict));
    let snapshot = store.domain_snapshot();
    assert_eq!(snapshot.events.len(), 1);
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(snapshot.outbox.len(), 1);
}

#[test]
fn backend_failure_leaves_event_snapshot_inbox_and_outbox_unchanged() {
    let store = InMemoryFakeStore::default();
    let genesis = TaskAggregate::new(contract());
    store.create_sync(genesis.clone()).expect("create task");
    let command = command(
        "command-1",
        "event-1",
        TaskCommand::AcceptTask {
            attempt_id: attempt_id("attempt-1"),
            idempotency_key: idempotency_key("task-1:attempt-1"),
        },
    );
    let commit = prepared_commit(&genesis, &command, "outbox-1");
    store.set_fail_commits(true);
    let before = store.domain_snapshot();

    assert_eq!(
        store.commit_sync(commit),
        Err(TaskStoreError::BackendUnavailable)
    );
    assert_eq!(store.domain_snapshot(), before);
}

#[test]
fn worker_dispatch_is_derived_from_claimed_authority_state_and_ports_compile() {
    let store = running_store();
    let aggregate = store
        .read_sync(&TaskId::new("task-1").expect("task id"))
        .expect("running task");
    let now = UnixTimestamp::new(1).expect("now");
    let dispatch = WorkerDispatch::from_aggregate(&aggregate, now).expect("worker dispatch");

    assert_eq!(dispatch.control().task_id(), aggregate.contract().task_id());
    assert_eq!(
        dispatch.control().attempt_id(),
        aggregate.active_attempt().expect("attempt").attempt_id()
    );
    assert_eq!(dispatch.idempotency_key().as_str(), "task-1:attempt-1");
    assert_eq!(
        dispatch.workspace_key(),
        aggregate.contract().workspace_key()
    );
    assert_eq!(
        dispatch.execution_spec(),
        aggregate.contract().execution_spec()
    );
    assert_eq!(dispatch.bindings(), aggregate.contract().bindings());

    struct FakeExecutor;

    impl WorkerExecutor for FakeExecutor {
        async fn start(
            &self,
            _dispatch: WorkerDispatch,
        ) -> Result<ExecutorRunRef, WorkerExecutorError> {
            ExecutorRunRef::new("executor-run-1").map_err(|_| WorkerExecutorError::InvalidResponse)
        }

        async fn cancel(
            &self,
            _cancellation: WorkerCancellation,
        ) -> Result<(), WorkerExecutorError> {
            Ok(())
        }

        async fn reconcile(
            &self,
            _reconciliation: WorkerReconciliation,
        ) -> Result<ExecutorRunRef, WorkerExecutorError> {
            ExecutorRunRef::new("executor-run-1").map_err(|_| WorkerExecutorError::InvalidResponse)
        }
    }

    fn assert_store<T: TaskStore>(_store: &T) {}
    fn assert_executor<T: WorkerExecutor>(_executor: &T) {}

    assert_store(&store);
    assert_executor(&FakeExecutor);
    assert!(WorkerCancellation::from_aggregate(&aggregate, now).is_ok());
    assert_eq!(
        WorkerReconciliation::from_aggregate(&aggregate, now),
        Err(TaskError::InvalidTransition)
    );
    assert_eq!(
        WorkerDispatch::from_aggregate(&aggregate, UnixTimestamp::new(101).expect("expired time"),),
        Err(TaskError::LeaseExpired)
    );

    store
        .process_sync(
            command(
                "unknown-command",
                "unknown-event",
                TaskCommand::ApplyWorkerEvent {
                    evidence: WorkerEvidence {
                        attempt_id: attempt_id("attempt-1"),
                        worker_run_id: WorkerRunId::new("worker-1").expect("worker id"),
                        producer_sequence: ProducerSequence::new(1).expect("sequence"),
                        lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                        fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
                    },
                    outcome: WorkerOutcome::OutcomeUnknown,
                },
            ),
            outbox_id("unknown-outbox"),
        )
        .expect("unknown outcome");
    let reconciling = store
        .read_sync(&TaskId::new("task-1").expect("task id"))
        .expect("reconciling task");
    assert!(WorkerReconciliation::from_aggregate(&reconciling, now).is_ok());
}

#[test]
fn authority_cancelled_task_retains_restart_safe_worker_cancellation_evidence() {
    let store = running_store();
    let cancelled = store
        .process_sync(
            command("cancel-command", "cancel-event", TaskCommand::CancelTask),
            outbox_id("cancel-outbox"),
        )
        .expect("cancel task");
    let TaskCommitOutcome::Committed(cancelled) = cancelled else {
        panic!("new cancellation must commit");
    };

    let cancellation = WorkerCancellation::from_aggregate(
        &cancelled,
        UnixTimestamp::new(101).expect("post-expiry cancellation time"),
    )
    .expect("durable terminal cancellation evidence");
    assert_eq!(cancellation.control().worker_run_id().as_str(), "worker-1");
    assert_eq!(
        cancellation.control().lease().expires_at(),
        UnixTimestamp::new(100).expect("lease expiry")
    );
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct DomainSnapshot {
    aggregates: BTreeMap<TaskId, TaskAggregate>,
    events: Vec<CommittedTaskEvent>,
    receipts: BTreeMap<(TaskId, InboxReceipt), TaskAggregate>,
    outbox: Vec<OutboxRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct FakeState {
    domain: DomainSnapshot,
    fail_commits: bool,
}

#[derive(Default)]
struct InMemoryFakeStore {
    state: Mutex<FakeState>,
}

impl InMemoryFakeStore {
    fn create_sync(&self, aggregate: TaskAggregate) -> Result<(), TaskStoreError> {
        let task_id = aggregate.contract().task_id().clone();
        let mut state = self.state.lock().expect("fake store lock");
        if state.domain.aggregates.contains_key(&task_id) {
            return Err(TaskStoreError::AlreadyExists);
        }
        state.domain.aggregates.insert(task_id, aggregate);
        Ok(())
    }

    fn read_sync(&self, task_id: &TaskId) -> Option<TaskAggregate> {
        self.state
            .lock()
            .expect("fake store lock")
            .domain
            .aggregates
            .get(task_id)
            .cloned()
    }

    fn read_receipt_sync(&self, task_id: &TaskId, receipt: &InboxReceipt) -> Option<TaskAggregate> {
        self.state
            .lock()
            .expect("fake store lock")
            .domain
            .receipts
            .get(&(task_id.clone(), receipt.clone()))
            .cloned()
    }

    fn commit_sync(&self, commit: TaskCommit) -> Result<TaskCommitOutcome, TaskStoreError> {
        let mut state = self.state.lock().expect("fake store lock");
        let key = (commit.task_id().clone(), commit.receipt().clone());
        if let Some(aggregate) = state.domain.receipts.get(&key) {
            return Ok(TaskCommitOutcome::Duplicate(aggregate.clone()));
        }
        let current = state
            .domain
            .aggregates
            .get(commit.task_id())
            .ok_or(TaskStoreError::NotFound)?;
        if current.aggregate_version() != commit.expected_version() {
            return Err(TaskStoreError::Conflict);
        }
        let reduced = match reduce_event(current, commit.event())
            .map_err(|_| TaskStoreError::InvalidCommit)?
        {
            ReduceOutcome::Applied(aggregate) => *aggregate,
            ReduceOutcome::Duplicate => return Err(TaskStoreError::InvalidCommit),
        };
        if &reduced != commit.resulting_aggregate() {
            return Err(TaskStoreError::InvalidCommit);
        }
        if state.fail_commits {
            return Err(TaskStoreError::BackendUnavailable);
        }

        state.domain.events.push(commit.event().clone());
        state.domain.outbox.extend_from_slice(commit.outbox());
        state
            .domain
            .receipts
            .insert(key, commit.resulting_aggregate().clone());
        state.domain.aggregates.insert(
            commit.task_id().clone(),
            commit.resulting_aggregate().clone(),
        );
        Ok(TaskCommitOutcome::Committed(
            commit.resulting_aggregate().clone(),
        ))
    }

    fn process_sync(
        &self,
        command: TaskCommandEnvelope,
        outbox_id: OutboxId,
    ) -> Result<TaskCommitOutcome, ProcessError> {
        let receipt = InboxReceipt::from_command(&command);
        if let Some(aggregate) = self.read_receipt_sync(&command.task_id, &receipt) {
            return Ok(TaskCommitOutcome::Duplicate(aggregate));
        }
        let aggregate = self
            .read_sync(&command.task_id)
            .ok_or(ProcessError::Store(TaskStoreError::NotFound))?;
        let decision = decide_command(&aggregate, &command).map_err(ProcessError::Task)?;
        let commit = TaskCommit::from_decision(&aggregate, &command, outbox_id, decision)
            .map_err(ProcessError::Task)?;
        self.commit_sync(commit).map_err(ProcessError::Store)
    }

    fn set_fail_commits(&self, fail_commits: bool) {
        self.state.lock().expect("fake store lock").fail_commits = fail_commits;
    }

    fn domain_snapshot(&self) -> DomainSnapshot {
        self.state.lock().expect("fake store lock").domain.clone()
    }
}

impl TaskStore for InMemoryFakeStore {
    async fn create(&self, aggregate: TaskAggregate) -> Result<(), TaskStoreError> {
        self.create_sync(aggregate)
    }

    async fn read(&self, task_id: TaskId) -> Result<Option<TaskAggregate>, TaskStoreError> {
        Ok(self.read_sync(&task_id))
    }

    async fn read_receipt(
        &self,
        task_id: TaskId,
        receipt: InboxReceipt,
    ) -> Result<Option<TaskAggregate>, TaskStoreError> {
        Ok(self.read_receipt_sync(&task_id, &receipt))
    }

    async fn commit(&self, commit: TaskCommit) -> Result<TaskCommitOutcome, TaskStoreError> {
        self.commit_sync(commit)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessError {
    Task(TaskError),
    Store(TaskStoreError),
}

fn running_store() -> InMemoryFakeStore {
    let store = InMemoryFakeStore::default();
    store
        .create_sync(TaskAggregate::new(contract()))
        .expect("create task");
    store
        .process_sync(
            command(
                "accept-command",
                "accept-event",
                TaskCommand::AcceptTask {
                    attempt_id: attempt_id("attempt-1"),
                    idempotency_key: idempotency_key("task-1:attempt-1"),
                },
            ),
            outbox_id("accept-outbox"),
        )
        .expect("accept task");
    store
        .process_sync(
            command(
                "claim-command",
                "claim-event",
                TaskCommand::ClaimAttempt {
                    attempt_id: attempt_id("attempt-1"),
                    worker_run_id: WorkerRunId::new("worker-1").expect("worker id"),
                    lease: LeaseGrant::new(
                        LeaseEpoch::new(1).expect("epoch"),
                        FencingTokenHash::new(HASH_A).expect("hash"),
                        UnixTimestamp::new(100).expect("expiry"),
                    ),
                },
            ),
            outbox_id("claim-outbox"),
        )
        .expect("claim task");
    store
}

fn prepared_commit(
    aggregate: &TaskAggregate,
    command: &TaskCommandEnvelope,
    outbox: &str,
) -> TaskCommit {
    let decision = decide_command(aggregate, command).expect("decision");
    TaskCommit::from_decision(aggregate, command, outbox_id(outbox), decision).expect("commit")
}

fn command(command_id: &str, event_id: &str, command: TaskCommand) -> TaskCommandEnvelope {
    TaskCommandEnvelope {
        command_id: CommandId::new(command_id).expect("command id"),
        event_id: EventId::new(event_id).expect("event id"),
        task_id: TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(1).expect("occurred at"),
        received_at: UnixTimestamp::new(1).expect("received at"),
        command,
    }
}

fn worker_command(command_id: &str, event_id: &str, sequence: u64) -> TaskCommandEnvelope {
    worker_command_with_outcome(command_id, event_id, sequence, WorkerOutcome::Progressed)
}

fn worker_command_with_outcome(
    command_id: &str,
    event_id: &str,
    sequence: u64,
    outcome: WorkerOutcome,
) -> TaskCommandEnvelope {
    command(
        command_id,
        event_id,
        TaskCommand::ApplyWorkerEvent {
            evidence: WorkerEvidence {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: WorkerRunId::new("worker-1").expect("worker id"),
                producer_sequence: ProducerSequence::new(sequence).expect("sequence"),
                lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
            },
            outcome,
        },
    )
}

fn contract() -> TaskContract {
    TaskContract::new(TaskContractSpec {
        task_id: TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        strategy: StrategyKind::Office,
        workspace_key: WorkspaceKey::new("workspace-1").expect("workspace key"),
        schema_version: TaskContractSchemaVersion::new(TASK_CONTRACT_SCHEMA_VERSION)
            .expect("schema version"),
        execution_spec: ExecutionSpecRef::new(
            ExecutionSpecId::new("execution-spec-1").expect("execution spec id"),
            ExecutionSpecRevision::new(1).expect("execution spec revision"),
            ExecutionSpecDigest::new(HASH_A).expect("execution spec digest"),
        ),
        bindings: Vec::new(),
        created_at: UnixTimestamp::new(1).expect("created at"),
    })
    .expect("contract")
}

fn attempt_id(value: &str) -> AttemptId {
    AttemptId::new(value).expect("attempt id")
}

fn idempotency_key(value: &str) -> IdempotencyKey {
    IdempotencyKey::new(value).expect("idempotency key")
}

fn outbox_id(value: &str) -> OutboxId {
    OutboxId::new(value).expect("outbox id")
}
