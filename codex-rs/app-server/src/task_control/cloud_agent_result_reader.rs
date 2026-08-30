use std::fmt;
use std::future::Future;
use std::sync::Arc;

use crewon_provider_agent_platform::AgentPlatformProviderError;
use crewon_provider_agent_platform::ProviderRunArtifactClient;
use crewon_provider_agent_platform::ProviderRunArtifactContent;
use crewon_provider_agent_platform::ProviderRunArtifactReadRequest;
use crewon_provider_agent_platform::ProviderRunAuthorizationBinding;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::StateRuntime;
use crewon_task_runtime::StrategyKind;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStore;

use super::cloud_execution_resolver::binding_matches_spec;
use super::cloud_execution_resolver::unique_cloud_agent_binding;
use super::provider_run_authority::ProviderRunAuthorityError;
use super::provider_run_authority::ProviderRunAuthorityRequest;
use super::provider_run_authority::resolve_provider_run_authority;
use super::task_state_store_adapter::TaskStateStoreAdapter;
use crate::platform_control::provider_connection_production::AgentPlatformProviderDescriptorFactory;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct CloudAgentResultArtifactReadRequest {
    pub(super) turn_id: String,
    pub(super) journal: ProviderRunJournalRecord,
    pub(super) artifact: crewon_provider_agent_platform::ProviderArtifactRef,
    pub(super) now: i64,
}

impl fmt::Debug for CloudAgentResultArtifactReadRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentResultArtifactReadRequest")
            .field("turn_id", &self.turn_id)
            .field("journal", &"[REDACTED]")
            .field("artifact", &self.artifact)
            .field("now", &self.now)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(super) enum CloudAgentResultArtifactReadError {
    #[error("Cloud Agent result read correlation is invalid")]
    InvalidCorrelation,
    #[error("Cloud Agent result authority is no longer available")]
    Unauthorized,
    #[error("Cloud Agent result is permanently unavailable")]
    PermanentlyUnavailable,
    #[error("Cloud Agent result read is temporarily unavailable")]
    TemporarilyUnavailable,
}

/// Reads exact Provider output bytes after revalidating current local authority for every I/O.
pub(super) trait CloudAgentResultArtifactReader: Send + Sync {
    fn read(
        &self,
        request: CloudAgentResultArtifactReadRequest,
    ) -> impl Future<Output = Result<ProviderRunArtifactContent, CloudAgentResultArtifactReadError>> + Send;
}

pub(super) struct ProductionCloudAgentResultArtifactReader {
    state: Arc<StateRuntime>,
    client_factory: Arc<AgentPlatformProviderDescriptorFactory>,
}

impl ProductionCloudAgentResultArtifactReader {
    pub(super) fn new(
        state: Arc<StateRuntime>,
        client_factory: Arc<AgentPlatformProviderDescriptorFactory>,
    ) -> Self {
        Self {
            state,
            client_factory,
        }
    }
}

