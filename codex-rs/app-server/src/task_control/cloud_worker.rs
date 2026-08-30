use std::sync::Arc;

use crewon_provider_agent_platform::AgentPlatformProviderClient;
use crewon_provider_agent_platform::AgentPlatformProviderError;
use crewon_provider_agent_platform::DurableProviderRunClient;
use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderRunAuthorizationBinding;
use crewon_provider_agent_platform::Rs256ProviderAuthorizer;
use crewon_state::ProviderRunJournalCreateOutcome;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::StateRuntime;
use crewon_task_runtime::ExecutorRunRef;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerCancellation;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerExecutor;
use crewon_task_runtime::WorkerExecutorError;
use crewon_task_runtime::WorkerReconciliation;

use super::cloud_execution_resolver::CloudExecutionResolveError;
use super::cloud_execution_resolver::CloudExecutionResolveRequest;
use super::cloud_execution_resolver::resolve_cloud_execution;
use super::cloud_execution_resolver::unique_cloud_agent_binding;
use super::cloud_worker_journal::ProviderRunJournalStore;
use super::cloud_worker_start::ProviderStartIdentity;
use super::cloud_worker_start::digest;
use super::cloud_worker_start::digest_hex;
use super::cloud_worker_start::journal_record;
use super::cloud_worker_start::provider_start_request;
use super::provider_run_authority::ProviderRunAuthorityError;
use super::provider_run_authority::ProviderRunAuthorityRequest;
use super::provider_run_authority::resolve_provider_run_authority;
use super::task_state_store_adapter::TaskStateStoreAdapter;
use crate::platform_control::provider_connection_production::AgentPlatformProviderDescriptorFactory;

type UnixClock = dyn Fn() -> i64 + Send + Sync;

pub(crate) trait ProviderRunClientFactory: Send + Sync {
    type Client: DurableProviderRunClient + Send + Sync;

    fn connect(
        &self,
        identity: ProviderAuthorizationIdentity,
    ) -> impl std::future::Future<Output = Result<Arc<Self::Client>, WorkerExecutorError>> + Send;
}

impl ProviderRunClientFactory for AgentPlatformProviderDescriptorFactory {
    type Client = AgentPlatformProviderClient<Rs256ProviderAuthorizer>;

    async fn connect(
        &self,
        identity: ProviderAuthorizationIdentity,
    ) -> Result<Arc<Self::Client>, WorkerExecutorError> {
        self.connect_provider_client("agent-platform", identity)
            .await
            .map(Arc::new)
            .map_err(map_provider_error)
    }
}

pub(super) struct CloudWorkerExecutor<Factory, Journal = StateRuntime> {
    state: Arc<StateRuntime>,
    journal: Arc<Journal>,
    client_factory: Arc<Factory>,
    clock: Arc<UnixClock>,
}

impl<Factory> CloudWorkerExecutor<Factory, StateRuntime> {
    pub(super) fn new(
        state: Arc<StateRuntime>,
        client_factory: Arc<Factory>,
        clock: Arc<UnixClock>,
    ) -> Self {
        Self {
            journal: state.clone(),
            state,
            client_factory,
            clock,
        }
    }
}

impl<Factory, Journal> CloudWorkerExecutor<Factory, Journal> {
    #[cfg(test)]
    pub(super) fn new_with_journal(
        state: Arc<StateRuntime>,
        journal: Arc<Journal>,
        client_factory: Arc<Factory>,
        clock: Arc<UnixClock>,
    ) -> Self {
        Self {
            state,
            journal,
            client_factory,
            clock,
        }
    }
}

impl<Factory, Journal> WorkerExecutor for CloudWorkerExecutor<Factory, Journal>
where
    Factory: ProviderRunClientFactory,
    Journal: ProviderRunJournalStore,
{
    async fn start(&self, dispatch: WorkerDispatch) -> Result<ExecutorRunRef, WorkerExecutorError> {
        self.start_attempt(dispatch).await
    }

    async fn cancel(&self, cancellation: WorkerCancellation) -> Result<(), WorkerExecutorError> {
        self.cancel_attempt(cancellation).await
    }

    async fn reconcile(
        &self,
        reconciliation: WorkerReconciliation,
    ) -> Result<ExecutorRunRef, WorkerExecutorError> {
        self.reconcile_attempt(reconciliation).await
    }
}

