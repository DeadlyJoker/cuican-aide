use super::*;
use pretty_assertions::assert_eq;

const SOURCE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FORK_DIGEST: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn resolves_every_supported_binding_mode_to_a_complete_pinned_object() {
    let resource = resource(ResourceKind::Skill, "rev-7");
    let manifest = manifest(resource.clone(), Some(SOURCE_DIGEST));
    let capabilities = ProviderCapabilities::new(
        provider(),
        [
            capability(
                ResourceKind::Skill,
                BindingMode::RemoteReference,
                ExecutionLocation::Provider,
            ),
            capability(
                ResourceKind::Skill,
                BindingMode::ProviderManaged,
                ExecutionLocation::Provider,
            ),
            capability(
                ResourceKind::Skill,
                BindingMode::LocalSnapshot,
                ExecutionLocation::LocalNode,
            ),
            capability(
                ResourceKind::Skill,
                BindingMode::LocalFork,
                ExecutionLocation::LocalNode,
            ),
        ],
    )
    .expect("valid capabilities");

    let cases = [
        (
            BindingMode::RemoteReference,
            ExecutionLocation::Provider,
            None,
        ),
        (
            BindingMode::ProviderManaged,
            ExecutionLocation::Provider,
            None,
        ),
        (
            BindingMode::LocalSnapshot,
            ExecutionLocation::LocalNode,
            Some(materialization("rev-7", SOURCE_DIGEST)),
        ),
        (
            BindingMode::LocalFork,
            ExecutionLocation::LocalNode,
            Some(materialization("fork-3", FORK_DIGEST)),
        ),
    ];

    for (mode, execution_location, materialization) in cases {
        let request = request(
            resource.clone(),
            mode,
            execution_location,
            materialization.clone(),
        );
        let expected_capability = capability(ResourceKind::Skill, mode, execution_location);

        assert_eq!(
            resolve_binding(&request, &manifest, &capabilities),
            Ok(ResolvedResourceBinding {
                binding_id: binding_id(),
                workspace_key: workspace_key(),
                resource: resource.clone(),
                mode,
                execution_location,
                manifest_schema_version: schema_version(),
                content_digest: Some(digest(SOURCE_DIGEST)),
                capability: expected_capability,
                materialization,
            })
        );
    }
}

#[test]
fn rejects_identity_revision_and_capability_provider_mismatches() {
    let resource = resource(ResourceKind::Agent, "rev-1");
    let request = request(
        resource.clone(),
        BindingMode::RemoteReference,
        ExecutionLocation::Provider,
        None,
    );
    let capabilities = capabilities_for(capability(
        ResourceKind::Agent,
        BindingMode::RemoteReference,
        ExecutionLocation::Provider,
    ));

    let cases = [
        (
            manifest(
                ResourceRef {
                    provider: other_provider(),
                    ..resource.clone()
                },
                Some(SOURCE_DIGEST),
            ),
            capabilities.clone(),
            BindingError::ResourceProviderMismatch,
        ),
        (
            manifest(
                ResourceRef {
                    resource_id: ResourceId::new("other-agent").expect("resource id"),
                    ..resource.clone()
                },
                Some(SOURCE_DIGEST),
            ),
            capabilities.clone(),
            BindingError::ResourceIdentityMismatch,
        ),
        (
            manifest(
                ResourceRef {
                    revision: ResourceRevision::new("rev-2").expect("revision"),
                    ..resource.clone()
                },
                Some(SOURCE_DIGEST),
            ),
            capabilities.clone(),
            BindingError::RevisionMismatch,
        ),
        (
            manifest(resource, Some(SOURCE_DIGEST)),
            ProviderCapabilities::new(other_provider(), capabilities.iter().copied())
                .expect("capabilities"),
            BindingError::CapabilityProviderMismatch,
        ),
    ];

    for (manifest, capabilities, expected) in cases {
        assert_eq!(
            resolve_binding(&request, &manifest, &capabilities),
            Err(expected)
        );
    }
}

