use pretty_assertions::assert_eq;

use crate::ProviderIdentityBindingRecord;
use crate::ProviderIdentityBindingRecordErrorKind;
use crate::ProviderIdentityBindingStatus;

#[test]
fn provider_identity_binding_is_hash_bound_and_rejects_connection_scoped_owner() {
    let record = binding("identity-binding-1");
    record.validate().expect("valid binding");
    assert_eq!(record.record_hash, record.canonical_hash());
    let debug = format!("{record:?}");
    assert!(!debug.contains(&record.local_actor_id));
    assert!(!debug.contains(&record.provider_subject));
    assert!(!debug.contains(&record.authority_id));

    let mut tampered = record.clone();
    tampered.provider_subject = "user:43".to_string();
    assert_eq!(
        tampered.validate().expect_err("hash mismatch").kind(),
        ProviderIdentityBindingRecordErrorKind::DigestMismatch
    );

    let mut connection_scoped = record;
    connection_scoped.local_actor_id = "remote-websocket:session-1".to_string();
    connection_scoped.record_hash = connection_scoped.canonical_hash();
    assert_eq!(
        connection_scoped
            .validate()
            .expect_err("connection owner rejected")
            .kind(),
        ProviderIdentityBindingRecordErrorKind::InvalidPrincipal
    );
}

#[test]
fn provider_identity_binding_requires_exact_agent_platform_identity_and_monotonic_source() {
    let mut record = binding("identity-binding-1");
    record.provider_id = "other-provider".to_string();
    record.record_hash = record.canonical_hash();
    assert_eq!(
        record.validate().expect_err("provider rejected").kind(),
        ProviderIdentityBindingRecordErrorKind::InconsistentFields
    );

    let mut subject = binding("identity-binding-1");
    subject.provider_subject = "user:042".to_string();
    subject.record_hash = subject.canonical_hash();
    assert_eq!(
        subject.validate().expect_err("subject rejected").kind(),
        ProviderIdentityBindingRecordErrorKind::InvalidProviderIdentity
    );

    let mut revision = binding("identity-binding-1");
    revision.source_revision = 0;
    revision.record_hash = revision.canonical_hash();
    assert_eq!(
        revision.validate().expect_err("revision rejected").kind(),
        ProviderIdentityBindingRecordErrorKind::OutOfRange
    );

    let mut invalid_revoked = binding("identity-binding-1");
    invalid_revoked.status = ProviderIdentityBindingStatus::Revoked;
    invalid_revoked.record_hash = invalid_revoked.canonical_hash();
    assert_eq!(
        invalid_revoked
            .validate()
            .expect_err("revoked revision rejected")
            .kind(),
        ProviderIdentityBindingRecordErrorKind::InconsistentFields
    );
}

pub(crate) fn binding(binding_id: &str) -> ProviderIdentityBindingRecord {
    let mut record = ProviderIdentityBindingRecord {
        binding_id: binding_id.to_string(),
        local_actor_id: format!("principal:{}", "a".repeat(64)),
        local_tenant_id: "tenant-local-1".to_string(),
        local_space_id: "space-local-1".to_string(),
        provider_id: "agent-platform".to_string(),
        provider_subject: "user:42".to_string(),
        provider_tenant_id: "7".to_string(),
        provider_space_id: "11".to_string(),
        authority_id: "crewon-identity-session".to_string(),
        source_binding_id: "identity-source-binding-1".to_string(),
        source_revision: 1,
        source_fresh_until: 200,
        revision: 1,
        status: ProviderIdentityBindingStatus::Active,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    record.record_hash = record.canonical_hash();
    record
}
