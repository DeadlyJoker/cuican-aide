use crewon_app_server_protocol::ResourceBindingStatus;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::LocalMaterialization;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_state::ProviderConnectionRecord;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceExecutionLocation;
use pretty_assertions::assert_eq;

use super::provider_resource_binding_adapter::ProviderResourceBindingAdapterError;
use super::provider_resource_binding_adapter::project_resource_binding;
use super::provider_resource_binding_adapter::resource_binding_record;

#[test]
fn resolved_binding_maps_to_strict_state_and_path_free_projection() {
    let connection = connection();
    let workspace = workspace();
    let resolved = resolved_binding(BindingMode::ProviderManaged);
    let record = resource_binding_record(&connection, &workspace, &resolved, /*now*/ 100)
        .expect("resource binding record");

    assert_eq!(record.connection_id, connection.connection_id);
    assert_eq!(record.workspace_key, workspace.workspace_key);
    assert_eq!(
        record.binding_mode,
        ProviderResourceBindingMode::ProviderManaged
    );
    assert_eq!(
        record.execution_location,
        ProviderResourceExecutionLocation::Provider
    );
    record.validate().expect("strict State record");

    let projection = project_resource_binding(&record).expect("binding projection");
    assert_eq!(projection.status, ResourceBindingStatus::Active);
    assert_eq!(projection.binding.binding_id, record.binding_id);
    assert_eq!(projection.binding.workspace_key, workspace.workspace_key);
    let serialized = serde_json::to_string(&projection).expect("serialize projection");
    for forbidden in [
        "local_actor",
        "credential",
        "endpoint",
        "rootPath",
        "secret",
    ] {
        assert!(!serialized.contains(forbidden));
    }
}

#[test]
fn adapter_preserves_local_provenance_and_rejects_parent_mismatch() {
    let connection = connection();
    let workspace_ref = workspace();
    let resolved = resolved_binding(BindingMode::LocalFork);
    let record = resource_binding_record(&connection, &workspace_ref, &resolved, /*now*/ 100)
        .expect("local fork record");
    let materialization = resolved
        .materialization()
        .expect("local fork materialization");
    assert_eq!(record.source_revision.as_deref(), Some("agent-version:7"));
    assert_eq!(
        record.local_revision.as_deref(),
        Some(materialization.local_revision.as_str())
    );

    let mut mismatched_workspace = workspace_ref;
    mismatched_workspace.workspace_key =
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c099".to_string();
    assert_eq!(
        resource_binding_record(
            &connection,
            &mismatched_workspace,
            &resolved,
            /*now*/ 100
        )
        .expect_err("workspace mismatch"),
        ProviderResourceBindingAdapterError::Incompatible
    );
    assert_eq!(
        resource_binding_record(&connection, &workspace(), &resolved, /*now*/ -1)
            .expect_err("negative timestamp"),
        ProviderResourceBindingAdapterError::InvalidInput
    );
}

fn connection() -> ProviderConnectionRecord {
    let mut record = ProviderConnectionRecord {
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        local_actor_id: "actor-1".to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        credential_id: "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c102".to_string(),
        credential_revision: 1,
        record_hash: String::new(),
        created_at: 90,
    };
    record.record_hash = record.canonical_hash();
    record
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        binding_id: "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
        scope: WorkspaceScope::Office,
        scope_id: "office-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}

fn resolved_binding(mode: BindingMode) -> crewon_resource_federation::ResolvedResourceBinding {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new("agent-demo").expect("resource id"),
        revision: ResourceRevision::new("agent-version:7").expect("resource revision"),
    };
    let digest = ContentDigest::new(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )
    .expect("digest");
    let execution_location = match mode {
        BindingMode::RemoteReference | BindingMode::ProviderManaged => ExecutionLocation::Provider,
        BindingMode::LocalSnapshot | BindingMode::LocalFork => ExecutionLocation::LocalNode,
    };
    let materialization = match mode {
        BindingMode::RemoteReference | BindingMode::ProviderManaged => None,
        BindingMode::LocalSnapshot => Some(LocalMaterialization {
            source_revision: resource.revision.clone(),
            source_digest: digest.clone(),
            local_revision: resource.revision.clone(),
            content_digest: digest.clone(),
        }),
        BindingMode::LocalFork => Some(LocalMaterialization {
            source_revision: resource.revision.clone(),
            source_digest: digest.clone(),
            local_revision: ResourceRevision::new("local-agent-version:1").expect("local revision"),
            content_digest: ContentDigest::new(
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            )
            .expect("local digest"),
        }),
    };
    let capabilities = ProviderCapabilities::new(
        provider,
        [Capability {
            resource_kind: ResourceKind::Agent,
            binding_mode: mode,
            execution_location,
        }],
    )
    .expect("capabilities");
    resolve_binding(
        &BindingRequest {
            binding_id: BindingId::new("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301")
                .expect("binding id"),
            workspace_key: WorkspaceKey::new(workspace().workspace_key).expect("workspace key"),
            resource: resource.clone(),
            mode,
            execution_location,
            materialization,
        },
        &ResourceManifest {
            resource,
            schema_version: ManifestSchemaVersion::new("agent.manifest.v1")
                .expect("schema version"),
            content_digest: Some(digest),
        },
        &capabilities,
    )
    .expect("resolved binding")
}
