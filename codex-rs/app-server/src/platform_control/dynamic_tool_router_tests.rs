use crewon_policy::SideEffect;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use pretty_assertions::assert_eq;
use serde_json::json;
use uuid::Uuid;

use super::dynamic_tool_router::registration::DynamicToolExecutionTarget;
use super::dynamic_tool_router::registration::DynamicToolInvocation;
use super::dynamic_tool_router::registration::DynamicToolOperation;
use super::dynamic_tool_router::registration::DynamicToolRegistration;
use super::dynamic_tool_router::registration::DynamicToolRegistry;
use super::dynamic_tool_router::registration::DynamicToolRouteError;

#[test]
fn provider_mcp_and_knowledge_bindings_have_server_owned_routes() {
    let mcp = DynamicToolRegistration::from_binding(
        binding(
            ProviderResourceKind::McpTool,
            ProviderResourceBindingMode::ProviderManaged,
        ),
        SideEffect::ExternalWrite,
    )
    .expect("Provider MCP registration");
    let knowledge = DynamicToolRegistration::from_binding(
        binding(
            ProviderResourceKind::KnowledgeBase,
            ProviderResourceBindingMode::RemoteReference,
        ),
        SideEffect::ReadOnly,
    )
    .expect("Provider Knowledge registration");

    assert_eq!(mcp.operation(), DynamicToolOperation::Call);
    assert_eq!(mcp.tool_name(), "call");
    assert_eq!(knowledge.operation(), DynamicToolOperation::Search);
    assert_eq!(knowledge.tool_name(), "search");
    assert_eq!(mcp.side_effect(), SideEffect::ExternalWrite);
    assert!(mcp.namespace().starts_with("crewon_binding_"));
    assert_eq!(mcp.namespace().len(), "crewon_binding_".len() + 32);
    assert!(matches!(
        mcp.target(),
        DynamicToolExecutionTarget::Provider { .. }
    ));
    assert!(!format!("{mcp:?}").contains("provider-grant"));
    assert_eq!(
        DynamicToolRegistration::from_binding(
            binding(
                ProviderResourceKind::KnowledgeBase,
                ProviderResourceBindingMode::ProviderManaged,
            ),
            SideEffect::ExternalWrite,
        )
        .expect_err("Knowledge search is always read-only"),
        DynamicToolRouteError::IncompatibleBinding
    );
}

#[test]
fn local_bindings_are_outside_the_provider_dynamic_router() {
    for (kind, mode) in [
        (
            ProviderResourceKind::McpTool,
            ProviderResourceBindingMode::LocalSnapshot,
        ),
        (
            ProviderResourceKind::McpTool,
            ProviderResourceBindingMode::LocalFork,
        ),
        (
            ProviderResourceKind::KnowledgeBase,
            ProviderResourceBindingMode::LocalFork,
        ),
    ] {
        assert_eq!(
            DynamicToolRegistration::from_binding(binding(kind, mode), SideEffect::ReadOnly,)
                .expect_err("local resources require a separate materialization contract"),
            DynamicToolRouteError::IncompatibleBinding
        );
    }
}

#[test]
fn unsupported_resource_kinds_fail_closed() {
    for kind in [
        ProviderResourceKind::Agent,
        ProviderResourceKind::Skill,
        ProviderResourceKind::McpServer,
        ProviderResourceKind::Workflow,
    ] {
        assert_eq!(
            DynamicToolRegistration::from_binding(
                binding(kind, ProviderResourceBindingMode::ProviderManaged),
                SideEffect::ReadOnly,
            )
            .expect_err("unsupported kind"),
            DynamicToolRouteError::IncompatibleBinding
        );
    }
}

