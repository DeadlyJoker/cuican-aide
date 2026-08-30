use super::*;
use crewon_resource_federation::WorkspaceKey;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::ExecutionSpecDigest;
use crewon_task_runtime::ExecutionSpecId;
use crewon_task_runtime::ExecutionSpecRef;
use crewon_task_runtime::ExecutionSpecRevision;
use crewon_task_runtime::FencingTokenHash;
use crewon_task_runtime::IdempotencyKey;
use crewon_task_runtime::LeaseEpoch;
use crewon_task_runtime::LeaseGrant;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::ProducerSequence;
use crewon_task_runtime::TASK_CONTRACT_SCHEMA_VERSION;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskContractSchemaVersion;
use crewon_task_runtime::TaskContractSpec;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerEvidence;
use crewon_task_runtime::WorkerOutcome;
use crewon_task_runtime::WorkerRunId;
use crewon_task_runtime::decide_command;
use pretty_assertions::assert_eq;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test]
async fn creates_reads_and_reopens_a_validated_aggregate() {
    let codex_home = tempfile::tempdir().expect("temporary state directory");
    let state = initialized_state(codex_home.path()).await;
    let adapter = TaskStateStoreAdapter::new(state.clone());
    let aggregate = TaskAggregate::new(contract());

    adapter
        .create(aggregate.clone())
        .await
        .expect("create task");
    assert_eq!(
        adapter.read(task_id()).await.expect("read task"),
        Some(aggregate.clone())
    );
    assert_eq!(
        adapter.create(aggregate.clone()).await,
        Err(TaskStoreError::AlreadyExists)
    );

    state.close().await;
    drop(adapter);
    drop(state);

    let reopened = initialized_state(codex_home.path()).await;
    let reopened_adapter = TaskStateStoreAdapter::new(reopened.clone());
    assert_eq!(
        reopened_adapter.read(task_id()).await.expect("read task"),
        Some(aggregate)
    );
    reopened.close().await;
}

#[tokio::test]
async fn atomically_commits_and_deduplicates_snapshot_event_receipt_and_outbox() {
    let codex_home = tempfile::tempdir().expect("temporary state directory");
    let state = initialized_state(codex_home.path()).await;
    let adapter = TaskStateStoreAdapter::new(state.clone());
    let genesis = TaskAggregate::new(contract());
    adapter.create(genesis.clone()).await.expect("create task");

    let envelope = command(
        "accept-command",
        "accept-event",
        TaskCommand::AcceptTask {
            attempt_id: crewon_task_runtime::AttemptId::new("attempt-1").expect("attempt id"),
            idempotency_key: IdempotencyKey::new("task-1:attempt-1").expect("idempotency key"),
        },
    );
    let receipt = InboxReceipt::from_command(&envelope);
    let commit = prepared_commit(&genesis, &envelope, "accept-outbox");
    let queued = commit.resulting_aggregate().clone();

    assert_eq!(
        adapter.commit(commit.clone()).await.expect("commit task"),
        TaskCommitOutcome::Committed(queued.clone())
    );
    assert_eq!(
        adapter.commit(commit).await.expect("deduplicate task"),
        TaskCommitOutcome::Duplicate(queued.clone())
    );
    assert_eq!(
        adapter
            .read_receipt(task_id(), receipt)
            .await
            .expect("read receipt"),
        Some(queued)
    );

    let outbox = state
        .list_task_outbox_records("task-1", /*limit*/ 100)
        .await
        .expect("list outbox");
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].decision_type, "enqueueAttempt");
    assert_eq!(
        serde_json::from_str::<SchedulerDecision>(&outbox[0].payload_json).expect("outbox payload"),
        SchedulerDecision::EnqueueAttempt {
            attempt_id: crewon_task_runtime::AttemptId::new("attempt-1").expect("attempt id"),
        }
    );
    state.close().await;
}

