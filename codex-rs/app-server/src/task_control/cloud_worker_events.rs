use crewon_provider_agent_platform::DurableProviderRunClient;
use crewon_provider_agent_platform::ProviderRunEvent;
use crewon_provider_agent_platform::ProviderRunEventPayload;
use crewon_provider_agent_platform::ProviderRunEventsRequest;
use crewon_provider_agent_platform::ProviderRunFailureCode;
use crewon_state::ProviderRunJournalAdvanceOutcome;
use crewon_state::ProviderRunJournalAdvanceRecord;
use crewon_state::ProviderRunJournalEventRecord;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::ProviderRunJournalStatus;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::InboxReceipt;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::ProducerSequence;
use crewon_task_runtime::SuspensionReason;
use crewon_task_runtime::TaskAggregate;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskError;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::TaskStoreError;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerEvidence;
use crewon_task_runtime::WorkerExecutorError;
use crewon_task_runtime::WorkerOutcome;
use crewon_task_runtime::decide_command;
use serde::Serialize;

use super::CloudWorkerExecutor;
use super::ProviderStartIdentity;
use super::digest;
use super::digest_hex;
use super::map_provider_error;
use crate::task_control::cloud_execution_resolver::unique_cloud_agent_binding;
use crate::task_control::cloud_worker_event_projection::provider_event_projection;
use crate::task_control::cloud_worker_journal::ProviderRunJournalStore;
use crate::task_control::provider_control_supervisor::ProviderEventPump;
use crate::task_control::task_state_store_adapter::TaskStateStoreAdapter;

const PROVIDER_EVENT_PAGE_LIMIT: u16 = 100;

