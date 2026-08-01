use std::sync::Arc;

use crewon_state::StateRuntime;
use crewon_state::TaskOutboxDeliveryOutcome;
use crewon_state::TaskOutboxStatus;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::ProducerSequence;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStatus;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerEvidence;
use crewon_task_runtime::WorkerOutcome;
use crewon_task_runtime::decide_command;
use pretty_assertions::assert_eq;

use super::super::cloud_agent_turn_cancellation::CloudAgentTurnInterruptDisposition;
use super::super::cloud_agent_turn_cancellation::CloudAgentTurnInterruptRequest;
use super::super::cloud_agent_turn_cancellation::CloudAgentTurnInterruptResult;
use super::super::cloud_agent_turn_cancellation::interrupt_cloud_agent_turn;
use super::super::cloud_agent_turn_coordinator::tests::fixture;
use super::super::cloud_agent_turn_coordinator::tests::start;
use super::super::cloud_execution_resolver::tests::FixtureOptions;
use super::super::cloud_execution_resolver::tests::fixture as execution_fixture;
use super::super::task_state_store_adapter::TaskStateStoreAdapter;
use super::CloudAgentTaskAuthority;
use super::CloudAgentTaskAuthorityReport;

#[tokio::test]
async fn unrelated_office_task_authority_decisions_are_not_consumed() {
    let fixture = execution_fixture(FixtureOptions::default()).await;
    assert_eq!(
        CloudAgentTaskAuthority::new(fixture.state.clone())
            .run_once(/*now*/ 150)
            .await
            .expect("ignore unrelated Office Task"),
        CloudAgentTaskAuthorityReport::default()
    );
    let accept = fixture
        .state
        .list_task_outbox_records("task-1", /*limit*/ 10)
        .await
        .expect("list unrelated Task outbox")
        .into_iter()
        .find(|row| row.decision_type == "enqueueAttempt")
        .expect("unrelated enqueue remains");
    assert_eq!(accept.status, TaskOutboxStatus::Pending);
    fixture.state.close().await;
}

#[tokio::test]
async fn enqueue_claim_replays_after_restart_before_source_delivery() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-authority-restart",
        "Run after restart",
        /*now*/ 150,
    )
    .await
    .expect("create queued Cloud Agent Turn")
    .turn;
    let task_id = turn.origin.task_id().expect("durable Task").to_string();
    let record = fixture
        .state
        .list_pending_cloud_agent_authority_outbox_records(/*now*/ 150, /*limit*/ 10)
        .await
        .expect("list authority outbox")
        .into_iter()
        .next()
        .expect("enqueue decision");
    let authority = CloudAgentTaskAuthority::new(fixture.state.clone());
    authority
        .apply_record(&record, /*now*/ 160)
        .await
        .expect("commit claim before source delivery");
    let before_restart = fixture
        .state
        .list_task_outbox_records(&task_id, /*limit*/ 10)
        .await
        .expect("list Task outbox before restart");
    assert_eq!(
        before_restart
            .iter()
            .find(|row| row.decision_type == "enqueueAttempt")
            .expect("source enqueue")
            .status,
        TaskOutboxStatus::Pending
    );

    drop(authority);
    fixture.state.close().await;
    let restarted = StateRuntime::init(
        fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let report = CloudAgentTaskAuthority::new(restarted.clone())
        .run_once(/*now*/ 170)
        .await
        .expect("replay claim and deliver source");
    assert_eq!(
        report,
        CloudAgentTaskAuthorityReport {
            inspected: 1,
            claimed: 1,
            replayed: 1,
            delivered: 1,
            ..CloudAgentTaskAuthorityReport::default()
        }
    );
    let task = TaskStateStoreAdapter::new(restarted.clone())
        .read(TaskId::new(&task_id).expect("Task id"))
        .await
        .expect("read Task")
        .expect("Task exists");
    assert_eq!(task.status(), TaskStatus::Running);
    assert_eq!(task.aggregate_version().get(), 2);
    assert_eq!(task.attempts().len(), 1);
    let outbox = restarted
        .list_task_outbox_records(&task_id, /*limit*/ 10)
        .await
        .expect("list restarted Task outbox");
    assert_eq!(
        outbox
            .iter()
            .map(|row| (row.decision_type.as_str(), row.status))
            .collect::<Vec<_>>(),
        vec![
            ("enqueueAttempt", TaskOutboxStatus::Delivered),
            ("dispatchAttempt", TaskOutboxStatus::Pending),
        ]
    );
    restarted.close().await;
}

