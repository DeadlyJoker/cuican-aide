use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use pretty_assertions::assert_eq;
use serde_json::Value;

use super::*;
use crate::ProviderDynamicAuthorizationBinding;

const DYNAMIC_FIXTURE: &str =
    include_str!("../../app-server-protocol/schema/canonical/provider_dynamic_execution.v3.json");

#[test]
fn dynamic_execution_command_and_closed_outcomes_round_trip() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");
    let request = request(ResourceKind::McpTool);
    let command = ExecuteDynamicCommandWire::from_domain(&request).expect("command");
    assert_eq!(
        serde_json::to_value(command).expect("serialize command"),
        fixture["executeCommands"][0]
    );

    let responses = fixture["executeResponses"]
        .as_array()
        .expect("execute responses");
    let outcomes = responses
        .iter()
        .map(|response| {
            let wire: ExecuteDynamicResponseWire =
                serde_json::from_value(response.clone()).expect("response wire");
            assert_eq!(serde_json::to_value(&wire).expect("serialize"), *response);
            wire.into_domain(&request).expect("response domain")
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        &outcomes[0],
        ProviderDynamicExecutionOutcome::Succeeded(success)
            if success.result().inline_items().is_some()
    ));
    assert!(matches!(
        &outcomes[1],
        ProviderDynamicExecutionOutcome::Succeeded(success)
            if success.result().artifact().is_some()
    ));
    assert_eq!(
        outcomes[2],
        ProviderDynamicExecutionOutcome::Failed(ProviderDynamicExecutionFailure::Rejected)
    );
    assert_eq!(
        outcomes[3],
        ProviderDynamicExecutionOutcome::Unknown(ProviderDynamicExecutionUnknown::UnknownOutcome)
    );
}

#[test]
fn dynamic_execution_response_rejects_identity_drift_unknown_fields_and_oversize() {
    let fixture: Value = serde_json::from_str(DYNAMIC_FIXTURE).expect("dynamic fixture");
    let request = request(ResourceKind::McpTool);

    let mut drift = fixture["executeResponses"][0].clone();
    drift["callId"] = Value::String("another-call".to_string());
    let drift: ExecuteDynamicResponseWire = serde_json::from_value(drift).expect("known response");
    assert_eq!(
        drift.into_domain(&request),
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let mut unknown = fixture["executeResponses"][0].clone();
    unknown["providerMessage"] = Value::String("must not cross boundary".to_string());
    assert!(serde_json::from_value::<ExecuteDynamicResponseWire>(unknown).is_err());

    let mut oversized = fixture["executeResponses"][0].clone();
    oversized["result"]["items"] = serde_json::json!(["x".repeat(17 * 1024)]);
    let oversized: ExecuteDynamicResponseWire =
        serde_json::from_value(oversized).expect("bounded at domain boundary");
    assert_eq!(
        oversized.into_domain(&request),
        Err(AgentPlatformProviderError::InvalidResponse)
    );

    let mut digest_drift = fixture["executeResponses"][0].clone();
    digest_drift["result"]["items"] = serde_json::json!(["different result"]);
    let digest_drift: ExecuteDynamicResponseWire =
        serde_json::from_value(digest_drift).expect("known response");
    assert_eq!(
        digest_drift.into_domain(&request),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

fn request(kind: ResourceKind) -> ProviderDynamicExecutionRequest {
    let resource_id = match kind {
        ResourceKind::McpTool => "tool-demo",
        ResourceKind::KnowledgeBase => "knowledge-demo",
        _ => panic!("unsupported test kind"),
    };
    let revision = match kind {
        ResourceKind::McpTool => "tool-version:3",
        ResourceKind::KnowledgeBase => "knowledge-version:5",
        _ => panic!("unsupported test kind"),
    };
    ProviderDynamicExecutionRequest::new(
        ProviderDynamicAuthorizationBinding::new(
            ResourceRef {
                provider: ProviderRef {
                    provider_id: ProviderId::new("agent-platform").expect("provider id"),
                    protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
                },
                kind,
                resource_id: ResourceId::new(resource_id).expect("resource id"),
                revision: ResourceRevision::new(revision).expect("revision"),
            },
            "tool-call-001",
            format!("sha256:{}", "f".repeat(64)),
            "credential-demo",
            /*credential_revision*/ 7,
        )
        .expect("authorization binding"),
        "command-tool-call-001",
        serde_json::json!({"title": "Ship the bounded result"}),
    )
    .expect("execution request")
}
