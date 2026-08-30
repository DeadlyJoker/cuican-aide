use crewon_resource_federation::BindingMode;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceKind;
use pretty_assertions::assert_eq;
use serde_json::Value;

use super::*;
use crate::AgentPlatformCapability;
use crate::AgentPlatformProviderError;
use crate::ProviderDynamicOperation;
use crate::ProviderDynamicSideEffect;
use crate::wire::ProviderDescriptorWire;

const DYNAMIC_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_dynamic_execution.v3.json");

#[test]
fn dynamic_discovery_fixture_round_trips_and_maps_exact_capabilities() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");
    let descriptor: ProviderDescriptorWire =
        serde_json::from_value(fixture["descriptor"].clone()).expect("descriptor");
    let descriptor = descriptor.validate().expect("dynamic descriptor");

    assert!(descriptor.supports(AgentPlatformCapability::RemoteTool));
    assert!(descriptor.supports(AgentPlatformCapability::RemoteKnowledge));
    for capability in [
        Capability {
            resource_kind: ResourceKind::McpTool,
            binding_mode: BindingMode::RemoteReference,
            execution_location: ExecutionLocation::Provider,
        },
        Capability {
            resource_kind: ResourceKind::KnowledgeBase,
            binding_mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
        },
    ] {
        assert!(descriptor.resource_capabilities().contains(&capability));
    }

    let commands = fixture["commands"].as_array().expect("commands");
    for command in commands {
        let wire: ReadDynamicResourceCommand =
            serde_json::from_value(command.clone()).expect("command");
        assert_eq!(serde_json::to_value(wire).expect("serialize"), *command);
    }
}

#[test]
fn dynamic_manifests_are_bounded_exact_and_redacted() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");
    let manifests = fixture["manifests"].as_array().expect("manifests");
    let provider = provider();

    let tool: DynamicResourceManifestWire =
        serde_json::from_value(manifests[0].clone()).expect("tool manifest");
    let tool = tool.into_domain(&provider).expect("tool domain");
    assert_eq!(tool.resource().kind, ResourceKind::McpTool);
    assert_eq!(tool.operation(), ProviderDynamicOperation::Call);
    assert_eq!(tool.side_effect(), ProviderDynamicSideEffect::ExternalWrite);
    assert_eq!(tool.input_schema()["type"], "object");
    assert!(!format!("{tool:?}").contains("Create one bounded"));

    let knowledge: DynamicResourceManifestWire =
        serde_json::from_value(manifests[1].clone()).expect("knowledge manifest");
    let knowledge = knowledge.into_domain(&provider).expect("knowledge domain");
    assert_eq!(knowledge.resource().kind, ResourceKind::KnowledgeBase);
    assert_eq!(knowledge.operation(), ProviderDynamicOperation::Search);
    assert_eq!(knowledge.side_effect(), ProviderDynamicSideEffect::ReadOnly);
}

#[test]
fn dynamic_discovery_rejects_capability_drift_and_unsafe_manifests() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");

    let mut missing_resource = fixture["descriptor"].clone();
    missing_resource["resourceCapabilities"]
        .as_array_mut()
        .expect("resource capabilities")
        .retain(|capability| capability["resourceType"] != "mcpTool");
    let descriptor: ProviderDescriptorWire =
        serde_json::from_value(missing_resource).expect("known descriptor fields");
    assert_eq!(
        descriptor.validate(),
        Err(AgentPlatformProviderError::Incompatible)
    );

    let mut knowledge_write = fixture["manifests"][1].clone();
    knowledge_write["sideEffect"] = Value::String("externalWrite".to_string());
    let manifest: DynamicResourceManifestWire =
        serde_json::from_value(knowledge_write).expect("known side effect");
    assert_eq!(
        manifest.into_domain(&provider()),
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let mut oversized = fixture["manifests"][0].clone();
    oversized["inputSchema"] = serde_json::json!({ "padding": "x".repeat(17 * 1024) });
    let manifest: DynamicResourceManifestWire =
        serde_json::from_value(oversized).expect("bounded at domain boundary");
    assert_eq!(
        manifest.into_domain(&provider()),
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let mut digest_drift = fixture["manifests"][0].clone();
    digest_drift["inputSchema"]["properties"]["title"]["maxLength"] = serde_json::json!(201);
    let manifest: DynamicResourceManifestWire =
        serde_json::from_value(digest_drift).expect("known schema");
    assert_eq!(
        manifest.into_domain(&provider()),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

fn provider() -> ProviderRef {
    ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
    }
}
