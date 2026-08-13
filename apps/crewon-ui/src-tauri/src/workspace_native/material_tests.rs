use ed25519_dalek::pkcs8::DecodePrivateKey as _;
use ed25519_dalek::SigningKey;
use pretty_assertions::assert_eq;

use super::catalog::DesktopWorkspaceAuthority;
use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::WorkspaceLaunchMaterial;

#[test]
fn command_private_pem_is_a_valid_ed25519_identity() {
    let fixture = fixture();
    let material = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    SigningKey::from_pkcs8_pem(material.command_signing().private_key_pem()).unwrap();
}

#[test]
fn launch_material_rotates_between_app_sessions_and_debug_is_redacted() {
    let fixture = fixture();
    let first = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    let second = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    assert_ne!(
        first.command_signing().key_id(),
        second.command_signing().key_id()
    );
    assert_ne!(
        first.command_signing().private_key_pem(),
        second.command_signing().private_key_pem()
    );
    assert_eq!(format!("{first:?}"), "WorkspaceLaunchMaterial([REDACTED])");
    assert!(!format!("{first:?}").contains("PRIVATE KEY"));
}

struct MaterialFixture {
    _root: tempfile::TempDir,
    authority: DesktopWorkspaceAuthority,
}

fn fixture() -> MaterialFixture {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let mut manager =
        DesktopWorkspaceAuthorityManager::open(root.path().join("authority")).unwrap();
    match manager.prepare("operation-1", 0, workspace).unwrap() {
        WorkspaceAuthorityPrepareResult::Pending(_) => {}
        WorkspaceAuthorityPrepareResult::Committed(_)
        | WorkspaceAuthorityPrepareResult::Aborted => panic!("expected pending authority"),
    }
    manager.commit("operation-1").unwrap();
    MaterialFixture {
        _root: root,
        authority: manager.authority().clone(),
    }
}
