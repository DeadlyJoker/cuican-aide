use super::*;
use crewon_resource_federation::WorkspaceKey;
use pretty_assertions::assert_eq;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn every_reachable_lifecycle_state_round_trips_through_json() {
    let genesis = TaskAggregate::new(contract());
    let queued = apply(
        &genesis,
        command(
            "c1",
            "e1",
            TaskCommand::AcceptTask {
                attempt_id: attempt_id("attempt-1"),
                idempotency_key: idempotency_key("task-1:attempt-1"),
            },
        ),
    );
    let running = apply(
        &queued,
        command(
            "c2",
            "e2",
            TaskCommand::ClaimAttempt {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("worker-1"),
                lease: lease(),
            },
        ),
    );
    let provider_suspended = apply(
        &running,
        worker_command(
            "c3",
            "e3",
            1,
            WorkerOutcome::Suspended {
                reason: SuspensionReason::ProviderPaused,
            },
        ),
    );
    let resumed = apply(
        &provider_suspended,
        worker_command("c4", "e4", 2, WorkerOutcome::Resumed),
    );
    let reconciling = apply(
        &resumed,
        worker_command("c5", "e5", 3, WorkerOutcome::OutcomeUnknown),
    );
    let completed = apply(
        &reconciling,
        worker_command("c6", "e6", 4, WorkerOutcome::Succeeded),
    );
    let retry_suspended = apply(
        &running,
        worker_command("retry-c", "retry-e", 1, WorkerOutcome::Failed),
    );
    let cancelled_by_worker = apply(
        &running,
        worker_command(
            "worker-cancel-c",
            "worker-cancel-e",
            1,
            WorkerOutcome::Cancelled,
        ),
    );
    let retry_after_worker_cancel = apply(
        &cancelled_by_worker,
        command(
            "cancel-retry-c",
            "cancel-retry-e",
            TaskCommand::ScheduleRetry {
                attempt_id: attempt_id("attempt-2"),
                idempotency_key: idempotency_key("task-1:attempt-2"),
            },
        ),
    );
    let failed = apply(
        &retry_suspended,
        command("fail-c", "fail-e", TaskCommand::FailTask),
    );
    let cancelled = apply(
        &running,
        command("cancel-c", "cancel-e", TaskCommand::CancelTask),
    );

    for aggregate in [
        genesis,
        queued,
        running,
        provider_suspended,
        resumed,
        reconciling,
        completed,
        retry_suspended,
        cancelled_by_worker,
        retry_after_worker_cancel,
        failed,
        cancelled,
    ] {
        let json = serde_json::to_string(&aggregate.to_snapshot()).expect("serialize snapshot");
        let snapshot = serde_json::from_str(&json).expect("deserialize snapshot");
        assert_eq!(TaskAggregate::restore(snapshot), Ok(aggregate));
    }
}

#[test]
fn restore_rejects_version_cursor_attempt_and_lifecycle_tampering() {
    let running = running_aggregate();

    let mut snapshot = running.to_snapshot();
    snapshot.aggregate_version = AggregateVersion::new(9);
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::VersionOffsetMismatch)
    );

    let mut snapshot = running.to_snapshot();
    snapshot.last_event_id = None;
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::EventCursorMismatch)
    );

    let mut snapshot = running.to_snapshot();
    snapshot.active_attempt_id = None;
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::ActiveAttemptMismatch)
    );

    let mut snapshot = running.to_snapshot();
    snapshot.attempts[0].ordinal = AttemptOrdinal::new(2).expect("ordinal");
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::AttemptOrdinalMismatch)
    );

    let mut snapshot = running.to_snapshot();
    snapshot.attempts[0].lease = None;
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::AttemptShapeMismatch)
    );

    let mut snapshot = running.to_snapshot();
    snapshot.status = TaskStatus::Completed;
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::LifecycleMismatch)
    );

    let mut snapshot = running.to_snapshot();
    snapshot.aggregate_version = AggregateVersion::new(1);
    snapshot.task_stream_offset = TaskStreamOffset::new(1);
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::HistoryCardinalityMismatch)
    );
}

#[test]
fn snapshot_deserialization_and_restore_fail_closed_on_unknown_or_unbounded_data() {
    let mut value = serde_json::to_value(running_aggregate().to_snapshot()).expect("snapshot json");
    value
        .as_object_mut()
        .expect("snapshot object")
        .insert("legacyState".to_string(), serde_json::json!(true));
    assert!(serde_json::from_value::<TaskAggregateSnapshot>(value).is_err());

    let mut snapshot = running_aggregate().to_snapshot();
    snapshot.attempts = vec![snapshot.attempts[0].clone(); MAX_TASK_ATTEMPTS + 1];
    assert_eq!(
        TaskAggregate::restore(snapshot),
        Err(TaskSnapshotError::TooManyAttempts)
    );
}

fn running_aggregate() -> TaskAggregate {
    let queued = apply(
        &TaskAggregate::new(contract()),
        command(
            "c1",
            "e1",
            TaskCommand::AcceptTask {
                attempt_id: attempt_id("attempt-1"),
                idempotency_key: idempotency_key("task-1:attempt-1"),
            },
        ),
    );
    apply(
        &queued,
        command(
            "c2",
            "e2",
            TaskCommand::ClaimAttempt {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("worker-1"),
                lease: lease(),
            },
        ),
    )
}

fn apply(aggregate: &TaskAggregate, command: TaskCommandEnvelope) -> TaskAggregate {
    let decision = decide_command(aggregate, &command).expect("command decision");
    let event = CommittedTaskEvent::new(
        decision.event,
        aggregate
            .task_stream_offset()
            .checked_next()
            .expect("next stream offset"),
    );
    match reduce_event(aggregate, &event).expect("reduce event") {
        ReduceOutcome::Applied(aggregate) => *aggregate,
        ReduceOutcome::Duplicate => panic!("new event cannot be duplicate"),
    }
}

fn command(command_id: &str, event_id: &str, task_command: TaskCommand) -> TaskCommandEnvelope {
    TaskCommandEnvelope {
        command_id: CommandId::new(command_id).expect("command id"),
        event_id: EventId::new(event_id).expect("event id"),
        task_id: TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(10).expect("occurred at"),
        received_at: UnixTimestamp::new(10).expect("received at"),
        command: task_command,
    }
}

fn worker_command(
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
                worker_run_id: worker_run_id("worker-1"),
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

fn worker_run_id(value: &str) -> WorkerRunId {
    WorkerRunId::new(value).expect("worker run id")
}

fn idempotency_key(value: &str) -> IdempotencyKey {
    IdempotencyKey::new(value).expect("idempotency key")
}

fn lease() -> LeaseGrant {
    LeaseGrant::new(
        LeaseEpoch::new(1).expect("epoch"),
        FencingTokenHash::new(HASH_A).expect("hash"),
        UnixTimestamp::new(100).expect("expires at"),
    )
}
