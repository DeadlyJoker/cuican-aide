use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use crewon_provider_agent_platform::AgentPlatformProviderError;
use crewon_provider_agent_platform::DurableProviderRunClient;
use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderRunCancelRequest;
use crewon_provider_agent_platform::ProviderRunCancelResult;
use crewon_provider_agent_platform::ProviderRunCancelStatus;
use crewon_provider_agent_platform::ProviderRunEvent;
use crewon_provider_agent_platform::ProviderRunEventMetadata;
use crewon_provider_agent_platform::ProviderRunEventPage;
use crewon_provider_agent_platform::ProviderRunEventPayload;
use crewon_provider_agent_platform::ProviderRunEventsRequest;
use crewon_provider_agent_platform::ProviderRunReadRequest;
use crewon_provider_agent_platform::ProviderRunSnapshot;
use crewon_provider_agent_platform::ProviderRunStartRequest;
use crewon_provider_agent_platform::ProviderRunStartResult;
use crewon_provider_agent_platform::ProviderRunStatus;
use crewon_state::ProviderRunJournalAdvanceOutcome;
use crewon_state::ProviderRunJournalAdvanceRecord;
use crewon_state::ProviderRunJournalCreateOutcome;
use crewon_state::ProviderRunJournalKey;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::ProviderRunJournalStatus;
use crewon_state::ProviderRunSupervisionQuery;
use crewon_task_runtime::AttemptStatus;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::FencingTokenHash;
use crewon_task_runtime::LeaseEpoch;
use crewon_task_runtime::LeaseGrant;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::ProducerSequence;
use crewon_task_runtime::SuspensionReason;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskStatus;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerCancellation;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerEvidence;
use crewon_task_runtime::WorkerExecutor;
use crewon_task_runtime::WorkerExecutorError;
use crewon_task_runtime::WorkerOutcome;
use crewon_task_runtime::WorkerReconciliation;
use crewon_task_runtime::WorkerRunId;
use crewon_task_runtime::decide_command;
use pretty_assertions::assert_eq;

use super::*;
use crate::task_control::cloud_execution_resolver::tests::CONTEXT_SECRET_MARKER;
use crate::task_control::cloud_execution_resolver::tests::Fixture;
use crate::task_control::cloud_execution_resolver::tests::FixtureOptions;
use crate::task_control::cloud_execution_resolver::tests::fixture;
use crate::task_control::cloud_worker_journal::ProviderRunJournalStore;
use crate::task_control::cloud_worker_journal::ProviderRunJournalStoreError;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn start_persists_exact_journal_and_replay_skips_provider() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::new([Ok(start_result(
        "provider-run-1",
        "provider-attempt-1",
    ))]));
    let worker = worker(&fixture, client.clone(), /*now*/ 150);

    let first = worker
        .start(fixture.dispatch.clone())
        .await
        .expect("first Provider start");
    let replay = worker
        .start(fixture.dispatch.clone())
        .await
        .expect("journal replay");

    assert_eq!(first.as_str(), "provider-run-1");
    assert_eq!(replay, first);
    assert_eq!(client.start_count(), 1);
    let requests = client.start_requests();
    let request = requests.first().expect("captured start request");
    assert_eq!(request.authorization().task_id(), "task-1");
    assert_eq!(request.authorization().credential_revision(), 1);
    assert_eq!(request.prompt(), "Run the exact task");
    assert_eq!(request.context_refs().len(), 1);
    assert_eq!(request.context_refs()[0].task_id(), "task-1");
    assert!(request.idempotency_key().starts_with("run:"));
    assert!(request.request_digest().starts_with("sha256:"));
    let debug = format!("{request:?}");
    assert!(!debug.contains("Run the exact task"));
    assert!(!debug.contains(CONTEXT_SECRET_MARKER));

    let journal = fixture
        .state
        .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
        .await
        .expect("read journal")
        .expect("journal");
    assert_eq!(journal.key.worker_run_id, "worker-1");
    assert_eq!(journal.provider_run_id, "provider-run-1");
    assert_eq!(journal.provider_attempt_id, "provider-attempt-1");
    assert_eq!(journal.credential_revision, 1);
    assert_eq!(journal.status, ProviderRunJournalStatus::Starting);
    assert_eq!(journal.start_command_id, request.command_id());
    assert_eq!(journal.start_idempotency_key, request.idempotency_key());
    assert_eq!(journal.request_digest, request.request_digest());

    fixture.state.close().await;
}

