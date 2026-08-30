use std::collections::BTreeSet;

use crewon_provider_transport::ProviderEndpointPolicy;
use crewon_provider_transport::SystemEndpointResolver;
use crewon_provider_transport::ValidatedProviderEndpoint;
use crewon_resource_federation::CatalogProvider;
use crewon_resource_federation::PageCursor;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderError;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceListQuery;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourcePage;
use crewon_resource_federation::ResourceRef;
use uuid::Uuid;

use crate::AgentPlatformCapability;
use crate::AgentPlatformDynamicResourceManifest;
use crate::AgentPlatformProviderError;
use crate::DiscoveryAuthorizationOperation;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::dynamic_manifest_wire::DynamicResourceManifestWire;
use crate::dynamic_manifest_wire::ReadDynamicResourceCommand;
use crate::http_client::AgentPlatformHttpClient;
use crate::wire::ListResourcesCommand;
use crate::wire::ProviderDescriptorWire;
use crate::wire::ProviderResourceManifestWire;
use crate::wire::ProviderResourcePageWire;
use crate::wire::ReadDescriptorCommand;
use crate::wire::ReadResourceCommand;
use crate::wire::ResourceRefWire;

const MAX_PROVIDER_PAGE_LIMIT: u16 = 50;

/// Validated Agent Platform descriptor and exact federation capabilities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPlatformProviderDescriptor {
    provider: ProviderRef,
    capabilities: BTreeSet<AgentPlatformCapability>,
    resource_capabilities: ProviderCapabilities,
}

impl AgentPlatformProviderDescriptor {
    pub(crate) fn new(
        provider: ProviderRef,
        capabilities: BTreeSet<AgentPlatformCapability>,
        resource_capabilities: ProviderCapabilities,
    ) -> Self {
        Self {
            provider,
            capabilities,
            resource_capabilities,
        }
    }

    /// Returns the exact Provider identity and protocol version.
    pub fn provider(&self) -> &ProviderRef {
        &self.provider
    }

    /// Returns whether the Provider advertised one exact runtime capability.
    pub fn supports(&self, capability: AgentPlatformCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    /// Iterates over the exact validated runtime capability snapshot.
    pub fn capabilities(&self) -> impl Iterator<Item = AgentPlatformCapability> + '_ {
        self.capabilities.iter().copied()
    }

    /// Returns the validated resource binding capability snapshot.
    pub fn resource_capabilities(&self) -> &ProviderCapabilities {
        &self.resource_capabilities
    }
}

/// Reusable, endpoint-pinned connector for strict Agent Platform Provider v3 clients.
#[derive(Clone)]
pub struct AgentPlatformProviderConnector {
    policy: ProviderEndpointPolicy,
    endpoint: ValidatedProviderEndpoint,
}

impl AgentPlatformProviderConnector {
    /// Validates and pins a production HTTPS Provider v3 endpoint.
    pub async fn production(raw_url: &str) -> Result<Self, AgentPlatformProviderError> {
        Self::validate(ProviderEndpointPolicy::production(), raw_url).await
    }

    /// Validates and pins a loopback development Provider v3 endpoint.
    pub async fn development_loopback(raw_url: &str) -> Result<Self, AgentPlatformProviderError> {
        Self::validate(ProviderEndpointPolicy::development_loopback(), raw_url).await
    }

    async fn validate(
        policy: ProviderEndpointPolicy,
        raw_url: &str,
    ) -> Result<Self, AgentPlatformProviderError> {
        let endpoint = policy.validate(raw_url, &SystemEndpointResolver).await?;
        if !endpoint.url().path().ends_with("/provider/v3/") {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        Ok(Self { policy, endpoint })
    }

    /// Reads and validates the live descriptor before returning a connected catalog client.
    pub async fn connect<Authorizer>(
        &self,
        authorizer: Authorizer,
    ) -> Result<AgentPlatformProviderClient<Authorizer>, AgentPlatformProviderError>
    where
        Authorizer: ProviderAuthorizer,
    {
        AgentPlatformProviderClient::connect(self.policy, self.endpoint.clone(), authorizer).await
    }
}

impl std::fmt::Debug for AgentPlatformProviderConnector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AgentPlatformProviderConnector([REDACTED])")
    }
}

/// Authenticated, transport-pinned Agent Platform catalog adapter.
pub struct AgentPlatformProviderClient<Authorizer> {
    pub(crate) http: AgentPlatformHttpClient,
    pub(crate) authorizer: Authorizer,
    pub(crate) descriptor: AgentPlatformProviderDescriptor,
}

