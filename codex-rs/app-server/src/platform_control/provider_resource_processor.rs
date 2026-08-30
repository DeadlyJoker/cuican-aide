use std::collections::BTreeSet;

use crewon_app_server_protocol::ResourceListParams;
use crewon_app_server_protocol::ResourceListResponse;
use crewon_app_server_protocol::ResourceManifestProjection;
use crewon_app_server_protocol::ResourceReadParams;
use crewon_app_server_protocol::ResourceReadResponse;
use crewon_app_server_protocol::ResourceRef as ProtocolResourceRef;
use crewon_app_server_protocol::ResourceType;
use crewon_resource_federation::PageCursor;
use crewon_resource_federation::PageLimit;
use crewon_resource_federation::ProviderError;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceListQuery;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_state::StateRuntime;

use super::RequestIdentity;
use super::provider_connection_descriptor::LiveProviderDescriptor;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_descriptor::ProviderDescriptorReadError;
use super::provider_connection_descriptor::ProviderDescriptorReadRequest;
use super::provider_connection_processor::ProviderConnectionAccess;
use super::provider_connection_processor::ProviderConnectionProcessorError;
use super::provider_connection_processor::ProviderConnectionView;
use super::provider_connection_processor::begin_provider_connection_access;
use super::provider_connection_processor::finish_provider_connection_access;
use super::provider_connection_projection::ProviderConnectionProjectionError;
use super::provider_connection_projection::map_resource_type;
use super::provider_connection_projection::project_provider_connection;
use super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;
use super::provider_resource_catalog::ProviderResourceCatalog;
use super::provider_resource_catalog::ProviderResourceCatalogFactory;

const DEFAULT_RESOURCE_PAGE_LIMIT: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderResourceProcessorError {
    #[error("Provider resource request is invalid")]
    InvalidRequest,
    #[error("Provider resource request is not authorized")]
    Unauthorized,
    #[error("Provider resource was not found")]
    NotFound,
    #[error("Provider authority changed during resource I/O")]
    AuthorityChanged,
    #[error("Provider resource is unavailable")]
    Unavailable,
    #[error("Provider resource is incompatible")]
    Incompatible,
    #[error("Provider resource response is invalid")]
    InvalidResponse,
}

pub(crate) struct ProviderResourceProcessor<'a, Factory, Clock> {
    state: &'a StateRuntime,
    ready_mappings: &'a ReadyProviderIdentityMappings,
    catalog_factory: &'a Factory,
    clock: &'a Clock,
}

