#![allow(
    clippy::expect_used,
    reason = "integration-test setup uses expect for precise fixture failures"
)]

use crewon_policy::ActionCredentialRef;
use crewon_policy::ActionIntent;
use crewon_policy::ActionIntentSpec;
use crewon_policy::ActionNonce;
use crewon_policy::ActionPurpose;
use crewon_policy::ActionTarget;
use crewon_policy::ActionTargetId;
use crewon_policy::ActionType;
use crewon_policy::ActionWorkspace;
use crewon_policy::CredentialBinding;
use crewon_policy::CredentialState;
use crewon_policy::PolicyActor;
use crewon_policy::PolicyModelErrorKind;
use crewon_policy::SideEffect;
use crewon_policy::WorkspaceScopeKind;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use pretty_assertions::assert_eq;
use serde_json::json;

#[test]
fn action_digest_matches_stable_canonical_fixture() {
    let action = action(base_spec());
    assert_eq!(
        action.canonical_json().expect("canonical action"),
        include_str!("fixtures/action_digest.v1.canonical.json").trim()
    );
    assert_eq!(
        action.digest().expect("action digest").as_str(),
        include_str!("fixtures/action_digest.v1.sha256").trim()
    );
}

#[test]
fn every_bound_field_mutation_invalidates_the_digest() {
    let baseline = action(base_spec()).digest().expect("baseline digest");
    let mut mutations = Vec::new();

    let mut spec = base_spec();
    spec.action_type = ActionType::ProviderRun;
    spec.target = ActionTarget::provider(
        provider("provider-1", "1"),
        ActionTargetId::new("run.start").expect("operation id"),
    );
    mutations.push(("actionType", action(spec)));

    let mut spec = base_spec();
    spec.actor = PolicyActor::space_user("actor-2", "tenant-1", "space-1").expect("mutated actor");
    mutations.push(("actor", action(spec)));

    let mut spec = base_spec();
    spec.actor = PolicyActor::space_user("actor-1", "tenant-2", "space-1").expect("mutated tenant");
    mutations.push(("tenant", action(spec)));

    let mut spec = base_spec();
    spec.actor = PolicyActor::space_user("actor-1", "tenant-1", "space-2").expect("mutated space");
    mutations.push(("space", action(spec)));

    let mut spec = base_spec();
    spec.purpose = ActionPurpose::new("release.verify").expect("mutated purpose");
    mutations.push(("purpose", action(spec)));

    let mut spec = base_spec();
    spec.workspace = workspace("workspace-2", "binding-1", "office-1");
    mutations.push(("workspaceKey", action(spec)));

    let mut spec = base_spec();
    spec.workspace = workspace("workspace-1", "binding-2", "office-1");
    mutations.push(("workspaceBinding", action(spec)));

    let mut spec = base_spec();
    spec.workspace = workspace_with(
        "workspace-1",
        "binding-1",
        WorkspaceScopeKind::Workflow,
        "office-1",
        "node-1",
        "environment-1",
    );
    mutations.push(("workspaceScopeKind", action(spec)));

    let mut spec = base_spec();
    spec.workspace = workspace("workspace-1", "binding-1", "office-2");
    mutations.push(("workspaceScopeId", action(spec)));

    let mut spec = base_spec();
    spec.workspace = workspace_with(
        "workspace-1",
        "binding-1",
        WorkspaceScopeKind::Office,
        "office-1",
        "node-2",
        "environment-1",
    );
    mutations.push(("workspaceNode", action(spec)));

    let mut spec = base_spec();
    spec.workspace = workspace_with(
        "workspace-1",
        "binding-1",
        WorkspaceScopeKind::Office,
        "office-1",
        "node-1",
        "environment-2",
    );
    mutations.push(("workspaceEnvironment", action(spec)));

    let mut spec = base_spec();
    spec.target = tool_target("tool-2", "tool-rev-1");
    mutations.push(("targetIdentity", action(spec)));

    let mut spec = base_spec();
    spec.target = tool_target("tool-1", "tool-rev-2");
    mutations.push(("targetRevision", action(spec)));

    let mut spec = base_spec();
    spec.target = tool_target_with_provider("provider-1", "2", "tool-1", "tool-rev-1");
    mutations.push(("providerProtocolRevision", action(spec)));

    let mut spec = base_spec();
    spec.arguments = json!({"path": "dist/app-v2.tar", "force": false});
    mutations.push(("arguments", action(spec)));

    let mut spec = base_spec();
    spec.credential = credential("cred-2", /*revision*/ 7, CredentialState::Available);
    mutations.push(("credentialId", action(spec)));

    let mut spec = base_spec();
    spec.credential = credential("cred-1", /*revision*/ 8, CredentialState::Available);
    mutations.push(("credentialRevision", action(spec)));

    let mut spec = base_spec();
    spec.credential = credential("cred-1", /*revision*/ 7, CredentialState::Revoked);
    mutations.push(("credentialStatus", action(spec)));

    let mut spec = base_spec();
    spec.credential = credential_with_expiry(
        "cred-1",
        /*revision*/ 7,
        CredentialState::Available,
        crewon_policy::CredentialExpiry::At(1_800),
    );
    mutations.push(("credentialExpiry", action(spec)));

    let mut spec = base_spec();
    spec.credential = CredentialBinding::None;
    mutations.push(("credentialBinding", action(spec)));

    let mut spec = base_spec();
    spec.execution_location = ExecutionLocation::LocalNode;
    mutations.push(("executionLocation", action(spec)));

    let mut spec = base_spec();
    spec.side_effect = SideEffect::Destructive;
    mutations.push(("sideEffect", action(spec)));

    let mut spec = base_spec();
    spec.expires_at = 2_000;
    mutations.push(("expiry", action(spec)));

    let mut spec = base_spec();
    spec.nonce = ActionNonce::new("nonce-2").expect("mutated nonce");
    mutations.push(("nonce", action(spec)));

    for (field, mutation) in mutations {
        assert_ne!(
            mutation.digest().expect("mutated digest"),
            baseline,
            "mutation of {field} must invalidate approval"
        );
    }
}