impl<Authorizer> AgentPlatformProviderClient<Authorizer>
where
    Authorizer: ProviderAuthorizer,
{
    /// Validates the endpoint, reads the strict descriptor, and returns a connected adapter.
    pub async fn connect(
        policy: ProviderEndpointPolicy,
        endpoint: ValidatedProviderEndpoint,
        authorizer: Authorizer,
    ) -> Result<Self, AgentPlatformProviderError> {
        if !endpoint.url().path().ends_with("/provider/v3/") {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let http = AgentPlatformHttpClient::new(policy.pinned_client(endpoint)?);
        let authorization = authorizer
            .authorize(ProviderAuthorizationRequest::Discovery(
                DiscoveryAuthorizationOperation::ReadDescriptor,
            ))
            .await
            .map_err(map_authorization)?;
        let descriptor = http
            .post_json::<_, ProviderDescriptorWire>(
                "./descriptor:read",
                authorization,
                &ReadDescriptorCommand::new(command_id()),
            )
            .await?
            .validate()?;
        Ok(Self {
            http,
            authorizer,
            descriptor,
        })
    }

    /// Returns the descriptor that was validated during connection setup.
    pub fn descriptor(&self) -> &AgentPlatformProviderDescriptor {
        &self.descriptor
    }

    async fn list_resources_inner(
        &self,
        query: ResourceListQuery,
    ) -> Result<ResourcePage, AgentPlatformProviderError> {
        if query.provider != *self.descriptor.provider() {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let resource_kind = query.resource_kind.unwrap_or(ResourceKind::Agent);
        if !self
            .descriptor
            .resource_capabilities()
            .iter()
            .any(|capability| capability.resource_kind == resource_kind)
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let after_cursor = query.cursor.map(|cursor| cursor.as_str().to_string());
        if after_cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > 64)
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let authorization = self
            .authorizer
            .authorize(ProviderAuthorizationRequest::Discovery(
                DiscoveryAuthorizationOperation::ListResources,
            ))
            .await
            .map_err(map_authorization)?;
        let response = self
            .http
            .post_json::<_, ProviderResourcePageWire>(
                "./resources:list",
                authorization,
                &ListResourcesCommand::new(
                    command_id(),
                    resource_kind,
                    after_cursor,
                    query.limit.get().min(MAX_PROVIDER_PAGE_LIMIT),
                )?,
            )
            .await?;
        response.validate()?;
        let mut resources = Vec::with_capacity(response.data.len());
        let mut unique = BTreeSet::new();
        for manifest in response.data {
            let resource = manifest.into_domain(self.descriptor.provider())?.resource;
            if !unique.insert(resource.clone()) {
                return Err(AgentPlatformProviderError::InvalidResponse);
            }
            resources.push(resource);
        }
        match response.next_cursor {
            Some(cursor) => ResourcePage::continued(
                resources,
                PageCursor::new(cursor).map_err(|_| AgentPlatformProviderError::InvalidResponse)?,
            )
            .map_err(|_| AgentPlatformProviderError::InvalidResponse),
            None => ResourcePage::complete(resources)
                .map_err(|_| AgentPlatformProviderError::InvalidResponse),
        }
    }

    async fn read_manifest_inner(
        &self,
        resource: ResourceRef,
    ) -> Result<ResourceManifest, AgentPlatformProviderError> {
        if !self
            .descriptor
            .resource_capabilities()
            .iter()
            .any(|capability| capability.resource_kind == resource.kind)
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let wire = ResourceRefWire::from_domain(&resource)?;
        let authorization = self
            .authorizer
            .authorize(ProviderAuthorizationRequest::Discovery(
                DiscoveryAuthorizationOperation::ReadResource,
            ))
            .await
            .map_err(map_authorization)?;
        let manifest = self
            .http
            .post_json::<_, ProviderResourceManifestWire>(
                "./resources:read",
                authorization,
                &ReadResourceCommand::new(command_id(), wire),
            )
            .await?
            .into_domain(self.descriptor.provider())?;
        if manifest.resource != resource {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(manifest)
    }

    /// Reads a bounded execution manifest for one exact Tool or Knowledge revision.
    pub async fn read_dynamic_manifest(
        &self,
        resource: ResourceRef,
    ) -> Result<AgentPlatformDynamicResourceManifest, AgentPlatformProviderError> {
        let required_capability = match resource.kind {
            ResourceKind::McpTool => AgentPlatformCapability::RemoteTool,
            ResourceKind::KnowledgeBase => AgentPlatformCapability::RemoteKnowledge,
            ResourceKind::Agent
            | ResourceKind::Skill
            | ResourceKind::McpServer
            | ResourceKind::Workflow => return Err(AgentPlatformProviderError::Incompatible),
        };
        if !self.descriptor.supports(required_capability)
            || !self
                .descriptor
                .resource_capabilities()
                .iter()
                .any(|capability| capability.resource_kind == resource.kind)
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let wire = ResourceRefWire::from_domain(&resource)?;
        let authorization = self
            .authorizer
            .authorize(ProviderAuthorizationRequest::Discovery(
                DiscoveryAuthorizationOperation::ReadDynamicResource,
            ))
            .await
            .map_err(map_authorization)?;
        let manifest = self
            .http
            .post_json::<_, DynamicResourceManifestWire>(
                "./dynamicResources:read",
                authorization,
                &ReadDynamicResourceCommand::new(command_id(), wire),
            )
            .await?
            .into_domain(self.descriptor.provider())?;
        if manifest.resource() != &resource {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(manifest)
    }
}

impl<Authorizer> CatalogProvider for AgentPlatformProviderClient<Authorizer>
where
    Authorizer: ProviderAuthorizer,
{
    async fn list_resources(
        &self,
        query: ResourceListQuery,
    ) -> Result<ResourcePage, ProviderError> {
        self.list_resources_inner(query)
            .await
            .map_err(|error| error.catalog_error())
    }

    async fn read_manifest(
        &self,
        resource: ResourceRef,
    ) -> Result<ResourceManifest, ProviderError> {
        self.read_manifest_inner(resource)
            .await
            .map_err(|error| error.catalog_error())
    }
}

fn command_id() -> String {
    format!("crewon-{}", Uuid::now_v7())
}

fn map_authorization(error: ProviderAuthorizationError) -> AgentPlatformProviderError {
    match error {
        ProviderAuthorizationError::Unavailable => AgentPlatformProviderError::Unavailable,
        ProviderAuthorizationError::Unauthorized => AgentPlatformProviderError::Unauthorized,
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