#[tokio::test]
async fn reclaimed_worker_reuses_attempt_run_without_second_provider_start() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::new([Ok(start_result(
        "provider-run-1",
        "provider-attempt-1",
    ))]));
    worker(&fixture, client.clone(), /*now*/ 150)
        .start(fixture.dispatch.clone())
        .await
        .expect("first Provider start");

    let current = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    let reclaimed = commit_task(
        &fixture,
        &current,
        command_at(
            "reclaim-command",
            "reclaim-event",
            /*received_at*/ 1_001,
            TaskCommand::ReclaimAttempt {
                attempt_id: fixture.dispatch.control().attempt_id().clone(),
                worker_run_id: WorkerRunId::new("worker-2").expect("worker run id"),
                lease: LeaseGrant::new(
                    LeaseEpoch::new(/*value*/ 2).expect("lease epoch"),
                    FencingTokenHash::new(
                        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    )
                    .expect("fencing token hash"),
                    UnixTimestamp::new(/*value*/ 2_000).expect("lease expiry"),
                ),
            },
        ),
        "reclaim-outbox",
    )
    .await;
    let dispatch = WorkerDispatch::from_aggregate(
        &reclaimed,
        UnixTimestamp::new(/*value*/ 1_100).expect("dispatch time"),
    )
    .expect("reclaimed dispatch");

    let replay = worker(&fixture, client.clone(), /*now*/ 1_100)
        .start(dispatch)
        .await
        .expect("reclaimed journal replay");
    assert_eq!(replay.as_str(), "provider-run-1");
    assert_eq!(client.start_count(), 1);
    let journal = fixture
        .state
        .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
        .await
        .expect("read journal")
        .expect("journal");
    assert_eq!(journal.key.worker_run_id, "worker-1");

    fixture.state.close().await;
}

#[tokio::test]
async fn conflicting_attempt_journal_fails_unknown_without_provider_side_effect() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::new([]));
    let mut journal = conflicting_journal(&fixture);
    journal.record_hash = journal.canonical_hash();
    assert_eq!(
        fixture
            .state
            .create_provider_run_journal_record(&journal)
            .await
            .expect("create conflicting journal"),
        ProviderRunJournalCreateOutcome::Created
    );

    assert_eq!(
        worker(&fixture, client.clone(), /*now*/ 150)
            .start(fixture.dispatch.clone())
            .await,
        Err(WorkerExecutorError::OutcomeUnknown)
    );
    assert_eq!(client.start_count(), 0);

    fixture.state.close().await;
}

#[tokio::test]
async fn stale_dispatch_is_rejected_before_provider_side_effect() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::new([Ok(start_result(
        "provider-run-unused",
        "provider-attempt-unused",
    ))]));
    let current = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    commit_task(
        &fixture,
        &current,
        command_at(
            "cancel-command",
            "cancel-event",
            /*received_at*/ 160,
            TaskCommand::CancelTask,
        ),
        "cancel-outbox",
    )
    .await;

    assert_eq!(
        worker(&fixture, client.clone(), /*now*/ 170)
            .start(fixture.dispatch.clone())
            .await,
        Err(WorkerExecutorError::InvalidResponse)
    );
    assert_eq!(client.start_count(), 0);

    fixture.state.close().await;
}

