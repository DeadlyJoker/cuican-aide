use super::*;
use pretty_assertions::assert_eq;

const SOURCE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FORK_DIGEST: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn every_binding_mode_round_trips_through_a_validated_snapshot() {
    let cases = [
        (BindingMode::RemoteReference, None),
        (BindingMode::ProviderManaged, None),
        (
            BindingMode::LocalSnapshot,
            Some(materialization("rev-1", SOURCE_DIGEST)),
        ),
        (
            BindingMode::LocalFork,
            Some(materialization("fork-1", FORK_DIGEST)),
        ),
    ];

    for (mode, materialization) in cases {
        let binding = resolved(mode, materialization);
        let json = serde_json::to_string(&binding.to_snapshot()).expect("serialize snapshot");
        let snapshot = serde_json::from_str(&json).expect("deserialize snapshot");

        assert_eq!(ResolvedResourceBinding::restore(snapshot), Ok(binding));
    }
}

#[test]
fn restore_rejects_tampered_capability_and_materialization() {
    let binding = resolved(BindingMode::RemoteReference, None);
    let mut capability_tamper = binding.to_snapshot();
    capability_tamper.capability.resource_kind = ResourceKind::Agent;
    assert_eq!(
        ResolvedResourceBinding::restore(capability_tamper),
        Err(BindingError::SnapshotCapabilityMismatch)
    );

    let binding = resolved(
        BindingMode::LocalSnapshot,
        Some(materialization("rev-1", SOURCE_DIGEST)),
    );
    let mut materialization_tamper = binding.to_snapshot();
    materialization_tamper
        .materialization
        .as_mut()
        .expect("materialization")
        .content_digest = ContentDigest::new(FORK_DIGEST).expect("digest");
    assert_eq!(
        ResolvedResourceBinding::restore(materialization_tamper),
        Err(BindingError::SnapshotVerificationFailed)
    );
}

fn resolved(
    mode: BindingMode,
    materialization: Option<LocalMaterialization>,
) -> ResolvedResourceBinding {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("2026-07-01").expect("protocol version"),
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Skill,
        resource_id: ResourceId::new("skill-1").expect("resource id"),
        revision: ResourceRevision::new("rev-1").expect("revision"),
    };
    let execution_location = match mode {
        BindingMode::RemoteReference | BindingMode::ProviderManaged => ExecutionLocation::Provider,
        BindingMode::LocalSnapshot | BindingMode::LocalFork => ExecutionLocation::LocalNode,
    };
    let capability = Capability {
        resource_kind: ResourceKind::Skill,
        binding_mode: mode,
        execution_location,
    };
    let manifest = ResourceManifest {
        resource: resource.clone(),
        schema_version: ManifestSchemaVersion::new("1").expect("schema version"),
        content_digest: Some(ContentDigest::new(SOURCE_DIGEST).expect("digest")),
    };
    let request = BindingRequest {
        binding_id: BindingId::new(format!("binding-{mode:?}")).expect("binding id"),
        workspace_key: WorkspaceKey::new("workspace-1").expect("workspace key"),
        resource,
        mode,
        execution_location,
        materialization,
    };
    let capabilities = ProviderCapabilities::new(provider, [capability]).expect("capabilities");

    resolve_binding(&request, &manifest, &capabilities).expect("resolved binding")
}

fn materialization(local_revision: &str, content_digest: &str) -> LocalMaterialization {
    LocalMaterialization {
        source_revision: ResourceRevision::new("rev-1").expect("source revision"),
        source_digest: ContentDigest::new(SOURCE_DIGEST).expect("source digest"),
        local_revision: ResourceRevision::new(local_revision).expect("local revision"),
        content_digest: ContentDigest::new(content_digest).expect("content digest"),
    }
}
