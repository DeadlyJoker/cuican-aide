use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use pretty_assertions::assert_eq;

use super::*;
use crate::ProviderAuthorizationError;

#[test]
fn dynamic_request_is_bounded_and_debug_redacts_arguments() {
    let request = ProviderDynamicExecutionRequest::new(
        binding(),
        "command-demo",
        serde_json::json!({"secretArgument": "must-not-leak"}),
    )
    .expect("dynamic request");

    assert_eq!(request.command_id(), "command-demo");
    assert!(!format!("{request:?}").contains("must-not-leak"));
    assert_eq!(
        ProviderDynamicExecutionRequest::new(
            binding(),
            "command-demo",
            serde_json::json!(["not", "an", "object"]),
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderDynamicExecutionRequest::new(
            binding(),
            "command-demo",
            serde_json::json!({"padding": "x".repeat(65 * 1024)}),
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
}

#[test]
fn dynamic_result_requires_bounded_inline_text_or_exact_artifact() {
    let result =
        ProviderDynamicResult::inline_text(vec!["safe result".to_string()]).expect("inline result");
    assert_eq!(
        result.inline_items(),
        Some(&["safe result".to_string()][..])
    );
    assert!(!format!("{result:?}").contains("safe result"));
    assert_eq!(
        ProviderDynamicResult::inline_text(vec!["x".repeat(17 * 1024)]),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

fn binding() -> ProviderDynamicAuthorizationBinding {
    ProviderDynamicAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind: ResourceKind::McpTool,
            resource_id: ResourceId::new("tool-demo").expect("resource id"),
            revision: ResourceRevision::new("tool-version:3").expect("revision"),
        },
        "tool-call-001",
        format!("sha256:{}", "f".repeat(64)),
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .unwrap_or_else(|error: ProviderAuthorizationError| panic!("binding: {error}"))
}
