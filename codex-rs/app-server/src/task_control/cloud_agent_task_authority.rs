use std::sync::Arc;
use std::time::Duration;

use crewon_state::StateRuntime;
use crewon_state::TaskOutboxDeliveryOutcome;
use crewon_state::TaskStoredOutboxRecord;
use crewon_task_runtime::AttemptId;
use crewon_task_runtime::AttemptStatus;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::FencingTokenHash;
use crewon_task_runtime::InboxReceipt;
use crewon_task_runtime::LeaseEpoch;
use crewon_task_runtime::LeaseGrant;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::SchedulerDecision;
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
use crewon_task_runtime::WorkerRunId;
use crewon_task_runtime::decide_command;
use sha2::Digest;
use sha2::Sha256;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::provider_control_production::unix_now;
use super::task_state_store_adapter::TaskStateStoreAdapter;

const AUTHORITY_LIMIT: u32 = 16;
const LEASE_DURATION_SECONDS: i64 = 7 * 24 * 60 * 60;
const AUTHORITY_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CloudAgentTaskAuthorityReport {
    pub(crate) inspected: u32,
    pub(crate) claimed: u32,
    pub(crate) failed: u32,
    pub(crate) replayed: u32,
    pub(crate) delivered: u32,
    pub(crate) conflicted: u32,
}

pub(crate) struct CloudAgentTaskAuthority {
    state: Arc<StateRuntime>,
}

impl CloudAgentTaskAuthority {
    pub(crate) fn new(state: Arc<StateRuntime>) -> Self {
        Self { state }
    }

    pub(crate) async fn run_once(
        &self,
        now: i64,
    ) -> Result<CloudAgentTaskAuthorityReport, CloudAgentTaskAuthorityError> {
        if now < 0 {
            return Err(CloudAgentTaskAuthorityError::InvalidTime);
        }
        let records = self
            .state
            .list_pending_cloud_agent_authority_outbox_records(now, AUTHORITY_LIMIT)
            .await
            .map_err(|_| CloudAgentTaskAuthorityError::StateUnavailable)?;
        let mut report = CloudAgentTaskAuthorityReport::default();
        for record in records {
            report.inspected += 1;
            match self.apply_record(&record, now).await {
                Ok(applied) => {
                    if let Some(action) = applied.action {
                        match action {
                            AuthorityAction::Claim { .. } => report.claimed += 1,
                            AuthorityAction::Fail { .. } => report.failed += 1,
                        }
                    }
                    if applied.replayed {
                        report.replayed += 1;
                    }
                    self.mark_delivered(&record, now, &mut report).await?;
                }
                Err(CloudAgentTaskAuthorityError::Conflict) => report.conflicted += 1,
                Err(error) => return Err(error),
            }
        }
        Ok(report)
    }

    async fn apply_record(
        &self,
        record: &TaskStoredOutboxRecord,
        now: i64,
    ) -> Result<AppliedAuthorityAction, CloudAgentTaskAuthorityError> {
        let action = authority_action(record)?;
        let ids = AuthorityIds::new(record, action.kind());
        let task_id = TaskId::new(&record.task_id)
            .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?;
        let command_id = CommandId::new(&ids.command_id)
            .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?;
        let receipt = InboxReceipt::Command(command_id.clone());
        let store = TaskStateStoreAdapter::new(self.state.clone());
        if let Some(replayed) = store
            .read_receipt(task_id.clone(), receipt.clone())
            .await
            .map_err(map_store_error)?
        {
            validate_result(&replayed, record, &action, &ids)?;
            return Ok(AppliedAuthorityAction {
                action: Some(action),
                replayed: true,
            });
        }
        let current = store
            .read(task_id.clone())
            .await
            .map_err(map_store_error)?
            .ok_or(CloudAgentTaskAuthorityError::InvalidRecord)?;
        if current.status().is_terminal() {
            return Ok(AppliedAuthorityAction {
                action: None,
                replayed: false,
            });
        }
        validate_current(&current, record, &action)?;
        let timestamp =
            UnixTimestamp::new(now).map_err(|_| CloudAgentTaskAuthorityError::InvalidTime)?;
        let command = TaskCommandEnvelope {
            command_id,
            event_id: EventId::new(&ids.event_id)
                .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?,
            task_id: task_id.clone(),
            authority: TaskAuthority::LocalAppServer,
            occurred_at: timestamp,
            received_at: timestamp,
            command: action.command(now, &ids)?,
        };
        let decision = decide_command(&current, &command)
            .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?;
        let commit = TaskCommit::from_decision(
            &current,
            &command,
            OutboxId::new(&ids.outbox_id)
                .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?,
            decision,
        )
        .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?;
        match store.commit(commit).await {
            Ok(TaskCommitOutcome::Committed(result)) => {
                validate_result(&result, record, &action, &ids)?;
                Ok(AppliedAuthorityAction {
                    action: Some(action),
                    replayed: false,
                })
            }
            Ok(TaskCommitOutcome::Duplicate(result)) => {
                validate_result(&result, record, &action, &ids)?;
                Ok(AppliedAuthorityAction {
                    action: Some(action),
                    replayed: true,
                })
            }
            Err(TaskStoreError::Conflict) => {
                let replayed = store
                    .read_receipt(task_id, receipt)
                    .await
                    .map_err(map_store_error)?
                    .ok_or(CloudAgentTaskAuthorityError::Conflict)?;
                validate_result(&replayed, record, &action, &ids)?;
                Ok(AppliedAuthorityAction {
                    action: Some(action),
                    replayed: true,
                })
            }
            Err(error) => Err(map_store_error(error)),
        }
    }

