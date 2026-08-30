use pretty_assertions::assert_eq;
use schemars::schema_for;
use serde_json::json;
use ts_rs::TS;

use super::ExecutionLocation;
use super::ProviderCapabilityKind;
use super::ProviderConnectParams;
use super::ProviderConnectResponse;
use super::ProviderConnectionProjection;
use super::ProviderConnectionStatus;
use super::ProviderKind;
use super::ProviderReadParams;
use super::ResourceBindParams;
use super::ResourceBindingCapability;
use super::ResourceBindingMode;
use super::ResourceListParams;
use super::ResourceReadParams;
use super::ResourceRef;
use super::ResourceType;
use super::ResourceUnbindParams;
use crate::ClientRequest;
use crate::ExperimentalApi;

#[test]
fn provider_projection_is_secret_owner_endpoint_and_path_free() {
    let response = ProviderConnectResponse {
        provider: ProviderConnectionProjection {
            connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
            provider_id: "agent-platform".to_string(),
            kind: ProviderKind::AgentPlatform,
            protocol_version: "3.0.0".to_string(),
            status: ProviderConnectionStatus::Connected,
            capabilities: vec![ProviderCapabilityKind::DurableRun],
            resource_capabilities: vec![ResourceBindingCapability {
                resource_type: ResourceType::Agent,
                mode: ResourceBindingMode::ProviderManaged,
                execution_location: ExecutionLocation::Provider,
            }],
            projection_etag:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
            observed_at: 100,
        },
    };
    let serialized = serde_json::to_string(&response).expect("serialize projection");
    for forbidden in [
        "secret", "owner", "endpoint", "rootPath", "actorId", "tenantId", "spaceId",
    ] {
        assert!(!serialized.contains(forbidden));
    }
}

#[test]
fn provider_rpc_params_and_registration_expose_only_server_resolved_references() {
    let connect = serde_json::from_value::<ProviderConnectParams>(json!({
        "providerId": "agent-platform"
    }))
    .expect("provider connect params");
    assert_eq!(connect.provider_id, "agent-platform");
    for forbidden in [
        "credentialId",
        "credentialRevision",
        "owner",
        "endpoint",
        "scope",
    ] {
        let mut forged = json!({ "providerId": "agent-platform" });
        forged
            .as_object_mut()
            .expect("connect object")
            .insert(forbidden.to_string(), json!("forged"));
        assert!(serde_json::from_value::<ProviderConnectParams>(forged).is_err());
    }

    let connect_request = serde_json::from_value::<ClientRequest>(json!({
        "method": "provider/connect",
        "id": 1,
        "params": { "providerId": "agent-platform" }
    }))
    .expect("registered provider connect");
    assert_eq!(connect_request.method(), "provider/connect");
    assert_eq!(
        connect_request.experimental_reason(),
        Some("provider/connect")
    );
    assert_eq!(connect_request.serialization_scope(), None);

    let read_request = serde_json::from_value::<ClientRequest>(json!({
        "method": "provider/read",
        "id": 2,
        "params": {
            "connectionId": "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101"
        }
    }))
    .expect("registered provider read");
    assert_eq!(read_request.method(), "provider/read");
    assert_eq!(read_request.experimental_reason(), Some("provider/read"));
    assert_eq!(read_request.serialization_scope(), None);
}