impl<'a, Factory, Clock> ProviderResourceProcessor<'a, Factory, Clock>
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
            ready_mappings,
            catalog_factory,
            clock,
        }
    }

    pub(crate) async fn list(
        &self,
        identity: &RequestIdentity,
        params: ResourceListParams,
    ) -> Result<ResourceListResponse, ProviderResourceProcessorError> {
        let limit = page_limit(params.limit)?;
        let cursor = params
            .cursor
            .map(PageCursor::new)
            .transpose()
            .map_err(|_| ProviderResourceProcessorError::InvalidRequest)?;
        let resource_kind = params.resource_type.map(map_protocol_resource_type);
        let access = self.begin(identity, &params.connection_id).await?;
        let catalog = self.connect_catalog(&access).await?;
        validate_catalog(&access, catalog.descriptor())?;
        if resource_kind.is_some_and(|kind| !supports_kind(catalog.descriptor(), kind)) {
            return Err(ProviderResourceProcessorError::Incompatible);
        }
        let mut query = ResourceListQuery::new(catalog.descriptor().provider().clone(), limit);
        if let Some(kind) = resource_kind {
            query = query.for_kind(kind);
        }
        if let Some(cursor) = cursor {
            query = query.after(cursor);
        }
        let page = catalog
            .list_resources(query)
            .await
            .map_err(map_catalog_error)?;
        validate_page(
            &page,
            catalog.descriptor(),
            resource_kind,
            usize::from(limit.get()),
        )?;
        let observed_at = self.finish(identity, &access).await?;
        let provider_etag = provider_etag(&access, catalog.descriptor(), observed_at)?;
        Ok(ResourceListResponse {
            data: page.resources().iter().map(project_resource_ref).collect(),
            next_cursor: page
                .next_cursor()
                .map(|next_cursor| next_cursor.as_str().to_string()),
            provider_etag,
        })
    }

    pub(crate) async fn read(
        &self,
        identity: &RequestIdentity,
        params: ResourceReadParams,
    ) -> Result<ResourceReadResponse, ProviderResourceProcessorError> {
        let access = self.begin(identity, &params.connection_id).await?;
        let resource = parse_resource_ref(&params.resource, access.connection())?;
        let catalog = self.connect_catalog(&access).await?;
        validate_catalog(&access, catalog.descriptor())?;
        if !supports_kind(catalog.descriptor(), resource.kind) {
            return Err(ProviderResourceProcessorError::Incompatible);
        }
        let manifest = catalog
            .read_manifest(resource.clone())
            .await
            .map_err(map_catalog_error)?;
        if manifest.resource != resource {
            return Err(ProviderResourceProcessorError::InvalidResponse);
        }
        let observed_at = self.finish(identity, &access).await?;
        let provider_etag = provider_etag(&access, catalog.descriptor(), observed_at)?;
        Ok(ResourceReadResponse {
            manifest: project_manifest(manifest),
            provider_etag,
        })
    }

    pub(super) async fn begin(
        &self,
        identity: &RequestIdentity,
        connection_id: &str,
    ) -> Result<ProviderConnectionAccess, ProviderResourceProcessorError> {
        begin_provider_connection_access(
            self.state,
            self.ready_mappings,
            self.clock,
            identity,
            connection_id,
        )
        .await
        .map_err(map_connection_error)
    }

    pub(super) async fn connect_catalog(
        &self,
        access: &ProviderConnectionAccess,
    ) -> Result<Factory::Catalog, ProviderResourceProcessorError> {
        self.catalog_factory
            .connect_catalog(ProviderDescriptorReadRequest {
                provider_id: access.connection().provider_id.clone(),
                authorization_identity: access.authorization_identity().clone(),
            })
            .await
            .map_err(map_descriptor_error)
    }

    pub(super) async fn finish(
        &self,
        identity: &RequestIdentity,
        access: &ProviderConnectionAccess,
    ) -> Result<i64, ProviderResourceProcessorError> {
        finish_provider_connection_access(
            self.state,
            self.ready_mappings,
            self.clock,
            identity,
            access,
        )
        .await
        .map_err(map_connection_error)
    }
}

fn page_limit(limit: Option<u32>) -> Result<PageLimit, ProviderResourceProcessorError> {
    let value = limit.unwrap_or(DEFAULT_RESOURCE_PAGE_LIMIT);
    let value = u16::try_from(value).map_err(|_| ProviderResourceProcessorError::InvalidRequest)?;
    PageLimit::new(value).map_err(|_| ProviderResourceProcessorError::InvalidRequest)
}

pub(super) fn validate_catalog(
    access: &ProviderConnectionAccess,
    descriptor: &LiveProviderDescriptor,
) -> Result<(), ProviderResourceProcessorError> {
    let connection = access.connection();
    if descriptor.provider().provider_id.as_str() != connection.provider_id
        || descriptor.provider().protocol_version.as_str() != connection.protocol_version
    {
        return Err(ProviderResourceProcessorError::Incompatible);
    }
    Ok(())
}

fn supports_kind(descriptor: &LiveProviderDescriptor, resource_kind: ResourceKind) -> bool {
    descriptor
        .resource_capabilities()
        .iter()
        .any(|capability| capability.resource_kind == resource_kind)
}

fn validate_page(
    page: &crewon_resource_federation::ResourcePage,
    descriptor: &LiveProviderDescriptor,
    requested_kind: Option<ResourceKind>,
    limit: usize,
) -> Result<(), ProviderResourceProcessorError> {
    if page.resources().len() > limit {
        return Err(ProviderResourceProcessorError::InvalidResponse);
    }
    let mut unique = BTreeSet::new();
    for resource in page.resources() {
        if resource.provider != *descriptor.provider()
            || requested_kind.is_some_and(|kind| resource.kind != kind)
            || !supports_kind(descriptor, resource.kind)
            || !unique.insert(resource.clone())
        {
            return Err(ProviderResourceProcessorError::InvalidResponse);
        }
    }
    Ok(())
}

pub(super) fn parse_resource_ref(
    resource: &ProtocolResourceRef,
    connection: &crewon_state::ProviderConnectionRecord,
) -> Result<ResourceRef, ProviderResourceProcessorError> {
    if resource.provider_id != connection.provider_id {
        return Err(ProviderResourceProcessorError::InvalidRequest);
    }
    Ok(ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new(connection.provider_id.clone())
                .map_err(|_| ProviderResourceProcessorError::InvalidResponse)?,
            protocol_version: ProviderProtocolVersion::new(connection.protocol_version.clone())
                .map_err(|_| ProviderResourceProcessorError::InvalidResponse)?,
        },
        kind: map_protocol_resource_type(resource.resource_type),
        resource_id: ResourceId::new(resource.resource_id.clone())
            .map_err(|_| ProviderResourceProcessorError::InvalidRequest)?,
        revision: ResourceRevision::new(resource.revision.clone())
            .map_err(|_| ProviderResourceProcessorError::InvalidRequest)?,
    })
}

