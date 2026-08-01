use crewon_provider_agent_platform::DurableProviderRunClient;
use crewon_provider_agent_platform::ProviderRunCancelRequest;
use crewon_provider_agent_platform::ProviderRunReadRequest;
use crewon_state::ProviderRunJournalRecord;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerCancellation;
use crewon_task_runtime::WorkerExecutorError;
use crewon_task_runtime::WorkerReconciliation;
use serde::Serialize;

use super::CloudWorkerExecutor;
use super::ProviderStartIdentity;
use super::digest;
use super::digest_hex;
use super::map_provider_error;
use crate::task_control::cloud_execution_resolver::unique_cloud_agent_binding;
use crate::task_control::cloud_worker_journal::ProviderRunJournalStore;
use crate::task_control::task_state_store_adapter::TaskStateStoreAdapter;

impl<Factory, Journal> CloudWorkerExecutor<Factory, Journal>
where
    Factory: super::ProviderRunClientFactory,
    Journal: ProviderRunJournalStore,
{
    pub(super) async fn cancel_attempt(
        &self,
        cancellation: WorkerCancellation,
    ) -> Result<(), WorkerExecutorError> {
        let now = (self.clock)();
        let now_timestamp =
            UnixTimestamp::new(now).map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let task = TaskStateStoreAdapter::new(self.state.clone())
            .read(cancellation.control().task_id().clone())
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        let current = WorkerCancellation::from_aggregate(&task, now_timestamp)
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        if current != cancellation {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        let binding = unique_cloud_agent_binding(task.contract().bindings())
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let identity =
            ProviderStartIdentity::from_aggregate(&task, cancellation.control(), binding)?;
        let journal = self
            .journal
            .read_for_attempt(
                cancellation.control().task_id().as_str(),
                cancellation.control().attempt_id().as_str(),
            )
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        if !identity.matches_journal(&journal) {
            return Err(WorkerExecutorError::OutcomeUnknown);
        }
        let (authorization, identity) = self
            .journal_authorization(
                cancellation.control().task_id().as_str(),
                binding,
                &journal,
                now,
            )
            .await?;
        let client = self.client_factory.connect(identity).await?;
        let snapshot = client
            .read(
                ProviderRunReadRequest::new(
                    authorization.clone(),
                    control_command_id(
                        "read", &journal, /* provider_revision */ /*provider_revision*/ None,
                    )?,
                    &journal.provider_run_id,
                )
                .map_err(map_provider_error)?,
            )
            .await
            .map_err(map_provider_error)?;
        if snapshot.provider_run_id() != journal.provider_run_id
            || snapshot.attempt_id() != journal.provider_attempt_id
            || snapshot.last_sequence() < journal.last_sequence
        {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        if snapshot.status().is_terminal() {
            return Ok(());
        }
        let result = client
            .cancel(
                ProviderRunCancelRequest::new(
                    authorization,
                    control_command_id("cancel", &journal, Some(snapshot.revision()))?,
                    &journal.provider_run_id,
                    "authorityRequested",
                    snapshot.revision(),
                )
                .map_err(map_provider_error)?,
            )
            .await
            .map_err(map_provider_error)?;
        if result.revision() < snapshot.revision() {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        Ok(())
    }

    pub(super) async fn reconcile_attempt(
        &self,
        reconciliation: WorkerReconciliation,
    ) -> Result<crewon_task_runtime::ExecutorRunRef, WorkerExecutorError> {
        let now = (self.clock)();
        let now_timestamp =
            UnixTimestamp::new(now).map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let task = TaskStateStoreAdapter::new(self.state.clone())
            .read(reconciliation.control().task_id().clone())
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        let current = WorkerReconciliation::from_aggregate(&task, now_timestamp)
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        if current != reconciliation {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        let binding = unique_cloud_agent_binding(task.contract().bindings())
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let identity =
            ProviderStartIdentity::from_aggregate(&task, reconciliation.control(), binding)?;
        let journal = self
            .journal
            .read_for_attempt(
                reconciliation.control().task_id().as_str(),
                reconciliation.control().attempt_id().as_str(),
            )
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        if !identity.matches_journal(&journal) {
            return Err(WorkerExecutorError::OutcomeUnknown);
        }
        let (authorization, identity) = self
            .journal_authorization(
                reconciliation.control().task_id().as_str(),
                binding,
                &journal,
                now,
            )
            .await?;
        let client = self.client_factory.connect(identity).await?;
        let snapshot = client
            .read(
                ProviderRunReadRequest::new(
                    authorization,
                    control_command_id(
                        "reconcile",
                        &journal,
                        /* provider_revision */ /*provider_revision*/ None,
                    )?,
                    &journal.provider_run_id,
                )
                .map_err(map_provider_error)?,
            )
            .await
            .map_err(map_provider_error)?;
        if snapshot.provider_run_id() != journal.provider_run_id
            || snapshot.attempt_id() != journal.provider_attempt_id
            || snapshot.last_sequence() < journal.last_sequence
        {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        super::executor_run_ref(snapshot.provider_run_id())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlCommandDigest<'a> {
    operation: &'a str,
    provider_run_id: &'a str,
    provider_attempt_id: &'a str,
    journal_version: u64,
    provider_revision: Option<u64>,
}

fn control_command_id(
    operation: &str,
    journal: &ProviderRunJournalRecord,
    provider_revision: Option<u64>,
) -> Result<String, WorkerExecutorError> {
    let digest = digest(&ControlCommandDigest {
        operation,
        provider_run_id: &journal.provider_run_id,
        provider_attempt_id: &journal.provider_attempt_id,
        journal_version: journal.journal_version,
        provider_revision,
    })?;
    Ok(format!("{operation}:{}", digest_hex(&digest)))
}