#[test]
fn resource_params_are_exact_paginated_and_do_not_accept_final_authority() {
    assert_eq!(
        serde_json::from_value::<ResourceListParams>(json!({
            "connectionId": "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101",
            "cursor": null,
            "limit": 20,
            "resourceType": "mcpTool"
        }))
        .expect("resource list params")
        .resource_type,
        Some(ResourceType::McpTool)
    );
    assert_eq!(
        serde_json::from_value::<ProviderReadParams>(json!({
            "connectionId": "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101"
        }))
        .expect("provider read params")
        .connection_id,
        "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101"
    );

    let exact_resource = json!({
        "providerId": "agent-platform",
        "resourceId": "agent-1",
        "revision": "rev-7",
        "resourceType": "agent"
    });
    let resource_read = serde_json::from_value::<ResourceReadParams>(json!({
        "connectionId": "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101",
        "resource": exact_resource
    }))
    .expect("resource read params");
    assert_eq!(resource_read.resource.revision, "rev-7");

    let list_request = serde_json::from_value::<ClientRequest>(json!({
        "method": "resource/list",
        "id": 3,
        "params": {
            "connectionId": "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101",
            "cursor": null,
            "limit": 20,
            "resourceType": "agent"
        }
    }))
    .expect("registered resource list");
    assert_eq!(list_request.method(), "resource/list");
    assert_eq!(list_request.experimental_reason(), Some("resource/list"));
    assert_eq!(list_request.serialization_scope(), None);

    let read_request = serde_json::from_value::<ClientRequest>(json!({
        "method": "resource/read",
        "id": 4,
        "params": {
            "connectionId": "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101",
            "resource": exact_resource
        }
    }))
    .expect("registered resource read");
    assert_eq!(read_request.method(), "resource/read");
    assert_eq!(read_request.experimental_reason(), Some("resource/read"));
    assert_eq!(read_request.serialization_scope(), None);

    let valid_bind = json!({
        "connectionId": "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101",
        "workspaceBindingId": "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201",
        "resource": exact_resource,
        "mode": "providerManaged"
    });
    let parsed = serde_json::from_value::<ResourceBindParams>(valid_bind.clone())
        .expect("resource bind params");
    assert_eq!(parsed.resource.resource_type, ResourceType::Agent);
    let bind_request = serde_json::from_value::<ClientRequest>(json!({
        "method": "resource/bind",
        "id": 5,
        "params": valid_bind
    }))
    .expect("registered resource bind");
    assert_eq!(bind_request.method(), "resource/bind");
    assert_eq!(bind_request.experimental_reason(), Some("resource/bind"));
    assert_eq!(bind_request.serialization_scope(), None);

    let unbind = serde_json::from_value::<ResourceUnbindParams>(json!({
        "bindingId": "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301"
    }))
    .expect("resource unbind params");
    let unbind_request = serde_json::from_value::<ClientRequest>(json!({
        "method": "resource/unbind",
        "id": 6,
        "params": { "bindingId": unbind.binding_id }
    }))
    .expect("registered resource unbind");
    assert_eq!(unbind_request.method(), "resource/unbind");
    assert_eq!(
        unbind_request.experimental_reason(),
        Some("resource/unbind")
    );
    assert_eq!(unbind_request.serialization_scope(), None);

    for (field, value) in [
        ("executionLocation", json!("localNode")),
        ("workspaceKey", json!("workspace:forged")),
        ("rootPath", json!("/forged")),
        ("owner", json!({ "actorId": "forged" })),
        ("endpoint", json!("https://evil.example")),
    ] {
        let mut forged = valid_bind.clone();
        forged
            .as_object_mut()
            .expect("object")
            .insert(field.to_string(), value);
        assert!(serde_json::from_value::<ResourceBindParams>(forged).is_err());
    }
}

#[test]
fn resource_type_preserves_exact_federation_kinds() {
    for (wire, expected) in [
        ("agent", ResourceType::Agent),
        ("skill", ResourceType::Skill),
        ("mcpServer", ResourceType::McpServer),
        ("mcpTool", ResourceType::McpTool),
        ("knowledgeBase", ResourceType::KnowledgeBase),
        ("workflow", ResourceType::Workflow),
    ] {
        assert_eq!(
            serde_json::from_value::<ResourceType>(json!(wire)).expect("exact resource type"),
            expected
        );
    }
    for lossy in ["mcp", "knowledge"] {
        assert!(serde_json::from_value::<ResourceType>(json!(lossy)).is_err());
    }

    let resource = ResourceRef {
        provider_id: "agent-platform".to_string(),
        resource_id: "tool-1".to_string(),
        revision: "rev-1".to_string(),
        resource_type: ResourceType::McpTool,
    };
    assert_eq!(
        serde_json::to_value(resource).expect("serialize exact resource")["resourceType"],
        json!("mcpTool")
    );
}

#[test]
fn provider_projection_schema_and_typescript_remain_authority_free() {
    let schema = serde_json::to_value(schema_for!(ProviderConnectionProjection))
        .expect("serialize Provider projection schema");
    let serialized_schema = schema.to_string();
    for forbidden in ["endpoint", "owner", "secret", "rootPath"] {
        assert!(!serialized_schema.contains(forbidden));
    }

    let typescript = ProviderConnectionProjection::export_to_string()
        .expect("export Provider projection TypeScript");
    assert!(typescript.contains("connectionId: string"));
    assert!(!typescript.contains("credential"));
    assert!(!typescript.contains("endpoint"));
    assert!(!typescript.contains("secret"));
}
