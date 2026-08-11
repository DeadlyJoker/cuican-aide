use std::fs;
use std::path::Path;

use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::SelectedWorkspaceAuthority;
use super::catalog::WorkspaceAuthorityIntent;
use super::catalog::WorkspaceAuthorityIntentReplay;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::catalog_io::write_catalog;
use super::catalog_io::write_catalog_with_sync;
use super::catalog_io::CatalogWriteError;
use super::WorkspaceNativeError;

#[test]
fn reopens_install_identity_and_same_canonical_workspace_with_one_visible_revision() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let first = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    let device_id = manager.authority().device_id().to_string();
    let device_binding_id = manager.authority().device_binding_id().to_string();
    drop(manager);

    let mut reopened = fixture.manager();
    assert_eq!(reopened.authority().device_id(), device_id);
    assert_eq!(reopened.authority().device_binding_id(), device_binding_id);
    assert_eq!(reopened.authority().current_workspace().unwrap(), &first);
    let alias = fixture.workspace_a.join("nested").join("..");
    fs::create_dir_all(fixture.workspace_a.join("nested")).unwrap();
    let pending = pending(
        reopened
            .prepare("operation-same", first.revision(), alias)
            .unwrap(),
    );
    let same_path = pending.candidate().unwrap().clone();
    assert_eq!(same_path.revision(), first.revision() + 1);
    assert_eq!(same_path.trusted_path(), first.trusted_path());
    assert_eq!(
        same_path.workspace_binding_id(),
        first.workspace_binding_id()
    );
    assert_eq!(same_path.incarnation_id(), first.incarnation_id());
    assert_eq!(
        same_path.workspace_runtime_binding_id(),
        first.workspace_runtime_binding_id()
    );
    assert_eq!(
        reopened.commit("operation-same").unwrap(),
        Some(same_path.clone())
    );
    assert_eq!(
        reopened.commit("operation-same").unwrap(),
        Some(same_path.clone())
    );
    drop(reopened);
    assert_eq!(
        fixture
            .manager()
            .replay_intent(
                "operation-same",
                first.revision(),
                WorkspaceAuthorityIntent::Select
            )
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::Committed(Some(same_path)))
    );
}

#[test]
fn selection_cancel_is_a_durable_same_key_receipt_without_revision_change() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    assert_eq!(
        manager.begin_selection_intent("selection-canceled", 0),
        Ok(super::catalog::WorkspaceSelectionBeginResult::Fresh)
    );
    manager
        .record_selection_canceled("selection-canceled", 0)
        .unwrap();
    assert_eq!(manager.authority().current_revision(), 0);
    assert_eq!(manager.authority().current_snapshot(), None);
    assert_eq!(
        manager
            .replay_intent("selection-canceled", 0, WorkspaceAuthorityIntent::Select)
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::UserCanceled)
    );
    manager
        .record_selection_canceled("selection-canceled", 0)
        .unwrap();
    assert_eq!(
        manager.record_selection_canceled("different-selection", 0),
        Err(WorkspaceNativeError::AuthorityConflict)
    );
    drop(manager);

    let reopened = fixture.manager();
    assert_eq!(
        reopened
            .replay_intent("selection-canceled", 0, WorkspaceAuthorityIntent::Select)
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::UserCanceled)
    );
    assert_eq!(
        reopened
            .replay_intent("selection-canceled", 0, WorkspaceAuthorityIntent::Clear)
            .unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
}

#[test]
fn pending_candidate_projection_is_server_owned_and_does_not_commit_catalog() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let pending = pending(
        manager
            .prepare("selection-pending", 0, fixture.workspace_a.clone())
            .unwrap(),
    );
    assert_eq!(
        manager
            .replay_intent("selection-pending", 0, WorkspaceAuthorityIntent::Select)
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::Pending)
    );
    let candidate = manager
        .pending_candidate_authority("selection-pending")
        .unwrap();
    assert_eq!(
        candidate.current_workspace().unwrap(),
        pending.candidate().unwrap()
    );
    assert_eq!(
        manager.authority().current_workspace().unwrap_err(),
        WorkspaceNativeError::AuthorityRecoveryRequired
    );
}