#[tokio::test]
async fn maps_storage_fencing_rejection_without_writing_worker_side_effects() {
    let codex_home = tempfile::tempdir().expect("temporary state directory");
    let state = initialized_state(codex_home.path()).await;
    let adapter = TaskStateStoreAdapter::new(state.clone());
    let genesis = TaskAggregate::new(contract());
    adapter.create(genesis.clone()).await.expect("create task");

    let accept = command(
        "accept-command",
        "accept-event",
        TaskCommand::AcceptTask {
            attempt_id: attempt_id(),
            idempotency_key: IdempotencyKey::new("task-1:attempt-1").expect("idempotency key"),
        },
    );
    let accept_commit = prepared_commit(&genesis, &accept, "accept-outbox");
    let queued = accept_commit.resulting_aggregate().clone();
    adapter.commit(accept_commit).await.expect("accept task");

    let claim = command(
        "claim-command",
        "claim-event",
        TaskCommand::ClaimAttempt {
            attempt_id: attempt_id(),
            worker_run_id: worker_run_id(),
            lease: lease(HASH_A),
        },
    );
    let claim_commit = prepared_commit(&queued, &claim, "claim-outbox");
    let running = claim_commit.resulting_aggregate().clone();
    let mut persisted_claim = task_commit_record(&claim_commit).expect("map claim record");
    persisted_claim
        .snapshot
        .lease
        .as_mut()
        .expect("snapshot lease")
        .fencing_token_hash = HASH_B.to_string();
    state
        .commit_task_record(&persisted_claim)
        .await
        .expect("persist mismatched projection");
    assert_eq!(
        adapter.read(task_id()).await,
        Err(TaskStoreError::InvalidCommit)
    );

    let worker = command_at(
        "worker-command",
        "worker-event",
        /*received_at*/ 20,
        TaskCommand::ApplyWorkerEvent {
            evidence: WorkerEvidence {
                attempt_id: attempt_id(),
                worker_run_id: worker_run_id(),
                producer_sequence: ProducerSequence::new(/*value*/ 1).expect("sequence"),
                lease_epoch: LeaseEpoch::new(/*value*/ 1).expect("epoch"),
                fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
            },
            outcome: WorkerOutcome::Progressed,
        },
    );
    let worker_commit = prepared_commit(&running, &worker, "worker-outbox");
    assert_eq!(
        adapter.commit(worker_commit).await,
        Err(TaskStoreError::Fenced)
    );
    assert_eq!(
        state
            .list_task_event_records("task-1", /*after_offset*/ 0, /*limit*/ 100)
            .await
            .expect("list events")
            .events
            .len(),
        2
    );
    state.close().await;
}

#[tokio::test]
async fn persists_and_deduplicates_worker_cancellation_across_reopen() {
    let codex_home = tempfile::tempdir().expect("temporary state directory");
    let state = initialized_state(codex_home.path()).await;
    let adapter = TaskStateStoreAdapter::new(state.clone());
    let genesis = TaskAggregate::new(contract());
    adapter.create(genesis.clone()).await.expect("create task");

    let accept = command(
        "accept-command",
        "accept-event",
        TaskCommand::AcceptTask {
            attempt_id: attempt_id(),
            idempotency_key: IdempotencyKey::new("task-1:attempt-1").expect("idempotency key"),
        },
    );
    let accept_commit = prepared_commit(&genesis, &accept, "accept-outbox");
    let queued = accept_commit.resulting_aggregate().clone();
    adapter.commit(accept_commit).await.expect("accept task");

    let claim = command(
        "claim-command",
        "claim-event",
        TaskCommand::ClaimAttempt {
            attempt_id: attempt_id(),
            worker_run_id: worker_run_id(),
            lease: lease(HASH_A),
        },
    );
    let claim_commit = prepared_commit(&queued, &claim, "claim-outbox");
    let running = claim_commit.resulting_aggregate().clone();
    adapter.commit(claim_commit).await.expect("claim task");

    let worker_cancelled = command_at(
        "worker-cancel-command",
        "worker-cancel-event",
        /*received_at*/ 20,
        TaskCommand::ApplyWorkerEvent {
            evidence: WorkerEvidence {
                attempt_id: attempt_id(),
                worker_run_id: worker_run_id(),
                producer_sequence: ProducerSequence::new(/*value*/ 1).expect("sequence"),
                lease_epoch: LeaseEpoch::new(/*value*/ 1).expect("epoch"),
                fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
            },
            outcome: WorkerOutcome::Cancelled,
        },
    );
    let receipt = InboxReceipt::from_command(&worker_cancelled);
    let cancel_commit = prepared_commit(&running, &worker_cancelled, "worker-cancel-outbox");
    let awaiting_authority = cancel_commit.resulting_aggregate().clone();

    assert_eq!(
        adapter
            .commit(cancel_commit.clone())
            .await
            .expect("commit worker cancellation"),
        TaskCommitOutcome::Committed(awaiting_authority.clone())
    );
    assert_eq!(awaiting_authority.status(), TaskStatus::Suspended);
    assert_eq!(
        awaiting_authority
            .active_attempt()
            .expect("active attempt")
            .status(),
        crewon_task_runtime::AttemptStatus::Cancelled
    );
    assert_eq!(
        adapter
            .commit(cancel_commit)
            .await
            .expect("deduplicate worker cancellation"),
        TaskCommitOutcome::Duplicate(awaiting_authority.clone())
    );
    assert_eq!(
        adapter
            .read_receipt(task_id(), receipt)
            .await
            .expect("read cancellation receipt"),
        Some(awaiting_authority.clone())
    );

    state.close().await;
    drop(adapter);
    drop(state);

    let reopened = initialized_state(codex_home.path()).await;
    let reopened_adapter = TaskStateStoreAdapter::new(reopened.clone());
    assert_eq!(
        reopened_adapter
            .read(task_id())
            .await
            .expect("read reopened task"),
        Some(awaiting_authority)
    );
    reopened.close().await;
}

