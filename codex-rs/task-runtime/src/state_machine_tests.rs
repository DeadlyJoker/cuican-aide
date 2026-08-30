use super::*;
use crewon_resource_federation::WorkspaceKey;
use pretty_assertions::assert_eq;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn reducer_runs_the_complete_success_and_suspend_resume_lifecycle() {
    let contract = contract();
    let mut aggregate = TaskAggregate::new(contract.clone());

    let (next, scheduler, _) = execute(
        &aggregate,
        command(
            "c1",
            "e1",
            TaskCommand::AcceptTask {
                attempt_id: attempt_id("attempt-1"),
                idempotency_key: idempotency_key("task-1:attempt-1"),
            },
        ),
    );
    aggregate = next;
    assert_eq!(
        scheduler,
        SchedulerDecision::EnqueueAttempt {
            attempt_id: attempt_id("attempt-1")
        }
    );
    assert_eq!(
        aggregate,
        expected_single_attempt(
            contract.clone(),
            ExpectedState {
                task_status: TaskStatus::Queued,
                suspension_reason: None,
                attempt_status: AttemptStatus::Created,
                worker_run_id: None,
                lease: None,
                producer_sequence: None,
                aggregate_version: 1,
                stream_offset: 1,
                last_event_id: "e1",
                progress_count: 0,
            },
        )
    );

    let lease = lease(1, HASH_A, 100);
    let (next, scheduler, _) = execute(
        &aggregate,
        command(
            "c2",
            "e2",
            TaskCommand::ClaimAttempt {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("worker-1"),
                lease: lease.clone(),
            },
        ),
    );
    aggregate = next;
    assert_eq!(
        scheduler,
        SchedulerDecision::DispatchAttempt {
            attempt_id: attempt_id("attempt-1"),
            worker_run_id: worker_run_id("worker-1"),
        }
    );

    let (next, scheduler, _) = execute(
        &aggregate,
        worker_command("c3", "e3", 10, 1, WorkerOutcome::Progressed),
    );
    aggregate = next;
    assert_eq!(scheduler, SchedulerDecision::NoAction);

    let (next, scheduler, _) = execute(
        &aggregate,
        worker_command(
            "c4",
            "e4",
            20,
            2,
            WorkerOutcome::Suspended {
                reason: SuspensionReason::ProviderPaused,
            },
        ),
    );
    aggregate = next;
    assert_eq!(
        scheduler,
        SchedulerDecision::AwaitResume {
            attempt_id: attempt_id("attempt-1")
        }
    );

    let (next, scheduler, _) = execute(
        &aggregate,
        worker_command("c5", "e5", 30, 3, WorkerOutcome::Resumed),
    );
    aggregate = next;
    assert_eq!(scheduler, SchedulerDecision::NoAction);

    let (aggregate, scheduler, _) = execute(
        &aggregate,
        worker_command("c6", "e6", 40, 4, WorkerOutcome::Succeeded),
    );
    assert_eq!(scheduler, SchedulerDecision::NoAction);
    assert_eq!(
        aggregate,
        expected_single_attempt(
            contract,
            ExpectedState {
                task_status: TaskStatus::Completed,
                suspension_reason: None,
                attempt_status: AttemptStatus::Succeeded,
                worker_run_id: Some("worker-1"),
                lease: Some(lease),
                producer_sequence: Some(4),
                aggregate_version: 6,
                stream_offset: 6,
                last_event_id: "e6",
                progress_count: 1,
            },
        )
    );
}