#[cfg(unix)]
#[test]
fn filesystem_root_and_separator_display_names_are_not_renderer_status_values() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    assert_eq!(
        manager
            .prepare("selection-root", 0, std::path::PathBuf::from("/"))
            .unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );
    let separator = fixture.root.path().join("bad\\display-name");
    fs::create_dir(&separator).unwrap();
    assert_eq!(
        manager
            .prepare("selection-separator", 0, separator)
            .unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );
}

#[cfg(windows)]
#[test]
fn filesystem_root_is_not_a_renderer_status_display_name() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let root = std::path::PathBuf::from(r"C:\");
    if root.exists() {
        assert_eq!(
            manager.prepare("selection-root", 0, root).unwrap_err(),
            WorkspaceNativeError::AuthorityInvalid
        );
    }
}

#[test]
fn path_change_rotates_workspace_incarnation_and_runtime_only_after_commit() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let first = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    let stable_device_id = manager.authority().device_id().to_string();
    let stable_device_binding_id = manager.authority().device_binding_id().to_string();

    let prepared = pending(
        manager
            .prepare(
                "operation-change",
                first.revision(),
                fixture.workspace_b.clone(),
            )
            .unwrap(),
    );
    assert_eq!(prepared.expected_revision(), first.revision());
    assert_ne!(
        prepared.candidate().unwrap().workspace_binding_id(),
        first.workspace_binding_id()
    );
    assert_ne!(
        prepared.candidate().unwrap().incarnation_id(),
        first.incarnation_id()
    );
    assert_ne!(
        prepared.candidate().unwrap().workspace_runtime_binding_id(),
        first.workspace_runtime_binding_id()
    );
    assert_eq!(
        prepared.candidate().unwrap().revision(),
        first.revision() + 1
    );
    assert_eq!(
        manager.authority().current_workspace().unwrap_err(),
        WorkspaceNativeError::AuthorityRecoveryRequired
    );
    let committed = manager.commit("operation-change").unwrap().unwrap();
    assert_eq!(Some(&committed), prepared.candidate());
    assert_eq!(manager.authority().device_id(), stable_device_id);
    assert_eq!(
        manager.authority().device_binding_id(),
        stable_device_binding_id
    );
}

