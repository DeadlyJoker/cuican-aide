use std::sync::Arc;

use crewon_protocol::ThreadId;
use crewon_state::CloudAgentTurnOrigin;
use crewon_state::CloudAgentTurnRecord;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_state::StateRuntime;
use crewon_state::ThreadExecutionContextRecord;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::InboxReceipt;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::StrategyKind;
use crewon_task_runtime::TaskAggregate;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStatus;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::TaskStoreError;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::decide_command;
use sha2::Digest;
use sha2::Sha256;

use super::task_state_store_adapter::TaskStateStoreAdapter;
use crate::platform_control::RequestIdentity;
use crate::platform_control::thread_execution_context_adapter::authorize_thread_execution_context_record;

const MAX_COMMIT_ATTEMPTS: usize = 3;
const MAX_TURN_ID_BYTES: usize = 512;

pub(crate) struct CloudAgentTurnInterruptRequest<'a> {
    pub(crate) state: Arc<StateRuntime>,
    pub(crate) identity: &'a RequestIdentity,
    pub(crate) thread_id: &'a str,
    pub(crate) turn_id: &'a str,
    pub(crate) now: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudAgentTurnInterruptDisposition {
    Cancelled,
    ExistingCancel,
    AlreadyTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CloudAgentTurnInterruptResult {
    pub(crate) disposition: CloudAgentTurnInterruptDisposition,
    pub(crate) task_status: Option<TaskStatus>,
}

/// Routes an exact Cloud Agent Turn to durable Task cancellation.
///
/// `None` means the Thread has no Cloud execution authority and the caller may
/// continue through the existing Core interrupt path. Once a Cloud Turn or
/// execution binding is observed, every failure is closed on this route.
pub(crate) async fn interrupt_cloud_agent_turn(
    request: CloudAgentTurnInterruptRequest<'_>,
) -> Result<Option<CloudAgentTurnInterruptResult>, CloudAgentTurnInterruptError> {
    validate_request(&request)?;
    if request.turn_id.is_empty() {
        return Ok(None);
    }
    let turn = request
        .state
        .get_cloud_agent_turn_record(request.turn_id)
        .await
        .map_err(|_| CloudAgentTurnInterruptError::StateUnavailable)?;
    if turn
        .as_ref()
        .is_some_and(|turn| turn.thread_id != request.thread_id)
    {
        return Err(CloudAgentTurnInterruptError::NotFound);
    }
    let context = request
        .state
        .get_thread_execution_context_record(request.thread_id)
        .await
        .map_err(|_| CloudAgentTurnInterruptError::StateUnavailable)?;
    let Some(context) = context else {
        return if turn.is_some() {
            Err(CloudAgentTurnInterruptError::AuthorityChanged)
        } else {
            Ok(None)
        };
    };
    authorize_thread_execution_context_record(request.identity, &context)
        .map_err(|_| CloudAgentTurnInterruptError::Unauthorized)?;
    if context.execution_binding.is_none() {
        return if turn.is_some() {
            Err(CloudAgentTurnInterruptError::AuthorityChanged)
        } else {
            Ok(None)
        };
    }
    let turn = turn.ok_or(CloudAgentTurnInterruptError::NotFound)?;
    validate_turn_authority(&turn, &context)?;
    match &turn.origin {
        CloudAgentTurnOrigin::DurableTask { task_id } => {
            cancel_task(&request, &turn, task_id).await.map(Some)
        }
        CloudAgentTurnOrigin::LegacyImport { .. } if turn.status.is_terminal() => {
            Ok(Some(CloudAgentTurnInterruptResult {
                disposition: CloudAgentTurnInterruptDisposition::AlreadyTerminal,
                task_status: None,
            }))
        }
        CloudAgentTurnOrigin::LegacyImport { .. } => {
            Err(CloudAgentTurnInterruptError::AuthorityChanged)
        }
    }
}

async fn cancel_task(
    request: &CloudAgentTurnInterruptRequest<'_>,
    turn: &CloudAgentTurnRecord,
    task_id: &str,
) -> Result<CloudAgentTurnInterruptResult, CloudAgentTurnInterruptError> {
    let task_id =
        TaskId::new(task_id).map_err(|_| CloudAgentTurnInterruptError::AuthorityChanged)?;
    let ids = CancelIds::new(request.thread_id, request.turn_id, task_id.as_str());
    let command_id = CommandId::new(&ids.command_id)
        .map_err(|_| CloudAgentTurnInterruptError::AuthorityChanged)?;
    let receipt = InboxReceipt::Command(command_id.clone());
    let timestamp = UnixTimestamp::new(request.now)
        .map_err(|_| CloudAgentTurnInterruptError::InvalidRequest)?;
    let store = TaskStateStoreAdapter::new(request.state.clone());

    for _ in 0..MAX_COMMIT_ATTEMPTS {
        if let Some(existing) = store
            .read_receipt(task_id.clone(), receipt.clone())
            .await
            .map_err(map_store_error)?
        {
            validate_cancelled_task(&existing, turn)?;
            return Ok(CloudAgentTurnInterruptResult {
                disposition: CloudAgentTurnInterruptDisposition::ExistingCancel,
                task_status: Some(existing.status()),
            });
        }
        let current = store
            .read(task_id.clone())
            .await
            .map_err(map_store_error)?
            .ok_or(CloudAgentTurnInterruptError::AuthorityChanged)?;
        validate_task_authority(&current, turn)?;
        if current.status().is_terminal() {
            return Ok(CloudAgentTurnInterruptResult {
                disposition: CloudAgentTurnInterruptDisposition::AlreadyTerminal,
                task_status: Some(current.status()),
            });
        }
        if turn.status.is_terminal() {
            return Err(CloudAgentTurnInterruptError::AuthorityChanged);
        }
        let command = TaskCommandEnvelope {
            command_id: command_id.clone(),
            event_id: EventId::new(&ids.event_id)
                .map_err(|_| CloudAgentTurnInterruptError::AuthorityChanged)?,
            task_id: task_id.clone(),
            authority: TaskAuthority::LocalAppServer,
            occurred_at: timestamp,
            received_at: timestamp,
            command: TaskCommand::CancelTask,
        };
        let decision = decide_command(&current, &command)
            .map_err(|_| CloudAgentTurnInterruptError::AuthorityChanged)?;
        let commit = TaskCommit::from_decision(
            &current,
            &command,
            OutboxId::new(&ids.outbox_id)
                .map_err(|_| CloudAgentTurnInterruptError::AuthorityChanged)?,
            decision,
        )
        .map_err(|_| CloudAgentTurnInterruptError::AuthorityChanged)?;
        match store.commit(commit).await {
            Ok(TaskCommitOutcome::Committed(result)) => {
                validate_cancelled_task(&result, turn)?;
                return Ok(CloudAgentTurnInterruptResult {
                    disposition: CloudAgentTurnInterruptDisposition::Cancelled,
                    task_status: Some(result.status()),
                });
            }
            Ok(TaskCommitOutcome::Duplicate(result)) => {
                validate_cancelled_task(&result, turn)?;
                return Ok(CloudAgentTurnInterruptResult {
                    disposition: CloudAgentTurnInterruptDisposition::ExistingCancel,
                    task_status: Some(result.status()),
                });
            }
            Err(TaskStoreError::Conflict) => continue,
            Err(error) => return Err(map_store_error(error)),
        }
    }

    if let Some(existing) = store
        .read_receipt(task_id.clone(), receipt)
        .await
        .map_err(map_store_error)?
    {
        validate_cancelled_task(&existing, turn)?;
        return Ok(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::ExistingCancel,
            task_status: Some(existing.status()),
        });
    }
    let current = store
        .read(task_id)
        .await
        .map_err(map_store_error)?
        .ok_or(CloudAgentTurnInterruptError::AuthorityChanged)?;
    validate_task_authority(&current, turn)?;
    if current.status().is_terminal() {
        return Ok(CloudAgentTurnInterruptResult {
            disposition: CloudAgentTurnInterruptDisposition::AlreadyTerminal,
            task_status: Some(current.status()),
        });
    }
    Err(CloudAgentTurnInterruptError::Conflict)
}