#[tokio::test]
async fn event_pump_commits_worker_fact_before_advancing_cursor() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::with_events(
        [Ok(start_result("provider-run-1", "provider-attempt-1"))],
        [Ok(cancelled_page(/*after_cursor*/ None))],
    ));
    let worker = worker(&fixture, client.clone(), /*now*/ 200);
    worker
        .start(fixture.dispatch.clone())
        .await
        .expect("Provider start");
    worker
        .pump_events(fixture.dispatch.clone())
        .await
        .expect("pump Provider events");

    let task = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    assert_eq!(task.status(), TaskStatus::Suspended);
    assert_eq!(
        task.active_attempt().expect("attempt").status(),
        AttemptStatus::Cancelled
    );
    let journal = fixture
        .state
        .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
        .await
        .expect("read journal")
        .expect("journal");
    assert_eq!(journal.last_sequence, 2);
    assert_eq!(journal.last_cursor.as_deref(), Some("event-0002"));
    assert_eq!(journal.status, ProviderRunJournalStatus::Cancelled);
    let outbox = fixture
        .state
        .list_task_outbox_records("task-1", /*limit*/ 100)
        .await
        .expect("list outbox");
    assert_eq!(outbox.len(), 3);
    assert_eq!(outbox[2].decision_type, "awaitRetryDecision");
    assert_eq!(client.event_requests().len(), 1);
    assert_eq!(
        client.event_requests()[0]
            .authorization()
            .credential_revision(),
        1
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn approval_required_is_durably_suspended_without_repeated_polling() {
    assert_unsupported_input_stops(
        vec![ProviderRunEventPayload::ApprovalRequired {
            approval_id: "approval-1".to_string(),
            action_digest: HASH_A.to_string(),
            expires_at: 500,
        }],
        SuspensionReason::ApprovalRequired,
        "approvalRequired",
    )
    .await;
}

#[tokio::test]
async fn tool_result_required_stops_before_later_page_events_without_repeated_polling() {
    assert_unsupported_input_stops(
        vec![
            ProviderRunEventPayload::ToolResultRequired {
                tool_call_id: "tool-call-1".to_string(),
                tool_schema_revision: "schema-v1".to_string(),
                arguments_digest: HASH_A.to_string(),
                intent_digest: HASH_A.to_string(),
                nonce: "nonce-1".to_string(),
                expires_at: 500,
            },
            ProviderRunEventPayload::ToolResultAccepted {
                tool_call_id: "tool-call-1".to_string(),
                intent_digest: HASH_A.to_string(),
                result_digest: HASH_A.to_string(),
            },
        ],
        SuspensionReason::ProviderPaused,
        "toolResultRequired",
    )
    .await;
}

#[tokio::test]
async fn unowned_tool_result_acceptance_is_durably_stopped_without_repeated_polling() {
    assert_unsupported_input_stops(
        vec![ProviderRunEventPayload::ToolResultAccepted {
            tool_call_id: "tool-call-1".to_string(),
            intent_digest: HASH_A.to_string(),
            result_digest: HASH_A.to_string(),
        }],
        SuspensionReason::ProviderPaused,
        "toolResultAccepted",
    )
    .await;
}

async fn assert_unsupported_input_stops(
    payloads: Vec<ProviderRunEventPayload>,
    expected_reason: SuspensionReason,
    expected_event_type: &str,
) {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::with_events(
        [Ok(start_result("provider-run-1", "provider-attempt-1"))],
        [Ok(input_required_page(payloads))],
    ));
    let worker = worker(&fixture, client.clone(), /*now*/ 200);
    worker
        .start(fixture.dispatch.clone())
        .await
        .expect("Provider start");
    worker
        .pump_events(fixture.dispatch.clone())
        .await
        .expect("unsupported input stop");

    let task = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    assert_eq!(task.status(), TaskStatus::Suspended);
    assert_eq!(task.suspension_reason(), Some(expected_reason));
    assert_eq!(
        task.active_attempt().expect("attempt").status(),
        AttemptStatus::Suspended
    );

    let journal = fixture
        .state
        .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
        .await
        .expect("read journal")
        .expect("journal");
    assert_eq!(journal.status, ProviderRunJournalStatus::Suspended);
    assert_eq!(journal.last_sequence, 2);
    assert_eq!(journal.last_cursor.as_deref(), Some("event-0002"));
    let page = fixture
        .state
        .read_provider_run_journal_event_page(&crewon_state::ProviderRunJournalEventPageQuery {
            key: journal.key.clone(),
            after_sequence: 1,
            limit: 10,
        })
        .await
        .expect("read event page")
        .expect("event page");
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].event_type, expected_event_type);
    assert_eq!(page.journal_last_sequence, 2);
    assert_eq!(client.event_requests().len(), 1);
    assert!(
        fixture
            .state
            .list_due_provider_run_supervision_records(&ProviderRunSupervisionQuery {
                after: None,
                now: 1_000,
                limit: 100,
            })
            .await
            .expect("list due Provider runs")
            .is_empty()
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn cursor_failure_replay_deduplicates_task_transition_and_outbox() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::with_events(
        [Ok(start_result("provider-run-1", "provider-attempt-1"))],
        [
            Ok(cancelled_page(/*after_cursor*/ None)),
            Ok(cancelled_page(Some("event-0001"))),
        ],
    ));
    let journal = Arc::new(FailOnceJournal::new(
        fixture.state.clone(),
        /*fail_sequence*/ 2,
    ));
    let worker = CloudWorkerExecutor::new_with_journal(
        fixture.state.clone(),
        journal,
        Arc::new(FixedProviderRunClientFactory::new(client)),
        Arc::new(|| 200),
    );
    worker
        .start(fixture.dispatch.clone())
        .await
        .expect("Provider start");

    assert_eq!(
        worker.pump_events(fixture.dispatch.clone()).await,
        Err(WorkerExecutorError::Unavailable)
    );
    let after_failure = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    assert_eq!(after_failure.status(), TaskStatus::Suspended);
    assert_eq!(after_failure.aggregate_version().get(), 3);
    let journal_after_failure = fixture
        .state
        .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
        .await
        .expect("read journal")
        .expect("journal");
    assert_eq!(journal_after_failure.last_sequence, 1);

    worker
        .pump_events(fixture.dispatch.clone())
        .await
        .expect("replay Provider event");
    let after_replay = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    assert_eq!(after_replay.aggregate_version().get(), 3);
    let outbox = fixture
        .state
        .list_task_outbox_records("task-1", /*limit*/ 100)
        .await
        .expect("list outbox");
    assert_eq!(outbox.len(), 3);
    let journal_after_replay = fixture
        .state
        .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
        .await
        .expect("read journal")
        .expect("journal");
    assert_eq!(journal_after_replay.last_sequence, 2);
    assert_eq!(
        journal_after_replay.status,
        ProviderRunJournalStatus::Cancelled
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn authority_cancel_wins_terminal_race_and_provider_cancel_is_journal_only() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::with_events(
        [Ok(start_result("provider-run-1", "provider-attempt-1"))],
        [Ok(cancelled_page(/*after_cursor*/ None))],
    ));
    let worker = worker(&fixture, client, /*now*/ 200);
    worker
        .start(fixture.dispatch.clone())
        .await
        .expect("Provider start");
    let current = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    let cancelled = commit_task(
        &fixture,
        &current,
        command_at(
            "authority-cancel-command",
            "authority-cancel-event",
            /*received_at*/ 190,
            TaskCommand::CancelTask,
        ),
        "authority-cancel-outbox",
    )
    .await;
    assert_eq!(cancelled.status(), TaskStatus::Cancelled);

    worker
        .pump_events(fixture.dispatch.clone())
        .await
        .expect("audit late Provider cancellation");
    let after_pump = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    assert_eq!(after_pump, cancelled);
    let journal = fixture
        .state
        .get_provider_run_journal_record_for_attempt("task-1", "attempt-1")
        .await
        .expect("read journal")
        .expect("journal");
    assert_eq!(journal.status, ProviderRunJournalStatus::Cancelled);
    assert_eq!(journal.last_sequence, 2);

    fixture.state.close().await;
}