#[test]
fn prepare_is_cas_and_same_operation_is_idempotent_but_not_substitutable() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let first = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    assert_eq!(
        manager
            .prepare("operation-wrong-revision", 0, fixture.workspace_b.clone())
            .unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
    let first_prepare = manager
        .prepare(
            "operation-change",
            first.revision(),
            fixture.workspace_b.clone(),
        )
        .unwrap();
    assert_eq!(
        manager
            .prepare(
                "operation-change",
                first.revision(),
                fixture.workspace_b.clone(),
            )
            .unwrap(),
        first_prepare
    );
    assert_eq!(
        manager
            .prepare(
                "operation-change",
                first.revision(),
                fixture.workspace_a.clone(),
            )
            .unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
    assert_eq!(
        manager
            .prepare(
                "operation-other",
                first.revision(),
                fixture.workspace_b.clone(),
            )
            .unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
    let committed = manager.commit("operation-change").unwrap().unwrap();
    assert_eq!(
        manager.commit("operation-change").unwrap(),
        Some(committed.clone())
    );
    assert_eq!(
        manager.abort("operation-change").unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
    assert_eq!(
        manager
            .prepare(
                "operation-change",
                first.revision(),
                fixture.workspace_b.clone(),
            )
            .unwrap(),
        WorkspaceAuthorityPrepareResult::Committed(Some(committed.clone()))
    );
    manager
        .prepare(
            "operation-later",
            committed.revision(),
            fixture.workspace_a.clone(),
        )
        .unwrap();
    assert_eq!(
        manager.commit("operation-change").unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
    manager.commit("operation-later").unwrap();
    assert_eq!(
        manager.commit("operation-change").unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
}

#[test]
fn abort_is_durable_and_idempotent_without_activating_candidate() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let first = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    manager
        .prepare(
            "operation-abort",
            first.revision(),
            fixture.workspace_b.clone(),
        )
        .unwrap();
    manager.abort("operation-abort").unwrap();
    manager.abort("operation-abort").unwrap();
    assert_eq!(manager.authority().current_workspace().unwrap(), &first);
    assert_eq!(
        manager
            .prepare(
                "operation-abort",
                first.revision(),
                fixture.workspace_b.clone(),
            )
            .unwrap(),
        WorkspaceAuthorityPrepareResult::Aborted
    );
    assert_eq!(
        manager.commit("operation-abort").unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
}

#[test]
fn pending_survives_restart_as_recovery_required_until_explicit_abort() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let first = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    manager
        .prepare(
            "operation-pending",
            first.revision(),
            fixture.workspace_b.clone(),
        )
        .unwrap();
    drop(manager);

    let mut reopened = fixture.manager();
    assert_eq!(
        reopened.authority().pending().unwrap().operation_id(),
        "operation-pending"
    );
    assert_eq!(
        reopened.authority().current_workspace().unwrap_err(),
        WorkspaceNativeError::AuthorityRecoveryRequired
    );
    reopened.abort("operation-pending").unwrap();
    assert_eq!(reopened.authority().current_workspace().unwrap(), &first);
}

#[test]
fn vanished_pending_candidate_can_be_audited_and_aborted_after_restart() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let first = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    manager
        .prepare(
            "operation-pending",
            first.revision(),
            fixture.workspace_b.clone(),
        )
        .unwrap();
    drop(manager);
    fs::remove_dir(&fixture.workspace_b).unwrap();

    let mut reopened = fixture.manager();
    assert_eq!(
        reopened.authority().pending().unwrap().operation_id(),
        "operation-pending"
    );
    assert_eq!(
        reopened.commit("operation-pending").unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );
    reopened.abort("operation-pending").unwrap();
    assert_eq!(reopened.authority().current_workspace().unwrap(), &first);
}

#[test]
fn clear_is_two_phase_monotonic_replayable_and_removes_trusted_path() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let first = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    let stable_device_id = manager.authority().device_id().to_string();
    let stable_device_binding_id = manager.authority().device_binding_id().to_string();

    let pending_clear = pending(
        manager
            .prepare_clear("operation-clear-abort", first.revision())
            .unwrap(),
    );
    assert_eq!(pending_clear.candidate(), None);
    assert_eq!(pending_clear.result_revision(), first.revision() + 1);
    manager.abort("operation-clear-abort").unwrap();
    assert_eq!(manager.authority().current_workspace().unwrap(), &first);
    assert_eq!(manager.authority().current_revision(), first.revision());

    manager
        .prepare_clear("operation-clear", first.revision())
        .unwrap();
    assert_eq!(manager.commit("operation-clear").unwrap(), None);
    assert_eq!(manager.commit("operation-clear").unwrap(), None);
    assert_eq!(manager.authority().current_revision(), first.revision() + 1);
    assert_eq!(
        manager.authority().current_workspace().unwrap_err(),
        WorkspaceNativeError::AuthorityUnavailable
    );
    drop(manager);

    let mut reopened = fixture.manager();
    assert_eq!(reopened.authority().device_id(), stable_device_id);
    assert_eq!(
        reopened.authority().device_binding_id(),
        stable_device_binding_id
    );
    assert_eq!(reopened.commit("operation-clear").unwrap(), None);
    let cleared_revision = reopened.authority().current_revision();
    assert_eq!(
        reopened
            .prepare_clear("operation-clear-again", cleared_revision)
            .unwrap_err(),
        WorkspaceNativeError::AuthorityConflict
    );
    let next = commit_workspace(
        &mut reopened,
        "operation-after-clear",
        cleared_revision,
        &fixture.workspace_b,
    );
    assert_eq!(next.revision(), cleared_revision + 1);
    assert_ne!(next.workspace_binding_id(), first.workspace_binding_id());
    assert_ne!(next.incarnation_id(), first.incarnation_id());
    assert_ne!(
        next.workspace_runtime_binding_id(),
        first.workspace_runtime_binding_id()
    );
}

#[test]
fn every_catalog_phase_recovers_an_exact_post_replace_write_result() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    manager.writer = write_then_report_post_replace_unknown;

    assert_eq!(
        manager.begin_selection_intent("unknown-dialog", 0),
        Ok(super::catalog::WorkspaceSelectionBeginResult::Fresh)
    );
    assert_reopens_exact(&fixture, &manager);
    manager
        .prepare_awaiting_selection("unknown-dialog", 0, fixture.workspace_a.clone())
        .unwrap();
    assert_reopens_exact(&fixture, &manager);
    manager.abort("unknown-dialog").unwrap();
    assert_reopens_exact(&fixture, &manager);

    manager.begin_selection_intent("unknown-cancel", 0).unwrap();
    manager
        .record_selection_canceled("unknown-cancel", 0)
        .unwrap();
    assert_reopens_exact(&fixture, &manager);
    assert_eq!(
        manager
            .replay_intent("unknown-cancel", 0, WorkspaceAuthorityIntent::Select)
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::UserCanceled)
    );

    manager
        .prepare("unknown-commit", 0, fixture.workspace_a.clone())
        .unwrap();
    let selected = manager.commit("unknown-commit").unwrap().unwrap();
    assert_reopens_exact(&fixture, &manager);
    manager
        .prepare_clear("unknown-clear", selected.revision())
        .unwrap();
    assert_eq!(manager.commit("unknown-clear").unwrap(), None);
    assert_reopens_exact(&fixture, &manager);
}