fn validate_request(
    request: &CloudAgentTurnInterruptRequest<'_>,
) -> Result<(), CloudAgentTurnInterruptError> {
    if ThreadId::from_string(request.thread_id).is_err()
        || request.now < 0
        || (!request.turn_id.is_empty()
            && (request.turn_id.trim().is_empty()
                || request.turn_id.len() > MAX_TURN_ID_BYTES
                || request.turn_id.chars().any(char::is_control)))
    {
        return Err(CloudAgentTurnInterruptError::InvalidRequest);
    }
    Ok(())
}

fn validate_turn_authority(
    turn: &CloudAgentTurnRecord,
    context: &ThreadExecutionContextRecord,
) -> Result<(), CloudAgentTurnInterruptError> {
    if turn.thread_id != context.thread_id
        || turn.local_actor_id != context.local_actor_id
        || turn.local_tenant_id != context.local_tenant_id
        || turn.local_space_id != context.local_space_id
        || turn.workspace_key != context.workspace_key
        || context.workspace_scope != ProviderResourceWorkspaceScope::Conversation
        || context.workspace_scope_id != turn.thread_id
        || context.execution_binding.as_ref() != Some(&turn.execution_binding)
    {
        return Err(CloudAgentTurnInterruptError::AuthorityChanged);
    }
    Ok(())
}

