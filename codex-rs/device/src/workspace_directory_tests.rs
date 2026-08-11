use std::fs;
use std::fs::File;
use std::time::Duration;

use pretty_assertions::assert_eq;
use tempfile::tempdir;

use super::WorkspaceDirectoryEntry;
use super::WorkspaceDirectoryEntryKind;
use super::WorkspaceDirectoryError;
use super::WorkspaceDirectoryRegistry;
use super::WorkspaceListCancellation;
use super::WorkspaceListLimits;
use super::WorkspaceListPage;
use super::WorkspaceListPageRequest;

#[test]
fn lists_the_stable_handle_in_utf8_byte_order_with_exact_cursors() {
    let parent = tempdir().expect("temporary parent");
    let workspace_path = parent.path().join("workspace");
    fs::create_dir(&workspace_path).expect("workspace directory");
    File::create(workspace_path.join("中")).expect("unicode file");
    File::create(workspace_path.join("é")).expect("unicode file");
    File::create(workspace_path.join("z")).expect("ascii file");
    fs::create_dir(workspace_path.join("a")).expect("nested directory");

    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-1", &workspace_path)
        .expect("register directory");
    fs::rename(&workspace_path, parent.path().join("moved")).expect("move registered path");
    fs::create_dir(&workspace_path).expect("replacement path");
    File::create(workspace_path.join("replacement-only")).expect("replacement file");

    let mut limits = WorkspaceListLimits::hard_maximums();
    limits.max_entries = 3;
    let mut listing = registry
        .begin_listing(&binding, limits, &WorkspaceListCancellation::default())
        .expect("list stable handle");
    let first = listing
        .next_page(WorkspaceListPageRequest {
            cursor: None,
            max_entries: 2,
        })
        .expect("first page");
    assert_eq!(
        first,
        WorkspaceListPage {
            entries: vec![
                directory("a"),
                file("z"),
            ],
            next_cursor: Some("workspace-page-1".to_string()),
            truncated: true,
        }
    );
    assert_eq!(
        listing
            .next_page(WorkspaceListPageRequest {
                cursor: first.next_cursor,
                max_entries: 2,
            })
            .expect("second page"),
        WorkspaceListPage {
            entries: vec![file("é")],
            next_cursor: None,
            truncated: true,
        }
    );
}

#[test]
#[cfg(unix)]
fn rejects_links_and_returns_the_exclusive_handle_after_failure() {
    let directory = tempdir().expect("temporary workspace");
    File::create(directory.path().join("target")).expect("target");
    std::os::unix::fs::symlink("target", directory.path().join("link")).expect("symlink");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-1", directory.path())
        .expect("register directory");
    assert_code(
        registry
            .begin_listing(
                &binding,
                WorkspaceListLimits::hard_maximums(),
                &WorkspaceListCancellation::default(),
            )
            .expect_err("symlink must fail"),
        "workspace_list_link_entry_unsupported",
    );

    fs::remove_file(directory.path().join("link")).expect("remove symlink");
    let mut listing = registry
        .begin_listing(
            &binding,
            WorkspaceListLimits::hard_maximums(),
            &WorkspaceListCancellation::default(),
        )
        .expect("handle returned after failure");
    assert_eq!(
        listing
            .next_page(WorkspaceListPageRequest {
                cursor: None,
                max_entries: 200,
            })
            .expect("result"),
        WorkspaceListPage {
            entries: vec![file("target")],
            next_cursor: None,
            truncated: false,
        }
    );
}

#[test]
#[cfg(unix)]
fn rejects_root_symlinks_and_special_files() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt as _;

    let parent = tempdir().expect("temporary parent");
    let directory = parent.path().join("workspace");
    fs::create_dir(&directory).expect("workspace");
    let root_link = parent.path().join("root-link");
    std::os::unix::fs::symlink(&directory, &root_link).expect("root symlink");
    let registry = WorkspaceDirectoryRegistry::new();
    assert!(registry.register("root-link", &root_link).is_err());

    let binding = registry
        .register("workspace-1", &directory)
        .expect("register directory");
    let fifo_path = directory.join("fifo");
    let fifo = CString::new(fifo_path.as_os_str().as_bytes()).expect("fifo path");
    // SAFETY: fifo is a valid NUL-terminated path owned through the call.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_code(
        registry
            .begin_listing(
                &binding,
                WorkspaceListLimits::hard_maximums(),
                &WorkspaceListCancellation::default(),
            )
            .expect_err("fifo must fail"),
        "workspace_list_entry_type_unsupported",
    );
    fs::remove_file(&fifo_path).expect("remove fifo");
}