    async fn mark_delivered(
        &self,
        record: &TaskStoredOutboxRecord,
        now: i64,
        report: &mut CloudAgentTaskAuthorityReport,
    ) -> Result<(), CloudAgentTaskAuthorityError> {
        match self
            .state
            .mark_task_outbox_delivered_if_attempt(&record.outbox_id, record.delivery_attempts, now)
            .await
            .map_err(|_| CloudAgentTaskAuthorityError::StateUnavailable)?
        {
            TaskOutboxDeliveryOutcome::Delivered | TaskOutboxDeliveryOutcome::AlreadyDelivered => {
                report.delivered += 1
            }
            TaskOutboxDeliveryOutcome::Conflict | TaskOutboxDeliveryOutcome::NotFound => {
                report.conflicted += 1;
            }
        }
        Ok(())
    }
}

pub(crate) fn start_cloud_agent_task_authority(
    state: Arc<StateRuntime>,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let authority = CloudAgentTaskAuthority::new(state);
        loop {
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                result = authority.run_once(unix_now()) => {
                    if let Err(error) = result {
                        warn!(%error, "Cloud Agent Task authority tick failed");
                    }
                }
            }
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                () = tokio::time::sleep(AUTHORITY_INTERVAL) => {}
            }
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthorityActionKind {
    Claim,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AuthorityAction {
    Claim { attempt_id: AttemptId },
    Fail { attempt_id: AttemptId },
}

impl AuthorityAction {
    fn kind(&self) -> AuthorityActionKind {
        match self {
            Self::Claim { .. } => AuthorityActionKind::Claim,
            Self::Fail { .. } => AuthorityActionKind::Fail,
        }
    }

    fn attempt_id(&self) -> &AttemptId {
        match self {
            Self::Claim { attempt_id } | Self::Fail { attempt_id } => attempt_id,
        }
    }

    fn command(
        &self,
        now: i64,
        ids: &AuthorityIds,
    ) -> Result<TaskCommand, CloudAgentTaskAuthorityError> {
        match self {
            Self::Claim { attempt_id } => {
                let expires_at = now
                    .checked_add(LEASE_DURATION_SECONDS)
                    .ok_or(CloudAgentTaskAuthorityError::InvalidTime)?;
                Ok(TaskCommand::ClaimAttempt {
                    attempt_id: attempt_id.clone(),
                    worker_run_id: WorkerRunId::new(&ids.worker_run_id)
                        .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?,
                    lease: LeaseGrant::new(
                        LeaseEpoch::new(/*value*/ 1)
                            .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?,
                        FencingTokenHash::new(&ids.fencing_token_hash)
                            .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?,
                        UnixTimestamp::new(expires_at)
                            .map_err(|_| CloudAgentTaskAuthorityError::InvalidTime)?,
                    ),
                })
            }
            Self::Fail { .. } => Ok(TaskCommand::FailTask),
        }
    }
}

struct AppliedAuthorityAction {
    action: Option<AuthorityAction>,
    replayed: bool,
}

struct AuthorityIds {
    command_id: String,
    event_id: String,
    outbox_id: String,
    worker_run_id: String,
    fencing_token_hash: String,
}

impl AuthorityIds {
    fn new(record: &TaskStoredOutboxRecord, kind: AuthorityActionKind) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"crewon.cloud-agent-task-authority.v1\0");
        for part in [
            record.task_id.as_bytes(),
            record.outbox_id.as_bytes(),
            match kind {
                AuthorityActionKind::Claim => b"claim".as_slice(),
                AuthorityActionKind::Fail => b"fail".as_slice(),
            },
        ] {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part);
        }
        let seed = hasher.finalize();
        Self {
            command_id: stable_id("cloud-agent-authority-command", &seed),
            event_id: stable_id("cloud-agent-authority-event", &seed),
            outbox_id: stable_id("cloud-agent-authority-outbox", &seed),
            worker_run_id: stable_id("cloud-agent-worker-run", &seed),
            fencing_token_hash: stable_id("sha256", &seed),
        }
    }
}

