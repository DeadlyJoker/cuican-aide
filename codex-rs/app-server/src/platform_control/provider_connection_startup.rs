use std::collections::HashMap;
use std::fmt;
use std::io;
use std::io::ErrorKind;
use std::sync::Arc;

use crewon_app_server_protocol::ProviderConnectionProjection;
use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindingProjection;
use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceListResponse;
use crewon_app_server_protocol::ResourceReadParams;
use crewon_app_server_protocol::ResourceReadResponse;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_provider_agent_platform::AgentPlatformDynamicResourceManifest;
use crewon_provider_agent_platform::AgentPlatformIdentitySourceClient;
use crewon_provider_agent_platform::AgentPlatformProviderError;
use crewon_provider_agent_platform::Rs256IdentitySourceAuthorizer;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::StateRuntime;

use super::RequestIdentity;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_processor::ProviderConnectionProcessor;
use super::provider_connection_processor::ProviderConnectionProcessorError;
use super::provider_connection_production::AgentPlatformProviderDescriptorFactory;
use super::provider_connection_production::PreparedProviderConnectionProduction;
use super::provider_connection_production::SystemProviderConnectionClock;
use super::provider_connection_projection::ProviderConnectionProjectionError;
use super::provider_connection_projection::project_provider_connection;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSettings;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSupervisor;
use super::provider_identity_refresh_supervisor::ProviderIdentityRefreshSupervisorError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReader;
use super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;
use super::provider_resource_binding_processor::ProviderResourceBindingProcessor;
use super::provider_resource_binding_processor::ProviderResourceBindingProcessorError;
use super::provider_resource_catalog::ProviderResourceCatalog;
use super::provider_resource_processor::ProviderResourceProcessor;
use super::provider_resource_processor::ProviderResourceProcessorError;
use super::provider_resource_processor::validate_catalog;

const IDENTITY_REFRESH_PAGE_SIZE: u32 = 100;
const MAX_IDENTITY_BINDINGS: usize = 1_024;

pub(crate) struct PreparedProviderConnectionRuntime<Clock> {
    state: Arc<StateRuntime>,
    ready_mappings: ReadyProviderIdentityMappings,
    production: PreparedProviderConnectionProduction,
    clock: Clock,
}

