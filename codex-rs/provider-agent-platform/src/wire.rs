use std::collections::BTreeSet;

use crewon_resource_federation::BindingMode;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ModelError;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use serde::Deserialize;
use serde::Serialize;

use crate::AgentPlatformProviderError;

pub(crate) const PROVIDER_ID: &str = "agent-platform";
pub(crate) const PROTOCOL_VERSION: &str = "3.0.0";
const MANIFEST_SCHEMA_VERSION: &str = "1.0.0";
const MAX_DESCRIPTOR_CAPABILITIES: usize = 8;
const MAX_RESOURCE_CAPABILITIES: usize = 8;
const MAX_RESOURCE_PAGE_ITEMS: usize = 50;
const MAX_CURSOR_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum AgentPlatformCapability {
    Approval,
    DurableRun,
    PersistentConversation,
    RemoteAgent,
    RemoteKnowledge,
    RemoteTool,
    ResumableEvents,
    ToolResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ResourceTypeWire {
    Agent,
    KnowledgeBase,
    McpTool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BindingModeWire {
    ProviderManaged,
    RemoteReference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ExecutionLocationWire {
    Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceRefWire {
    provider_id: String,
    resource_type: ResourceTypeWire,
    resource_id: String,
    revision: String,
}

impl ResourceRefWire {
    pub(crate) fn from_domain(resource: &ResourceRef) -> Result<Self, AgentPlatformProviderError> {
        if resource.provider.provider_id.as_str() != PROVIDER_ID
            || resource.provider.protocol_version.as_str() != PROTOCOL_VERSION
            || !matches!(
                resource.kind,
                ResourceKind::Agent | ResourceKind::McpTool | ResourceKind::KnowledgeBase
            )
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        Ok(Self {
            provider_id: PROVIDER_ID.to_string(),
            resource_type: ResourceTypeWire::from_domain(resource.kind)?,
            resource_id: resource.resource_id.as_str().to_string(),
            revision: resource.revision.as_str().to_string(),
        })
    }

    pub(crate) fn into_domain(
        self,
        provider: &ProviderRef,
    ) -> Result<ResourceRef, AgentPlatformProviderError> {
        if self.provider_id != PROVIDER_ID {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(ResourceRef {
            provider: provider.clone(),
            kind: self.resource_type.into_domain(),
            resource_id: ResourceId::new(self.resource_id).map_err(invalid_model)?,
            revision: ResourceRevision::new(self.revision).map_err(invalid_model)?,
        })
    }
}

impl ResourceTypeWire {
    fn from_domain(kind: ResourceKind) -> Result<Self, AgentPlatformProviderError> {
        match kind {
            ResourceKind::Agent => Ok(Self::Agent),
            ResourceKind::McpTool => Ok(Self::McpTool),
            ResourceKind::KnowledgeBase => Ok(Self::KnowledgeBase),
            ResourceKind::Skill | ResourceKind::McpServer | ResourceKind::Workflow => {
                Err(AgentPlatformProviderError::Incompatible)
            }
        }
    }

    fn into_domain(self) -> ResourceKind {
        match self {
            Self::Agent => ResourceKind::Agent,
            Self::McpTool => ResourceKind::McpTool,
            Self::KnowledgeBase => ResourceKind::KnowledgeBase,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceCapabilityWire {
    resource_type: ResourceTypeWire,
    binding_mode: BindingModeWire,
    execution_location: ExecutionLocationWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderDescriptorWire {
    provider_id: String,
    protocol_version: String,
    capabilities: Vec<AgentPlatformCapability>,
    resource_capabilities: Vec<ResourceCapabilityWire>,
}

impl ProviderDescriptorWire {
    pub(crate) fn validate(
        self,
    ) -> Result<crate::AgentPlatformProviderDescriptor, AgentPlatformProviderError> {
        if self.provider_id != PROVIDER_ID || self.protocol_version != PROTOCOL_VERSION {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        if self.capabilities.is_empty()
            || self.capabilities.len() > MAX_DESCRIPTOR_CAPABILITIES
            || self.resource_capabilities.len() > MAX_RESOURCE_CAPABILITIES
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        let capability_count = self.capabilities.len();
        let capabilities = self.capabilities.into_iter().collect::<BTreeSet<_>>();
        let baseline = BTreeSet::from([
            AgentPlatformCapability::DurableRun,
            AgentPlatformCapability::RemoteAgent,
            AgentPlatformCapability::ResumableEvents,
        ]);
        let allowed = BTreeSet::from([
            AgentPlatformCapability::DurableRun,
            AgentPlatformCapability::RemoteAgent,
            AgentPlatformCapability::RemoteKnowledge,
            AgentPlatformCapability::RemoteTool,
            AgentPlatformCapability::ResumableEvents,
        ]);
        if !baseline.is_subset(&capabilities)
            || !capabilities.is_subset(&allowed)
            || capabilities.len() != capability_count
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let expected_agent = ResourceCapabilityWire {
            resource_type: ResourceTypeWire::Agent,
            binding_mode: BindingModeWire::ProviderManaged,
            execution_location: ExecutionLocationWire::Provider,
        };
        let resource_count = self.resource_capabilities.len();
        let resource_capabilities = self
            .resource_capabilities
            .into_iter()
            .collect::<BTreeSet<_>>();
        if resource_capabilities.len() != resource_count
            || !resource_capabilities.contains(&expected_agent)
            || resource_capabilities.iter().any(|capability| {
                capability.execution_location != ExecutionLocationWire::Provider
                    || match capability.resource_type {
                        ResourceTypeWire::Agent => {
                            capability.binding_mode != BindingModeWire::ProviderManaged
                        }
                        ResourceTypeWire::McpTool | ResourceTypeWire::KnowledgeBase => !matches!(
                            capability.binding_mode,
                            BindingModeWire::RemoteReference | BindingModeWire::ProviderManaged
                        ),
                    }
            })
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let has_tool = resource_capabilities
            .iter()
            .any(|capability| capability.resource_type == ResourceTypeWire::McpTool);
        let has_knowledge = resource_capabilities
            .iter()
            .any(|capability| capability.resource_type == ResourceTypeWire::KnowledgeBase);
        if capabilities.contains(&AgentPlatformCapability::RemoteTool) != has_tool
            || capabilities.contains(&AgentPlatformCapability::RemoteKnowledge) != has_knowledge
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let provider = provider_ref()?;
        let resource_capabilities = ProviderCapabilities::new(
            provider.clone(),
            resource_capabilities
                .into_iter()
                .map(|capability| Capability {
                    resource_kind: capability.resource_type.into_domain(),
                    binding_mode: match capability.binding_mode {
                        BindingModeWire::ProviderManaged => BindingMode::ProviderManaged,
                        BindingModeWire::RemoteReference => BindingMode::RemoteReference,
                    },
                    execution_location: ExecutionLocation::Provider,
                }),
        )
        .map_err(invalid_model)?;
        Ok(crate::AgentPlatformProviderDescriptor::new(
            provider,
            capabilities,
            resource_capabilities,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderResourceManifestWire {
    resource: ResourceRefWire,
    manifest_schema_version: String,
    content_digest: String,
}

impl ProviderResourceManifestWire {
    pub(crate) fn into_domain(
        self,
        provider: &ProviderRef,
    ) -> Result<ResourceManifest, AgentPlatformProviderError> {
        if self.manifest_schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        Ok(ResourceManifest {
            resource: self.resource.into_domain(provider)?,
            schema_version: ManifestSchemaVersion::new(self.manifest_schema_version)
                .map_err(invalid_model)?,
            content_digest: Some(ContentDigest::new(self.content_digest).map_err(invalid_model)?),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderResourcePageWire {
    pub(crate) data: Vec<ProviderResourceManifestWire>,
    pub(crate) next_cursor: Option<String>,
}

impl ProviderResourcePageWire {
    pub(crate) fn validate(&self) -> Result<(), AgentPlatformProviderError> {
        if self.data.len() > MAX_RESOURCE_PAGE_ITEMS
            || self.next_cursor.as_ref().is_some_and(|cursor| {
                cursor.is_empty()
                    || cursor.len() > MAX_CURSOR_BYTES
                    || cursor.chars().any(char::is_control)
            })
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReadDescriptorCommandType {
    ReadDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadDescriptorCommand {
    #[serde(rename = "type")]
    command_type: ReadDescriptorCommandType,
    command_id: String,
}

impl ReadDescriptorCommand {
    pub(crate) fn new(command_id: String) -> Self {
        Self {
            command_type: ReadDescriptorCommandType::ReadDescriptor,
            command_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ListResourcesCommandType {
    ListResources,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListResourcesCommand {
    #[serde(rename = "type")]
    command_type: ListResourcesCommandType,
    command_id: String,
    resource_type: ResourceTypeWire,
    after_cursor: Option<String>,
    limit: u16,
}

impl ListResourcesCommand {
    pub(crate) fn new(
        command_id: String,
        resource_kind: ResourceKind,
        after_cursor: Option<String>,
        limit: u16,
    ) -> Result<Self, AgentPlatformProviderError> {
        Ok(Self {
            command_type: ListResourcesCommandType::ListResources,
            command_id,
            resource_type: ResourceTypeWire::from_domain(resource_kind)?,
            after_cursor,
            limit,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReadResourceCommandType {
    ReadResource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadResourceCommand {
    #[serde(rename = "type")]
    command_type: ReadResourceCommandType,
    command_id: String,
    resource: ResourceRefWire,
}

impl ReadResourceCommand {
    pub(crate) fn new(command_id: String, resource: ResourceRefWire) -> Self {
        Self {
            command_type: ReadResourceCommandType::ReadResource,
            command_id,
            resource,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderErrorCodeWire {
    InvalidRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    CapabilityUnsupported,
    ProviderUnavailable,
    Timeout,
    UnknownOutcome,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderErrorWire {
    pub(crate) code: ProviderErrorCodeWire,
    pub(crate) retryable: bool,
    pub(crate) provider_run_id: Option<String>,
    pub(crate) trace_id: String,
}

fn provider_ref() -> Result<ProviderRef, AgentPlatformProviderError> {
    Ok(ProviderRef {
        provider_id: ProviderId::new(PROVIDER_ID).map_err(invalid_model)?,
        protocol_version: ProviderProtocolVersion::new(PROTOCOL_VERSION).map_err(invalid_model)?,
    })
}

fn invalid_model(_error: ModelError) -> AgentPlatformProviderError {
    AgentPlatformProviderError::InvalidResponse
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