#[test]
fn authority_owns_retry_and_unknown_reconciles_the_same_attempt() {
    let contract = contract();
    let mut aggregate = running_aggregate(&contract, 100);

    let (next, scheduler, _) = execute(
        &aggregate,
        worker_command("c3", "e3", 10, 1, WorkerOutcome::Failed),
    );
    aggregate = next;
    assert_eq!(
        scheduler,
        SchedulerDecision::AwaitRetryDecision {
            attempt_id: attempt_id("attempt-1")
        }
    );
    assert_eq!(aggregate.status(), TaskStatus::Suspended);
    assert_eq!(
        aggregate.suspension_reason(),
        Some(SuspensionReason::RetryDecision)
    );

    let (next, scheduler, _) = execute(
        &aggregate,
        command(
            "c4",
            "e4",
            TaskCommand::ScheduleRetry {
                attempt_id: attempt_id("attempt-2"),
                idempotency_key: idempotency_key("task-1:attempt-2"),
            },
        ),
    );
    aggregate = next;
    assert_eq!(
        scheduler,
        SchedulerDecision::EnqueueAttempt {
            attempt_id: attempt_id("attempt-2")
        }
    );

    let lease = lease(1, HASH_B, 200);
    let (next, _, _) = execute(
        &aggregate,
        command(
            "c5",
            "e5",
            TaskCommand::ClaimAttempt {
                attempt_id: attempt_id("attempt-2"),
                worker_run_id: worker_run_id("worker-2"),
                lease: lease.clone(),
            },
        ),
    );
    aggregate = next;

    let (next, scheduler, _) = execute(
        &aggregate,
        worker_command_for(
            "c6",
            "e6",
            30,
            WorkerEvidence {
                attempt_id: attempt_id("attempt-2"),
                worker_run_id: worker_run_id("worker-2"),
                producer_sequence: ProducerSequence::new(1).expect("sequence"),
                lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                fencing_token_hash: FencingTokenHash::new(HASH_B).expect("hash"),
            },
            WorkerOutcome::OutcomeUnknown,
        ),
    );
    aggregate = next;
    assert_eq!(
        scheduler,
        SchedulerDecision::ReconcileAttempt {
            attempt_id: attempt_id("attempt-2"),
            worker_run_id: worker_run_id("worker-2"),
        }
    );
    assert_eq!(aggregate.status(), TaskStatus::Reconciling);
    assert_eq!(
        decide_command(
            &aggregate,
            &command(
                "c7",
                "e7",
                TaskCommand::ScheduleRetry {
                    attempt_id: attempt_id("attempt-3"),
                    idempotency_key: idempotency_key("task-1:attempt-3"),
                }
            ),
        ),
        Err(TaskError::InvalidTransition)
    );

    let (aggregate, _, _) = execute(
        &aggregate,
        worker_command_for(
            "c8",
            "e8",
            40,
            WorkerEvidence {
                attempt_id: attempt_id("attempt-2"),
                worker_run_id: worker_run_id("worker-2"),
                producer_sequence: ProducerSequence::new(2).expect("sequence"),
                lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                fencing_token_hash: FencingTokenHash::new(HASH_B).expect("hash"),
            },
            WorkerOutcome::Succeeded,
        ),
    );

    assert_eq!(aggregate.status(), TaskStatus::Completed);
    assert_eq!(aggregate.attempts().len(), 2);
    assert_eq!(aggregate.attempts()[0].status(), AttemptStatus::Failed);
    assert_eq!(aggregate.attempts()[1].status(), AttemptStatus::Succeeded);
    assert_eq!(aggregate.attempts()[1].lease(), Some(&lease));
}

#[test]
fn final_failure_and_cancel_are_authority_terminal_decisions() {
    let contract = contract();
    let running = running_aggregate(&contract, 100);
    let (failed_attempt, _, _) = execute(
        &running,
        worker_command("c3", "e3", 10, 1, WorkerOutcome::Failed),
    );
    let (failed_task, scheduler, _) =
        execute(&failed_attempt, command("c4", "e4", TaskCommand::FailTask));

    assert_eq!(failed_task.status(), TaskStatus::Failed);
    assert_eq!(scheduler, SchedulerDecision::NoAction);

    let (cancelled_after_failure, scheduler, _) = execute(
        &failed_attempt,
        command("c4-cancel", "e4-cancel", TaskCommand::CancelTask),
    );
    assert_eq!(cancelled_after_failure.status(), TaskStatus::Cancelled);
    assert_eq!(scheduler, SchedulerDecision::NoAction);

    let (cancelled, scheduler, _) = execute(&running, command("c5", "e5", TaskCommand::CancelTask));
    assert_eq!(cancelled.status(), TaskStatus::Cancelled);
    assert_eq!(
        cancelled.active_attempt().expect("attempt").status(),
        AttemptStatus::Cancelled
    );
    assert_eq!(
        scheduler,
        SchedulerDecision::CancelAttempt {
            attempt_id: attempt_id("attempt-1"),
            worker_run_id: worker_run_id("worker-1"),
        }
    );
}