#[test]
fn revision_cap_allows_the_last_safe_commit_and_rejects_a_mutation_at_the_cap() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let mut near_cap = manager.authority().clone();
    near_cap.revision = super::catalog::MAX_SAFE_REVISION - 1;
    manager.persist(near_cap).unwrap();
    let selected = commit_workspace(
        &mut manager,
        "revision-last-safe",
        super::catalog::MAX_SAFE_REVISION - 1,
        &fixture.workspace_a,
    );
    assert_eq!(selected.revision(), super::catalog::MAX_SAFE_REVISION);
    let before = fs::read(&manager.catalog_path).unwrap();
    assert_eq!(
        manager.begin_selection_intent("revision-overflow", super::catalog::MAX_SAFE_REVISION,),
        Err(WorkspaceNativeError::AuthorityInvalid)
    );
    assert_eq!(fs::read(&manager.catalog_path).unwrap(), before);
}

#[test]
fn post_replace_state_that_is_not_the_intended_authority_is_unknown() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let before = manager.authority().clone();
    manager.writer = write_different_authority_then_report_unknown;
    assert_eq!(
        manager.begin_selection_intent("unknown-forged", 0),
        Err(WorkspaceNativeError::AuthorityMutationUnknown)
    );
    assert_eq!(manager.authority(), &before);
    assert_ne!(fixture.manager().authority(), &before);
}

#[test]
fn exact_post_replace_state_remains_unknown_when_directory_sync_cannot_be_proven() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let before = manager.authority().clone();
    manager.writer = write_then_report_post_replace_unknown;
    manager.syncer = always_fail_directory_sync;
    assert_eq!(
        manager.begin_selection_intent("unknown-not-durable", 0),
        Err(WorkspaceNativeError::AuthorityMutationUnknown)
    );
    assert_eq!(manager.authority(), &before);
    assert_ne!(fixture.manager().authority(), &before);
}

