use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindingMode as ProtocolResourceBindingMode;
use crewon_app_server_protocol::ResourceBindingProjection;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_resource_federation::BindingError;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_state::ProviderResourceBindingResolveOutcome;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceBindingUnbindOutcome;
use crewon_state::ProviderResourceBindingUnbindRequest;
use crewon_state::StateRuntime;
use uuid::Uuid;

use super::RequestIdentity;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;
use super::provider_resource_binding_adapter::ProviderResourceBindingAdapterError;
use super::provider_resource_binding_adapter::project_resource_binding;
use super::provider_resource_binding_adapter::resource_binding_record;
use super::provider_resource_catalog::ProviderResourceCatalog;
use super::provider_resource_catalog::ProviderResourceCatalogFactory;
use super::provider_resource_processor::ProviderResourceProcessor;
use super::provider_resource_processor::ProviderResourceProcessorError;
use super::provider_resource_processor::map_catalog_error;
use super::provider_resource_processor::parse_resource_ref;
use super::provider_resource_processor::validate_catalog;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderResourceBindingProcessorError {
    #[error("Provider resource binding request is invalid")]
    InvalidRequest,
    #[error("Provider resource binding is not authorized")]
    Unauthorized,
    #[error("Provider resource binding was not found")]
    NotFound,
    #[error("Provider resource binding authority changed")]
    AuthorityChanged,
    #[error("Provider resource binding capacity was exceeded")]
    CapacityExceeded,
    #[error("Provider resource binding conflicts with persisted state")]
    Conflict,
    #[error("Provider resource binding is unavailable")]
    Unavailable,
    #[error("Provider resource binding is incompatible")]
    Incompatible,
    #[error("Provider resource binding response is invalid")]
    InvalidResponse,
}

pub(crate) struct ProviderResourceBindingProcessor<'a, Factory, Clock> {
    state: &'a StateRuntime,
    resources: ProviderResourceProcessor<'a, Factory, Clock>,
}

impl<'a, Factory, Clock> ProviderResourceBindingProcessor<'a, Factory, Clock>
where
    Factory: ProviderResourceCatalogFactory,
    Clock: ProviderConnectionClock,
{
    pub(crate) fn new(
        state: &'a StateRuntime,
        ready_mappings: &'a ReadyProviderIdentityMappings,
        catalog_factory: &'a Factory,
        clock: &'a Clock,
    ) -> Self {
        Self {
            state,
            resources: ProviderResourceProcessor::new(
                state,
                ready_mappings,
                catalog_factory,
                clock,
            ),
        }
    }

    pub(crate) async fn bind(
        &self,
        identity: &RequestIdentity,
        workspace: &WorkspaceRef,
        params: ResourceBindParams,
    ) -> Result<ResourceBindingProjection, ProviderResourceBindingProcessorError> {
        if workspace.binding_id != params.workspace_binding_id {
            return Err(ProviderResourceBindingProcessorError::InvalidRequest);
        }
        let (mode, execution_location) = binding_mode(params.mode)?;
        let access = self
            .resources
            .begin(identity, &params.connection_id)
            .await
            .map_err(map_resource_error)?;
        let resource = parse_resource_ref(&params.resource, access.connection())
            .map_err(map_resource_error)?;
        let catalog = self
            .resources
            .connect_catalog(&access)
            .await
            .map_err(map_resource_error)?;
        validate_catalog(&access, catalog.descriptor()).map_err(map_resource_error)?;
        let manifest = catalog
            .read_manifest(resource.clone())
            .await
            .map_err(map_catalog_error)
            .map_err(map_resource_error)?;
        let resolved = resolve_binding(
            &BindingRequest {
                binding_id: BindingId::new(format!("resource-binding:{}", Uuid::now_v7()))
                    .map_err(|_| ProviderResourceBindingProcessorError::InvalidResponse)?,
                workspace_key: WorkspaceKey::new(workspace.workspace_key.clone())
                    .map_err(|_| ProviderResourceBindingProcessorError::InvalidRequest)?,
                resource,
                mode,
                execution_location,
                materialization: None,
            },
            &manifest,
            catalog.descriptor().resource_capabilities(),
        )
        .map_err(map_binding_error)?;
        let observed_at = self
            .resources
            .finish(identity, &access)
            .await
            .map_err(map_resource_error)?;
        let record =
            resource_binding_record(access.connection(), workspace, &resolved, observed_at)
                .map_err(map_adapter_error)?;
        let persisted = match self
            .state
            .resolve_provider_resource_binding_record(&record)
            .await
            .map_err(|_| ProviderResourceBindingProcessorError::Unavailable)?
        {
            ProviderResourceBindingResolveOutcome::Created(record)
            | ProviderResourceBindingResolveOutcome::Existing(record)
            | ProviderResourceBindingResolveOutcome::Reactivated(record) => record,
            ProviderResourceBindingResolveOutcome::ConnectionNotFound
            | ProviderResourceBindingResolveOutcome::WorkspaceNotFound
            | ProviderResourceBindingResolveOutcome::ParentMismatch => {
                return Err(ProviderResourceBindingProcessorError::AuthorityChanged);
            }
            ProviderResourceBindingResolveOutcome::CapacityExceeded => {
                return Err(ProviderResourceBindingProcessorError::CapacityExceeded);
            }
            ProviderResourceBindingResolveOutcome::Conflict => {
                return Err(ProviderResourceBindingProcessorError::Conflict);
            }
        };
        project_resource_binding(&persisted).map_err(map_adapter_error)
    }
}