#[test]
fn invalid_semantic_combinations_and_unbounded_arguments_fail_closed() {
    let mut mismatched_target = base_spec();
    mismatched_target.action_type = ActionType::ProviderRun;
    assert_eq!(
        ActionIntent::new(mismatched_target)
            .expect_err("action type and target must agree")
            .field(),
        "target"
    );

    let mut mismatched_credential = base_spec();
    mismatched_credential.credential = CredentialBinding::Reference(
        ActionCredentialRef::new(
            "cred-1",
            ProviderId::new("provider-2").expect("other provider"),
            CredentialState::Available,
            /*revision*/ 7,
            crewon_policy::CredentialExpiry::At(1_900),
        )
        .expect("other credential"),
    );
    assert_eq!(
        ActionIntent::new(mismatched_credential)
            .expect_err("credential must belong to target provider")
            .field(),
        "credential.providerId"
    );

    let mut first_provider = base_spec();
    first_provider.credential = CredentialBinding::None;
    let mut second_provider = first_provider.clone();
    second_provider.target = tool_target_with_provider("provider-2", "1", "tool-1", "tool-rev-1");
    assert_ne!(
        action(first_provider)
            .digest()
            .expect("first provider digest"),
        action(second_provider)
            .digest()
            .expect("second provider digest")
    );

    let mut oversized = base_spec();
    oversized.arguments = json!({"payload": "x".repeat(300_000)});
    assert_eq!(
        ActionIntent::new(oversized)
            .expect_err("arguments must be bounded")
            .kind(),
        PolicyModelErrorKind::LimitExceeded
    );
}