fn project_resource_ref(resource: &ResourceRef) -> ProtocolResourceRef {
    ProtocolResourceRef {
        provider_id: resource.provider.provider_id.as_str().to_string(),
        resource_id: resource.resource_id.as_str().to_string(),
        revision: resource.revision.as_str().to_string(),
        resource_type: map_resource_type(resource.kind),
    }
}

fn project_manifest(manifest: ResourceManifest) -> ResourceManifestProjection {
    ResourceManifestProjection {
        resource: project_resource_ref(&manifest.resource),
        schema_version: manifest.schema_version.as_str().to_string(),
        content_digest: manifest
            .content_digest
            .map(|digest| digest.as_str().to_string()),
    }
}

fn provider_etag(
    access: &ProviderConnectionAccess,
    descriptor: &LiveProviderDescriptor,
    observed_at: i64,
) -> Result<String, ProviderResourceProcessorError> {
    project_provider_connection(&ProviderConnectionView::new(
        access.connection().clone(),
        descriptor.clone(),
        observed_at,
    ))
    .map(|provider| provider.projection_etag)
    .map_err(map_projection_error)
}

fn map_protocol_resource_type(resource_type: ResourceType) -> ResourceKind {
    match resource_type {
        ResourceType::Agent => ResourceKind::Agent,
        ResourceType::Skill => ResourceKind::Skill,
        ResourceType::McpServer => ResourceKind::McpServer,
        ResourceType::McpTool => ResourceKind::McpTool,
        ResourceType::KnowledgeBase => ResourceKind::KnowledgeBase,
        ResourceType::Workflow => ResourceKind::Workflow,
    }
}

fn map_connection_error(error: ProviderConnectionProcessorError) -> ProviderResourceProcessorError {
    match error {
        ProviderConnectionProcessorError::InvalidRequest => {
            ProviderResourceProcessorError::InvalidRequest
        }
        ProviderConnectionProcessorError::Unauthorized => {
            ProviderResourceProcessorError::Unauthorized
        }
        ProviderConnectionProcessorError::NotFound => ProviderResourceProcessorError::NotFound,
        ProviderConnectionProcessorError::AuthorityChanged => {
            ProviderResourceProcessorError::AuthorityChanged
        }
        ProviderConnectionProcessorError::CapacityExceeded
        | ProviderConnectionProcessorError::Unavailable => {
            ProviderResourceProcessorError::Unavailable
        }
        ProviderConnectionProcessorError::Incompatible => {
            ProviderResourceProcessorError::Incompatible
        }
    }
}

fn map_descriptor_error(error: ProviderDescriptorReadError) -> ProviderResourceProcessorError {
    match error {
        ProviderDescriptorReadError::Unauthorized => ProviderResourceProcessorError::Unauthorized,
        ProviderDescriptorReadError::Unavailable => ProviderResourceProcessorError::Unavailable,
        ProviderDescriptorReadError::Incompatible => ProviderResourceProcessorError::Incompatible,
        ProviderDescriptorReadError::InvalidResponse => {
            ProviderResourceProcessorError::InvalidResponse
        }
    }
}

pub(super) fn map_catalog_error(error: ProviderError) -> ProviderResourceProcessorError {
    match error {
        ProviderError::Unauthorized => ProviderResourceProcessorError::Unauthorized,
        ProviderError::NotFound => ProviderResourceProcessorError::NotFound,
        ProviderError::Unavailable => ProviderResourceProcessorError::Unavailable,
        ProviderError::Incompatible => ProviderResourceProcessorError::Incompatible,
        ProviderError::InvalidResponse => ProviderResourceProcessorError::InvalidResponse,
    }
}

fn map_projection_error(
    error: ProviderConnectionProjectionError,
) -> ProviderResourceProcessorError {
    match error {
        ProviderConnectionProjectionError::InvalidView => {
            ProviderResourceProcessorError::InvalidResponse
        }
        ProviderConnectionProjectionError::Incompatible => {
            ProviderResourceProcessorError::Incompatible
        }
    }
}