#[test]
fn rejects_execution_location_and_capability_conflicts() {
    let resource = resource(ResourceKind::KnowledgeBase, "kb-rev-1");
    let manifest = manifest(resource.clone(), Some(SOURCE_DIGEST));
    let supported = capability(
        ResourceKind::KnowledgeBase,
        BindingMode::RemoteReference,
        ExecutionLocation::Provider,
    );
    let capabilities = capabilities_for(supported);

    assert_eq!(
        resolve_binding(
            &request(
                resource.clone(),
                BindingMode::RemoteReference,
                ExecutionLocation::LocalNode,
                None,
            ),
            &manifest,
            &capabilities,
        ),
        Err(BindingError::ExecutionLocationNotAllowed)
    );
    assert_eq!(
        resolve_binding(
            &request(
                resource,
                BindingMode::ProviderManaged,
                ExecutionLocation::Provider,
                None,
            ),
            &manifest,
            &capabilities,
        ),
        Err(BindingError::CapabilityNotSupported)
    );
}

#[test]
fn rejects_invalid_snapshot_materialization() {
    let resource = resource(ResourceKind::Skill, "rev-7");
    let capability = capability(
        ResourceKind::Skill,
        BindingMode::LocalSnapshot,
        ExecutionLocation::LocalNode,
    );
    let capabilities = capabilities_for(capability);

    let cases = [
        (
            manifest(resource.clone(), Some(SOURCE_DIGEST)),
            None,
            BindingError::MaterializationRequired,
        ),
        (
            manifest(resource.clone(), None),
            Some(materialization("rev-7", SOURCE_DIGEST)),
            BindingError::ManifestDigestRequired,
        ),
        (
            manifest(resource.clone(), Some(SOURCE_DIGEST)),
            Some(materialization("rev-7", FORK_DIGEST)),
            BindingError::SnapshotVerificationFailed,
        ),
        (
            manifest(resource.clone(), Some(SOURCE_DIGEST)),
            Some(LocalMaterialization {
                source_revision: ResourceRevision::new("wrong-source").expect("revision"),
                ..materialization("rev-7", SOURCE_DIGEST)
            }),
            BindingError::SnapshotVerificationFailed,
        ),
    ];

    for (manifest, materialization, expected) in cases {
        assert_eq!(
            resolve_binding(
                &request(
                    resource.clone(),
                    BindingMode::LocalSnapshot,
                    ExecutionLocation::LocalNode,
                    materialization,
                ),
                &manifest,
                &capabilities,
            ),
            Err(expected)
        );
    }
}

#[test]
fn rejects_invalid_fork_provenance_and_remote_materialization() {
    let resource = resource(ResourceKind::Skill, "rev-7");
    let manifest = manifest(resource.clone(), Some(SOURCE_DIGEST));
    let capabilities = ProviderCapabilities::new(
        provider(),
        [
            capability(
                ResourceKind::Skill,
                BindingMode::LocalFork,
                ExecutionLocation::LocalNode,
            ),
            capability(
                ResourceKind::Skill,
                BindingMode::RemoteReference,
                ExecutionLocation::Provider,
            ),
        ],
    )
    .expect("capabilities");
    let invalid_fork = LocalMaterialization {
        source_digest: digest(FORK_DIGEST),
        ..materialization("fork-3", FORK_DIGEST)
    };

    assert_eq!(
        resolve_binding(
            &request(
                resource.clone(),
                BindingMode::LocalFork,
                ExecutionLocation::LocalNode,
                Some(invalid_fork),
            ),
            &manifest,
            &capabilities,
        ),
        Err(BindingError::ForkProvenanceMismatch)
    );
    assert_eq!(
        resolve_binding(
            &request(
                resource,
                BindingMode::RemoteReference,
                ExecutionLocation::Provider,
                Some(materialization("rev-7", SOURCE_DIGEST)),
            ),
            &manifest,
            &capabilities,
        ),
        Err(BindingError::UnexpectedMaterialization)
    );
}

#[test]
fn unknown_or_legacy_capability_data_fails_closed() {
    let unknown_mode = serde_json::json!({
        "resourceKind": "skill",
        "bindingMode": "downloaded",
        "executionLocation": "localNode"
    });
    let legacy_boolean = serde_json::json!({
        "resourceKind": "skill",
        "bindingMode": "localSnapshot",
        "executionLocation": "localNode",
        "downloaded": true
    });
    let unknown_resource = serde_json::json!({
        "resourceKind": "application",
        "bindingMode": "remoteReference",
        "executionLocation": "provider"
    });

    assert!(serde_json::from_value::<Capability>(unknown_mode).is_err());
    assert!(serde_json::from_value::<Capability>(legacy_boolean).is_err());
    assert!(serde_json::from_value::<Capability>(unknown_resource).is_err());
}