#[tokio::test]
async fn authority_cancel_reads_current_revision_and_cancels_exact_provider_run() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::with_control(
        [Ok(start_result("provider-run-1", "provider-attempt-1"))],
        [
            Ok(run_snapshot(
                ProviderRunStatus::Running,
                /*revision*/ 7,
            )),
            Ok(run_snapshot(
                ProviderRunStatus::Cancelled,
                /*revision*/ 8,
            )),
        ],
        [Ok(ProviderRunCancelResult::new(
            ProviderRunCancelStatus::CancelRequested,
            /*revision*/ 8,
            /*duplicate*/ false,
        )
        .expect("cancel result"))],
    ));
    let worker = worker(&fixture, client.clone(), /*now*/ 200);
    worker
        .start(fixture.dispatch.clone())
        .await
        .expect("Provider start");
    let current = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    let cancelled = commit_task(
        &fixture,
        &current,
        command_at(
            "authority-cancel-command",
            "authority-cancel-event",
            /*received_at*/ 190,
            TaskCommand::CancelTask,
        ),
        "authority-cancel-outbox",
    )
    .await;
    let cancellation = WorkerCancellation::from_aggregate(
        &cancelled,
        UnixTimestamp::new(/*value*/ 200).expect("cancel time"),
    )
    .expect("Worker cancellation");

    worker
        .cancel(cancellation.clone())
        .await
        .expect("cancel active Provider run");
    worker
        .cancel(cancellation)
        .await
        .expect("terminal Provider cancellation is idempotent");

    assert_eq!(client.read_requests().len(), 2);
    assert_eq!(client.cancel_requests().len(), 1);
    let cancel = &client.cancel_requests()[0];
    assert_eq!(cancel.provider_run_id(), "provider-run-1");
    assert_eq!(cancel.expected_revision(), 7);
    assert_eq!(cancel.reason(), "authorityRequested");
    assert_eq!(cancel.authorization().credential_revision(), 1);

    fixture.state.close().await;
}