#[test]
fn mutation_unknown_latch_never_reopens_within_the_same_process_lifetime() {
    let latch = super::catalog_io::CatalogMutationLatch::new();
    assert!(latch.permits_durable_replay());
    latch.mark_unknown();
    assert!(!latch.permits_durable_replay());
    latch.mark_unknown();
    assert!(!latch.permits_durable_replay());
}

#[test]
fn catalog_is_exact_atomic_and_redacted() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    let selected = commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    let entries = fs::read_dir(&fixture.authority_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    assert_eq!(entries, vec!["workspace-authority.json"]);
    assert_eq!(
        format!("{manager:?}"),
        "DesktopWorkspaceAuthorityManager([REDACTED])"
    );
    assert_eq!(
        format!("{:?}", manager.authority()),
        "DesktopWorkspaceAuthority([REDACTED])"
    );
    assert!(!format!("{manager:?}").contains(selected.trusted_path()));

    let catalog_path = fixture.authority_dir.join("workspace-authority.json");
    let mut catalog: serde_json::Value =
        serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
    catalog
        .as_object_mut()
        .unwrap()
        .insert("extra".to_string(), serde_json::Value::Bool(true));
    fs::write(&catalog_path, serde_json::to_vec(&catalog).unwrap()).unwrap();
    assert_eq!(
        DesktopWorkspaceAuthorityManager::open(fixture.authority_dir.clone()).unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );
}

#[test]
fn nested_catalog_snapshots_reject_extra_fields() {
    let fixture = Fixture::new();
    let mut manager = fixture.manager();
    commit_workspace(&mut manager, "operation-first", 0, &fixture.workspace_a);
    drop(manager);
    let catalog_path = fixture.authority_dir.join("workspace-authority.json");
    let mut catalog: serde_json::Value =
        serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
    catalog["current"]
        .as_object_mut()
        .unwrap()
        .insert("extra".to_string(), serde_json::Value::Bool(true));
    fs::write(&catalog_path, serde_json::to_vec(&catalog).unwrap()).unwrap();
    assert_eq!(
        DesktopWorkspaceAuthorityManager::open(fixture.authority_dir.clone()).unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );
}

#[cfg(unix)]
#[test]
fn opened_catalog_identity_cannot_be_substituted_by_a_same_length_file() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first.json");
    let second = root.path().join("second.json");
    fs::write(&first, b"same-length-a").unwrap();
    fs::write(&second, b"same-length-b").unwrap();
    let first_metadata = fs::metadata(&first).unwrap();
    let reopened_first = fs::File::open(&first).unwrap().metadata().unwrap();
    let second_metadata = fs::metadata(&second).unwrap();
    assert!(super::catalog_io::same_file_identity(
        &first_metadata,
        &reopened_first
    ));
    assert!(!super::catalog_io::same_file_identity(
        &first_metadata,
        &second_metadata
    ));
}