#[test]
fn bounded_capability_and_catalog_page_payloads_fail_closed() {
    let capabilities = (0..=MAX_PROVIDER_CAPABILITIES)
        .map(|_| {
            serde_json::json!({
                "resourceKind": "skill",
                "bindingMode": "remoteReference",
                "executionLocation": "provider"
            })
        })
        .collect::<Vec<_>>();
    let payload = serde_json::json!({
        "provider": provider(),
        "capabilities": capabilities,
    });

    assert!(serde_json::from_value::<ProviderCapabilities>(payload).is_err());

    let resources = (0..=MAX_RESOURCE_PAGE_ITEMS)
        .map(|index| resource(ResourceKind::Agent, &format!("rev-{index}")))
        .collect::<Vec<_>>();
    let page = serde_json::json!({
        "resources": resources,
        "nextCursor": null,
    });

    assert!(serde_json::from_value::<ResourcePage>(page).is_err());
}

#[test]
fn catalog_provider_port_accepts_only_versioned_domain_objects() {
    struct FakeCatalog;

    impl CatalogProvider for FakeCatalog {
        async fn list_resources(
            &self,
            _query: ResourceListQuery,
        ) -> Result<ResourcePage, ProviderError> {
            ResourcePage::complete(Vec::new()).map_err(|_| ProviderError::InvalidResponse)
        }

        async fn read_manifest(
            &self,
            resource: ResourceRef,
        ) -> Result<ResourceManifest, ProviderError> {
            Ok(manifest(resource, Some(SOURCE_DIGEST)))
        }
    }

    fn assert_catalog_provider<T: CatalogProvider>(_provider: &T) {}

    assert_catalog_provider(&FakeCatalog);
}

fn provider() -> ProviderRef {
    ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("2026-07-01").expect("protocol version"),
    }
}

fn other_provider() -> ProviderRef {
    ProviderRef {
        provider_id: ProviderId::new("other-provider").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("2026-07-01").expect("protocol version"),
    }
}

fn resource(kind: ResourceKind, revision: &str) -> ResourceRef {
    ResourceRef {
        provider: provider(),
        kind,
        resource_id: ResourceId::new("resource-42").expect("resource id"),
        revision: ResourceRevision::new(revision).expect("revision"),
    }
}

fn manifest(resource: ResourceRef, content_digest: Option<&str>) -> ResourceManifest {
    ResourceManifest {
        resource,
        schema_version: schema_version(),
        content_digest: content_digest.map(digest),
    }
}

fn schema_version() -> ManifestSchemaVersion {
    ManifestSchemaVersion::new("1").expect("schema version")
}

fn capability(
    resource_kind: ResourceKind,
    binding_mode: BindingMode,
    execution_location: ExecutionLocation,
) -> Capability {
    Capability {
        resource_kind,
        binding_mode,
        execution_location,
    }
}

fn capabilities_for(capability: Capability) -> ProviderCapabilities {
    ProviderCapabilities::new(provider(), [capability]).expect("capabilities")
}

fn request(
    resource: ResourceRef,
    mode: BindingMode,
    execution_location: ExecutionLocation,
    materialization: Option<LocalMaterialization>,
) -> BindingRequest {
    BindingRequest {
        binding_id: binding_id(),
        workspace_key: workspace_key(),
        resource,
        mode,
        execution_location,
        materialization,
    }
}

fn binding_id() -> BindingId {
    BindingId::new("binding-1").expect("binding id")
}

fn workspace_key() -> WorkspaceKey {
    WorkspaceKey::new("workspace-1").expect("workspace key")
}

fn materialization(local_revision: &str, content_digest: &str) -> LocalMaterialization {
    LocalMaterialization {
        source_revision: ResourceRevision::new("rev-7").expect("source revision"),
        source_digest: digest(SOURCE_DIGEST),
        local_revision: ResourceRevision::new(local_revision).expect("local revision"),
        content_digest: digest(content_digest),
    }
}

fn digest(value: &str) -> ContentDigest {
    ContentDigest::new(value).expect("content digest")
}