fn authority_action(
    record: &TaskStoredOutboxRecord,
) -> Result<AuthorityAction, CloudAgentTaskAuthorityError> {
    let decision = serde_json::from_str::<SchedulerDecision>(&record.payload_json)
        .map_err(|_| CloudAgentTaskAuthorityError::InvalidRecord)?;
    match decision {
        SchedulerDecision::EnqueueAttempt { attempt_id }
            if record.decision_type == "enqueueAttempt" =>
        {
            Ok(AuthorityAction::Claim { attempt_id })
        }
        SchedulerDecision::AwaitRetryDecision { attempt_id }
            if record.decision_type == "awaitRetryDecision" =>
        {
            Ok(AuthorityAction::Fail { attempt_id })
        }
        SchedulerDecision::NoAction
        | SchedulerDecision::EnqueueAttempt { .. }
        | SchedulerDecision::DispatchAttempt { .. }
        | SchedulerDecision::CancelAttempt { .. }
        | SchedulerDecision::AwaitResume { .. }
        | SchedulerDecision::AwaitRetryDecision { .. }
        | SchedulerDecision::ReconcileAttempt { .. } => {
            Err(CloudAgentTaskAuthorityError::InvalidRecord)
        }
    }
}

fn validate_current(
    task: &TaskAggregate,
    record: &TaskStoredOutboxRecord,
    action: &AuthorityAction,
) -> Result<(), CloudAgentTaskAuthorityError> {
    if task.contract().authority() != TaskAuthority::LocalAppServer
        || task.contract().strategy() != StrategyKind::Single
        || task.aggregate_version().get() != record.aggregate_version
        || task
            .active_attempt()
            .map(crewon_task_runtime::Attempt::attempt_id)
            != Some(action.attempt_id())
    {
        return Err(CloudAgentTaskAuthorityError::Conflict);
    }
    match action {
        AuthorityAction::Claim { .. }
            if task.status() == TaskStatus::Queued
                && task
                    .active_attempt()
                    .is_some_and(|attempt| attempt.status() == AttemptStatus::Created) =>
        {
            Ok(())
        }
        AuthorityAction::Fail { .. }
            if task.status() == TaskStatus::Suspended
                && task.active_attempt().is_some_and(|attempt| {
                    matches!(
                        attempt.status(),
                        AttemptStatus::Failed | AttemptStatus::Cancelled
                    )
                }) =>
        {
            Ok(())
        }
        AuthorityAction::Claim { .. } | AuthorityAction::Fail { .. } => {
            Err(CloudAgentTaskAuthorityError::Conflict)
        }
    }
}

fn validate_result(
    task: &TaskAggregate,
    record: &TaskStoredOutboxRecord,
    action: &AuthorityAction,
    ids: &AuthorityIds,
) -> Result<(), CloudAgentTaskAuthorityError> {
    let expected_version = record
        .aggregate_version
        .checked_add(1)
        .ok_or(CloudAgentTaskAuthorityError::InvalidRecord)?;
    if task.contract().authority() != TaskAuthority::LocalAppServer
        || task.contract().strategy() != StrategyKind::Single
        || task.aggregate_version().get() != expected_version
        || task
            .active_attempt()
            .map(crewon_task_runtime::Attempt::attempt_id)
            != Some(action.attempt_id())
    {
        return Err(CloudAgentTaskAuthorityError::InvalidRecord);
    }
    match action {
        AuthorityAction::Claim { .. } => {
            let attempt = task
                .active_attempt()
                .ok_or(CloudAgentTaskAuthorityError::InvalidRecord)?;
            if task.status() == TaskStatus::Running
                && attempt.status() == AttemptStatus::Started
                && attempt.worker_run_id().map(WorkerRunId::as_str)
                    == Some(ids.worker_run_id.as_str())
                && attempt
                    .lease()
                    .map(LeaseGrant::fencing_token_hash)
                    .map(FencingTokenHash::as_str)
                    == Some(ids.fencing_token_hash.as_str())
            {
                Ok(())
            } else {
                Err(CloudAgentTaskAuthorityError::InvalidRecord)
            }
        }
        AuthorityAction::Fail { .. } if task.status() == TaskStatus::Failed => Ok(()),
        AuthorityAction::Fail { .. } => Err(CloudAgentTaskAuthorityError::InvalidRecord),
    }
}

fn map_store_error(error: TaskStoreError) -> CloudAgentTaskAuthorityError {
    match error {
        TaskStoreError::Conflict => CloudAgentTaskAuthorityError::Conflict,
        TaskStoreError::BackendUnavailable => CloudAgentTaskAuthorityError::StateUnavailable,
        TaskStoreError::AlreadyExists
        | TaskStoreError::NotFound
        | TaskStoreError::Fenced
        | TaskStoreError::InvalidCommit => CloudAgentTaskAuthorityError::InvalidRecord,
    }
}

fn stable_id(prefix: &str, seed: &[u8]) -> String {
    let digest = Sha256::digest(seed);
    format!("{prefix}:{digest:x}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum CloudAgentTaskAuthorityError {
    #[error("Cloud Agent Task authority time is invalid")]
    InvalidTime,
    #[error("Cloud Agent Task authority record is invalid")]
    InvalidRecord,
    #[error("Cloud Agent Task authority state conflicts with the durable decision")]
    Conflict,
    #[error("Cloud Agent Task authority State is unavailable")]
    StateUnavailable,
}

#[cfg(test)]
#[path = "cloud_agent_task_authority_tests.rs"]
mod tests;