impl CloudAgentResultArtifactReader for ProductionCloudAgentResultArtifactReader {
    async fn read(
        &self,
        request: CloudAgentResultArtifactReadRequest,
    ) -> Result<ProviderRunArtifactContent, CloudAgentResultArtifactReadError> {
        if request.now < 0 || request.artifact.task_id() != request.journal.key.task_id {
            return Err(CloudAgentResultArtifactReadError::InvalidCorrelation);
        }
        let turn = self
            .state
            .get_cloud_agent_turn_record(&request.turn_id)
            .await
            .map_err(|_| CloudAgentResultArtifactReadError::TemporarilyUnavailable)?
            .ok_or(CloudAgentResultArtifactReadError::InvalidCorrelation)?;
        if turn.origin.task_id() != Some(request.journal.key.task_id.as_str())
            || turn.status != crewon_state::CloudAgentTurnStatus::Finalizing
        {
            return Err(CloudAgentResultArtifactReadError::InvalidCorrelation);
        }
        let current_journal = self
            .state
            .get_provider_run_journal_record(&request.journal.key)
            .await
            .map_err(|_| CloudAgentResultArtifactReadError::TemporarilyUnavailable)?
            .ok_or(CloudAgentResultArtifactReadError::InvalidCorrelation)?;
        if !journal_identity_matches(&current_journal, &request.journal) {
            return Err(CloudAgentResultArtifactReadError::InvalidCorrelation);
        }
        let task = TaskStateStoreAdapter::new(self.state.clone())
            .read(
                TaskId::new(&request.journal.key.task_id)
                    .map_err(|_| CloudAgentResultArtifactReadError::InvalidCorrelation)?,
            )
            .await
            .map_err(|_| CloudAgentResultArtifactReadError::TemporarilyUnavailable)?
            .ok_or(CloudAgentResultArtifactReadError::InvalidCorrelation)?;
        let attempt = task
            .active_attempt()
            .ok_or(CloudAgentResultArtifactReadError::InvalidCorrelation)?;
        if task.contract().authority() != TaskAuthority::LocalAppServer
            || task.contract().strategy() != StrategyKind::Single
            || attempt.attempt_id().as_str() != request.journal.key.attempt_id
            || attempt
                .worker_run_id()
                .map(crewon_task_runtime::WorkerRunId::as_str)
                != Some(request.journal.key.worker_run_id.as_str())
            || task
                .contract()
                .execution_spec()
                .execution_spec_id()
                .as_str()
                != request.journal.execution_spec_id
            || task.contract().execution_spec().revision().get()
                != request.journal.execution_spec_revision
            || task.contract().execution_spec().digest().as_str()
                != request.journal.execution_spec_digest
        {
            return Err(CloudAgentResultArtifactReadError::InvalidCorrelation);
        }
        let spec = self
            .state
            .get_cloud_execution_spec_record(
                &request.journal.execution_spec_id,
                request.journal.execution_spec_revision,
            )
            .await
            .map_err(|_| CloudAgentResultArtifactReadError::TemporarilyUnavailable)?
            .ok_or(CloudAgentResultArtifactReadError::InvalidCorrelation)?;
        let binding = unique_cloud_agent_binding(task.contract().bindings())
            .map_err(|_| CloudAgentResultArtifactReadError::InvalidCorrelation)?;
        if spec.digest != request.journal.execution_spec_digest
            || spec.task_id != request.journal.key.task_id
            || spec.binding_id != turn.execution_binding.binding_id
            || spec.credential_id != request.journal.credential_id
            || spec.credential_revision != request.journal.credential_revision
            || !binding_matches_spec(binding, &spec)
        {
            return Err(CloudAgentResultArtifactReadError::InvalidCorrelation);
        }
        let authority = resolve_provider_run_authority(ProviderRunAuthorityRequest {
            state: self.state.as_ref(),
            binding,
            expected_binding_revision: Some(turn.execution_binding.revision),
            credential_id: &request.journal.credential_id,
            credential_revision: request.journal.credential_revision,
            now: request.now,
        })
        .await
        .map_err(map_authority_error)?;
        let authorization = ProviderRunAuthorizationBinding::new(
            binding.resource().clone(),
            &request.journal.key.task_id,
            authority.credential_id(),
            authority.credential_revision(),
        )
        .map_err(|_| CloudAgentResultArtifactReadError::Unauthorized)?;
        let read_request = ProviderRunArtifactReadRequest::new(authorization, request.artifact)
            .map_err(|_| CloudAgentResultArtifactReadError::InvalidCorrelation)?;
        let client = self
            .client_factory
            .connect_provider_client("agent-platform", authority.authorization_identity().clone())
            .await
            .map_err(map_provider_error)?;
        client
            .read_artifact(read_request)
            .await
            .map_err(map_provider_error)
    }
}

fn journal_identity_matches(
    current: &ProviderRunJournalRecord,
    expected: &ProviderRunJournalRecord,
) -> bool {
    current.key == expected.key
        && current.execution_spec_id == expected.execution_spec_id
        && current.execution_spec_revision == expected.execution_spec_revision
        && current.execution_spec_digest == expected.execution_spec_digest
        && current.provider_id == expected.provider_id
        && current.protocol_version == expected.protocol_version
        && current.resource_id == expected.resource_id
        && current.resource_revision == expected.resource_revision
        && current.credential_id == expected.credential_id
        && current.credential_revision == expected.credential_revision
        && current.provider_run_id == expected.provider_run_id
        && current.provider_attempt_id == expected.provider_attempt_id
}

fn map_authority_error(error: ProviderRunAuthorityError) -> CloudAgentResultArtifactReadError {
    match error {
        ProviderRunAuthorityError::StateUnavailable => {
            CloudAgentResultArtifactReadError::TemporarilyUnavailable
        }
        ProviderRunAuthorityError::InvalidRequest => {
            CloudAgentResultArtifactReadError::InvalidCorrelation
        }
        ProviderRunAuthorityError::BindingMismatch
        | ProviderRunAuthorityError::ConnectionMismatch
        | ProviderRunAuthorityError::GrantMismatch
        | ProviderRunAuthorityError::IdentityMismatch => {
            CloudAgentResultArtifactReadError::Unauthorized
        }
    }
}

fn map_provider_error(error: AgentPlatformProviderError) -> CloudAgentResultArtifactReadError {
    match error {
        AgentPlatformProviderError::Unavailable
        | AgentPlatformProviderError::Timeout
        | AgentPlatformProviderError::UnknownOutcome
        | AgentPlatformProviderError::RateLimited { .. } => {
            CloudAgentResultArtifactReadError::TemporarilyUnavailable
        }
        AgentPlatformProviderError::Unauthorized => CloudAgentResultArtifactReadError::Unauthorized,
        AgentPlatformProviderError::InvalidRequest
        | AgentPlatformProviderError::NotFound
        | AgentPlatformProviderError::Conflict
        | AgentPlatformProviderError::Incompatible
        | AgentPlatformProviderError::InvalidResponse => {
            CloudAgentResultArtifactReadError::PermanentlyUnavailable
        }
        _ => CloudAgentResultArtifactReadError::PermanentlyUnavailable,
    }
}
