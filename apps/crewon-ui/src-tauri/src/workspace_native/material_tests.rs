use pretty_assertions::assert_eq;

use super::catalog::DesktopWorkspaceAuthority;
use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::WorkspaceLaunchMaterial;

#[test]
fn launch_material_rotates_between_app_sessions_and_debug_is_redacted() {
    let fixture = fixture();
    let first = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    let second = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    assert_ne!(first.private_server_token(), second.private_server_token());
    assert_eq!(format!("{first:?}"), "WorkspaceLaunchMaterial([REDACTED])");
    assert!(!format!("{first:?}").contains(first.private_server_token()));
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