#[tokio::test]
async fn reconcile_reads_same_provider_run_without_creating_retry() {
    let fixture = fixture(FixtureOptions::default()).await;
    let client = Arc::new(FakeRunClient::with_control(
        [Ok(start_result("provider-run-1", "provider-attempt-1"))],
        [Ok(run_snapshot(
            ProviderRunStatus::Running,
            /*revision*/ 7,
        ))],
        [],
    ));
    let worker = worker(&fixture, client.clone(), /*now*/ 200);
    worker
        .start(fixture.dispatch.clone())
        .await
        .expect("Provider start");
    let current = TaskStateStoreAdapter::new(fixture.state.clone())
        .read(fixture.dispatch.control().task_id().clone())
        .await
        .expect("read task")
        .expect("task");
    let reconciling = commit_task(
        &fixture,
        &current,
        command_at(
            "unknown-command",
            "unknown-event",
            /*received_at*/ 180,
            TaskCommand::ApplyWorkerEvent {
                evidence: WorkerEvidence {
                    attempt_id: fixture.dispatch.control().attempt_id().clone(),
                    worker_run_id: fixture.dispatch.control().worker_run_id().clone(),
                    producer_sequence: ProducerSequence::new(/*value*/ 1).expect("sequence"),
                    lease_epoch: fixture.dispatch.control().lease().epoch(),
                    fencing_token_hash: fixture
                        .dispatch
                        .control()
                        .lease()
                        .fencing_token_hash()
                        .clone(),
                },
                outcome: WorkerOutcome::OutcomeUnknown,
            },
        ),
        "unknown-outbox",
    )
    .await;
    let reconciliation = WorkerReconciliation::from_aggregate(
        &reconciling,
        UnixTimestamp::new(/*value*/ 200).expect("reconcile time"),
    )
    .expect("Worker reconciliation");

    let run = worker
        .reconcile(reconciliation)
        .await
        .expect("reconcile same Provider run");
    assert_eq!(run.as_str(), "provider-run-1");
    assert_eq!(reconciling.attempts().len(), 1);
    assert_eq!(client.read_requests().len(), 1);
    assert!(
        client.read_requests()[0]
            .command_id()
            .starts_with("reconcile:")
    );
    assert_eq!(client.cancel_requests().len(), 0);

    fixture.state.close().await;
}

fn worker(
    fixture: &Fixture,
    client: Arc<FakeRunClient>,
    now: i64,
) -> CloudWorkerExecutor<FixedProviderRunClientFactory<FakeRunClient>> {
    CloudWorkerExecutor::new(
        fixture.state.clone(),
        Arc::new(FixedProviderRunClientFactory::new(client)),
        Arc::new(move || now),
    )
}

struct FixedProviderRunClientFactory<Client> {
    client: Arc<Client>,
}

