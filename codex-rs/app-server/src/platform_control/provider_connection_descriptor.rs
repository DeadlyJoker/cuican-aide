use std::collections::BTreeSet;
use std::fmt;
use std::future::Future;

use crewon_provider_agent_platform::AgentPlatformCapability;
use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderRef;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";
const MAX_RUNTIME_CAPABILITIES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderDescriptorReadError {
    #[error("Provider descriptor authorization failed")]
    Unauthorized,
    #[error("Provider descriptor is unavailable")]
    Unavailable,
    #[error("Provider descriptor is incompatible")]
    Incompatible,
    #[error("Provider descriptor response is invalid")]
    InvalidResponse,
}

#[derive(Clone)]
pub(crate) struct ProviderDescriptorReadRequest {
    pub(crate) provider_id: String,
    pub(crate) authorization_identity: ProviderAuthorizationIdentity,
}

impl fmt::Debug for ProviderDescriptorReadRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderDescriptorReadRequest")
            .field("provider_id", &self.provider_id)
            .field("authorization_identity", &"[REDACTED]")
            .finish()
    }
}

/// Reads and validates the current Provider descriptor using server-owned authority.
pub(crate) trait ProviderDescriptorReader: Send + Sync {
    fn read_descriptor(
        &self,
        request: ProviderDescriptorReadRequest,
    ) -> impl Future<Output = Result<LiveProviderDescriptor, ProviderDescriptorReadError>> + Send;
}

/// Supplies current wall-clock seconds so authority is checked before and after Provider I/O.
pub(crate) trait ProviderConnectionClock: Send + Sync {
    fn now(&self) -> i64;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveProviderDescriptor {
    provider: ProviderRef,
    capabilities: BTreeSet<AgentPlatformCapability>,
    resource_capabilities: ProviderCapabilities,
}

impl LiveProviderDescriptor {
    pub(crate) fn new_agent_platform(
        provider: ProviderRef,
        capabilities: impl IntoIterator<Item = AgentPlatformCapability>,
        resource_capabilities: ProviderCapabilities,
    ) -> Result<Self, ProviderDescriptorReadError> {
        if provider.provider_id.as_str() != AGENT_PLATFORM_PROVIDER_ID
            || resource_capabilities.provider() != &provider
        {
            return Err(ProviderDescriptorReadError::Incompatible);
        }
        let mut bounded = BTreeSet::new();
        for (index, capability) in capabilities.into_iter().enumerate() {
            if index >= MAX_RUNTIME_CAPABILITIES || !bounded.insert(capability) {
                return Err(ProviderDescriptorReadError::InvalidResponse);
            }
        }
        if bounded.is_empty() {
            return Err(ProviderDescriptorReadError::InvalidResponse);
        }
        Ok(Self {
            provider,
            capabilities: bounded,
            resource_capabilities,
        })
    }

    pub(super) fn provider(&self) -> &ProviderRef {
        &self.provider
    }

    pub(super) fn capabilities(&self) -> &BTreeSet<AgentPlatformCapability> {
        &self.capabilities
    }

    pub(super) fn resource_capabilities(&self) -> &ProviderCapabilities {
        &self.resource_capabilities
    }
}