fn validate_task_authority(
    task: &TaskAggregate,
    turn: &CloudAgentTurnRecord,
) -> Result<(), CloudAgentTurnInterruptError> {
    if turn.origin.task_id() != Some(task.contract().task_id().as_str())
        || task.contract().authority() != TaskAuthority::LocalAppServer
        || task.contract().strategy() != StrategyKind::Single
        || task.contract().workspace_key().as_str() != turn.workspace_key
    {
        return Err(CloudAgentTurnInterruptError::AuthorityChanged);
    }
    Ok(())
}

fn validate_cancelled_task(
    task: &TaskAggregate,
    turn: &CloudAgentTurnRecord,
) -> Result<(), CloudAgentTurnInterruptError> {
    validate_task_authority(task, turn)?;
    if task.status() != TaskStatus::Cancelled {
        return Err(CloudAgentTurnInterruptError::AuthorityChanged);
    }
    Ok(())
}

fn map_store_error(error: TaskStoreError) -> CloudAgentTurnInterruptError {
    match error {
        TaskStoreError::Conflict => CloudAgentTurnInterruptError::Conflict,
        TaskStoreError::BackendUnavailable => CloudAgentTurnInterruptError::StateUnavailable,
        TaskStoreError::AlreadyExists
        | TaskStoreError::NotFound
        | TaskStoreError::Fenced
        | TaskStoreError::InvalidCommit => CloudAgentTurnInterruptError::AuthorityChanged,
    }
}

struct CancelIds {
    command_id: String,
    event_id: String,
    outbox_id: String,
}

impl CancelIds {
    fn new(thread_id: &str, turn_id: &str, task_id: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"crewon.cloud-agent-turn-cancel.v1\0");
        for part in [thread_id.as_bytes(), turn_id.as_bytes(), task_id.as_bytes()] {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part);
        }
        let seed = hasher.finalize();
        Self {
            command_id: stable_id("cloud-agent-cancel-command", &seed),
            event_id: stable_id("cloud-agent-cancel-event", &seed),
            outbox_id: stable_id("cloud-agent-cancel-outbox", &seed),
        }
    }
}

fn stable_id(prefix: &str, seed: &[u8]) -> String {
    let digest = Sha256::digest(seed);
    format!("{prefix}:{digest:x}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum CloudAgentTurnInterruptError {
    #[error("Cloud Agent Turn interrupt request is invalid")]
    InvalidRequest,
    #[error("Cloud Agent Turn interrupt is not authorized")]
    Unauthorized,
    #[error("Cloud Agent Turn was not found")]
    NotFound,
    #[error("Cloud Agent Turn interrupt authority changed")]
    AuthorityChanged,
    #[error("Cloud Agent Turn interrupt conflicts with durable state")]
    Conflict,
    #[error("Cloud Agent Turn interrupt State is unavailable")]
    StateUnavailable,
}

#[cfg(test)]
#[path = "cloud_agent_turn_cancellation_tests.rs"]
mod tests;
