use pretty_assertions::assert_eq;

use crate::DurableWorkspaceRootRecord;
use crate::DurableWorkspaceRootRecordErrorKind;

pub(crate) fn root_record(
    workspace_key: &str,
    root_fingerprint: &str,
) -> DurableWorkspaceRootRecord {
    let mut record = DurableWorkspaceRootRecord {
        workspace_key: workspace_key.to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
        root_fingerprint: root_fingerprint.to_string(),
        record_hash: String::new(),
        created_at: 100,
    };
    record.record_hash = record.canonical_hash();
    record
}

#[test]
fn durable_workspace_root_record_is_strict_and_hash_bound() {
    let record = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001",
        &format!("sha256:{}", "a".repeat(64)),
    );
    record.validate().expect("valid root record");

    let mut tampered = record.clone();
    tampered.root_fingerprint = format!("sha256:{}", "b".repeat(64));
    assert_eq!(
        tampered.validate().expect_err("tampered record").kind(),
        DurableWorkspaceRootRecordErrorKind::DigestMismatch
    );

    let mut invalid_key = record;
    invalid_key.workspace_key = "workspace:not-a-uuid".to_string();
    assert_eq!(
        invalid_key
            .validate()
            .expect_err("invalid workspace key")
            .kind(),
        DurableWorkspaceRootRecordErrorKind::InvalidWorkspaceKey
    );

    let mut invalid_node = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c002",
        &format!("sha256:{}", "c".repeat(64)),
    );
    invalid_node.node_id = " node-1".to_string();
    invalid_node.record_hash = invalid_node.canonical_hash();
    assert_eq!(
        invalid_node.validate().expect_err("trimmed node id").kind(),
        DurableWorkspaceRootRecordErrorKind::Empty
    );

    let mut invalid_digest = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c003",
        &format!("sha256:{}", "d".repeat(64)),
    );
    invalid_digest.root_fingerprint = format!("sha256:{}", "A".repeat(64));
    invalid_digest.record_hash = invalid_digest.canonical_hash();
    assert_eq!(
        invalid_digest
            .validate()
            .expect_err("uppercase digest")
            .kind(),
        DurableWorkspaceRootRecordErrorKind::InvalidDigest
    );

    let mut invalid_time = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c004",
        &format!("sha256:{}", "e".repeat(64)),
    );
    invalid_time.created_at = -1;
    invalid_time.record_hash = invalid_time.canonical_hash();
    assert_eq!(
        invalid_time
            .validate()
            .expect_err("negative created at")
            .kind(),
        DurableWorkspaceRootRecordErrorKind::OutOfRange
    );
}