impl<Client> FixedProviderRunClientFactory<Client> {
    fn new(client: Arc<Client>) -> Self {
        Self { client }
    }
}

impl<Client> ProviderRunClientFactory for FixedProviderRunClientFactory<Client>
where
    Client: DurableProviderRunClient + Send + Sync,
{
    type Client = Client;

    async fn connect(
        &self,
        identity: ProviderAuthorizationIdentity,
    ) -> Result<Arc<Self::Client>, WorkerExecutorError> {
        assert_eq!(
            format!("{identity:?}"),
            "ProviderAuthorizationIdentity([REDACTED])"
        );
        Ok(self.client.clone())
    }
}

fn start_result(provider_run_id: &str, attempt_id: &str) -> ProviderRunStartResult {
    ProviderRunStartResult::new(provider_run_id, attempt_id, /*created*/ true)
        .expect("start result")
}

fn conflicting_journal(fixture: &Fixture) -> ProviderRunJournalRecord {
    ProviderRunJournalRecord {
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
        provider_run_id: "provider-run-conflict".to_string(),
        provider_attempt_id: "provider-attempt-conflict".to_string(),
        provider_revision: None,
        last_sequence: 0,
        last_cursor: None,
        status: ProviderRunJournalStatus::Starting,
        start_command_id: "different-start-command".to_string(),
        start_idempotency_key: "different-start-idempotency".to_string(),
        request_digest: HASH_A.to_string(),
        record_hash: String::new(),
        created_at: 140,
        updated_at: 140,
    }
}

async fn commit_task(
    fixture: &Fixture,
    aggregate: &crewon_task_runtime::TaskAggregate,
    envelope: TaskCommandEnvelope,
    outbox_id: &str,
) -> crewon_task_runtime::TaskAggregate {
    let decision = decide_command(aggregate, &envelope).expect("task decision");
    let commit = TaskCommit::from_decision(
        aggregate,
        &envelope,
        OutboxId::new(outbox_id).expect("outbox id"),
        decision,
    )
    .expect("task commit");
    match TaskStateStoreAdapter::new(fixture.state.clone())
        .commit(commit)
        .await
        .expect("persist task transition")
    {
        TaskCommitOutcome::Committed(aggregate) => aggregate,
        TaskCommitOutcome::Duplicate(_) => panic!("new transition cannot be duplicate"),
    }
}

fn command_at(
    command_id: &str,
    event_id: &str,
    received_at: i64,
    command: TaskCommand,
) -> TaskCommandEnvelope {
    TaskCommandEnvelope {
        command_id: CommandId::new(command_id).expect("command id"),
        event_id: EventId::new(event_id).expect("event id"),
        task_id: crewon_task_runtime::TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(received_at).expect("occurred at"),
        received_at: UnixTimestamp::new(received_at).expect("received at"),
        command,
    }
}

struct FakeRunClient {
    starts: Mutex<Vec<ProviderRunStartRequest>>,
    results: Mutex<VecDeque<Result<ProviderRunStartResult, AgentPlatformProviderError>>>,
    event_requests: Mutex<Vec<ProviderRunEventsRequest>>,
    event_results: Mutex<VecDeque<Result<ProviderRunEventPage, AgentPlatformProviderError>>>,
    read_requests: Mutex<Vec<ProviderRunReadRequest>>,
    read_results: Mutex<VecDeque<Result<ProviderRunSnapshot, AgentPlatformProviderError>>>,
    cancel_requests: Mutex<Vec<ProviderRunCancelRequest>>,
    cancel_results: Mutex<VecDeque<Result<ProviderRunCancelResult, AgentPlatformProviderError>>>,
}

impl FakeRunClient {
    fn new(
        results: impl IntoIterator<Item = Result<ProviderRunStartResult, AgentPlatformProviderError>>,
    ) -> Self {
        Self {
            starts: Mutex::new(Vec::new()),
            results: Mutex::new(results.into_iter().collect()),
            event_requests: Mutex::new(Vec::new()),
            event_results: Mutex::new(VecDeque::new()),
            read_requests: Mutex::new(Vec::new()),
            read_results: Mutex::new(VecDeque::new()),
            cancel_requests: Mutex::new(Vec::new()),
            cancel_results: Mutex::new(VecDeque::new()),
        }
    }