#[test]
#[cfg(target_os = "linux")]
fn rejects_non_utf8_names() {
    use std::os::unix::ffi::OsStringExt as _;

    let directory = tempdir().expect("temporary workspace");
    let invalid_name = std::ffi::OsString::from_vec(vec![0xff]);
    File::create(directory.path().join(invalid_name)).expect("non utf8 file");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-1", directory.path())
        .expect("register directory");
    assert_code(
        registry
            .begin_listing(
                &binding,
                WorkspaceListLimits::hard_maximums(),
                &WorkspaceListCancellation::default(),
            )
            .expect_err("non utf8 must fail"),
        "workspace_list_entry_name_invalid",
    );
}

#[test]
fn enforces_scan_name_output_timeout_and_cancellation_limits() {
    let directory = tempdir().expect("temporary workspace");
    File::create(directory.path().join("one")).expect("file one");
    File::create(directory.path().join("two")).expect("file two");
    File::create(directory.path().join("three")).expect("file three");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-1", directory.path())
        .expect("register directory");

    let mut scan_limited = WorkspaceListLimits::hard_maximums();
    scan_limited.max_entries = 1;
    scan_limited.max_scanned_entries = 2;
    assert_code(
        registry
            .begin_listing(
                &binding,
                scan_limited,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("scan limit"),
        "workspace_list_scan_limit_exceeded",
    );
    fs::remove_file(directory.path().join("three")).expect("remove third file");

    let mut name_limited = WorkspaceListLimits::hard_maximums();
    name_limited.max_name_bytes = 2;
    assert_code(
        registry
            .begin_listing(
                &binding,
                name_limited,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("individual name limit"),
        "workspace_list_entry_name_invalid",
    );

    let mut name_limited = WorkspaceListLimits::hard_maximums();
    name_limited.max_name_bytes = 3;
    name_limited.max_scanned_name_bytes = 5;
    assert_code(
        registry
            .begin_listing(
                &binding,
                name_limited,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("scan byte limit"),
        "workspace_list_scan_bytes_exceeded",
    );

    let mut output_limited = WorkspaceListLimits::hard_maximums();
    output_limited.max_output_bytes = 8;
    assert_code(
        registry
            .begin_listing(
                &binding,
                output_limited,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("output limit"),
        "workspace_list_output_too_large",
    );

    let cancellation = WorkspaceListCancellation::default();
    cancellation.cancel();
    assert_code(
        registry
            .begin_listing(
                &binding,
                WorkspaceListLimits::hard_maximums(),
                &cancellation,
            )
            .expect_err("canceled"),
        "workspace_list_canceled",
    );

    let mut invalid_timeout = WorkspaceListLimits::hard_maximums();
    invalid_timeout.timeout = Duration::ZERO;
    assert_code(
        registry
            .begin_listing(
                &binding,
                invalid_timeout,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("invalid timeout"),
        "workspace_list_limits_invalid",
    );

    let mut impossible_name_budget = WorkspaceListLimits::hard_maximums();
    impossible_name_budget.max_name_bytes = 4;
    impossible_name_budget.max_scanned_name_bytes = 3;
    assert_code(
        registry
            .begin_listing(
                &binding,
                impossible_name_budget,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("impossible name budget"),
        "workspace_list_limits_invalid",
    );

    let mut expired = WorkspaceListLimits::hard_maximums();
    expired.timeout = Duration::from_nanos(1);
    assert_code(
        registry
            .begin_listing(
                &binding,
                expired,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("deadline"),
        "workspace_list_deadline_exceeded",
    );
}

#[test]
fn restart_changes_incarnation_and_old_bindings_fail_closed() {
    let directory = tempdir().expect("temporary workspace");
    let first_registry = WorkspaceDirectoryRegistry::new();
    let old_binding = first_registry
        .register("workspace-1", directory.path())
        .expect("first binding");
    drop(first_registry);

    let restarted_registry = WorkspaceDirectoryRegistry::new();
    let current_binding = restarted_registry
        .register("workspace-1", directory.path())
        .expect("current binding");
    assert_ne!(old_binding, current_binding);
    assert_code(
        restarted_registry
            .begin_listing(
                &old_binding,
                WorkspaceListLimits::hard_maximums(),
                &WorkspaceListCancellation::default(),
            )
            .expect_err("old binding"),
        "workspace_binding_unavailable",
    );
}

fn file(name: &str) -> WorkspaceDirectoryEntry {
    WorkspaceDirectoryEntry {
        name: name.to_string(),
        kind: WorkspaceDirectoryEntryKind::File,
    }
}

fn directory(name: &str) -> WorkspaceDirectoryEntry {
    WorkspaceDirectoryEntry {
        name: name.to_string(),
        kind: WorkspaceDirectoryEntryKind::Directory,
    }
}

fn assert_code(error: WorkspaceDirectoryError, expected: &'static str) {
    assert_eq!(error.code, expected);
}
