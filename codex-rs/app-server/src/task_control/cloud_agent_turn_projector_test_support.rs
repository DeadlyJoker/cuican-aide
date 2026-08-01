use std::sync::Arc;

use crewon_state::CloudAgentTurnRecord;
use crewon_state::CloudExecutionSpecRecord;
use crewon_state::ProviderRunEventProjection;
use crewon_state::ProviderRunFailureCode;
use crewon_state::ProviderRunJournalAdvanceOutcome;
use crewon_state::ProviderRunJournalAdvanceRecord;
use crewon_state::ProviderRunJournalCreateOutcome;
use crewon_state::ProviderRunJournalEventRecord;
use crewon_state::ProviderRunJournalKey;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::ProviderRunJournalStatus;
use crewon_state::StateRuntime;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::ProducerSequence;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerEvidence;
use crewon_task_runtime::WorkerOutcome;
use crewon_task_runtime::decide_command;

use super::cloud_agent_task_authority::CloudAgentTaskAuthority;
use super::cloud_agent_turn_coordinator::tests::Fixture;
use super::cloud_agent_turn_coordinator::tests::fixture;
use super::cloud_agent_turn_coordinator::tests::start;
use super::task_state_store_adapter::TaskStateStoreAdapter;

const HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

pub(crate) struct ProjectorHarness {
    pub(crate) fixture: Fixture,
    pub(crate) turn: CloudAgentTurnRecord,
}

pub(crate) async fn projector_harness(
    projections: Vec<ProviderRunEventProjection>,
) -> ProjectorHarness {
    let fixture = fixture().await;
    let turn = start(
        &fixture.state,
        &fixture.identity,
        "client-message-projector",
        "Return the verified result",
        /*now*/ 150,
    )
    .await
    .expect("create Cloud Agent Turn")
    .turn;
    CloudAgentTaskAuthority::new(fixture.state.clone())
        .run_once(/*now*/ 160)
        .await
        .expect("claim Cloud Agent Task");
    let journal = create_journal(&fixture.state, &turn).await;
    let mut current = journal.clone();
    for projection in projections {
        current = append_projection(&fixture.state, &current, projection).await;
    }
    ProjectorHarness { fixture, turn }
}

async fn create_journal(
    state: &Arc<StateRuntime>,
    turn: &CloudAgentTurnRecord,
) -> ProviderRunJournalRecord {
    let task_id = turn.origin.task_id().expect("durable Task");
    let task = TaskStateStoreAdapter::new(state.clone())
        .read(TaskId::new(task_id).expect("Task ID"))
        .await
        .expect("read Task")
        .expect("Task exists");
    let attempt = task.active_attempt().expect("active Attempt");
    let worker_run_id = attempt.worker_run_id().expect("Worker Run");
    let execution = task.contract().execution_spec();
    let spec = state
        .get_cloud_execution_spec_record(
            execution.execution_spec_id().as_str(),
            execution.revision().get(),
        )
        .await
        .expect("read execution spec")
        .expect("execution spec exists");
    let mut journal = journal_record(&spec, attempt.attempt_id().as_str(), worker_run_id.as_str());
    journal.record_hash = journal.canonical_hash();
    assert_eq!(
        state
            .create_provider_run_journal_record(&journal)
            .await
            .expect("create Provider Run journal"),
        ProviderRunJournalCreateOutcome::Created
    );
    journal
}

fn journal_record(
    spec: &CloudExecutionSpecRecord,
    attempt_id: &str,
    worker_run_id: &str,
) -> ProviderRunJournalRecord {
    ProviderRunJournalRecord {
        key: ProviderRunJournalKey {
            task_id: spec.task_id.clone(),
            attempt_id: attempt_id.to_string(),
            worker_run_id: worker_run_id.to_string(),
        },
        journal_version: 0,
        execution_spec_id: spec.execution_spec_id.clone(),
        execution_spec_revision: spec.revision,
        execution_spec_digest: spec.digest.clone(),
        provider_id: spec.provider_id.clone(),
        protocol_version: spec.protocol_version.clone(),
        resource_id: spec.resource_id.clone(),
        resource_revision: spec.resource_revision.clone(),
        credential_id: spec.credential_id.clone(),
        credential_revision: spec.credential_revision,
        provider_run_id: "provider-run-projector".to_string(),
        provider_attempt_id: "provider-attempt-projector".to_string(),
        provider_revision: None,
        last_sequence: 0,
        last_cursor: None,
        status: ProviderRunJournalStatus::Starting,
        start_command_id: "start-projector".to_string(),
        start_idempotency_key: "start-projector-idempotency".to_string(),
        request_digest: HASH.to_string(),
        record_hash: String::new(),
        created_at: 160,
        updated_at: 160,
    }
}

