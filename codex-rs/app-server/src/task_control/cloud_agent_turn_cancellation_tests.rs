use crewon_state::ProviderAccessGrantRevokeOutcome;
use crewon_state::ProviderAccessGrantRevokeRequest;
use crewon_state::StateRuntime;
use crewon_state::TaskOutboxStatus;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::ProducerSequence;
use crewon_task_runtime::SchedulerDecision;
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

use super::CloudAgentTurnInterruptDisposition;
use super::CloudAgentTurnInterruptError;
use super::CloudAgentTurnInterruptRequest;
use super::CloudAgentTurnInterruptResult;
use super::interrupt_cloud_agent_turn;
use crate::platform_control::authenticated_identity_in_space;
use crate::task_control::cloud_agent_task_authority::CloudAgentTaskAuthority;
use crate::task_control::cloud_agent_task_authority::CloudAgentTaskAuthorityReport;
use crate::task_control::cloud_agent_turn_coordinator::tests::fixture;
use crate::task_control::cloud_agent_turn_coordinator::tests::start;
use crate::task_control::task_state_store_adapter::TaskStateStoreAdapter;

const THREAD_ID: &str = "019f550e-ba52-7490-a248-b0d3a84103c1";

#[tokio::test]
async fn queued_cancel_is_idempotent_across_restart_and_supersedes_enqueue() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-cancel-queued",
        "Cancel before claim",
        /*now*/ 150,
    )
    .await
    .expect("create queued Turn")
    .turn;

    assert_eq!(
        interrupt(
            &fixture.state,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 160
        )
        .await
        .expect("cancel queued Turn"),
        Some(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::Cancelled,
            task_status: Some(TaskStatus::Cancelled),
        })
    );
    assert_eq!(
        interrupt(
            &fixture.state,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 161
        )
        .await
        .expect("repeat queued cancellation"),
        Some(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::ExistingCancel,
            task_status: Some(TaskStatus::Cancelled),
        })
    );

    fixture.state.close().await;
    let restarted = StateRuntime::init(
        fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    assert_eq!(
        interrupt(
            &restarted,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 170
        )
        .await
        .expect("repeat cancellation after restart"),
        Some(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::ExistingCancel,
            task_status: Some(TaskStatus::Cancelled),
        })
    );
    assert_eq!(
        CloudAgentTaskAuthority::new(restarted.clone())
            .run_once(/*now*/ 170)
            .await
            .expect("acknowledge superseded enqueue"),
        CloudAgentTaskAuthorityReport {
            inspected: 1,
            delivered: 1,
            ..CloudAgentTaskAuthorityReport::default()
        }
    );
    let task_id = turn.origin.task_id().expect("durable Task");
    let outbox = restarted
        .list_task_outbox_records(task_id, /*limit*/ 10)
        .await
        .expect("list cancelled Task outbox");
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].decision_type, "enqueueAttempt");
    assert_eq!(outbox[0].status, TaskOutboxStatus::Delivered);
    restarted.close().await;
}

