use std::collections::HashMap;

use pretty_assertions::assert_eq;

use super::FileSensitivity;
use super::PreparedPrincipalSessionProduction;
use super::StrictKeyset;
use super::read_bounded_file;

#[tokio::test]
async fn production_composition_is_disabled_by_default_and_rejects_ambiguous_enablement() {
    assert!(
        PreparedPrincipalSessionProduction::from_environment(&HashMap::new())
            .await
            .expect("disabled composition")
            .is_none()
    );
    let invalid = HashMap::from([(
        "CREWON_PRINCIPAL_SESSION_ENABLED".to_string(),
        "yes".to_string(),
    )]);
    let error = match PreparedPrincipalSessionProduction::from_environment(&invalid).await {
        Ok(_) => panic!("ambiguous flag must fail"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
}

#[test]
fn trusted_keyset_rejects_duplicate_keys_before_crypto_configuration() {
    let parsed = serde_json::from_str::<StrictKeyset>(r#"{"key-1":"public-a","key-1":"public-b"}"#);
    assert!(parsed.is_err());
}

#[test]
fn bounded_file_reader_rejects_content_larger_than_its_hard_cap() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("key.pem");
    std::fs::write(&path, b"1234").expect("write key file");
    assert!(read_bounded_file(&path, /*max_bytes*/ 3, FileSensitivity::Public).is_err());
}

#[cfg(unix)]
#[test]
fn bounded_file_reader_rejects_symbolic_links() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("temporary directory");
    let target = directory.path().join("target.pem");
    let link = directory.path().join("link.pem");
    std::fs::write(&target, b"public key").expect("write target");
    symlink(&target, &link).expect("create symbolic link");
    assert!(read_bounded_file(&link, /*max_bytes*/ 64, FileSensitivity::Public).is_err());
}