impl<Clock> PreparedProviderConnectionRuntime<Clock>
where
    Clock: ProviderConnectionClock,
{
    pub(crate) fn readiness(&self) -> &ReadyProviderIdentityMappings {
        &self.ready_mappings
    }

    pub(crate) fn provider_client_factory(&self) -> Arc<AgentPlatformProviderDescriptorFactory> {
        Arc::new(self.production.factory().clone())
    }

    pub(crate) fn state(&self) -> &Arc<StateRuntime> {
        &self.state
    }

    pub(crate) fn clock(&self) -> &Clock {
        &self.clock
    }

    pub(crate) fn provider_factory(&self) -> &AgentPlatformProviderDescriptorFactory {
        self.production.factory()
    }

    pub(crate) async fn connect(
        &self,
        identity: &RequestIdentity,
        provider_id: &str,
    ) -> Result<ProviderConnectionProjection, ProviderConnectionRuntimeError> {
        let processor = ProviderConnectionProcessor::new(
            self.state.as_ref(),
            &self.ready_mappings,
            self.production.factory(),
            &self.clock,
        );
        let view = processor
            .connect(identity, provider_id)
            .await
            .map_err(map_processor_error)?;
        project_provider_connection(&view).map_err(map_projection_error)
    }

    pub(crate) async fn read(
        &self,
        identity: &RequestIdentity,
        connection_id: &str,
    ) -> Result<ProviderConnectionProjection, ProviderConnectionRuntimeError> {
        let processor = ProviderConnectionProcessor::new(
            self.state.as_ref(),
            &self.ready_mappings,
            self.production.factory(),
            &self.clock,
        );
        let view = processor
            .read(identity, connection_id)
            .await
            .map_err(map_processor_error)?;
        project_provider_connection(&view).map_err(map_projection_error)
    }

    pub(crate) async fn list_resources(
        &self,
        identity: &RequestIdentity,
        params: ResourceListParams,
    ) -> Result<ResourceListResponse, ProviderResourceRuntimeError> {
        ProviderResourceProcessor::new(
            self.state.as_ref(),
            &self.ready_mappings,
            self.production.factory(),
            &self.clock,
        )
        .list(identity, params)
        .await
        .map_err(map_resource_error)
    }

    pub(crate) async fn read_resource(
        &self,
        identity: &RequestIdentity,
        params: ResourceReadParams,
    ) -> Result<ResourceReadResponse, ProviderResourceRuntimeError> {
        ProviderResourceProcessor::new(
            self.state.as_ref(),
            &self.ready_mappings,
            self.production.factory(),
            &self.clock,
        )
        .read(identity, params)
        .await
        .map_err(map_resource_error)
    }

    pub(crate) async fn bind_resource(
        &self,
        identity: &RequestIdentity,
        workspace: &WorkspaceRef,
        params: ResourceBindParams,
    ) -> Result<ResourceBindingProjection, ProviderResourceRuntimeError> {
        ProviderResourceBindingProcessor::new(
            self.state.as_ref(),
            &self.ready_mappings,
            self.production.factory(),
            &self.clock,
        )
        .bind(identity, workspace, params)
        .await
        .map_err(ProviderResourceRuntimeError::from)
    }

    pub(crate) async fn read_dynamic_manifest(
        &self,
        identity: &RequestIdentity,
        binding: &ProviderResourceBindingRecord,
    ) -> Result<AgentPlatformDynamicResourceManifest, ProviderResourceRuntimeError> {
        binding
            .validate()
            .map_err(|_| ProviderResourceRuntimeError::InvalidRequest)?;
        let identity_ref = identity.reference();
        if binding.status != ProviderResourceBindingStatus::Active
            || binding.execution_location != ProviderResourceExecutionLocation::Provider
            || binding.local_actor_id != identity_ref.actor_id
            || identity_ref.tenant_id.as_deref() != Some(binding.local_tenant_id.as_str())
            || identity_ref.space_id.as_deref() != Some(binding.local_space_id.as_str())
            || !matches!(
                binding.resource_kind,
                ProviderResourceKind::McpTool | ProviderResourceKind::KnowledgeBase
            )
        {
            return Err(ProviderResourceRuntimeError::Unauthorized);
        }
        let processor = ProviderResourceProcessor::new(
            self.state.as_ref(),
            &self.ready_mappings,
            self.production.factory(),
            &self.clock,
        );
        let access = processor
            .begin(identity, &binding.connection_id)
            .await
            .map_err(map_resource_error)?;
        let resource = dynamic_resource_ref(binding)?;
        let catalog = processor
            .connect_catalog(&access)
            .await
            .map_err(map_resource_error)?;
        validate_catalog(&access, catalog.descriptor()).map_err(map_resource_error)?;
        let manifest = catalog
            .read_dynamic_manifest(resource.clone())
            .await
            .map_err(map_dynamic_manifest_error)?;
        if manifest.resource() != &resource
            || binding.content_digest.as_deref() != Some(manifest.content_digest().as_str())
        {
            return Err(ProviderResourceRuntimeError::AuthorityChanged);
        }
        processor
            .finish(identity, &access)
            .await
            .map_err(map_resource_error)?;
        Ok(manifest)
    }
}

fn dynamic_resource_ref(
    binding: &ProviderResourceBindingRecord,
) -> Result<ResourceRef, ProviderResourceRuntimeError> {
    Ok(ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new(binding.provider_id.clone())
                .map_err(|_| ProviderResourceRuntimeError::InvalidResponse)?,
            protocol_version: ProviderProtocolVersion::new(binding.protocol_version.clone())
                .map_err(|_| ProviderResourceRuntimeError::InvalidResponse)?,
        },
        kind: match binding.resource_kind {
            ProviderResourceKind::McpTool => ResourceKind::McpTool,
            ProviderResourceKind::KnowledgeBase => ResourceKind::KnowledgeBase,
            ProviderResourceKind::Agent
            | ProviderResourceKind::Skill
            | ProviderResourceKind::McpServer
            | ProviderResourceKind::Workflow => {
                return Err(ProviderResourceRuntimeError::Incompatible);
            }
        },
        resource_id: ResourceId::new(binding.resource_id.clone())
            .map_err(|_| ProviderResourceRuntimeError::InvalidResponse)?,
        revision: ResourceRevision::new(binding.resource_revision.clone())
            .map_err(|_| ProviderResourceRuntimeError::InvalidResponse)?,
    })
}