#[test]
fn terminal_claim_rebuilds_event_supervision_after_lease_expiry() {
    let contract = contract();
    let running = running_aggregate(&contract, 100);
    let (cancelled, _, _) = execute(
        &running,
        command(
            "cancel-supervision",
            "cancel-supervision-event",
            TaskCommand::CancelTask,
        ),
    );
    let now = UnixTimestamp::new(200).expect("supervision time");

    assert_eq!(
        WorkerDispatch::from_aggregate(&cancelled, now),
        Err(TaskError::InvalidTransition)
    );
    let supervision =
        WorkerDispatch::for_event_supervision(&cancelled, now).expect("terminal event supervision");
    assert_eq!(supervision.control().task_id(), contract.task_id());
    assert_eq!(supervision.control().attempt_id(), &attempt_id("attempt-1"));
    assert_eq!(
        supervision.control().worker_run_id(),
        &worker_run_id("worker-1")
    );
    assert_eq!(supervision.execution_spec(), contract.execution_spec());

    let queued = execute(
        &TaskAggregate::new(contract),
        command(
            "accept-supervision",
            "accept-supervision-event",
            TaskCommand::AcceptTask {
                attempt_id: attempt_id("attempt-1"),
                idempotency_key: idempotency_key("task-1:attempt-1"),
            },
        ),
    )
    .0;
    assert_eq!(
        WorkerDispatch::for_event_supervision(&queued, now),
        Err(TaskError::InvalidTransition)
    );
}

#[test]
fn worker_cancellation_returns_retry_or_final_decision_to_authority() {
    let contract = contract();
    let running = running_aggregate(&contract, 100);
    let (cancelled_attempt, scheduler, _) = execute(
        &running,
        worker_command(
            "worker-cancel-c",
            "worker-cancel-e",
            10,
            1,
            WorkerOutcome::Cancelled,
        ),
    );

    assert_eq!(
        scheduler,
        SchedulerDecision::AwaitRetryDecision {
            attempt_id: attempt_id("attempt-1")
        }
    );
    assert_eq!(cancelled_attempt.status(), TaskStatus::Suspended);
    assert_eq!(
        cancelled_attempt.suspension_reason(),
        Some(SuspensionReason::RetryDecision)
    );
    assert_eq!(
        cancelled_attempt
            .active_attempt()
            .expect("attempt")
            .status(),
        AttemptStatus::Cancelled
    );

    let (retried, scheduler, _) = execute(
        &cancelled_attempt,
        command(
            "retry-c",
            "retry-e",
            TaskCommand::ScheduleRetry {
                attempt_id: attempt_id("attempt-2"),
                idempotency_key: idempotency_key("task-1:attempt-2"),
            },
        ),
    );
    assert_eq!(
        scheduler,
        SchedulerDecision::EnqueueAttempt {
            attempt_id: attempt_id("attempt-2")
        }
    );
    assert_eq!(retried.status(), TaskStatus::Queued);
    assert_eq!(retried.attempts()[0].status(), AttemptStatus::Cancelled);
    assert_eq!(retried.attempts()[1].status(), AttemptStatus::Created);

    let (failed, scheduler, _) = execute(
        &cancelled_attempt,
        command("fail-c", "fail-e", TaskCommand::FailTask),
    );
    assert_eq!(failed.status(), TaskStatus::Failed);
    assert_eq!(scheduler, SchedulerDecision::NoAction);

    let (user_cancelled, scheduler, _) = execute(
        &cancelled_attempt,
        command("cancel-c", "cancel-e", TaskCommand::CancelTask),
    );
    assert_eq!(user_cancelled.status(), TaskStatus::Cancelled);
    assert_eq!(scheduler, SchedulerDecision::NoAction);
}