#[tokio::test]
async fn cancel_after_claim_commit_still_replays_and_acks_source_enqueue() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-authority-cancel-restart",
        "Cancel during authority delivery",
        /*now*/ 150,
    )
    .await
    .expect("create queued Cloud Agent Turn")
    .turn;
    let task_id = turn.origin.task_id().expect("durable Task").to_string();
    let record = fixture
        .state
        .list_pending_cloud_agent_authority_outbox_records(/*now*/ 150, /*limit*/ 10)
        .await
        .expect("list authority outbox")
        .into_iter()
        .next()
        .expect("enqueue decision");
    let authority = CloudAgentTaskAuthority::new(fixture.state.clone());
    authority
        .apply_record(&record, /*now*/ 160)
        .await
        .expect("commit claim before source delivery");

    assert_eq!(
        interrupt_cloud_agent_turn(CloudAgentTurnInterruptRequest {
            state: fixture.state.clone(),
            identity: &fixture.identity,
            thread_id: &turn.thread_id,
            turn_id: &turn.turn_id,
            now: 170,
        })
        .await
        .expect("cancel claimed Task"),
        Some(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::Cancelled,
            task_status: Some(TaskStatus::Cancelled),
        })
    );
    assert_eq!(
        authority
            .run_once(/*now*/ 180)
            .await
            .expect("replay claim receipt and acknowledge source"),
        CloudAgentTaskAuthorityReport {
            inspected: 1,
            claimed: 1,
            replayed: 1,
            delivered: 1,
            ..CloudAgentTaskAuthorityReport::default()
        }
    );
    let task = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(TaskId::new(&task_id).expect("Task id"))
        .await
        .expect("read cancelled Task")
        .expect("Task exists");
    assert_eq!(task.status(), TaskStatus::Cancelled);
    assert_eq!(task.aggregate_version().get(), 3);
    assert_eq!(task.attempts().len(), 1);
    let outbox = fixture
        .state
        .list_task_outbox_records(&task_id, /*limit*/ 10)
        .await
        .expect("list cancellation outbox");
    assert_eq!(
        outbox
            .iter()
            .map(|row| (row.decision_type.as_str(), row.status))
            .collect::<Vec<_>>(),
        vec![
            ("enqueueAttempt", TaskOutboxStatus::Delivered),
            ("dispatchAttempt", TaskOutboxStatus::Pending),
            ("cancelAttempt", TaskOutboxStatus::Pending),
        ]
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn known_provider_failure_is_final_and_never_schedules_retry() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-known-failure",
        "Fail deterministically",
        /*now*/ 150,
    )
    .await
    .expect("create queued Cloud Agent Turn")
    .turn;
    let task_id = turn.origin.task_id().expect("durable Task");
    let authority = CloudAgentTaskAuthority::new(fixture.state.clone());
    let claim_report = authority
        .run_once(/*now*/ 160)
        .await
        .expect("claim Cloud Agent Attempt");
    assert_eq!(claim_report.claimed, 1);
    mark_dispatch_delivered(&fixture.state, task_id, /*now*/ 165).await;
    apply_worker_outcome(
        fixture.state.clone(),
        task_id,
        WorkerOutcome::Failed,
        /*now*/ 170,
    )
    .await;

    let report = authority
        .run_once(/*now*/ 180)
        .await
        .expect("finalize known failure");
    assert_eq!(
        report,
        CloudAgentTaskAuthorityReport {
            inspected: 1,
            failed: 1,
            delivered: 1,
            ..CloudAgentTaskAuthorityReport::default()
        }
    );
    let task = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(TaskId::new(task_id).expect("Task id"))
        .await
        .expect("read failed Task")
        .expect("Task exists");
    assert_eq!(task.status(), TaskStatus::Failed);
    assert_eq!(task.attempts().len(), 1);
    assert!(
        fixture
            .state
            .list_pending_cloud_agent_authority_outbox_records(/*now*/ 180, /*limit*/ 10)
            .await
            .expect("no retry decision remains")
            .is_empty()
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn unknown_outcome_remains_reconciling_and_is_not_failed_or_retried() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-unknown-outcome",
        "Reconcile the same run",
        /*now*/ 150,
    )
    .await
    .expect("create queued Cloud Agent Turn")
    .turn;
    let task_id = turn.origin.task_id().expect("durable Task");
    let authority = CloudAgentTaskAuthority::new(fixture.state.clone());
    authority
        .run_once(/*now*/ 160)
        .await
        .expect("claim Cloud Agent Attempt");
    mark_dispatch_delivered(&fixture.state, task_id, /*now*/ 165).await;
    apply_worker_outcome(
        fixture.state.clone(),
        task_id,
        WorkerOutcome::OutcomeUnknown,
        /*now*/ 170,
    )
    .await;

    assert_eq!(
        authority
            .run_once(/*now*/ 180)
            .await
            .expect("ignore Worker reconcile decision"),
        CloudAgentTaskAuthorityReport::default()
    );
    let task = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(TaskId::new(task_id).expect("Task id"))
        .await
        .expect("read reconciling Task")
        .expect("Task exists");
    assert_eq!(task.status(), TaskStatus::Reconciling);
    assert_eq!(task.attempts().len(), 1);
    fixture.state.close().await;
}