impl<Factory, Journal> CloudWorkerExecutor<Factory, Journal>
where
    Factory: super::ProviderRunClientFactory,
    Journal: ProviderRunJournalStore,
{
    pub(super) async fn pump_events(
        &self,
        dispatch: WorkerDispatch,
    ) -> Result<(), WorkerExecutorError> {
        let now = (self.clock)();
        let mut task = self.event_task(&dispatch, now).await?;
        let binding = unique_cloud_agent_binding(dispatch.bindings())
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let identity = ProviderStartIdentity::from_dispatch(&dispatch, binding)?;
        let mut journal = self
            .journal
            .read_for_attempt(
                dispatch.control().task_id().as_str(),
                dispatch.control().attempt_id().as_str(),
            )
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        if !identity.matches_journal(&journal) {
            return Err(WorkerExecutorError::OutcomeUnknown);
        }

        let (authorization, identity) = self
            .journal_authorization(
                dispatch.control().task_id().as_str(),
                binding,
                &journal,
                now,
            )
            .await?;
        let client = self.client_factory.connect(identity).await?;
        let request = ProviderRunEventsRequest::new(
            authorization,
            event_page_command_id(&journal)?,
            &journal.provider_run_id,
            journal.last_cursor.clone(),
            PROVIDER_EVENT_PAGE_LIMIT,
        )
        .map_err(map_provider_error)?;
        let page = client
            .list_events(request)
            .await
            .map_err(map_provider_error)?;

        for event in page.events() {
            if event.metadata().attempt_id() != journal.provider_attempt_id {
                return Err(WorkerExecutorError::InvalidResponse);
            }
            let mapping = map_provider_event(event)?;
            if let Some(outcome) = mapping.worker_outcome.clone() {
                task = self
                    .commit_worker_event(&dispatch, task, event, outcome, now)
                    .await?;
            }
            let stop_after_event = mapping.stop_after_event;
            journal = self.advance_journal(&journal, event, mapping, now).await?;
            if stop_after_event {
                break;
            }
        }
        Ok(())
    }

    async fn event_task(
        &self,
        dispatch: &WorkerDispatch,
        now: i64,
    ) -> Result<TaskAggregate, WorkerExecutorError> {
        let task = TaskStateStoreAdapter::new(self.state.clone())
            .read(dispatch.control().task_id().clone())
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        if !task_matches_dispatch(&task, dispatch) {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        let now = UnixTimestamp::new(now).map_err(|_| WorkerExecutorError::InvalidResponse)?;
        if !task.status().is_terminal() && dispatch.control().lease().is_expired_at(now) {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        Ok(task)
    }

    async fn commit_worker_event(
        &self,
        dispatch: &WorkerDispatch,
        task: TaskAggregate,
        provider_event: &ProviderRunEvent,
        outcome: WorkerOutcome,
        now: i64,
    ) -> Result<TaskAggregate, WorkerExecutorError> {
        if task.status().is_terminal() {
            return Ok(task);
        }
        let envelope = worker_event_envelope(&task, dispatch, provider_event, outcome, now)?;
        let receipt = InboxReceipt::from_command(&envelope);
        let adapter = TaskStateStoreAdapter::new(self.state.clone());
        if adapter
            .read_receipt(envelope.task_id.clone(), receipt.clone())
            .await
            .map_err(map_task_store_error)?
            .is_some()
        {
            return read_current_task(&adapter, envelope.task_id).await;
        }
        let decision = match decide_command(&task, &envelope) {
            Ok(decision) => decision,
            Err(TaskError::TerminalTask) => return Ok(task),
            Err(_) => return Err(WorkerExecutorError::InvalidResponse),
        };
        let commit = TaskCommit::from_decision(
            &task,
            &envelope,
            provider_outbox_id(provider_event)?,
            decision,
        )
        .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        match adapter.commit(commit).await {
            Ok(TaskCommitOutcome::Committed(task) | TaskCommitOutcome::Duplicate(task)) => Ok(task),
            Err(TaskStoreError::Conflict | TaskStoreError::Fenced) => {
                if adapter
                    .read_receipt(envelope.task_id.clone(), receipt)
                    .await
                    .map_err(map_task_store_error)?
                    .is_some()
                {
                    return read_current_task(&adapter, envelope.task_id).await;
                }
                let latest = read_current_task(&adapter, envelope.task_id).await?;
                if latest.status().is_terminal() {
                    Ok(latest)
                } else {
                    Err(WorkerExecutorError::OutcomeUnknown)
                }
            }
            Err(error) => Err(map_task_store_error(error)),
        }
    }

    async fn advance_journal(
        &self,
        journal: &ProviderRunJournalRecord,
        provider_event: &ProviderRunEvent,
        mapping: ProviderEventMapping,
        now: i64,
    ) -> Result<ProviderRunJournalRecord, WorkerExecutorError> {
        let metadata = provider_event.metadata();
        let updated_at = now.max(metadata.created_at()).max(journal.updated_at);
        let advance = ProviderRunJournalAdvanceRecord {
            key: journal.key.clone(),
            expected_journal_version: journal.journal_version,
            expected_sequence: journal.last_sequence,
            expected_cursor: journal.last_cursor.clone(),
            event: ProviderRunJournalEventRecord {
                event_id: metadata.event_id().to_string(),
                sequence: metadata.sequence(),
                cursor: metadata.cursor().to_string(),
                event_type: mapping.event_type.to_string(),
                projection: provider_event_projection(
                    provider_event,
                    mapping.event_type,
                    &journal.key.task_id,
                )?,
                created_at: metadata.created_at(),
            },
            status: mapping.journal_status,
            provider_revision: mapping.provider_revision,
            updated_at,
        };
        match self
            .journal
            .advance(&advance)
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
        {
            ProviderRunJournalAdvanceOutcome::Advanced(journal)
            | ProviderRunJournalAdvanceOutcome::Duplicate(journal) => Ok(journal),
            ProviderRunJournalAdvanceOutcome::Conflict
            | ProviderRunJournalAdvanceOutcome::NotFound => {
                Err(WorkerExecutorError::OutcomeUnknown)
            }
        }
    }
}

impl<Factory, Journal> ProviderEventPump for CloudWorkerExecutor<Factory, Journal>
where
    Factory: super::ProviderRunClientFactory,
    Journal: ProviderRunJournalStore,
{
    async fn pump_event_page(&self, dispatch: WorkerDispatch) -> Result<(), WorkerExecutorError> {
        self.pump_events(dispatch).await
    }
}

#[derive(Clone)]
struct ProviderEventMapping {
    event_type: &'static str,
    journal_status: ProviderRunJournalStatus,
    provider_revision: Option<u64>,
    worker_outcome: Option<WorkerOutcome>,
    stop_after_event: bool,
}

fn map_provider_event(
    event: &ProviderRunEvent,
) -> Result<ProviderEventMapping, WorkerExecutorError> {
    match event.payload() {
        ProviderRunEventPayload::RunStarted { revision } => Ok(ProviderEventMapping {
            event_type: "runStarted",
            journal_status: ProviderRunJournalStatus::Running,
            provider_revision: Some(*revision),
            worker_outcome: None,
            stop_after_event: false,
        }),
        ProviderRunEventPayload::Progress { .. } => Ok(mapped(
            "progress",
            ProviderRunJournalStatus::Running,
            WorkerOutcome::Progressed,
        )),
        ProviderRunEventPayload::Completed { .. } => Ok(mapped(
            "completed",
            ProviderRunJournalStatus::Completed,
            WorkerOutcome::Succeeded,
        )),
        ProviderRunEventPayload::Failed { error }
            if error.code() == ProviderRunFailureCode::UnknownOutcome =>
        {
            Ok(mapped(
                "failed",
                ProviderRunJournalStatus::Reconciling,
                WorkerOutcome::OutcomeUnknown,
            ))
        }
        ProviderRunEventPayload::Failed { .. } => Ok(mapped(
            "failed",
            ProviderRunJournalStatus::Failed,
            WorkerOutcome::Failed,
        )),
        ProviderRunEventPayload::Cancelled { .. } => Ok(mapped(
            "cancelled",
            ProviderRunJournalStatus::Cancelled,
            WorkerOutcome::Cancelled,
        )),
        ProviderRunEventPayload::ApprovalRequired { .. } => Ok(suspended(
            "approvalRequired",
            SuspensionReason::ApprovalRequired,
        )),
        ProviderRunEventPayload::ToolResultRequired { .. } => Ok(suspended(
            "toolResultRequired",
            SuspensionReason::ProviderPaused,
        )),
        ProviderRunEventPayload::ToolResultAccepted { .. } => Ok(suspended(
            "toolResultAccepted",
            SuspensionReason::ProviderPaused,
        )),
        _ => Err(WorkerExecutorError::Unsupported),
    }
}

fn mapped(
    event_type: &'static str,
    journal_status: ProviderRunJournalStatus,
    worker_outcome: WorkerOutcome,
) -> ProviderEventMapping {
    ProviderEventMapping {
        event_type,
        journal_status,
        provider_revision: None,
        worker_outcome: Some(worker_outcome),
        stop_after_event: false,
    }
}

fn suspended(event_type: &'static str, reason: SuspensionReason) -> ProviderEventMapping {
    ProviderEventMapping {
        event_type,
        journal_status: ProviderRunJournalStatus::Suspended,
        provider_revision: None,
        worker_outcome: Some(WorkerOutcome::Suspended { reason }),
        stop_after_event: true,
    }
}

fn task_matches_dispatch(task: &TaskAggregate, dispatch: &WorkerDispatch) -> bool {
    let Some(attempt) = task.active_attempt() else {
        return false;
    };
    task.contract().task_id() == dispatch.control().task_id()
        && task.contract().workspace_key() == dispatch.workspace_key()
        && task.contract().execution_spec() == dispatch.execution_spec()
        && task.contract().bindings() == dispatch.bindings()
        && attempt.attempt_id() == dispatch.control().attempt_id()
        && attempt.worker_run_id() == Some(dispatch.control().worker_run_id())
        && attempt.lease() == Some(dispatch.control().lease())
}

fn worker_event_envelope(
    task: &TaskAggregate,
    dispatch: &WorkerDispatch,
    provider_event: &ProviderRunEvent,
    outcome: WorkerOutcome,
    now: i64,
) -> Result<TaskCommandEnvelope, WorkerExecutorError> {
    let metadata = provider_event.metadata();
    let event_digest = provider_event_digest(provider_event)?;
    let received_at = now.max(metadata.created_at());
    Ok(TaskCommandEnvelope {
        command_id: CommandId::new(format!("worker:{}", digest_hex(&event_digest)))
            .map_err(|_| WorkerExecutorError::InvalidResponse)?,
        event_id: EventId::new(format!("provider:{}", digest_hex(&event_digest)))
            .map_err(|_| WorkerExecutorError::InvalidResponse)?,
        task_id: task.contract().task_id().clone(),
        authority: task.contract().authority(),
        occurred_at: UnixTimestamp::new(metadata.created_at())
            .map_err(|_| WorkerExecutorError::InvalidResponse)?,
        received_at: UnixTimestamp::new(received_at)
            .map_err(|_| WorkerExecutorError::InvalidResponse)?,
        command: TaskCommand::ApplyWorkerEvent {
            evidence: WorkerEvidence {
                attempt_id: dispatch.control().attempt_id().clone(),
                worker_run_id: dispatch.control().worker_run_id().clone(),
                producer_sequence: ProducerSequence::new(metadata.sequence())
                    .map_err(|_| WorkerExecutorError::InvalidResponse)?,
                lease_epoch: dispatch.control().lease().epoch(),
                fencing_token_hash: dispatch.control().lease().fencing_token_hash().clone(),
            },
            outcome,
        },
    })
}

fn provider_outbox_id(provider_event: &ProviderRunEvent) -> Result<OutboxId, WorkerExecutorError> {
    let event_digest = provider_event_digest(provider_event)?;
    OutboxId::new(format!("provider:{}", digest_hex(&event_digest)))
        .map_err(|_| WorkerExecutorError::InvalidResponse)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderEventDigest<'a> {
    provider_run_id: &'a str,
    provider_attempt_id: &'a str,
    provider_event_id: &'a str,
    sequence: u64,
    cursor: &'a str,
}

fn provider_event_digest(event: &ProviderRunEvent) -> Result<String, WorkerExecutorError> {
    let metadata = event.metadata();
    digest(&ProviderEventDigest {
        provider_run_id: metadata.provider_run_id(),
        provider_attempt_id: metadata.attempt_id(),
        provider_event_id: metadata.event_id(),
        sequence: metadata.sequence(),
        cursor: metadata.cursor(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPageCommandDigest<'a> {
    provider_run_id: &'a str,
    after_sequence: u64,
    after_cursor: Option<&'a str>,
}

fn event_page_command_id(
    journal: &ProviderRunJournalRecord,
) -> Result<String, WorkerExecutorError> {
    let digest = digest(&EventPageCommandDigest {
        provider_run_id: &journal.provider_run_id,
        after_sequence: journal.last_sequence,
        after_cursor: journal.last_cursor.as_deref(),
    })?;
    Ok(format!("events:{}", digest_hex(&digest)))
}

async fn read_current_task(
    adapter: &TaskStateStoreAdapter,
    task_id: crewon_task_runtime::TaskId,
) -> Result<TaskAggregate, WorkerExecutorError> {
    adapter
        .read(task_id)
        .await
        .map_err(map_task_store_error)?
        .ok_or(WorkerExecutorError::InvalidResponse)
}

fn map_task_store_error(error: TaskStoreError) -> WorkerExecutorError {
    match error {
        TaskStoreError::BackendUnavailable => WorkerExecutorError::Unavailable,
        TaskStoreError::Conflict | TaskStoreError::Fenced => WorkerExecutorError::OutcomeUnknown,
        TaskStoreError::AlreadyExists
        | TaskStoreError::NotFound
        | TaskStoreError::InvalidCommit => WorkerExecutorError::InvalidResponse,
    }
}
