use crewon_app_server_protocol::ExecutionLocation as ProtocolExecutionLocation;
use crewon_app_server_protocol::ProviderCapabilityKind;
use crewon_app_server_protocol::ProviderConnectionStatus;
use crewon_app_server_protocol::ProviderKind;
use crewon_app_server_protocol::ResourceBindingMode;
use crewon_app_server_protocol::ResourceType;
use crewon_provider_agent_platform::AgentPlatformCapability;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceKind;
use crewon_state::ProviderConnectionRecord;
use pretty_assertions::assert_eq;

use super::provider_connection_descriptor::LiveProviderDescriptor;
use super::provider_connection_processor::ProviderConnectionView;
use super::provider_connection_projection::ProviderConnectionProjectionError;
use super::provider_connection_projection::project_provider_connection;

#[test]
fn projection_is_deterministic_secret_free_and_observation_time_independent() {
    let connection = connection();
    let descriptor = descriptor("3.0.0");
    let first = project_provider_connection(&ProviderConnectionView::new(
        connection.clone(),
        descriptor.clone(),
        /*observed_at*/ 150,
    ))
    .expect("first projection");
    let later = project_provider_connection(&ProviderConnectionView::new(
        connection.clone(),
        descriptor,
        /*observed_at*/ 160,
    ))
    .expect("later projection");

    assert_eq!(first.connection_id, connection.connection_id);
    assert_eq!(first.provider_id, "agent-platform");
    assert_eq!(first.kind, ProviderKind::AgentPlatform);
    assert_eq!(first.protocol_version, "3.0.0");
    assert_eq!(first.status, ProviderConnectionStatus::Connected);
    assert_eq!(
        first.capabilities,
        [
            ProviderCapabilityKind::Approval,
            ProviderCapabilityKind::DurableRun,
            ProviderCapabilityKind::PersistentConversation,
            ProviderCapabilityKind::RemoteAgent,
            ProviderCapabilityKind::RemoteKnowledge,
            ProviderCapabilityKind::RemoteTool,
            ProviderCapabilityKind::ResumableEvents,
            ProviderCapabilityKind::ToolResult,
        ]
    );
    assert_eq!(
        first
            .resource_capabilities
            .iter()
            .map(|capability| capability.resource_type)
            .collect::<Vec<_>>(),
        [
            ResourceType::Agent,
            ResourceType::Skill,
            ResourceType::McpServer,
            ResourceType::McpTool,
            ResourceType::KnowledgeBase,
            ResourceType::Workflow,
        ]
    );
    assert_eq!(
        first.resource_capabilities[0].mode,
        ResourceBindingMode::ProviderManaged
    );
    assert_eq!(
        first.resource_capabilities[0].execution_location,
        ProtocolExecutionLocation::Provider
    );
    assert_eq!(first.projection_etag, later.projection_etag);
    let reduced = project_provider_connection(&ProviderConnectionView::new(
        connection.clone(),
        minimal_descriptor("3.0.0"),
        /*observed_at*/ 160,
    ))
    .expect("reduced projection");
    assert_ne!(first.projection_etag, reduced.projection_etag);
    assert_eq!(first.observed_at, 150);
    assert_eq!(later.observed_at, 160);
    assert!(first.projection_etag.starts_with("sha256:"));
    assert_eq!(first.projection_etag.len(), 71);

    let serialized = serde_json::to_string(&first).expect("serialize projection");
    for forbidden in [
        connection.local_actor_id.as_str(),
        connection.local_tenant_id.as_str(),
        connection.local_space_id.as_str(),
        connection.credential_id.as_str(),
        "credential",
        "sourceBinding",
        "grantedScope",
        "endpoint",
        "secret",
    ] {
        assert!(!serialized.contains(forbidden));
    }
}

#[test]
fn projection_rejects_protocol_drift_and_invalid_observation_time() {
    let connection = connection();
    assert_eq!(
        project_provider_connection(&ProviderConnectionView::new(
            connection.clone(),
            descriptor("3.1.0"),
            /*observed_at*/ 150,
        ))
        .expect_err("protocol drift rejected"),
        ProviderConnectionProjectionError::Incompatible
    );
    assert_eq!(
        project_provider_connection(&ProviderConnectionView::new(
            connection,
            descriptor("3.0.0"),
            /*observed_at*/ 99,
        ))
        .expect_err("observation before connection rejected"),
        ProviderConnectionProjectionError::InvalidView
    );
}

fn connection() -> ProviderConnectionRecord {
    let mut record = ProviderConnectionRecord {
        connection_id: "provider-connection:019f7500-0000-7000-8000-000000000001".to_string(),
        local_actor_id:
            "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f".to_string(),
        local_tenant_id: "tenant-private-projection-fixture".to_string(),
        local_space_id: "space-private-projection-fixture".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        credential_id: "provider-grant:019f7400-0000-7000-8000-000000000001".to_string(),
        credential_revision: 1,
        record_hash: String::new(),
        created_at: 100,
    };
    record.record_hash = record.canonical_hash();
    record
}

fn descriptor(protocol_version: &str) -> LiveProviderDescriptor {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new(protocol_version).expect("protocol"),
    };
    let resource_capabilities = ProviderCapabilities::new(
        provider.clone(),
        [
            ResourceKind::Workflow,
            ResourceKind::Agent,
            ResourceKind::KnowledgeBase,
            ResourceKind::McpTool,
            ResourceKind::Skill,
            ResourceKind::McpServer,
        ]
        .map(|resource_kind| Capability {
            resource_kind,
            binding_mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
        }),
    )
    .expect("resource capabilities");
    LiveProviderDescriptor::new_agent_platform(
        provider,
        [
            AgentPlatformCapability::ToolResult,
            AgentPlatformCapability::DurableRun,
            AgentPlatformCapability::Approval,
            AgentPlatformCapability::RemoteAgent,
            AgentPlatformCapability::RemoteKnowledge,
            AgentPlatformCapability::RemoteTool,
            AgentPlatformCapability::PersistentConversation,
            AgentPlatformCapability::ResumableEvents,
        ],
        resource_capabilities,
    )
    .expect("live descriptor")
}

fn minimal_descriptor(protocol_version: &str) -> LiveProviderDescriptor {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new(protocol_version).expect("protocol"),
    };
    let resource_capabilities = ProviderCapabilities::new(
        provider.clone(),
        [Capability {
            resource_kind: ResourceKind::Agent,
            binding_mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
        }],
    )
    .expect("resource capabilities");
    LiveProviderDescriptor::new_agent_platform(
        provider,
        [AgentPlatformCapability::DurableRun],
        resource_capabilities,
    )
    .expect("live descriptor")
}
