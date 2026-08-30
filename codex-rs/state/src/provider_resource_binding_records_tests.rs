use pretty_assertions::assert_eq;

use crate::ProviderResourceBindingMode;
use crate::ProviderResourceBindingRecord;
use crate::ProviderResourceBindingRecordErrorKind;
use crate::ProviderResourceBindingStatus;
use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::ProviderResourceWorkspaceScope;

pub(crate) fn binding_record(binding_id: &str) -> ProviderResourceBindingRecord {
    let mut record = ProviderResourceBindingRecord {
        binding_id: binding_id.to_string(),
        local_actor_id: "actor-1".to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: ProviderResourceKind::Agent,
        resource_id: "agent-demo".to_string(),
        resource_revision: "agent-version:7".to_string(),
        binding_mode: ProviderResourceBindingMode::ProviderManaged,
        execution_location: ProviderResourceExecutionLocation::Provider,
        manifest_schema_version: "1.0.0".to_string(),
        content_digest: Some(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        ),
        source_revision: None,
        source_digest: None,
        local_revision: None,
        local_content_digest: None,
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

#[test]
fn provider_resource_binding_record_is_strict_hash_bound_and_redacted() {
    let record = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301");
    record.validate().expect("valid Provider resource binding");
    let debug = format!("{record:?}");
    for sensitive in [
        record.local_actor_id.as_str(),
        record.local_tenant_id.as_str(),
        record.local_space_id.as_str(),
        record.connection_id.as_str(),
        record.workspace_key.as_str(),
        record.workspace_scope_id.as_str(),
        record.resource_id.as_str(),
        record.resource_revision.as_str(),
        record.content_digest.as_deref().expect("digest"),
        record.record_hash.as_str(),
    ] {
        assert!(!debug.contains(sensitive));
    }

    let mut tampered = record.clone();
    tampered.resource_revision = "agent-version:8".to_string();
    assert_eq!(
        tampered.validate().expect_err("tampered record").kind(),
        ProviderResourceBindingRecordErrorKind::DigestMismatch
    );

    let mut invalid_id = record.clone();
    invalid_id.binding_id = "resource-binding:not-a-uuid".to_string();
    invalid_id.record_hash = invalid_id.canonical_hash();
    assert_eq!(
        invalid_id
            .validate()
            .expect_err("invalid binding id")
            .kind(),
        ProviderResourceBindingRecordErrorKind::InvalidBindingId
    );

    let mut invalid_location = record;
    invalid_location.execution_location = ProviderResourceExecutionLocation::LocalNode;
    invalid_location.record_hash = invalid_location.canonical_hash();
    assert_eq!(
        invalid_location
            .validate()
            .expect_err("invalid execution location")
            .kind(),
        ProviderResourceBindingRecordErrorKind::InconsistentFields
    );
}

#[test]
fn provider_resource_binding_record_validates_materialization_and_lifecycle() {
    let mut snapshot = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c302");
    snapshot.binding_mode = ProviderResourceBindingMode::LocalSnapshot;
    snapshot.execution_location = ProviderResourceExecutionLocation::LocalNode;
    snapshot.source_revision = Some(snapshot.resource_revision.clone());
    snapshot.source_digest = snapshot.content_digest.clone();
    snapshot.local_revision = Some(snapshot.resource_revision.clone());
    snapshot.local_content_digest = snapshot.content_digest.clone();
    snapshot.record_hash = snapshot.canonical_hash();
    snapshot.validate().expect("valid local snapshot");

    let mut fork = snapshot.clone();
    fork.binding_id = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c304".to_string();
    fork.binding_mode = ProviderResourceBindingMode::LocalFork;
    fork.local_revision = Some("local-agent-version:1".to_string());
    fork.local_content_digest =
        Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string());
    fork.record_hash = fork.canonical_hash();
    fork.validate().expect("valid local fork");

    let mut missing_materialization = snapshot.clone();
    missing_materialization.local_content_digest = None;
    missing_materialization.record_hash = missing_materialization.canonical_hash();
    assert_eq!(
        missing_materialization
            .validate()
            .expect_err("missing materialization")
            .kind(),
        ProviderResourceBindingRecordErrorKind::InconsistentFields
    );

    let mut bad_provenance = snapshot;
    bad_provenance.source_revision = Some("agent-version:6".to_string());
    bad_provenance.record_hash = bad_provenance.canonical_hash();
    assert_eq!(
        bad_provenance
            .validate()
            .expect_err("bad snapshot provenance")
            .kind(),
        ProviderResourceBindingRecordErrorKind::InconsistentFields
    );

    let mut unbound = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c303");
    unbound.status = ProviderResourceBindingStatus::Unbound;
    unbound.revision = 2;
    unbound.updated_at = 110;
    unbound.unbound_at = Some(110);
    unbound.record_hash = unbound.canonical_hash();
    unbound.validate().expect("valid unbound lifecycle");

    unbound.revision = 3;
    unbound.record_hash = unbound.canonical_hash();
    assert_eq!(
        unbound
            .validate()
            .expect_err("invalid unbound revision")
            .kind(),
        ProviderResourceBindingRecordErrorKind::InconsistentFields
    );
}