#[test]
fn authority_terminal_state_rejects_late_worker_cancellation_without_regression() {
    let contract = contract();
    let running = running_aggregate(&contract, 100);
    let (cancelled, _, _) = execute(
        &running,
        command("cancel-c", "cancel-e", TaskCommand::CancelTask),
    );
    let before = cancelled.clone();

    assert_eq!(
        decide_command(
            &cancelled,
            &worker_command(
                "late-worker-cancel-c",
                "late-worker-cancel-e",
                20,
                1,
                WorkerOutcome::Cancelled,
            ),
        ),
        Err(TaskError::TerminalTask)
    );
    assert_eq!(cancelled, before);
}

#[test]
fn worker_events_require_current_identity_sequence_lease_and_fencing() {
    let contract = contract();
    let aggregate = running_aggregate(&contract, 100);
    let valid = WorkerEvidence {
        attempt_id: attempt_id("attempt-1"),
        worker_run_id: worker_run_id("worker-1"),
        producer_sequence: ProducerSequence::new(1).expect("sequence"),
        lease_epoch: LeaseEpoch::new(1).expect("epoch"),
        fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
    };
    let cases = [
        (
            WorkerEvidence {
                attempt_id: attempt_id("other-attempt"),
                ..valid.clone()
            },
            10,
            TaskError::AttemptMismatch,
        ),
        (
            WorkerEvidence {
                worker_run_id: worker_run_id("other-worker"),
                ..valid.clone()
            },
            10,
            TaskError::WorkerRunMismatch,
        ),
        (
            WorkerEvidence {
                lease_epoch: LeaseEpoch::new(2).expect("epoch"),
                ..valid.clone()
            },
            10,
            TaskError::StaleFencingToken,
        ),
        (
            WorkerEvidence {
                fencing_token_hash: FencingTokenHash::new(HASH_B).expect("hash"),
                ..valid.clone()
            },
            10,
            TaskError::StaleFencingToken,
        ),
        (valid, 101, TaskError::LeaseExpired),
    ];

    for (evidence, received_at, expected) in cases {
        let command = worker_command_for(
            "bad-command",
            "bad-event",
            received_at,
            evidence,
            WorkerOutcome::Progressed,
        );
        assert_eq!(decide_command(&aggregate, &command), Err(expected));
    }

    let (progressed, _, _) = execute(
        &aggregate,
        worker_command("c3", "e3", 10, 1, WorkerOutcome::Progressed),
    );
    assert_eq!(
        decide_command(
            &progressed,
            &worker_command("c4", "e4", 20, 1, WorkerOutcome::Progressed),
        ),
        Err(TaskError::ProducerSequenceOutOfOrder)
    );
}

#[test]
fn expired_lease_can_be_reclaimed_and_old_worker_is_fenced() {
    let contract = contract();
    let aggregate = running_aggregate(&contract, 100);
    let new_lease = lease(2, HASH_B, 200);
    let (reclaimed, scheduler, _) = execute(
        &aggregate,
        command_at(
            "c3",
            "e3",
            101,
            TaskAuthority::LocalAppServer,
            TaskCommand::ReclaimAttempt {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("worker-2"),
                lease: new_lease.clone(),
            },
        ),
    );

    assert_eq!(
        scheduler,
        SchedulerDecision::DispatchAttempt {
            attempt_id: attempt_id("attempt-1"),
            worker_run_id: worker_run_id("worker-2"),
        }
    );
    assert_eq!(
        reclaimed.active_attempt().expect("attempt").lease(),
        Some(&new_lease)
    );
    assert_eq!(
        decide_command(
            &reclaimed,
            &worker_command("c4", "e4", 110, 1, WorkerOutcome::Progressed),
        ),
        Err(TaskError::WorkerRunMismatch)
    );
}