pub(crate) async fn unbind_resource_binding(
    state: &StateRuntime,
    identity: &RequestIdentity,
    binding_id: &str,
    now: i64,
) -> Result<ResourceBindingProjection, ProviderResourceBindingProcessorError> {
    if now < 0 || !valid_binding_id(binding_id) {
        return Err(ProviderResourceBindingProcessorError::InvalidRequest);
    }
    if identity.authenticated_principal().is_none() {
        return Err(ProviderResourceBindingProcessorError::Unauthorized);
    }
    let reference = identity.reference();
    let (Some(tenant_id), Some(space_id)) = (&reference.tenant_id, &reference.space_id) else {
        return Err(ProviderResourceBindingProcessorError::Unauthorized);
    };
    let current = state
        .get_provider_resource_binding_record(binding_id)
        .await
        .map_err(|_| ProviderResourceBindingProcessorError::Unavailable)?
        .ok_or(ProviderResourceBindingProcessorError::NotFound)?;
    if current.local_actor_id != reference.actor_id
        || current.local_tenant_id != *tenant_id
        || current.local_space_id != *space_id
    {
        return Err(ProviderResourceBindingProcessorError::NotFound);
    }
    let (expected_revision, unbound_at) = match current.status {
        ProviderResourceBindingStatus::Active => (current.revision, now),
        ProviderResourceBindingStatus::Unbound => (
            current
                .revision
                .checked_sub(1)
                .ok_or(ProviderResourceBindingProcessorError::InvalidResponse)?,
            current
                .unbound_at
                .ok_or(ProviderResourceBindingProcessorError::InvalidResponse)?,
        ),
    };
    let outcome = state
        .unbind_provider_resource_binding_record(&ProviderResourceBindingUnbindRequest {
            binding_id: binding_id.to_string(),
            local_actor_id: reference.actor_id.clone(),
            local_tenant_id: tenant_id.clone(),
            local_space_id: space_id.clone(),
            expected_revision,
            unbound_at,
        })
        .await
        .map_err(|_| ProviderResourceBindingProcessorError::Unavailable)?;
    match outcome {
        ProviderResourceBindingUnbindOutcome::Unbound
        | ProviderResourceBindingUnbindOutcome::ExistingUnbound => {}
        ProviderResourceBindingUnbindOutcome::NotFound => {
            return Err(ProviderResourceBindingProcessorError::NotFound);
        }
        ProviderResourceBindingUnbindOutcome::Conflict => {
            return Err(ProviderResourceBindingProcessorError::Conflict);
        }
    }
    let persisted = state
        .get_provider_resource_binding_record(binding_id)
        .await
        .map_err(|_| ProviderResourceBindingProcessorError::Unavailable)?
        .ok_or(ProviderResourceBindingProcessorError::InvalidResponse)?;
    project_resource_binding(&persisted).map_err(map_adapter_error)
}