#[test]
fn arguments_hash_is_canonical_but_preserves_json_value_and_array_semantics() {
    let mut first = base_spec();
    first.arguments =
        serde_json::from_str(r#"{"z":3,"nested":{"b":2,"a":1},"steps":["build","publish"]}"#)
            .expect("first arguments");
    let mut reordered = base_spec();
    reordered.arguments =
        serde_json::from_str(r#"{"steps":["build","publish"],"nested":{"a":1,"b":2},"z":3}"#)
            .expect("reordered arguments");
    let mut changed_value = base_spec();
    changed_value.arguments = json!({
        "z": 4,
        "nested": {"a": 1, "b": 2},
        "steps": ["build", "publish"]
    });
    let mut changed_order = base_spec();
    changed_order.arguments = json!({
        "z": 3,
        "nested": {"a": 1, "b": 2},
        "steps": ["publish", "build"]
    });

    let first = action(first);
    let reordered = action(reordered);
    let changed_value = action(changed_value);
    let changed_order = action(changed_order);
    assert_eq!(first.arguments_hash(), reordered.arguments_hash());
    assert_ne!(first.arguments_hash(), changed_value.arguments_hash());
    assert_ne!(first.arguments_hash(), changed_order.arguments_hash());
}

fn base_spec() -> ActionIntentSpec {
    ActionIntentSpec {
        action_type: ActionType::ToolCall,
        actor: PolicyActor::space_user("actor-1", "tenant-1", "space-1").expect("actor"),
        purpose: ActionPurpose::new("release.publish").expect("purpose"),
        workspace: workspace("workspace-1", "binding-1", "office-1"),
        target: tool_target("tool-1", "tool-rev-1"),
        arguments: json!({"force": false, "path": "dist/app.tar"}),
        credential: credential("cred-1", /*revision*/ 7, CredentialState::Available),
        execution_location: ExecutionLocation::Provider,
        side_effect: SideEffect::Publish,
        expires_at: 1_500,
        nonce: ActionNonce::new("nonce-1").expect("nonce"),
    }
}

fn action(spec: ActionIntentSpec) -> ActionIntent {
    ActionIntent::new(spec).expect("valid action intent")
}

fn workspace(workspace_key: &str, binding_id: &str, scope_id: &str) -> ActionWorkspace {
    workspace_with(
        workspace_key,
        binding_id,
        WorkspaceScopeKind::Office,
        scope_id,
        "node-1",
        "environment-1",
    )
}

fn workspace_with(
    workspace_key: &str,
    binding_id: &str,
    scope: WorkspaceScopeKind,
    scope_id: &str,
    node_id: &str,
    environment_id: &str,
) -> ActionWorkspace {
    ActionWorkspace::new(
        WorkspaceKey::new(workspace_key).expect("workspace key"),
        binding_id,
        scope,
        scope_id,
        node_id,
        environment_id,
    )
    .expect("workspace")
}

fn tool_target(tool_id: &str, revision: &str) -> ActionTarget {
    tool_target_with_provider("provider-1", "1", tool_id, revision)
}

fn tool_target_with_provider(
    provider_id: &str,
    protocol_version: &str,
    tool_id: &str,
    revision: &str,
) -> ActionTarget {
    ActionTarget::tool(
        provider(provider_id, protocol_version),
        ActionTargetId::new(tool_id).expect("tool id"),
        ResourceRevision::new(revision).expect("tool revision"),
    )
}

fn provider(provider_id: &str, protocol_version: &str) -> ProviderRef {
    ProviderRef {
        provider_id: ProviderId::new(provider_id).expect("provider"),
        protocol_version: ProviderProtocolVersion::new(protocol_version).expect("protocol version"),
    }
}

fn credential(id: &str, revision: u64, status: CredentialState) -> CredentialBinding {
    credential_with_expiry(
        id,
        revision,
        status,
        crewon_policy::CredentialExpiry::At(1_900),
    )
}

fn credential_with_expiry(
    id: &str,
    revision: u64,
    status: CredentialState,
    expiry: crewon_policy::CredentialExpiry,
) -> CredentialBinding {
    CredentialBinding::Reference(
        ActionCredentialRef::new(
            id,
            ProviderId::new("provider-1").expect("provider"),
            status,
            revision,
            expiry,
        )
        .expect("credential"),
    )
}