#[test]
fn authority_offset_and_duplicate_guards_have_no_partial_effects() {
    let aggregate = TaskAggregate::new(contract());
    let wrong_authority = command_at(
        "c1",
        "e1",
        1,
        TaskAuthority::CloudTaskControl,
        TaskCommand::AcceptTask {
            attempt_id: attempt_id("attempt-1"),
            idempotency_key: idempotency_key("task-1:attempt-1"),
        },
    );
    assert_eq!(
        decide_command(&aggregate, &wrong_authority),
        Err(TaskError::AuthorityMismatch)
    );

    let decision = decide_command(
        &aggregate,
        &command(
            "c2",
            "e2",
            TaskCommand::AcceptTask {
                attempt_id: attempt_id("attempt-1"),
                idempotency_key: idempotency_key("task-1:attempt-1"),
            },
        ),
    )
    .expect("accept decision");
    let event = CommittedTaskEvent::new(decision.event.clone(), TaskStreamOffset::new(1));
    let applied = match reduce_event(&aggregate, &event).expect("apply event") {
        ReduceOutcome::Applied(aggregate) => *aggregate,
        ReduceOutcome::Duplicate => panic!("first event cannot be duplicate"),
    };
    assert_eq!(reduce_event(&applied, &event), Ok(ReduceOutcome::Duplicate));

    let gap = CommittedTaskEvent::new(decision.event, TaskStreamOffset::new(3));
    assert_eq!(
        reduce_event(&aggregate, &gap),
        Err(TaskError::EventOffsetGap)
    );
}

#[test]
fn every_terminal_task_rejects_every_new_command_and_event_kind() {
    for terminal in terminal_aggregates() {
        let commands = [
            TaskCommand::AcceptTask {
                attempt_id: attempt_id("new-attempt"),
                idempotency_key: idempotency_key("new-key"),
            },
            TaskCommand::ClaimAttempt {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("new-worker"),
                lease: lease(1, HASH_A, 200),
            },
            TaskCommand::ReclaimAttempt {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("new-worker"),
                lease: lease(2, HASH_B, 200),
            },
            TaskCommand::ApplyWorkerEvent {
                evidence: WorkerEvidence {
                    attempt_id: attempt_id("attempt-1"),
                    worker_run_id: worker_run_id("worker-1"),
                    producer_sequence: ProducerSequence::new(9).expect("sequence"),
                    lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                    fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
                },
                outcome: WorkerOutcome::Progressed,
            },
            TaskCommand::ApplyWorkerEvent {
                evidence: WorkerEvidence {
                    attempt_id: attempt_id("attempt-1"),
                    worker_run_id: worker_run_id("worker-1"),
                    producer_sequence: ProducerSequence::new(10).expect("sequence"),
                    lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                    fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
                },
                outcome: WorkerOutcome::Cancelled,
            },
            TaskCommand::CancelTask,
            TaskCommand::ScheduleRetry {
                attempt_id: attempt_id("new-attempt"),
                idempotency_key: idempotency_key("new-key"),
            },
            TaskCommand::FailTask,
        ];
        for (index, task_command) in commands.into_iter().enumerate() {
            assert_eq!(
                decide_command(
                    &terminal,
                    &command(
                        &format!("terminal-command-{index}"),
                        &format!("terminal-command-event-{index}"),
                        task_command,
                    ),
                ),
                Err(TaskError::TerminalTask)
            );
        }

        let event_kinds = [
            TaskEventKind::TaskAccepted {
                attempt_id: attempt_id("new-attempt"),
                ordinal: AttemptOrdinal::first(),
                idempotency_key: idempotency_key("new-key"),
            },
            TaskEventKind::AttemptClaimed {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("new-worker"),
                lease: lease(1, HASH_A, 200),
            },
            TaskEventKind::AttemptReclaimed {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("new-worker"),
                lease: lease(2, HASH_B, 200),
            },
            TaskEventKind::WorkerReported {
                evidence: WorkerEvidence {
                    attempt_id: attempt_id("attempt-1"),
                    worker_run_id: worker_run_id("worker-1"),
                    producer_sequence: ProducerSequence::new(9).expect("sequence"),
                    lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                    fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
                },
                outcome: WorkerOutcome::Succeeded,
            },
            TaskEventKind::WorkerReported {
                evidence: WorkerEvidence {
                    attempt_id: attempt_id("attempt-1"),
                    worker_run_id: worker_run_id("worker-1"),
                    producer_sequence: ProducerSequence::new(10).expect("sequence"),
                    lease_epoch: LeaseEpoch::new(1).expect("epoch"),
                    fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
                },
                outcome: WorkerOutcome::Cancelled,
            },
            TaskEventKind::RetryScheduled {
                attempt_id: attempt_id("new-attempt"),
                ordinal: AttemptOrdinal::new(2).expect("ordinal"),
                idempotency_key: idempotency_key("new-key"),
            },
            TaskEventKind::TaskCancelled,
            TaskEventKind::TaskFailed,
        ];
        for (index, kind) in event_kinds.into_iter().enumerate() {
            let proposed = ProposedTaskEvent {
                event_id: EventId::new(format!("terminal-event-{index}")).expect("event id"),
                task_id: TaskId::new("task-1").expect("task id"),
                occurred_at: UnixTimestamp::new(99).expect("occurred at"),
                received_at: UnixTimestamp::new(99).expect("received at"),
                kind,
            };
            let committed = CommittedTaskEvent::new(
                proposed,
                terminal
                    .task_stream_offset()
                    .checked_next()
                    .expect("next offset"),
            );
            assert_eq!(
                reduce_event(&terminal, &committed),
                Err(TaskError::TerminalTask)
            );
        }
    }
}