fn binding_mode(
    mode: ProtocolResourceBindingMode,
) -> Result<(BindingMode, ExecutionLocation), ProviderResourceBindingProcessorError> {
    match mode {
        ProtocolResourceBindingMode::RemoteReference => {
            Ok((BindingMode::RemoteReference, ExecutionLocation::Provider))
        }
        ProtocolResourceBindingMode::ProviderManaged => {
            Ok((BindingMode::ProviderManaged, ExecutionLocation::Provider))
        }
        ProtocolResourceBindingMode::LocalSnapshot | ProtocolResourceBindingMode::LocalFork => {
            Err(ProviderResourceBindingProcessorError::Incompatible)
        }
    }
}

fn valid_binding_id(binding_id: &str) -> bool {
    binding_id
        .strip_prefix("resource-binding:")
        .and_then(|value| Uuid::parse_str(value).ok().map(|parsed| (value, parsed)))
        .is_some_and(|(value, parsed)| parsed.to_string() == value)
}

fn map_resource_error(
    error: ProviderResourceProcessorError,
) -> ProviderResourceBindingProcessorError {
    match error {
        ProviderResourceProcessorError::InvalidRequest => {
            ProviderResourceBindingProcessorError::InvalidRequest
        }
        ProviderResourceProcessorError::Unauthorized => {
            ProviderResourceBindingProcessorError::Unauthorized
        }
        ProviderResourceProcessorError::NotFound => ProviderResourceBindingProcessorError::NotFound,
        ProviderResourceProcessorError::AuthorityChanged => {
            ProviderResourceBindingProcessorError::AuthorityChanged
        }
        ProviderResourceProcessorError::Unavailable => {
            ProviderResourceBindingProcessorError::Unavailable
        }
        ProviderResourceProcessorError::Incompatible => {
            ProviderResourceBindingProcessorError::Incompatible
        }
        ProviderResourceProcessorError::InvalidResponse => {
            ProviderResourceBindingProcessorError::InvalidResponse
        }
    }
}

fn map_binding_error(error: BindingError) -> ProviderResourceBindingProcessorError {
    match error {
        BindingError::ResourceProviderMismatch
        | BindingError::ResourceIdentityMismatch
        | BindingError::RevisionMismatch
        | BindingError::CapabilityProviderMismatch
        | BindingError::ExecutionLocationNotAllowed => {
            ProviderResourceBindingProcessorError::InvalidResponse
        }
        BindingError::CapabilityNotSupported
        | BindingError::MaterializationRequired
        | BindingError::UnexpectedMaterialization
        | BindingError::ManifestDigestRequired
        | BindingError::SnapshotVerificationFailed
        | BindingError::ForkProvenanceMismatch
        | BindingError::SnapshotCapabilityMismatch => {
            ProviderResourceBindingProcessorError::Incompatible
        }
    }
}

fn map_adapter_error(
    error: ProviderResourceBindingAdapterError,
) -> ProviderResourceBindingProcessorError {
    match error {
        ProviderResourceBindingAdapterError::InvalidInput => {
            ProviderResourceBindingProcessorError::Unavailable
        }
        ProviderResourceBindingAdapterError::Incompatible => {
            ProviderResourceBindingProcessorError::InvalidResponse
        }
        ProviderResourceBindingAdapterError::InvalidRecord => {
            ProviderResourceBindingProcessorError::InvalidResponse
        }
    }
}