fn map_dynamic_manifest_error(error: AgentPlatformProviderError) -> ProviderResourceRuntimeError {
    match error {
        AgentPlatformProviderError::Unauthorized => ProviderResourceRuntimeError::Unauthorized,
        AgentPlatformProviderError::NotFound => ProviderResourceRuntimeError::NotFound,
        AgentPlatformProviderError::Unavailable
        | AgentPlatformProviderError::Timeout
        | AgentPlatformProviderError::UnknownOutcome
        | AgentPlatformProviderError::RateLimited { .. } => {
            ProviderResourceRuntimeError::Unavailable
        }
        AgentPlatformProviderError::Incompatible => ProviderResourceRuntimeError::Incompatible,
        AgentPlatformProviderError::InvalidRequest
        | AgentPlatformProviderError::Conflict
        | AgentPlatformProviderError::InvalidResponse => {
            ProviderResourceRuntimeError::InvalidResponse
        }
        _ => ProviderResourceRuntimeError::InvalidResponse,
    }
}

impl PreparedProviderConnectionRuntime<SystemProviderConnectionClock> {
    pub(crate) async fn from_process_environment(
        state: Option<Arc<StateRuntime>>,
        identity_reader: Option<&AgentPlatformIdentitySourceClient<Rs256IdentitySourceAuthorizer>>,
    ) -> io::Result<Option<Self>> {
        let environment = std::env::vars().collect::<HashMap<_, _>>();
        let clock = SystemProviderConnectionClock;
        let now = clock.now();
        prepare_provider_connection_runtime(&environment, state, identity_reader, clock, now).await
    }
}

