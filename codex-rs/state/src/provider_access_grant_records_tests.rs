use pretty_assertions::assert_eq;

use crate::ProviderAccessGrantRecord;
use crate::ProviderAccessGrantRecordErrorKind;
use crate::ProviderAccessGrantStatus;

pub(crate) fn access_grant_record(grant_id: &str) -> ProviderAccessGrantRecord {
    let mut record = ProviderAccessGrantRecord {
        grant_id: grant_id.to_string(),
        local_actor_id:
            "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f".to_string(),
        local_tenant_id: "7".to_string(),
        local_space_id: "11".to_string(),
        provider_id: "agent-platform".to_string(),
        source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
        source_revision: 1,
        granted_scopes: vec![
            "provider.discovery".to_string(),
            "providerRun:start".to_string(),
        ],
        status: ProviderAccessGrantStatus::Active,
        expires_at: 200,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        revoked_at: None,
    };
    record.record_hash = record.canonical_hash();
    record
}

#[test]
fn provider_access_grant_is_strict_hash_bound_and_redacted() {
    let record = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301");
    record.validate().expect("valid Provider access grant");
    let debug = format!("{record:?}");
    for sensitive in [
        record.local_actor_id.as_str(),
        record.source_binding_id.as_str(),
        record.granted_scopes[0].as_str(),
        record.record_hash.as_str(),
    ] {
        assert!(!debug.contains(sensitive));
    }
    assert!(debug.contains("owner: \"[REDACTED]\""));
    assert!(debug.contains("source_binding: \"[REDACTED]\""));

    let mut tampered = record.clone();
    tampered.provider_id = "agent-platform-tampered".to_string();
    assert_eq!(
        tampered.validate().expect_err("tampered record").kind(),
        ProviderAccessGrantRecordErrorKind::DigestMismatch
    );

    let mut invalid_id = record.clone();
    invalid_id.grant_id = "provider-grant:not-a-uuid".to_string();
    assert_eq!(
        invalid_id.validate().expect_err("invalid grant id").kind(),
        ProviderAccessGrantRecordErrorKind::InvalidGrantId
    );

    let mut invalid_principal = record.clone();
    invalid_principal.local_actor_id = "actor-1".to_string();
    invalid_principal.record_hash = invalid_principal.canonical_hash();
    assert_eq!(
        invalid_principal
            .validate()
            .expect_err("invalid principal")
            .kind(),
        ProviderAccessGrantRecordErrorKind::InvalidPrincipal
    );

    let mut duplicate_scope = record.clone();
    duplicate_scope
        .granted_scopes
        .push("providerRun:start".to_string());
    duplicate_scope.record_hash = duplicate_scope.canonical_hash();
    assert_eq!(
        duplicate_scope
            .validate()
            .expect_err("duplicate scope")
            .kind(),
        ProviderAccessGrantRecordErrorKind::InconsistentFields
    );

    let mut invalid_expiry = record.clone();
    invalid_expiry.expires_at = invalid_expiry.created_at;
    invalid_expiry.record_hash = invalid_expiry.canonical_hash();
    assert_eq!(
        invalid_expiry
            .validate()
            .expect_err("invalid expiry")
            .kind(),
        ProviderAccessGrantRecordErrorKind::OutOfRange
    );

    let mut invalid_revoked = record;
    invalid_revoked.status = ProviderAccessGrantStatus::Revoked;
    invalid_revoked.record_hash = invalid_revoked.canonical_hash();
    assert_eq!(
        invalid_revoked
            .validate()
            .expect_err("incomplete revoke")
            .kind(),
        ProviderAccessGrantRecordErrorKind::InconsistentFields
    );
}