    fn with_events(
        results: impl IntoIterator<Item = Result<ProviderRunStartResult, AgentPlatformProviderError>>,
        event_results: impl IntoIterator<
            Item = Result<ProviderRunEventPage, AgentPlatformProviderError>,
        >,
    ) -> Self {
        Self {
            starts: Mutex::new(Vec::new()),
            results: Mutex::new(results.into_iter().collect()),
            event_requests: Mutex::new(Vec::new()),
            event_results: Mutex::new(event_results.into_iter().collect()),
            read_requests: Mutex::new(Vec::new()),
            read_results: Mutex::new(VecDeque::new()),
            cancel_requests: Mutex::new(Vec::new()),
            cancel_results: Mutex::new(VecDeque::new()),
        }
    }

    fn with_control(
        results: impl IntoIterator<Item = Result<ProviderRunStartResult, AgentPlatformProviderError>>,
        read_results: impl IntoIterator<Item = Result<ProviderRunSnapshot, AgentPlatformProviderError>>,
        cancel_results: impl IntoIterator<
            Item = Result<ProviderRunCancelResult, AgentPlatformProviderError>,
        >,
    ) -> Self {
        Self {
            starts: Mutex::new(Vec::new()),
            results: Mutex::new(results.into_iter().collect()),
            event_requests: Mutex::new(Vec::new()),
            event_results: Mutex::new(VecDeque::new()),
            read_requests: Mutex::new(Vec::new()),
            read_results: Mutex::new(read_results.into_iter().collect()),
            cancel_requests: Mutex::new(Vec::new()),
            cancel_results: Mutex::new(cancel_results.into_iter().collect()),
        }
    }

    fn start_count(&self) -> usize {
        self.starts.lock().expect("start lock").len()
    }

    fn start_requests(&self) -> Vec<ProviderRunStartRequest> {
        self.starts.lock().expect("start lock").clone()
    }

    fn event_requests(&self) -> Vec<ProviderRunEventsRequest> {
        self.event_requests.lock().expect("event lock").clone()
    }

    fn read_requests(&self) -> Vec<ProviderRunReadRequest> {
        self.read_requests.lock().expect("read lock").clone()
    }

    fn cancel_requests(&self) -> Vec<ProviderRunCancelRequest> {
        self.cancel_requests.lock().expect("cancel lock").clone()
    }
}

impl DurableProviderRunClient for FakeRunClient {
    async fn start(
        &self,
        request: ProviderRunStartRequest,
    ) -> Result<ProviderRunStartResult, AgentPlatformProviderError> {
        self.starts.lock().expect("start lock").push(request);
        self.results
            .lock()
            .expect("result lock")
            .pop_front()
            .unwrap_or(Err(AgentPlatformProviderError::InvalidResponse))
    }

    async fn read(
        &self,
        request: ProviderRunReadRequest,
    ) -> Result<ProviderRunSnapshot, AgentPlatformProviderError> {
        self.read_requests.lock().expect("read lock").push(request);
        self.read_results
            .lock()
            .expect("read result lock")
            .pop_front()
            .unwrap_or(Err(AgentPlatformProviderError::InvalidResponse))
    }

    async fn list_events(
        &self,
        request: ProviderRunEventsRequest,
    ) -> Result<ProviderRunEventPage, AgentPlatformProviderError> {
        self.event_requests
            .lock()
            .expect("event lock")
            .push(request);
        self.event_results
            .lock()
            .expect("event result lock")
            .pop_front()
            .unwrap_or(Err(AgentPlatformProviderError::InvalidResponse))
    }

    async fn cancel(
        &self,
        request: ProviderRunCancelRequest,
    ) -> Result<ProviderRunCancelResult, AgentPlatformProviderError> {
        self.cancel_requests
            .lock()
            .expect("cancel lock")
            .push(request);
        self.cancel_results
            .lock()
            .expect("cancel result lock")
            .pop_front()
            .unwrap_or(Err(AgentPlatformProviderError::InvalidResponse))
    }
}

