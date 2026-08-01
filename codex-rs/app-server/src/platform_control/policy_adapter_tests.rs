use super::*;
use crate::platform_control::ConnectionRequestIdentity;
use crate::transport::ConnectionOrigin;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_policy::ActionTargetId;
use crewon_policy::PolicyDecision;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceRevision;
use serde_json::json;

#[test]
fn adapter_uses_server_identity_and_resolved_workspace_not_declared_client_metadata() {
    let identity = identity();
    let workspace = workspace("workspace-1", "binding-1");
    let action = build_action_intent(&identity, &workspace, input(SideEffect::ExternalWrite))
        .expect("build server action");
    let canonical = action.canonical_json().expect("canonical action");

    assert!(canonical.contains(identity.reference().actor_id.as_str()));
    assert!(canonical.contains("\"workspaceKey\":\"workspace-1\""));
    assert!(canonical.contains("\"bindingId\":\"binding-1\""));
    assert!(canonical.contains("\"scope\":\"office\""));
    assert!(!canonical.contains("untrusted-client-name"));
    assert!(!canonical.contains("\"sessionId\""));
    assert!(!canonical.contains("\"traceId\""));
}

#[test]
fn adapter_fails_closed_for_invalid_workspace_and_preserves_policy_outcome() {
    let identity = identity();
    assert!(matches!(
        build_action_intent(
            &identity,
            &workspace("workspace-1", "../../escape"),
            input(SideEffect::ReadOnly),
        ),
        Err(PolicyAdapterError::PolicyModel(_))
    ));

    let allow = evaluate_action(
        &identity,
        &workspace("workspace-1", "binding-1"),
        AccessDecisionId::new("decision-allow").expect("decision id"),
        input(SideEffect::ReadOnly),
        /*now*/ 10,
    )
    .expect("allow decision");
    let approval = evaluate_action(
        &identity,
        &workspace("workspace-1", "binding-1"),
        AccessDecisionId::new("decision-approval").expect("decision id"),
        input(SideEffect::Publish),
        /*now*/ 10,
    )
    .expect("approval decision");

    assert!(matches!(allow, PolicyDecision::Allow(_)));
    assert!(matches!(approval, PolicyDecision::ApprovalRequired(_)));
    assert!(allow.execution_authorization().is_some());
    assert!(approval.execution_authorization().is_none());
}

fn identity() -> RequestIdentity {
    ConnectionRequestIdentity::new(ConnectionOrigin::Stdio).derive(
        RequestIdentityClientRef {
            name: "untrusted-client-name".to_string(),
            version: "999".to_string(),
            capabilities: RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "trace-1".to_string(),
    )
}

fn workspace(workspace_key: &str, binding_id: &str) -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: workspace_key.to_string(),
        binding_id: binding_id.to_string(),
        scope: WorkspaceScope::Office,
        scope_id: "office-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "environment-1".to_string(),
    }
}

fn input(side_effect: SideEffect) -> ResolvedPolicyActionInput {
    ResolvedPolicyActionInput {
        action_type: ActionType::ToolCall,
        purpose: ActionPurpose::new("release.publish").expect("purpose"),
        target: ActionTarget::tool(
            ProviderRef {
                provider_id: ProviderId::new("provider-1").expect("provider"),
                protocol_version: ProviderProtocolVersion::new("1").expect("protocol version"),
            },
            ActionTargetId::new("tool-1").expect("tool id"),
            ResourceRevision::new("rev-1").expect("revision"),
        ),
        arguments: json!({"path": "dist/app.tar"}),
        credential: CredentialBinding::None,
        execution_location: ExecutionLocation::Provider,
        side_effect,
        expires_at: 100,
        nonce: ActionNonce::new("nonce-1").expect("nonce"),
    }
}