async fn mark_dispatch_delivered(state: &StateRuntime, task_id: &str, now: i64) {
    let dispatch = state
        .list_task_outbox_records(task_id, /*limit*/ 10)
        .await
        .expect("list dispatch outbox")
        .into_iter()
        .find(|row| row.decision_type == "dispatchAttempt")
        .expect("dispatch decision");
    assert_eq!(
        state
            .mark_task_outbox_delivered_if_attempt(
                &dispatch.outbox_id,
                dispatch.delivery_attempts,
                now,
            )
            .await
            .expect("deliver dispatch outbox"),
        TaskOutboxDeliveryOutcome::Delivered
    );
}

async fn apply_worker_outcome(
    state: Arc<StateRuntime>,
    task_id: &str,
    outcome: WorkerOutcome,
    now: i64,
) {
    let store = TaskStateStoreAdapter::new(state);
    let task_id = TaskId::new(task_id).expect("Task id");
    let current = store
        .read(task_id.clone())
        .await
        .expect("read running Task")
        .expect("Task exists");
    let attempt = current.active_attempt().expect("active Attempt");
    let lease = attempt.lease().expect("active lease");
    let outcome_name = outcome_name(&outcome);
    let command = TaskCommandEnvelope {
        command_id: CommandId::new(format!("worker-command-{outcome_name}")).expect("command id"),
        event_id: EventId::new(format!("worker-event-{outcome_name}")).expect("event id"),
        task_id,
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(now).expect("occurred at"),
        received_at: UnixTimestamp::new(now).expect("received at"),
        command: TaskCommand::ApplyWorkerEvent {
            evidence: WorkerEvidence {
                attempt_id: attempt.attempt_id().clone(),
                worker_run_id: attempt.worker_run_id().expect("Worker run").clone(),
                producer_sequence: ProducerSequence::new(/*value*/ 1).expect("producer sequence"),
                lease_epoch: lease.epoch(),
                fencing_token_hash: lease.fencing_token_hash().clone(),
            },
            outcome,
        },
    };
    let decision = decide_command(&current, &command).expect("Worker outcome decision");
    let commit = TaskCommit::from_decision(
        &current,
        &command,
        OutboxId::new(format!("worker-outbox-{outcome_name}")).expect("outbox id"),
        decision,
    )
    .expect("Worker outcome commit");
    assert!(matches!(
        store.commit(commit).await.expect("commit Worker outcome"),
        TaskCommitOutcome::Committed(_)
    ));
}

fn outcome_name(outcome: &WorkerOutcome) -> &'static str {
    match outcome {
        WorkerOutcome::Failed => "failed",
        WorkerOutcome::OutcomeUnknown => "unknown",
        WorkerOutcome::Progressed
        | WorkerOutcome::Suspended { .. }
        | WorkerOutcome::Resumed
        | WorkerOutcome::Succeeded
        | WorkerOutcome::Cancelled => "other",
    }
}
