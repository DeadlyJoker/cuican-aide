use super::prepare_launch_root;
use super::prepare_runtime_directory;
use super::project_gateway_ready;
use super::project_workspace_ready;
use super::write_private;

#[test]
fn readiness_projections_bind_exact_nonsecret_authority() {
    assert_eq!(
        project_gateway_ready(
            b"CrewON Device Gateway listening on wss://127.0.0.1:43125/device/v1"
        ),
        Some(43_125)
    );
    assert_eq!(
        project_workspace_ready(
            b"CrewON Workspace Runtime ready:http://127.0.0.1:43126:runtime-1",
            "runtime-1"
        ),
        Some("http://127.0.0.1:43126".to_string())
    );
}

#[cfg(unix)]
#[test]
fn runtime_and_launch_directories_reject_symlinks_and_non_directories() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    std::fs::create_dir(&target).unwrap();

    let runtime_root = root.path().join("runtime-root");
    std::fs::create_dir(&runtime_root).unwrap();
    let runtime_leaf = runtime_root.join("runtime-1");
    symlink(&target, &runtime_leaf).unwrap();
    assert!(prepare_runtime_directory(&runtime_root, "runtime-1").is_err());

    let launch_root = root.path().join("launch-root");
    symlink(&target, &launch_root).unwrap();
    assert!(prepare_launch_root(&launch_root).is_err());

    let non_directory = root.path().join("not-a-directory");
    std::fs::write(&non_directory, b"not a directory").unwrap();
    assert!(prepare_runtime_directory(&non_directory, "runtime-2").is_err());
}

#[test]
fn readiness_projections_reject_wrong_binding_or_unbound_addresses() {
    assert_eq!(
        project_gateway_ready(b"CrewON Device Gateway listening on wss://0.0.0.0:43125/device/v1"),
        None
    );
    assert_eq!(
        project_workspace_ready(
            b"CrewON Workspace Runtime ready:http://127.0.0.1:43126:runtime-old",
            "runtime-1"
        ),
        None
    );
}

#[test]
fn gateway_material_files_are_create_new_and_owner_only() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("gateway.key.pem");
    write_private(&path, b"secret gateway material").expect("write private file");
    assert_eq!(
        std::fs::read(&path).expect("read private file"),
        b"secret gateway material"
    );
    assert!(write_private(&path, b"replacement").is_err());
    assert_eq!(
        std::fs::read(&path).expect("read preserved file"),
        b"secret gateway material"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path)
                .expect("private file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