async fn append_projection(
    state: &Arc<StateRuntime>,
    journal: &ProviderRunJournalRecord,
    mut projection: ProviderRunEventProjection,
) -> ProviderRunJournalRecord {
    if let ProviderRunEventProjection::Completed { output_artifacts } = &mut projection {
        for artifact in output_artifacts {
            artifact.task_id.clone_from(&journal.key.task_id);
        }
    }
    let sequence = journal.last_sequence + 1;
    let event_type = projection.event_type();
    let created_at = 160 + i64::try_from(sequence).expect("sequence time");
    if let Some(outcome) = worker_outcome(&projection) {
        apply_worker_outcome(state, journal, sequence, outcome, created_at).await;
    }
    let event = ProviderRunJournalEventRecord {
        event_id: format!("provider-event-{sequence}"),
        sequence,
        cursor: format!("cursor-{sequence}"),
        event_type: event_type.to_string(),
        projection: crewon_state::ProviderRunEventProjectionRecord::from_projection(
            &journal.key.task_id,
            &projection,
        )
        .expect("canonical projection"),
        created_at,
    };
    let advance = ProviderRunJournalAdvanceRecord {
        key: journal.key.clone(),
        expected_journal_version: journal.journal_version,
        expected_sequence: journal.last_sequence,
        expected_cursor: journal.last_cursor.clone(),
        event,
        status: journal_status(&projection),
        provider_revision: matches!(projection, ProviderRunEventProjection::RunStarted { .. })
            .then_some(1),
        updated_at: created_at,
    };
    match state
        .advance_provider_run_journal(&advance)
        .await
        .expect("advance Provider journal")
    {
        ProviderRunJournalAdvanceOutcome::Advanced(journal) => journal,
        outcome => panic!("unexpected journal outcome: {outcome:?}"),
    }
}

fn worker_outcome(projection: &ProviderRunEventProjection) -> Option<WorkerOutcome> {
    match projection {
        ProviderRunEventProjection::Progress { .. } => Some(WorkerOutcome::Progressed),
        ProviderRunEventProjection::Completed { .. } => Some(WorkerOutcome::Succeeded),
        ProviderRunEventProjection::Failed {
            code: ProviderRunFailureCode::UnknownOutcome,
            ..
        } => Some(WorkerOutcome::OutcomeUnknown),
        ProviderRunEventProjection::Failed { .. } => Some(WorkerOutcome::Failed),
        ProviderRunEventProjection::Cancelled { .. } => Some(WorkerOutcome::Cancelled),
        ProviderRunEventProjection::RunStarted { .. }
        | ProviderRunEventProjection::ApprovalRequired { .. }
        | ProviderRunEventProjection::ToolResultRequired { .. }
        | ProviderRunEventProjection::ToolResultAccepted { .. } => None,
    }
}

fn journal_status(projection: &ProviderRunEventProjection) -> ProviderRunJournalStatus {
    match projection {
        ProviderRunEventProjection::RunStarted { .. }
        | ProviderRunEventProjection::Progress { .. } => ProviderRunJournalStatus::Running,
        ProviderRunEventProjection::ApprovalRequired { .. }
        | ProviderRunEventProjection::ToolResultRequired { .. }
        | ProviderRunEventProjection::ToolResultAccepted { .. } => {
            ProviderRunJournalStatus::Suspended
        }
        ProviderRunEventProjection::Completed { .. } => ProviderRunJournalStatus::Completed,
        ProviderRunEventProjection::Failed {
            code: ProviderRunFailureCode::UnknownOutcome,
            ..
        } => ProviderRunJournalStatus::Reconciling,
        ProviderRunEventProjection::Failed { .. } => ProviderRunJournalStatus::Failed,
        ProviderRunEventProjection::Cancelled { .. } => ProviderRunJournalStatus::Cancelled,
    }
}

async fn apply_worker_outcome(
    state: &Arc<StateRuntime>,
    journal: &ProviderRunJournalRecord,
    sequence: u64,
    outcome: WorkerOutcome,
    now: i64,
) {
    let adapter = TaskStateStoreAdapter::new(state.clone());
    let task_id = TaskId::new(&journal.key.task_id).expect("Task ID");
    let task = adapter
        .read(task_id.clone())
        .await
        .expect("read current Task")
        .expect("Task exists");
    if task.status().is_terminal() {
        return;
    }
    let attempt = task.active_attempt().expect("active Attempt");
    let lease = attempt.lease().expect("active lease");
    let timestamp = UnixTimestamp::new(now).expect("event time");
    let command = TaskCommandEnvelope {
        command_id: CommandId::new(format!("projector-worker-command-{sequence}"))
            .expect("command ID"),
        event_id: EventId::new(format!("projector-worker-event-{sequence}")).expect("event ID"),
        task_id: task_id.clone(),
        authority: task.contract().authority(),
        occurred_at: timestamp,
        received_at: timestamp,
        command: TaskCommand::ApplyWorkerEvent {
            evidence: WorkerEvidence {
                attempt_id: attempt.attempt_id().clone(),
                worker_run_id: attempt.worker_run_id().expect("Worker Run").clone(),
                producer_sequence: ProducerSequence::new(sequence).expect("producer sequence"),
                lease_epoch: lease.epoch(),
                fencing_token_hash: lease.fencing_token_hash().clone(),
            },
            outcome,
        },
    };
    let decision = decide_command(&task, &command).expect("worker decision");
    let commit = TaskCommit::from_decision(
        &task,
        &command,
        OutboxId::new(format!("projector-worker-outbox-{sequence}")).expect("outbox ID"),
        decision,
    )
    .expect("worker commit");
    assert!(matches!(
        adapter.commit(commit).await.expect("commit worker event"),
        TaskCommitOutcome::Committed(_)
    ));
}