async fn initialized_state(path: &std::path::Path) -> Arc<StateRuntime> {
    StateRuntime::init(path.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}

fn prepared_commit(
    aggregate: &TaskAggregate,
    envelope: &TaskCommandEnvelope,
    outbox_id: &str,
) -> TaskCommit {
    let decision = decide_command(aggregate, envelope).expect("command decision");
    TaskCommit::from_decision(
        aggregate,
        envelope,
        OutboxId::new(outbox_id).expect("outbox id"),
        decision,
    )
    .expect("task commit")
}

fn contract() -> TaskContract {
    TaskContract::new(TaskContractSpec {
        task_id: task_id(),
        authority: TaskAuthority::LocalAppServer,
        strategy: StrategyKind::Office,
        workspace_key: WorkspaceKey::new("workspace-1").expect("workspace key"),
        schema_version: TaskContractSchemaVersion::new(TASK_CONTRACT_SCHEMA_VERSION)
            .expect("schema version"),
        execution_spec: ExecutionSpecRef::new(
            ExecutionSpecId::new("execution-spec-1").expect("execution spec id"),
            ExecutionSpecRevision::new(/*value*/ 1).expect("execution spec revision"),
            ExecutionSpecDigest::new(HASH_A).expect("execution spec digest"),
        ),
        bindings: Vec::new(),
        created_at: UnixTimestamp::new(/*value*/ 1).expect("created at"),
    })
    .expect("contract")
}

fn task_id() -> TaskId {
    TaskId::new("task-1").expect("task id")
}

fn attempt_id() -> crewon_task_runtime::AttemptId {
    crewon_task_runtime::AttemptId::new("attempt-1").expect("attempt id")
}

fn worker_run_id() -> WorkerRunId {
    WorkerRunId::new("worker-1").expect("worker run id")
}

fn lease(hash: &str) -> LeaseGrant {
    LeaseGrant::new(
        LeaseEpoch::new(/*value*/ 1).expect("epoch"),
        FencingTokenHash::new(hash).expect("hash"),
        UnixTimestamp::new(/*value*/ 100).expect("expires at"),
    )
}

fn command(command_id: &str, event_id: &str, task_command: TaskCommand) -> TaskCommandEnvelope {
    command_at(command_id, event_id, /*received_at*/ 10, task_command)
}

fn command_at(
    command_id: &str,
    event_id: &str,
    received_at: i64,
    task_command: TaskCommand,
) -> TaskCommandEnvelope {
    TaskCommandEnvelope {
        command_id: CommandId::new(command_id).expect("command id"),
        event_id: EventId::new(event_id).expect("event id"),
        task_id: task_id(),
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(received_at).expect("occurred at"),
        received_at: UnixTimestamp::new(received_at).expect("received at"),
        command: task_command,
    }
}
