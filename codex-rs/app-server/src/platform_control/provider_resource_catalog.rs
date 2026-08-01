use std::future::Future;

use crewon_resource_federation::ProviderError;
use crewon_resource_federation::ResourceListQuery;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourcePage;
use crewon_resource_federation::ResourceRef;

use super::provider_connection_descriptor::LiveProviderDescriptor;
use super::provider_connection_descriptor::ProviderDescriptorReadError;
use super::provider_connection_descriptor::ProviderDescriptorReadRequest;

/// One authenticated, endpoint-pinned Provider catalog session.
///
/// Implementations must keep the returned descriptor and resource operations on
/// the same authenticated Provider client and preserve exact resource revisions.
pub(crate) trait ProviderResourceCatalog: Send + Sync {
    fn descriptor(&self) -> &LiveProviderDescriptor;

    fn list_resources(
        &self,
        query: ResourceListQuery,
    ) -> impl Future<Output = Result<ResourcePage, ProviderError>> + Send;

    fn read_manifest(
        &self,
        resource: ResourceRef,
    ) -> impl Future<Output = Result<ResourceManifest, ProviderError>> + Send;
}

/// Creates an authenticated catalog session from server-resolved authority.
///
/// Implementations validate the live descriptor while connecting and must not
/// accept client-selected endpoints, credentials, owners, or authorization scopes.
pub(crate) trait ProviderResourceCatalogFactory: Send + Sync {
    type Catalog: ProviderResourceCatalog;

    fn connect_catalog(
        &self,
        request: ProviderDescriptorReadRequest,
    ) -> impl Future<Output = Result<Self::Catalog, ProviderDescriptorReadError>> + Send;
}