#[test]
fn registry_rejects_conflicts_unknown_tools_and_binding_drift() {
    let record = binding(
        ProviderResourceKind::McpTool,
        ProviderResourceBindingMode::ProviderManaged,
    );
    let registration = DynamicToolRegistration::from_binding(record.clone(), SideEffect::ReadOnly)
        .expect("registration");
    let registry =
        DynamicToolRegistry::from_registrations([registration.clone()]).expect("unique registry");
    assert_eq!(registry.len(), 1);

    let invocation = DynamicToolInvocation::new(
        "tool-call-1",
        registration.namespace(),
        registration.tool_name(),
        json!({"query": "hello"}),
    )
    .expect("bounded invocation");
    assert_eq!(invocation.call_id(), "tool-call-1");
    assert_eq!(invocation.arguments(), &json!({"query": "hello"}));
    assert_eq!(
        registry
            .resolve(&invocation, &record)
            .expect("exact current binding"),
        &registration
    );

    let duplicate =
        DynamicToolRegistry::from_registrations([registration.clone(), registration.clone()]);
    assert_eq!(
        duplicate.expect_err("namespace conflict"),
        DynamicToolRouteError::RegistrationConflict
    );

    let unknown =
        DynamicToolInvocation::new("tool-call-2", registration.namespace(), "search", json!({}))
            .expect("unknown invocation shape");
    assert_eq!(
        registry
            .resolve(&unknown, &record)
            .expect_err("unknown tool"),
        DynamicToolRouteError::UnknownTool
    );

    let mut drifted = record;
    drifted.revision = 3;
    drifted.updated_at += 1;
    drifted.record_hash = drifted.canonical_hash();
    assert_eq!(
        registry
            .resolve(&invocation, &drifted)
            .expect_err("binding revision drift"),
        DynamicToolRouteError::BindingDrift
    );
}

#[test]
fn invocation_bounds_are_enforced_before_route_lookup() {
    assert_eq!(
        DynamicToolInvocation::new("call", "pim", "call", json!({"blob": "x".repeat(70_000)}))
            .expect_err("oversized arguments"),
        DynamicToolRouteError::ArgumentsTooLarge
    );
    assert_eq!(
        DynamicToolInvocation::new("call", "bad namespace", "call", json!({}))
            .expect_err("invalid namespace"),
        DynamicToolRouteError::InvalidInvocation
    );
}

#[test]
fn registration_batch_has_a_hard_item_limit() {
    let registrations = (1_u128..=65)
        .map(|suffix| {
            let mut record = binding(
                ProviderResourceKind::McpTool,
                ProviderResourceBindingMode::ProviderManaged,
            );
            record.binding_id = format!("resource-binding:{}", Uuid::from_u128(suffix));
            record.record_hash = record.canonical_hash();
            DynamicToolRegistration::from_binding(record, SideEffect::ReadOnly)
                .expect("unique registration")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        DynamicToolRegistry::from_registrations(registrations).expect_err("registration cap"),
        DynamicToolRouteError::RegistrationLimitExceeded
    );
}

pub(super) fn binding(
    resource_kind: ProviderResourceKind,
    binding_mode: ProviderResourceBindingMode,
) -> ProviderResourceBindingRecord {
    let local = matches!(
        binding_mode,
        ProviderResourceBindingMode::LocalSnapshot | ProviderResourceBindingMode::LocalFork
    );
    let content_digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let local_digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let mut record = ProviderResourceBindingRecord {
        binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301".to_string(),
        local_actor_id: "actor-1".to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind,
        resource_id: "resource-9".to_string(),
        resource_revision: "resource-version:7".to_string(),
        binding_mode,
        execution_location: if local {
            ProviderResourceExecutionLocation::LocalNode
        } else {
            ProviderResourceExecutionLocation::Provider
        },
        manifest_schema_version: "resource.manifest.v1".to_string(),
        content_digest: Some(content_digest.to_string()),
        source_revision: local.then(|| "resource-version:7".to_string()),
        source_digest: local.then(|| content_digest.to_string()),
        local_revision: local.then(|| match binding_mode {
            ProviderResourceBindingMode::LocalSnapshot => "resource-version:7".to_string(),
            ProviderResourceBindingMode::LocalFork => "local-resource-version:1".to_string(),
            ProviderResourceBindingMode::RemoteReference
            | ProviderResourceBindingMode::ProviderManaged => unreachable!(),
        }),
        local_content_digest: local.then(|| match binding_mode {
            ProviderResourceBindingMode::LocalSnapshot => content_digest.to_string(),
            ProviderResourceBindingMode::LocalFork => local_digest.to_string(),
            ProviderResourceBindingMode::RemoteReference
            | ProviderResourceBindingMode::ProviderManaged => unreachable!(),
        }),
        status: ProviderResourceBindingStatus::Active,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        unbound_at: None,
    };
    record.record_hash = record.canonical_hash();
    record
}
