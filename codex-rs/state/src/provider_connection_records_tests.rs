use pretty_assertions::assert_eq;

use crate::ProviderConnectionRecord;
use crate::ProviderConnectionRecordErrorKind;

pub(crate) fn connection_record(connection_id: &str) -> ProviderConnectionRecord {
    let mut record = ProviderConnectionRecord {
        connection_id: connection_id.to_string(),
        local_actor_id: "actor-1".to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        credential_id: "cred_0123456789abcdef0123456789abcdef".to_string(),
        credential_revision: 7,
        record_hash: String::new(),
        created_at: 100,
    };
    record.record_hash = record.canonical_hash();
    record
}

#[test]
fn provider_connection_record_is_strict_hash_bound_and_redacted() {
    let record = connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101");
    record.validate().expect("valid provider connection");
    let debug = format!("{record:?}");
    for sensitive in [
        "actor-1",
        "tenant-1",
        "space-1",
        "cred_0123456789abcdef0123456789abcdef",
        record.record_hash.as_str(),
    ] {
        assert!(!debug.contains(sensitive));
    }

    let mut tampered = record.clone();
    tampered.credential_revision = 8;
    assert_eq!(
        tampered.validate().expect_err("tampered record").kind(),
        ProviderConnectionRecordErrorKind::DigestMismatch
    );

    let mut invalid_id = record.clone();
    invalid_id.connection_id = "provider-connection:not-a-uuid".to_string();
    assert_eq!(
        invalid_id
            .validate()
            .expect_err("invalid connection id")
            .kind(),
        ProviderConnectionRecordErrorKind::InvalidConnectionId
    );

    let mut invalid_owner = record.clone();
    invalid_owner.local_actor_id = " actor-1".to_string();
    invalid_owner.record_hash = invalid_owner.canonical_hash();
    assert_eq!(
        invalid_owner.validate().expect_err("invalid owner").kind(),
        ProviderConnectionRecordErrorKind::Empty
    );

    let mut invalid_revision = record.clone();
    invalid_revision.credential_revision = 0;
    invalid_revision.record_hash = invalid_revision.canonical_hash();
    assert_eq!(
        invalid_revision
            .validate()
            .expect_err("zero credential revision")
            .kind(),
        ProviderConnectionRecordErrorKind::OutOfRange
    );

    let mut invalid_time = record;
    invalid_time.created_at = -1;
    invalid_time.record_hash = invalid_time.canonical_hash();
    assert_eq!(
        invalid_time
            .validate()
            .expect_err("negative created at")
            .kind(),
        ProviderConnectionRecordErrorKind::OutOfRange
    );
}