#[cfg(unix)]
#[test]
fn permissions_symlinks_and_nonregular_catalogs_fail_closed() {
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::PermissionsExt as _;

    let fixture = Fixture::new();
    let manager = fixture.manager();
    let catalog_path = fixture.authority_dir.join("workspace-authority.json");
    assert_eq!(
        fs::metadata(&fixture.authority_dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&catalog_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    drop(manager);
    fs::set_permissions(&catalog_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        DesktopWorkspaceAuthorityManager::open(fixture.authority_dir.clone()).unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );

    let symlink_fixture = Fixture::new();
    let real_authority = symlink_fixture.root.path().join("real-authority");
    fs::create_dir(&real_authority).unwrap();
    let linked_authority = symlink_fixture.root.path().join("linked-authority");
    symlink(&real_authority, &linked_authority).unwrap();
    assert_eq!(
        DesktopWorkspaceAuthorityManager::open(linked_authority).unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );

    let catalog_fixture = Fixture::new();
    let manager = catalog_fixture.manager();
    let catalog_path = catalog_fixture
        .authority_dir
        .join("workspace-authority.json");
    let target = catalog_fixture.root.path().join("catalog-target");
    fs::copy(&catalog_path, &target).unwrap();
    drop(manager);
    fs::remove_file(&catalog_path).unwrap();
    symlink(&target, &catalog_path).unwrap();
    assert_eq!(
        DesktopWorkspaceAuthorityManager::open(catalog_fixture.authority_dir.clone()).unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );

    let nonregular_fixture = Fixture::new();
    let manager = nonregular_fixture.manager();
    let catalog_path = nonregular_fixture
        .authority_dir
        .join("workspace-authority.json");
    drop(manager);
    fs::remove_file(&catalog_path).unwrap();
    fs::create_dir(&catalog_path).unwrap();
    assert_eq!(
        DesktopWorkspaceAuthorityManager::open(nonregular_fixture.authority_dir.clone())
            .unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );

    let workspace_link_fixture = Fixture::new();
    let mut manager = workspace_link_fixture.manager();
    let linked_workspace = workspace_link_fixture.root.path().join("linked-workspace");
    symlink(&workspace_link_fixture.workspace_a, &linked_workspace).unwrap();
    assert_eq!(
        manager
            .prepare("operation-link", 0, linked_workspace)
            .unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );
}

fn commit_workspace(
    manager: &mut DesktopWorkspaceAuthorityManager,
    operation_id: &str,
    expected_revision: u64,
    path: &Path,
) -> SelectedWorkspaceAuthority {
    let prepared = pending(
        manager
            .prepare(operation_id, expected_revision, path.to_path_buf())
            .unwrap(),
    );
    let candidate = prepared.candidate().unwrap().clone();
    assert_eq!(
        manager.commit(operation_id).unwrap(),
        Some(candidate.clone())
    );
    candidate
}

fn write_then_report_post_replace_unknown(
    directory: &Path,
    path: &Path,
    authority: &super::catalog::DesktopWorkspaceAuthority,
) -> Result<(), CatalogWriteError> {
    write_catalog_with_sync(directory, path, authority, |_| {
        Err(WorkspaceNativeError::AuthorityUnavailable)
    })
}

fn write_different_authority_then_report_unknown(
    directory: &Path,
    path: &Path,
    authority: &super::catalog::DesktopWorkspaceAuthority,
) -> Result<(), CatalogWriteError> {
    let mut different = authority.clone();
    different.device_id = "different-device".to_string();
    write_catalog(directory, path, &different)?;
    Err(CatalogWriteError::AfterReplaceUnknown)
}

fn always_fail_directory_sync(_directory: &Path) -> Result<(), WorkspaceNativeError> {
    Err(WorkspaceNativeError::AuthorityUnavailable)
}

fn assert_reopens_exact(fixture: &Fixture, manager: &DesktopWorkspaceAuthorityManager) {
    assert_eq!(fixture.manager().authority(), manager.authority());
}

fn pending(result: WorkspaceAuthorityPrepareResult) -> super::catalog::PendingWorkspaceAuthority {
    match result {
        WorkspaceAuthorityPrepareResult::Pending(pending) => pending,
        WorkspaceAuthorityPrepareResult::Committed(_)
        | WorkspaceAuthorityPrepareResult::Aborted => {
            panic!("expected pending Workspace authority")
        }
    }
}

struct Fixture {
    root: TempDir,
    authority_dir: std::path::PathBuf,
    workspace_a: std::path::PathBuf,
    workspace_b: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let authority_dir = root.path().join("authority");
        let workspace_a = root.path().join("workspace-a");
        let workspace_b = root.path().join("workspace-b");
        fs::create_dir(&workspace_a).unwrap();
        fs::create_dir(&workspace_b).unwrap();
        Self {
            root,
            authority_dir,
            workspace_a,
            workspace_b,
        }
    }

    fn manager(&self) -> DesktopWorkspaceAuthorityManager {
        DesktopWorkspaceAuthorityManager::open(self.authority_dir.clone()).unwrap()
    }
}
