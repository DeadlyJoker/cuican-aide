use crewon_app_server_protocol::ExecutionLocation as ProtocolExecutionLocation;
use crewon_app_server_protocol::ProviderCapabilityKind;
use crewon_app_server_protocol::ProviderConnectionProjection;
use crewon_app_server_protocol::ProviderConnectionStatus;
use crewon_app_server_protocol::ProviderKind;
use crewon_app_server_protocol::ResourceBindingCapability;
use crewon_app_server_protocol::ResourceBindingMode;
use crewon_app_server_protocol::ResourceType;
use crewon_provider_agent_platform::AgentPlatformCapability;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ResourceKind;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use super::provider_connection_processor::ProviderConnectionView;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";
const PROJECTION_SCHEMA_VERSION: &str = "crewon.provider-connection-projection.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderConnectionProjectionError {
    #[error("Provider connection view is invalid")]
    InvalidView,
    #[error("Provider connection descriptor is incompatible")]
    Incompatible,
}

pub(crate) fn project_provider_connection(
    view: &ProviderConnectionView,
) -> Result<ProviderConnectionProjection, ProviderConnectionProjectionError> {
    let connection = view.connection();
    connection
        .validate()
        .map_err(|_| ProviderConnectionProjectionError::InvalidView)?;
    if view.observed_at() < connection.created_at {
        return Err(ProviderConnectionProjectionError::InvalidView);
    }
    let descriptor = view.descriptor();
    if connection.provider_id != AGENT_PLATFORM_PROVIDER_ID
        || descriptor.provider().provider_id.as_str() != connection.provider_id
        || descriptor.provider().protocol_version.as_str() != connection.protocol_version
    {
        return Err(ProviderConnectionProjectionError::Incompatible);
    }

    let capabilities = descriptor
        .capabilities()
        .iter()
        .copied()
        .map(map_provider_capability)
        .collect::<Result<Vec<_>, _>>()?;
    let resource_capabilities = descriptor
        .resource_capabilities()
        .iter()
        .map(|capability| ResourceBindingCapability {
            resource_type: map_resource_type(capability.resource_kind),
            mode: map_binding_mode(capability.binding_mode),
            execution_location: map_execution_location(capability.execution_location),
        })
        .collect::<Vec<_>>();
    let kind = ProviderKind::AgentPlatform;
    let status = ProviderConnectionStatus::Connected;
    let projection_etag = projection_etag(&ProjectionEtagMaterial {
        schema_version: PROJECTION_SCHEMA_VERSION,
        connection_id: &connection.connection_id,
        provider_id: &connection.provider_id,
        kind,
        protocol_version: &connection.protocol_version,
        status,
        capabilities: &capabilities,
        resource_capabilities: &resource_capabilities,
    })?;

    Ok(ProviderConnectionProjection {
        connection_id: connection.connection_id.clone(),
        provider_id: connection.provider_id.clone(),
        kind,
        protocol_version: connection.protocol_version.clone(),
        status,
        capabilities,
        resource_capabilities,
        projection_etag,
        observed_at: view.observed_at(),
    })
}

fn map_provider_capability(
    capability: AgentPlatformCapability,
) -> Result<ProviderCapabilityKind, ProviderConnectionProjectionError> {
    match capability {
        AgentPlatformCapability::Approval => Ok(ProviderCapabilityKind::Approval),
        AgentPlatformCapability::DurableRun => Ok(ProviderCapabilityKind::DurableRun),
        AgentPlatformCapability::PersistentConversation => {
            Ok(ProviderCapabilityKind::PersistentConversation)
        }
        AgentPlatformCapability::RemoteAgent => Ok(ProviderCapabilityKind::RemoteAgent),
        AgentPlatformCapability::RemoteKnowledge => Ok(ProviderCapabilityKind::RemoteKnowledge),
        AgentPlatformCapability::RemoteTool => Ok(ProviderCapabilityKind::RemoteTool),
        AgentPlatformCapability::ResumableEvents => Ok(ProviderCapabilityKind::ResumableEvents),
        AgentPlatformCapability::ToolResult => Ok(ProviderCapabilityKind::ToolResult),
        _ => Err(ProviderConnectionProjectionError::Incompatible),
    }
}

pub(super) fn map_resource_type(resource_kind: ResourceKind) -> ResourceType {
    match resource_kind {
        ResourceKind::Agent => ResourceType::Agent,
        ResourceKind::Skill => ResourceType::Skill,
        ResourceKind::McpServer => ResourceType::McpServer,
        ResourceKind::McpTool => ResourceType::McpTool,
        ResourceKind::KnowledgeBase => ResourceType::KnowledgeBase,
        ResourceKind::Workflow => ResourceType::Workflow,
    }
}

fn map_binding_mode(binding_mode: BindingMode) -> ResourceBindingMode {
    match binding_mode {
        BindingMode::RemoteReference => ResourceBindingMode::RemoteReference,
        BindingMode::LocalSnapshot => ResourceBindingMode::LocalSnapshot,
        BindingMode::LocalFork => ResourceBindingMode::LocalFork,
        BindingMode::ProviderManaged => ResourceBindingMode::ProviderManaged,
    }
}

fn map_execution_location(execution_location: ExecutionLocation) -> ProtocolExecutionLocation {
    match execution_location {
        ExecutionLocation::LocalNode => ProtocolExecutionLocation::LocalNode,
        ExecutionLocation::Provider => ProtocolExecutionLocation::Provider,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionEtagMaterial<'a> {
    schema_version: &'static str,
    connection_id: &'a str,
    provider_id: &'a str,
    kind: ProviderKind,
    protocol_version: &'a str,
    status: ProviderConnectionStatus,
    capabilities: &'a [ProviderCapabilityKind],
    resource_capabilities: &'a [ResourceBindingCapability],
}

fn projection_etag(
    material: &ProjectionEtagMaterial<'_>,
) -> Result<String, ProviderConnectionProjectionError> {
    let canonical =
        serde_json::to_vec(material).map_err(|_| ProviderConnectionProjectionError::InvalidView)?;
    let mut digest = Sha256::new();
    digest.update(PROJECTION_SCHEMA_VERSION.as_bytes());
    digest.update((canonical.len() as u64).to_be_bytes());
    digest.update(canonical);
    Ok(format!("sha256:{:x}", digest.finalize()))
}