fn cancelled_page(after_cursor: Option<&str>) -> ProviderRunEventPage {
    let events = if after_cursor.is_some() {
        vec![provider_event(
            /*sequence*/ 2,
            ProviderRunEventPayload::Cancelled {
                reason: "providerCancelled".to_string(),
            },
        )]
    } else {
        vec![
            provider_event(
                /*sequence*/ 1,
                ProviderRunEventPayload::RunStarted { revision: 1 },
            ),
            provider_event(
                /*sequence*/ 2,
                ProviderRunEventPayload::Cancelled {
                    reason: "providerCancelled".to_string(),
                },
            ),
        ]
    };
    ProviderRunEventPage::validated(
        events,
        Some("event-0002".to_string()),
        "provider-run-1",
        after_cursor,
    )
    .expect("Provider event page")
}

fn input_required_page(payloads: Vec<ProviderRunEventPayload>) -> ProviderRunEventPage {
    let mut events = vec![provider_event(
        /*sequence*/ 1,
        ProviderRunEventPayload::RunStarted { revision: 1 },
    )];
    events.extend(
        payloads
            .into_iter()
            .enumerate()
            .map(|(index, payload)| provider_event(index as u64 + 2, payload)),
    );
    let next_cursor = events
        .last()
        .map(|event| event.metadata().cursor().to_string());
    ProviderRunEventPage::validated(
        events,
        next_cursor,
        "provider-run-1",
        /*after_cursor*/ None,
    )
    .expect("Provider input-required event page")
}

fn provider_event(sequence: u64, payload: ProviderRunEventPayload) -> ProviderRunEvent {
    let cursor = format!("event-{sequence:04}");
    let metadata = ProviderRunEventMetadata::new(
        format!("provider-event-{sequence}"),
        "provider-run-1".to_string(),
        "provider-attempt-1".to_string(),
        sequence,
        cursor,
        "3.0.0".to_string(),
        150 + i64::try_from(sequence).expect("sequence time"),
    )
    .expect("Provider event metadata");
    ProviderRunEvent::new(metadata, payload, "task-1").expect("Provider event")
}

fn run_snapshot(status: ProviderRunStatus, revision: u64) -> ProviderRunSnapshot {
    ProviderRunSnapshot::new(
        "provider-run-1",
        "provider-attempt-1",
        status,
        revision,
        /*last_sequence*/ 1,
        /*created_at*/ 150,
        /*updated_at*/ 160,
    )
    .expect("Provider Run snapshot")
}

struct FailOnceJournal {
    state: Arc<crewon_state::StateRuntime>,
    fail_sequence: u64,
    failed: AtomicBool,
}

impl FailOnceJournal {
    fn new(state: Arc<crewon_state::StateRuntime>, fail_sequence: u64) -> Self {
        Self {
            state,
            fail_sequence,
            failed: AtomicBool::new(false),
        }
    }
}

impl ProviderRunJournalStore for FailOnceJournal {
    async fn read_for_attempt(
        &self,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<Option<ProviderRunJournalRecord>, ProviderRunJournalStoreError> {
        self.state
            .get_provider_run_journal_record_for_attempt(task_id, attempt_id)
            .await
            .map_err(|_| ProviderRunJournalStoreError::BackendUnavailable)
    }

    async fn create(
        &self,
        record: &ProviderRunJournalRecord,
    ) -> Result<ProviderRunJournalCreateOutcome, ProviderRunJournalStoreError> {
        self.state
            .create_provider_run_journal_record(record)
            .await
            .map_err(|_| ProviderRunJournalStoreError::BackendUnavailable)
    }

    async fn advance(
        &self,
        record: &ProviderRunJournalAdvanceRecord,
    ) -> Result<ProviderRunJournalAdvanceOutcome, ProviderRunJournalStoreError> {
        if record.event.sequence == self.fail_sequence && !self.failed.swap(true, Ordering::SeqCst)
        {
            return Err(ProviderRunJournalStoreError::BackendUnavailable);
        }
        self.state
            .advance_provider_run_journal(record)
            .await
            .map_err(|_| ProviderRunJournalStoreError::BackendUnavailable)
    }
}
