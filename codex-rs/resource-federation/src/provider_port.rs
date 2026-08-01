use crate::BoundedVec;
use crate::ModelError;
use crate::PageCursor;
use crate::ProviderRef;
use crate::ResourceKind;
use crate::ResourceManifest;
use crate::ResourceRef;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;

/// Maximum number of versioned resource references in one catalog page.
pub const MAX_RESOURCE_PAGE_ITEMS: usize = 100;

/// Validated catalog page size in the inclusive range 1 through 100.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct PageLimit(u16);

impl PageLimit {
    /// Creates a bounded catalog page size.
    pub fn new(value: u16) -> Result<Self, ModelError> {
        if value == 0 || usize::from(value) > MAX_RESOURCE_PAGE_ITEMS {
            return Err(ModelError::out_of_range("limit"));
        }
        Ok(Self(value))
    }

    /// Returns the validated numeric limit.
    pub fn get(self) -> u16 {
        self.0
    }
}

impl<'de> Deserialize<'de> for PageLimit {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u16::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Bounded, optionally filtered query for Provider resource discovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceListQuery {
    pub provider: ProviderRef,
    pub resource_kind: Option<ResourceKind>,
    pub cursor: Option<PageCursor>,
    pub limit: PageLimit,
}

impl ResourceListQuery {
    /// Starts a query without an optional kind filter or cursor.
    pub fn new(provider: ProviderRef, limit: PageLimit) -> Self {
        Self {
            provider,
            resource_kind: None,
            cursor: None,
            limit,
        }
    }

    /// Adds an exact core resource kind filter.
    pub fn for_kind(mut self, resource_kind: ResourceKind) -> Self {
        self.resource_kind = Some(resource_kind);
        self
    }

    /// Continues discovery after an opaque Provider cursor.
    pub fn after(mut self, cursor: PageCursor) -> Self {
        self.cursor = Some(cursor);
        self
    }
}

/// Bounded page of exact versioned resource references.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ResourcePage {
    pub(crate) resources: Vec<ResourceRef>,
    pub(crate) next_cursor: Option<PageCursor>,
}

impl ResourcePage {
    /// Builds a final page while enforcing the Provider response item cap.
    pub fn complete(resources: Vec<ResourceRef>) -> Result<Self, ModelError> {
        Self::from_parts(resources, None)
    }

    /// Builds a continued page with an opaque Provider cursor.
    pub fn continued(
        resources: Vec<ResourceRef>,
        next_cursor: PageCursor,
    ) -> Result<Self, ModelError> {
        Self::from_parts(resources, Some(next_cursor))
    }

    /// Returns the bounded exact resource references in this page.
    pub fn resources(&self) -> &[ResourceRef] {
        &self.resources
    }

    /// Returns the opaque continuation cursor when another page exists.
    pub fn next_cursor(&self) -> Option<&PageCursor> {
        self.next_cursor.as_ref()
    }

    fn from_parts(
        resources: Vec<ResourceRef>,
        next_cursor: Option<PageCursor>,
    ) -> Result<Self, ModelError> {
        if resources.len() > MAX_RESOURCE_PAGE_ITEMS {
            return Err(ModelError::too_many_items("resources"));
        }
        Ok(Self {
            resources,
            next_cursor,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourcePageWire {
    resources: BoundedVec<ResourceRef, MAX_RESOURCE_PAGE_ITEMS>,
    next_cursor: Option<PageCursor>,
}

impl<'de> Deserialize<'de> for ResourcePage {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ResourcePageWire::deserialize(deserializer)?;
        Self::from_parts(wire.resources.into_inner(), wire.next_cursor).map_err(de::Error::custom)
    }
}

/// Safe error categories returned by a catalog Provider adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderError {
    Unauthorized,
    NotFound,
    Unavailable,
    Incompatible,
    InvalidResponse,
}

/// Adapter port for discovering and reading exact versioned resource manifests.
///
/// Implementations must preserve exact revisions, enforce their authentication
/// and endpoint policies outside this crate, and fail instead of substituting a
/// latest or compatible revision.
pub trait CatalogProvider {
    /// Lists a bounded page of exact versioned references.
    fn list_resources(
        &self,
        query: ResourceListQuery,
    ) -> impl std::future::Future<Output = Result<ResourcePage, ProviderError>> + Send;

    /// Reads the manifest for the exact supplied resource revision.
    fn read_manifest(
        &self,
        resource: ResourceRef,
    ) -> impl std::future::Future<Output = Result<ResourceManifest, ProviderError>> + Send;
}