impl<Factory, Journal> CloudWorkerExecutor<Factory, Journal>
where
    Factory: ProviderRunClientFactory,
    Journal: ProviderRunJournalStore,
{
    async fn start_attempt(
        &self,
        dispatch: WorkerDispatch,
    ) -> Result<ExecutorRunRef, WorkerExecutorError> {
        let now = (self.clock)();
        let current = self.current_task(&dispatch, now).await?;

        let binding = unique_cloud_agent_binding(dispatch.bindings()).map_err(map_resolve_error)?;
        let identity = ProviderStartIdentity::from_dispatch(&dispatch, binding)?;
        if let Some(existing) = self
            .journal
            .read_for_attempt(
                dispatch.control().task_id().as_str(),
                dispatch.control().attempt_id().as_str(),
            )
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
        {
            return if identity.matches_journal(&existing) {
                executor_run_ref(&existing.provider_run_id)
            } else {
                Err(WorkerExecutorError::OutcomeUnknown)
            };
        }

        let resolved = resolve_cloud_execution(CloudExecutionResolveRequest {
            state: self.state.as_ref(),
            contract: current.contract(),
            now,
        })
        .await
        .map_err(map_resolve_error)?;
        let request = provider_start_request(&dispatch, &identity, &resolved)?;
        let client = self
            .client_factory
            .connect(resolved.authority().authorization_identity().clone())
            .await?;
        let result = client.start(request).await.map_err(map_provider_error)?;
        let journal = journal_record(&dispatch, &identity, &resolved, &result, now);
        match self
            .journal
            .create(&journal)
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
        {
            ProviderRunJournalCreateOutcome::Created
            | ProviderRunJournalCreateOutcome::ExistingSame => {
                executor_run_ref(result.provider_run_id())
            }
            ProviderRunJournalCreateOutcome::Conflict
            | ProviderRunJournalCreateOutcome::ExecutionSpecNotFound => {
                Err(WorkerExecutorError::OutcomeUnknown)
            }
        }
    }

    pub(super) async fn current_task(
        &self,
        dispatch: &WorkerDispatch,
        now: i64,
    ) -> Result<crewon_task_runtime::TaskAggregate, WorkerExecutorError> {
        let now_timestamp =
            UnixTimestamp::new(now).map_err(|_| WorkerExecutorError::InvalidResponse)?;
        let current = TaskStateStoreAdapter::new(self.state.clone())
            .read(dispatch.control().task_id().clone())
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        let current_dispatch = WorkerDispatch::from_aggregate(&current, now_timestamp)
            .map_err(|_| WorkerExecutorError::InvalidResponse)?;
        if &current_dispatch != dispatch {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        Ok(current)
    }

    pub(super) async fn journal_authorization(
        &self,
        task_id: &str,
        binding: &crewon_resource_federation::ResolvedResourceBinding,
        journal: &ProviderRunJournalRecord,
        now: i64,
    ) -> Result<
        (
            ProviderRunAuthorizationBinding,
            ProviderAuthorizationIdentity,
        ),
        WorkerExecutorError,
    > {
        let expected_binding_revision = self
            .state
            .get_cloud_agent_turn_record_by_task_id(task_id)
            .await
            .map_err(|_| WorkerExecutorError::Unavailable)?
            .map(|turn| {
                if turn.execution_binding.binding_id == binding.binding_id().as_str() {
                    Ok(turn.execution_binding.revision)
                } else {
                    Err(WorkerExecutorError::Unauthorized)
                }
            })
            .transpose()?;
        let authority = resolve_provider_run_authority(ProviderRunAuthorityRequest {
            state: self.state.as_ref(),
            binding,
            expected_binding_revision,
            credential_id: &journal.credential_id,
            credential_revision: journal.credential_revision,
            now,
        })
        .await
        .map_err(map_authority_error)?;
        let authorization = ProviderRunAuthorizationBinding::new(
            binding.resource().clone(),
            task_id,
            authority.credential_id(),
            authority.credential_revision(),
        )
        .map_err(|_| WorkerExecutorError::Unauthorized)?;
        Ok((authorization, authority.authorization_identity().clone()))
    }
}

fn executor_run_ref(provider_run_id: &str) -> Result<ExecutorRunRef, WorkerExecutorError> {
    ExecutorRunRef::new(provider_run_id).map_err(|_| WorkerExecutorError::InvalidResponse)
}

fn map_resolve_error(error: CloudExecutionResolveError) -> WorkerExecutorError {
    match error {
        CloudExecutionResolveError::StateUnavailable => WorkerExecutorError::Unavailable,
        CloudExecutionResolveError::CredentialMismatch => WorkerExecutorError::Unauthorized,
        CloudExecutionResolveError::InvalidRequest
        | CloudExecutionResolveError::ExecutionSpecNotFound
        | CloudExecutionResolveError::ExecutionSpecMismatch
        | CloudExecutionResolveError::BindingCardinality
        | CloudExecutionResolveError::BindingMismatch
        | CloudExecutionResolveError::ArtifactUnavailable
        | CloudExecutionResolveError::ArtifactMismatch
        | CloudExecutionResolveError::PromptInvalid => WorkerExecutorError::InvalidResponse,
    }
}

fn map_authority_error(error: ProviderRunAuthorityError) -> WorkerExecutorError {
    match error {
        ProviderRunAuthorityError::StateUnavailable => WorkerExecutorError::Unavailable,
        ProviderRunAuthorityError::InvalidRequest
        | ProviderRunAuthorityError::BindingMismatch
        | ProviderRunAuthorityError::ConnectionMismatch
        | ProviderRunAuthorityError::GrantMismatch
        | ProviderRunAuthorityError::IdentityMismatch => WorkerExecutorError::Unauthorized,
    }
}

pub(super) fn map_provider_error(error: AgentPlatformProviderError) -> WorkerExecutorError {
    match error {
        AgentPlatformProviderError::Unauthorized => WorkerExecutorError::Unauthorized,
        AgentPlatformProviderError::Incompatible => WorkerExecutorError::Unsupported,
        AgentPlatformProviderError::Unavailable
        | AgentPlatformProviderError::Timeout
        | AgentPlatformProviderError::RateLimited { .. } => WorkerExecutorError::Unavailable,
        AgentPlatformProviderError::UnknownOutcome => WorkerExecutorError::OutcomeUnknown,
        AgentPlatformProviderError::InvalidRequest
        | AgentPlatformProviderError::NotFound
        | AgentPlatformProviderError::Conflict
        | AgentPlatformProviderError::InvalidResponse => WorkerExecutorError::InvalidResponse,
        _ => WorkerExecutorError::InvalidResponse,
    }
}

#[cfg(test)]
#[path = "cloud_worker_tests.rs"]
mod tests;

#[path = "cloud_worker_events.rs"]
mod events;

#[path = "cloud_worker_control.rs"]
mod control;