#[test]
fn reclaim_requires_the_exact_next_lease_epoch() {
    let aggregate = running_aggregate(&contract(), 100);
    assert_eq!(
        decide_command(
            &aggregate,
            &command_at(
                "c3",
                "e3",
                101,
                TaskAuthority::LocalAppServer,
                TaskCommand::ReclaimAttempt {
                    attempt_id: attempt_id("attempt-1"),
                    worker_run_id: worker_run_id("worker-2"),
                    lease: lease(3, HASH_B, 200),
                },
            ),
        ),
        Err(TaskError::StaleFencingToken)
    );
}

fn execute(
    aggregate: &TaskAggregate,
    command: TaskCommandEnvelope,
) -> (TaskAggregate, SchedulerDecision, CommittedTaskEvent) {
    let decision = decide_command(aggregate, &command).expect("command decision");
    let event = CommittedTaskEvent::new(
        decision.event,
        aggregate
            .task_stream_offset()
            .checked_next()
            .expect("next stream offset"),
    );
    let next = match reduce_event(aggregate, &event).expect("reduce event") {
        ReduceOutcome::Applied(aggregate) => *aggregate,
        ReduceOutcome::Duplicate => panic!("new command cannot be duplicate"),
    };
    (next, decision.scheduler, event)
}

fn running_aggregate(contract: &TaskContract, lease_expiry: i64) -> TaskAggregate {
    let genesis = TaskAggregate::new(contract.clone());
    let (queued, _, _) = execute(
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
    let (running, _, _) = execute(
        &queued,
        command(
            "c2",
            "e2",
            TaskCommand::ClaimAttempt {
                attempt_id: attempt_id("attempt-1"),
                worker_run_id: worker_run_id("worker-1"),
                lease: lease(1, HASH_A, lease_expiry),
            },
        ),
    );
    running
}

fn terminal_aggregates() -> [TaskAggregate; 3] {
    let contract = contract();
    let running = running_aggregate(&contract, 100);
    let (completed, _, _) = execute(
        &running,
        worker_command("complete-c", "complete-e", 10, 1, WorkerOutcome::Succeeded),
    );
    let (failed_attempt, _, _) = execute(
        &running,
        worker_command("fail-c", "fail-e", 10, 1, WorkerOutcome::Failed),
    );
    let (failed, _, _) = execute(
        &failed_attempt,
        command("final-fail-c", "final-fail-e", TaskCommand::FailTask),
    );
    let (cancelled, _, _) = execute(
        &running,
        command("cancel-c", "cancel-e", TaskCommand::CancelTask),
    );
    [completed, failed, cancelled]
}

fn command(command_id: &str, event_id: &str, command: TaskCommand) -> TaskCommandEnvelope {
    command_at(
        command_id,
        event_id,
        1,
        TaskAuthority::LocalAppServer,
        command,
    )
}

fn command_at(
    command_id: &str,
    event_id: &str,
    received_at: i64,
    authority: TaskAuthority,
    command: TaskCommand,
) -> TaskCommandEnvelope {
    TaskCommandEnvelope {
        command_id: CommandId::new(command_id).expect("command id"),
        event_id: EventId::new(event_id).expect("event id"),
        task_id: TaskId::new("task-1").expect("task id"),
        authority,
        occurred_at: UnixTimestamp::new(received_at).expect("occurred at"),
        received_at: UnixTimestamp::new(received_at).expect("received at"),
        command,
    }
}

fn worker_command(
    command_id: &str,
    event_id: &str,
    received_at: i64,
    sequence: u64,
    outcome: WorkerOutcome,
) -> TaskCommandEnvelope {
    worker_command_for(
        command_id,
        event_id,
        received_at,
        WorkerEvidence {
            attempt_id: attempt_id("attempt-1"),
            worker_run_id: worker_run_id("worker-1"),
            producer_sequence: ProducerSequence::new(sequence).expect("sequence"),
            lease_epoch: LeaseEpoch::new(1).expect("epoch"),
            fencing_token_hash: FencingTokenHash::new(HASH_A).expect("hash"),
        },
        outcome,
    )
}

fn worker_command_for(
    command_id: &str,
    event_id: &str,
    received_at: i64,
    evidence: WorkerEvidence,
    outcome: WorkerOutcome,
) -> TaskCommandEnvelope {
    command_at(
        command_id,
        event_id,
        received_at,
        TaskAuthority::LocalAppServer,
        TaskCommand::ApplyWorkerEvent { evidence, outcome },
    )
}

fn expected_single_attempt(contract: TaskContract, state: ExpectedState) -> TaskAggregate {
    let mut attempt = Attempt::created(
        attempt_id("attempt-1"),
        AttemptOrdinal::new(1).expect("ordinal"),
        idempotency_key("task-1:attempt-1"),
    );
    attempt.status = state.attempt_status;
    attempt.worker_run_id = state.worker_run_id.map(worker_run_id);
    attempt.lease = state.lease;
    attempt.last_producer_sequence = state
        .producer_sequence
        .map(|sequence| ProducerSequence::new(sequence).expect("sequence"));
    TaskAggregate {
        contract,
        status: state.task_status,
        suspension_reason: state.suspension_reason,
        attempts: vec![attempt],
        active_attempt_id: Some(attempt_id("attempt-1")),
        aggregate_version: AggregateVersion::new(state.aggregate_version),
        task_stream_offset: TaskStreamOffset::new(state.stream_offset),
        last_event_id: Some(EventId::new(state.last_event_id).expect("event id")),
        progress_count: state.progress_count,
    }
}

struct ExpectedState {
    task_status: TaskStatus,
    suspension_reason: Option<SuspensionReason>,
    attempt_status: AttemptStatus,
    worker_run_id: Option<&'static str>,
    lease: Option<LeaseGrant>,
    producer_sequence: Option<u64>,
    aggregate_version: u64,
    stream_offset: u64,
    last_event_id: &'static str,
    progress_count: u64,
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
    .expect("task contract")
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

fn lease(epoch: u64, hash: &str, expires_at: i64) -> LeaseGrant {
    LeaseGrant::new(
        LeaseEpoch::new(epoch).expect("lease epoch"),
        FencingTokenHash::new(hash).expect("token hash"),
        UnixTimestamp::new(expires_at).expect("expires at"),
    )
}