#[tokio::test]
async fn running_cancel_commits_one_stable_provider_cancel_decision() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-cancel-running",
        "Cancel after claim",
        /*now*/ 150,
    )
    .await
    .expect("create queued Turn")
    .turn;
    CloudAgentTaskAuthority::new(fixture.state.clone())
        .run_once(/*now*/ 160)
        .await
        .expect("claim Attempt");

    let (first, second) = tokio::join!(
        interrupt(
            &fixture.state,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 170
        ),
        interrupt(
            &fixture.state,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 171
        ),
    );
    let concurrent = [
        first
            .expect("first concurrent cancellation")
            .expect("Cloud route"),
        second
            .expect("second concurrent cancellation")
            .expect("Cloud route"),
    ];
    assert!(concurrent.contains(&CloudAgentTurnInterruptResult {
        disposition: CloudAgentTurnInterruptDisposition::Cancelled,
        task_status: Some(TaskStatus::Cancelled),
    }));
    assert!(concurrent.contains(&CloudAgentTurnInterruptResult {
        disposition: CloudAgentTurnInterruptDisposition::ExistingCancel,
        task_status: Some(TaskStatus::Cancelled),
    }));
    assert_eq!(
        interrupt(
            &fixture.state,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 180
        )
        .await
        .expect("repeat running cancellation"),
        Some(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::ExistingCancel,
            task_status: Some(TaskStatus::Cancelled),
        })
    );

    let task_id = turn.origin.task_id().expect("durable Task");
    let outbox = fixture
        .state
        .list_task_outbox_records(task_id, /*limit*/ 10)
        .await
        .expect("list Task outbox");
    let cancellations = outbox
        .iter()
        .filter(|record| record.decision_type == "cancelAttempt")
        .collect::<Vec<_>>();
    assert_eq!(cancellations.len(), 1);
    let decision = serde_json::from_str::<SchedulerDecision>(&cancellations[0].payload_json)
        .expect("decode cancellation decision");
    let task = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(TaskId::new(task_id).expect("Task id"))
        .await
        .expect("read cancelled Task")
        .expect("Task exists");
    let attempt = task.active_attempt().expect("cancelled Attempt");
    assert_eq!(
        decision,
        SchedulerDecision::CancelAttempt {
            attempt_id: attempt.attempt_id().clone(),
            worker_run_id: attempt.worker_run_id().expect("Worker run").clone(),
        }
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn provider_completion_winning_cancel_race_is_terminal_noop() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-cancel-race",
        "Complete before cancellation commits",
        /*now*/ 150,
    )
    .await
    .expect("create queued Turn")
    .turn;
    CloudAgentTaskAuthority::new(fixture.state.clone())
        .run_once(/*now*/ 160)
        .await
        .expect("claim Attempt");
    apply_success(
        &fixture.state,
        turn.origin.task_id().expect("durable Task"),
        /*now*/ 170,
    )
    .await;

    assert_eq!(
        interrupt(
            &fixture.state,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 180
        )
        .await
        .expect("terminal cancellation race"),
        Some(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::AlreadyTerminal,
            task_status: Some(TaskStatus::Completed),
        })
    );
    assert!(
        fixture
            .state
            .list_task_outbox_records(
                turn.origin.task_id().expect("durable Task"),
                /*limit*/ 10,
            )
            .await
            .expect("list terminal Task outbox")
            .iter()
            .all(|record| record.decision_type != "cancelAttempt")
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn owner_can_cancel_after_grant_revoke_but_cross_owner_cannot() {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-cancel-revoke",
        "Cancel after authority revoke",
        /*now*/ 150,
    )
    .await
    .expect("create queued Turn")
    .turn;
    let cross_space = authenticated_identity_in_space("trace-cross-space", "space-other");
    assert_eq!(
        interrupt(
            &fixture.state,
            &cross_space,
            &turn.turn_id,
            /*now*/ 160,
        )
        .await,
        Err(CloudAgentTurnInterruptError::Unauthorized)
    );
    assert_eq!(
        fixture
            .state
            .revoke_provider_access_grant_record(&ProviderAccessGrantRevokeRequest {
                grant_id: "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c102".to_string(),
                expected_revision: 1,
                revoked_at: 170,
            })
            .await
            .expect("revoke Provider grant"),
        ProviderAccessGrantRevokeOutcome::Revoked
    );
    assert_eq!(
        interrupt(
            &fixture.state,
            &fixture.identity,
            &turn.turn_id,
            /*now*/ 180
        )
        .await
        .expect("owner cancellation remains available"),
        Some(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::Cancelled,
            task_status: Some(TaskStatus::Cancelled),
        })
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn missing_cloud_authority_falls_through_but_bound_thread_misses_fail_closed() {
    let fixture = fixture().await;
    assert_eq!(
        interrupt(&fixture.state, &fixture.identity, "", /*now*/ 150)
            .await
            .expect("Core startup interrupt route"),
        None
    );
    assert_eq!(
        interrupt_cloud_agent_turn(CloudAgentTurnInterruptRequest {
            state: fixture.state.clone(),
            identity: &fixture.identity,
            thread_id: "019f550e-ba52-7490-a248-b0d3a84103c2",
            turn_id: "core-turn-1",
            now: 150,
        })
        .await
        .expect("unbound Core route"),
        None
    );
    assert_eq!(
        interrupt(
            &fixture.state,
            &fixture.identity,
            "unknown-cloud-turn",
            /*now*/ 150,
        )
        .await,
        Err(CloudAgentTurnInterruptError::NotFound)
    );
    fixture.state.close().await;
}

async fn interrupt(
    state: &std::sync::Arc<StateRuntime>,
    identity: &crate::platform_control::RequestIdentity,
    turn_id: &str,
    now: i64,
) -> Result<Option<CloudAgentTurnInterruptResult>, CloudAgentTurnInterruptError> {
    interrupt_cloud_agent_turn(CloudAgentTurnInterruptRequest {
        state: state.clone(),
        identity,
        thread_id: THREAD_ID,
        turn_id,
        now,
    })
    .await
}

async fn apply_success(state: &std::sync::Arc<StateRuntime>, task_id: &str, now: i64) {
    let store = TaskStateStoreAdapter::new(state.clone());
    let task_id = TaskId::new(task_id).expect("Task id");
    let current = store
        .read(task_id.clone())
        .await
        .expect("read running Task")
        .expect("Task exists");
    let attempt = current.active_attempt().expect("active Attempt");
    let lease = attempt.lease().expect("active lease");
    let command = TaskCommandEnvelope {
        command_id: CommandId::new("worker-command-success").expect("command id"),
        event_id: EventId::new("worker-event-success").expect("event id"),
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
            outcome: WorkerOutcome::Succeeded,
        },
    };
    let decision = decide_command(&current, &command).expect("complete Task decision");
    let commit = TaskCommit::from_decision(
        &current,
        &command,
        OutboxId::new("worker-outbox-success").expect("outbox id"),
        decision,
    )
    .expect("complete Task commit");
    assert!(matches!(
        store.commit(commit).await.expect("commit Task completion"),
        TaskCommitOutcome::Committed(_)
    ));
}