impl<Clock> fmt::Debug for PreparedProviderConnectionRuntime<Clock> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PreparedProviderConnectionRuntime([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderConnectionRuntimeError {
    #[error("Provider connection request is invalid")]
    InvalidRequest,
    #[error("Provider connection is not authorized")]
    Unauthorized,
    #[error("Provider connection was not found")]
    NotFound,
    #[error("Provider authority changed")]
    AuthorityChanged,
    #[error("Provider connection capacity was exceeded")]
    CapacityExceeded,
    #[error("Provider connection is unavailable")]
    Unavailable,
    #[error("Provider connection is incompatible")]
    Incompatible,
    #[error("Provider connection projection is invalid")]
    InvalidProjection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderResourceRuntimeError {
    #[error("Provider resource request is invalid")]
    InvalidRequest,
    #[error("Provider resource request is not authorized")]
    Unauthorized,
    #[error("Provider resource was not found")]
    NotFound,
    #[error("Provider authority changed")]
    AuthorityChanged,
    #[error("Provider resource binding capacity was exceeded")]
    CapacityExceeded,
    #[error("Provider resource binding conflicts with persisted state")]
    Conflict,
    #[error("Provider resource is unavailable")]
    Unavailable,
    #[error("Provider resource is incompatible")]
    Incompatible,
    #[error("Provider resource response is invalid")]
    InvalidResponse,
}

impl From<ProviderResourceBindingProcessorError> for ProviderResourceRuntimeError {
    fn from(error: ProviderResourceBindingProcessorError) -> Self {
        match error {
            ProviderResourceBindingProcessorError::InvalidRequest => Self::InvalidRequest,
            ProviderResourceBindingProcessorError::Unauthorized => Self::Unauthorized,
            ProviderResourceBindingProcessorError::NotFound => Self::NotFound,
            ProviderResourceBindingProcessorError::AuthorityChanged => Self::AuthorityChanged,
            ProviderResourceBindingProcessorError::CapacityExceeded => Self::CapacityExceeded,
            ProviderResourceBindingProcessorError::Conflict => Self::Conflict,
            ProviderResourceBindingProcessorError::Unavailable => Self::Unavailable,
            ProviderResourceBindingProcessorError::Incompatible => Self::Incompatible,
            ProviderResourceBindingProcessorError::InvalidResponse => Self::InvalidResponse,
        }
    }
}

fn map_processor_error(error: ProviderConnectionProcessorError) -> ProviderConnectionRuntimeError {
    match error {
        ProviderConnectionProcessorError::InvalidRequest => {
            ProviderConnectionRuntimeError::InvalidRequest
        }
        ProviderConnectionProcessorError::Unauthorized => {
            ProviderConnectionRuntimeError::Unauthorized
        }
        ProviderConnectionProcessorError::NotFound => ProviderConnectionRuntimeError::NotFound,
        ProviderConnectionProcessorError::AuthorityChanged => {
            ProviderConnectionRuntimeError::AuthorityChanged
        }
        ProviderConnectionProcessorError::CapacityExceeded => {
            ProviderConnectionRuntimeError::CapacityExceeded
        }
        ProviderConnectionProcessorError::Unavailable => {
            ProviderConnectionRuntimeError::Unavailable
        }
        ProviderConnectionProcessorError::Incompatible => {
            ProviderConnectionRuntimeError::Incompatible
        }
    }
}

fn map_projection_error(
    error: ProviderConnectionProjectionError,
) -> ProviderConnectionRuntimeError {
    match error {
        ProviderConnectionProjectionError::InvalidView => {
            ProviderConnectionRuntimeError::InvalidProjection
        }
        ProviderConnectionProjectionError::Incompatible => {
            ProviderConnectionRuntimeError::Incompatible
        }
    }
}

fn map_resource_error(error: ProviderResourceProcessorError) -> ProviderResourceRuntimeError {
    match error {
        ProviderResourceProcessorError::InvalidRequest => {
            ProviderResourceRuntimeError::InvalidRequest
        }
        ProviderResourceProcessorError::Unauthorized => ProviderResourceRuntimeError::Unauthorized,
        ProviderResourceProcessorError::NotFound => ProviderResourceRuntimeError::NotFound,
        ProviderResourceProcessorError::AuthorityChanged => {
            ProviderResourceRuntimeError::AuthorityChanged
        }
        ProviderResourceProcessorError::Unavailable => ProviderResourceRuntimeError::Unavailable,
        ProviderResourceProcessorError::Incompatible => ProviderResourceRuntimeError::Incompatible,
        ProviderResourceProcessorError::InvalidResponse => {
            ProviderResourceRuntimeError::InvalidResponse
        }
    }
}

pub(crate) async fn prepare_provider_connection_runtime<Reader, Clock>(
    environment: &HashMap<String, String>,
    state: Option<Arc<StateRuntime>>,
    identity_reader: Option<&Reader>,
    clock: Clock,
    now: i64,
) -> io::Result<Option<PreparedProviderConnectionRuntime<Clock>>>
where
    Reader: ProviderIdentitySourceReader,
    Clock: ProviderConnectionClock,
{
    let Some(production) =
        PreparedProviderConnectionProduction::from_environment(environment).await?
    else {
        return Ok(None);
    };
    let state = state.ok_or_else(missing_authority_dependency)?;
    let identity_reader = identity_reader.ok_or_else(missing_authority_dependency)?;
    if now < 0 {
        return Err(authority_unavailable());
    }
    let settings =
        ProviderIdentityRefreshSettings::new(IDENTITY_REFRESH_PAGE_SIZE, MAX_IDENTITY_BINDINGS)
            .map_err(map_refresh_error)?;
    let ready_mappings =
        ProviderIdentityRefreshSupervisor::new(state.as_ref(), identity_reader, settings)
            .refresh_all(now)
            .await
            .map_err(map_refresh_error)?;
    Ok(Some(PreparedProviderConnectionRuntime {
        state,
        ready_mappings,
        production,
        clock,
    }))
}

fn map_refresh_error(error: ProviderIdentityRefreshSupervisorError) -> io::Error {
    match error {
        ProviderIdentityRefreshSupervisorError::InvalidSettings => invalid_startup_configuration(),
        ProviderIdentityRefreshSupervisorError::CapacityExceeded
        | ProviderIdentityRefreshSupervisorError::SourceUnavailable
        | ProviderIdentityRefreshSupervisorError::StateUnavailable
        | ProviderIdentityRefreshSupervisorError::SnapshotConflict => authority_unavailable(),
    }
}

fn invalid_startup_configuration() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidInput,
        "Agent Platform Provider startup configuration is invalid",
    )
}

fn missing_authority_dependency() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidInput,
        "Agent Platform Provider requires principal identity authority and sqlite state",
    )
}

fn authority_unavailable() -> io::Error {
    io::Error::new(
        ErrorKind::ConnectionRefused,
        "Agent Platform Provider identity authority is unavailable",
    )
}
