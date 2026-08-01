use super::*;
use crate::platform_control::ConnectionRequestIdentity;
use crate::transport::ConnectionOrigin;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_core::context::ContextAudienceKind;
use pretty_assertions::assert_eq;

#[test]
fn server_identity_and_workspace_binding_define_audience_without_paths() {
    let identity = identity();
    let conversation = workspace(WorkspaceScope::Conversation, "binding-conversation");
    let office = workspace(WorkspaceScope::Office, "binding-office");

    let single = build(
        &identity,
        &conversation,
        ContextConsumer::Single,
        ContextSourceKind::Application,
        ContextTrust::TrustedApplication,
    )
    .expect("single context");
    let experts = build(
        &identity,
        &conversation,
        ContextConsumer::Experts,
        ContextSourceKind::User,
        ContextTrust::UntrustedData,
    )
    .expect("experts context");
    let office_shared = build(
        &identity,
        &office,
        ContextConsumer::OfficeShared,
        ContextSourceKind::Memory,
        ContextTrust::UntrustedData,
    )
    .expect("office context");
    let office_private = build_context_fragment(
        &identity,
        &office,
        ContextConsumer::OfficeMemberPrivate {
            member_id: "member-1".to_string(),
        },
        input(ContextSourceKind::Tool, ContextTrust::UntrustedData),
        /*now*/ 10,
    )
    .expect("member context");

    assert_eq!(single.audience().kind(), ContextAudienceKind::Single);
    assert_eq!(experts.audience().kind(), ContextAudienceKind::Experts);
    assert_eq!(
        office_shared.audience().kind(),
        ContextAudienceKind::OfficeShared
    );
    assert_eq!(
        office_private.audience().kind(),
        ContextAudienceKind::OfficeMemberPrivate
    );
    assert_eq!(office_private.audience().member_id(), Some("member-1"));
    assert_eq!(
        single.audience().workspace_binding_id(),
        "binding-conversation"
    );
    assert_eq!(
        office_shared.audience().workspace_binding_id(),
        "binding-office"
    );
}

#[test]
fn workspace_scope_and_data_source_trust_fail_closed() {
    let identity = identity();
    let conversation = workspace(WorkspaceScope::Conversation, "binding-conversation");
    assert_eq!(
        build(
            &identity,
            &conversation,
            ContextConsumer::OfficeShared,
            ContextSourceKind::Application,
            ContextTrust::TrustedApplication,
        ),
        Err(ContextAdapterError::WorkspaceScopeMismatch)
    );
    assert_eq!(
        build(
            &identity,
            &conversation,
            ContextConsumer::Single,
            ContextSourceKind::Provider,
            ContextTrust::TrustedApplication,
        ),
        Err(ContextAdapterError::InvalidContext(
            GovernedContextError::InvalidTrustForSource
        ))
    );
}

fn build(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    consumer: ContextConsumer,
    source_kind: ContextSourceKind,
    trust: ContextTrust,
) -> Result<GovernedContextFragment, ContextAdapterError> {
    build_context_fragment(
        identity,
        workspace,
        consumer,
        input(source_kind, trust),
        /*now*/ 10,
    )
}

fn input(source_kind: ContextSourceKind, trust: ContextTrust) -> ContextFragmentInput {
    ContextFragmentInput {
        fragment_id: "fragment-1".to_string(),
        source_kind,
        source_id: "source-1".to_string(),
        trust,
        sensitivity: ContextSensitivity::Internal,
        purpose: ContextPurpose::Coordination,
        budget: ContextBudget::new(/*token_cap*/ 256).expect("budget"),
        freshness: ContextFreshness::current(/*observed_at*/ 10).expect("freshness"),
        content: "bounded context".to_string(),
    }
}

fn workspace(scope: WorkspaceScope, binding_id: &str) -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: "workspace-1".to_string(),
        binding_id: binding_id.to_string(),
        scope,
        scope_id: "scope-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}

fn identity() -> RequestIdentity {
    ConnectionRequestIdentity::new(ConnectionOrigin::Stdio).derive(
        RequestIdentityClientRef {
            name: "test".to_string(),
            version: "1".to_string(),
            capabilities: RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "trace-1".to_string(),
    )
}
