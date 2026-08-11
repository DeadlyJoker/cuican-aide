use std::fs;
use std::path::Path;

use pretty_assertions::assert_eq;

use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::WorkspaceAuthorityIntent;
use super::catalog::WorkspaceAuthorityIntentReplay;
use super::catalog::WorkspaceAuthorityPendingPhase;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::WorkspaceNativeError;

#[test]
fn v1_requires_explicit_intent_and_phase_and_rejects_future_schema_without_rewrite() {
    for missing in ["intent", "phase"] {
        let fixture = Fixture::new();
        let mut manager = fixture.manager();
        manager
            .begin_selection_intent("selection-awaiting", 0)
            .unwrap();
        drop(manager);
        let mut value = fixture.value();
        value["pending"].as_object_mut().unwrap().remove(missing);
        let bytes = fixture.write(&value);
        assert_invalid_without_rewrite(&fixture, &bytes);
    }

    let fixture = Fixture::new();
    drop(fixture.manager());
    let mut value = fixture.value();
    value["schemaVersion"] = serde_json::json!("crewon.desktop-workspace-authority.v2");
    let bytes = fixture.write(&value);
    assert_invalid_without_rewrite(&fixture, &bytes);
}

#[test]
fn migrates_v0_select_and_clear_prepared_authority_with_required_v1_fields() {
    let select = Fixture::new();
    let mut manager = select.manager();
    manager
        .prepare("legacy-select", 0, select.workspace_a.clone())
        .unwrap();
    drop(manager);
    select.write_v0_without_transition_fields();
    let reopened = select.manager();
    let pending = reopened.authority().pending().unwrap();
    assert_eq!(pending.phase(), WorkspaceAuthorityPendingPhase::Prepared);
    assert_eq!(pending.intent(), WorkspaceAuthorityIntent::Select);
    assert_v1_transition_fields(&select);

    let clear = Fixture::new();
    let mut manager = clear.manager();
    let selected = commit(&mut manager, "select-first", 0, &clear.workspace_a);
    manager
        .prepare_clear("legacy-clear", selected.revision())
        .unwrap();
    drop(manager);
    clear.write_v0_without_transition_fields();
    let reopened = clear.manager();
    let pending = reopened.authority().pending().unwrap();
    assert_eq!(pending.phase(), WorkspaceAuthorityPendingPhase::Prepared);
    assert_eq!(pending.intent(), WorkspaceAuthorityIntent::Clear);
    assert_v1_transition_fields(&clear);
}

#[test]
fn migrates_v0_committed_and_aborted_receipts_without_changing_their_result() {
    let committed = Fixture::new();
    let mut manager = committed.manager();
    let selected = commit(&mut manager, "legacy-committed", 0, &committed.workspace_a);
    drop(manager);
    committed.write_v0_without_transition_fields();
    assert_eq!(
        committed
            .manager()
            .replay_intent("legacy-committed", 0, WorkspaceAuthorityIntent::Select)
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::Committed(Some(selected)))
    );

    let aborted = Fixture::new();
    let mut manager = aborted.manager();
    let selected = commit(&mut manager, "select-first", 0, &aborted.workspace_a);
    manager
        .prepare(
            "legacy-aborted",
            selected.revision(),
            aborted.workspace_b.clone(),
        )
        .unwrap();
    manager.abort("legacy-aborted").unwrap();
    drop(manager);
    aborted.write_v0_without_transition_fields();
    assert_eq!(
        aborted
            .manager()
            .replay_intent(
                "legacy-aborted",
                selected.revision(),
                WorkspaceAuthorityIntent::Select
            )
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::Aborted)
    );
}

#[test]
fn recovers_v0_noop_pending_as_a_legacy_receipt_for_select_and_clear() {
    let select = Fixture::new();
    let mut manager = select.manager();
    let selected = commit(&mut manager, "select-first", 0, &select.workspace_a);
    drop(manager);
    let mut value = select.value();
    value["schemaVersion"] = serde_json::json!("crewon.desktop-workspace-authority.v0");
    value["lastOperation"] = serde_json::Value::Null;
    value["pending"] = serde_json::json!({
        "operationId": "legacy-select-noop-pending",
        "expectedRevision": selected.revision(),
        "resultRevision": selected.revision(),
        "candidate": value["current"].clone(),
    });
    select.write(&value);
    let reopened = select.manager();
    assert_eq!(reopened.authority().pending(), None);
    assert_eq!(
        reopened
            .replay_intent(
                "legacy-select-noop-pending",
                selected.revision(),
                WorkspaceAuthorityIntent::Select
            )
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::LegacyNoOp)
    );

    let clear = Fixture::new();
    drop(clear.manager());
    let mut value = clear.value();
    value["schemaVersion"] = serde_json::json!("crewon.desktop-workspace-authority.v0");
    value["pending"] = serde_json::json!({
        "operationId": "legacy-clear-noop-pending",
        "expectedRevision": 0,
        "resultRevision": 0,
        "candidate": null,
    });
    clear.write(&value);
    assert_eq!(
        clear
            .manager()
            .replay_intent(
                "legacy-clear-noop-pending",
                0,
                WorkspaceAuthorityIntent::Clear
            )
            .unwrap(),
        Some(WorkspaceAuthorityIntentReplay::LegacyNoOp)
    );
}

#[test]
fn migrates_v0_noop_committed_and_aborted_receipts_as_legacy_noop() {
    for resolution in ["committed", "aborted"] {
        for clear in [false, true] {
            let fixture = Fixture::new();
            let mut manager = fixture.manager();
            let revision = if clear {
                0
            } else {
                commit(&mut manager, "select-first", 0, &fixture.workspace_a).revision()
            };
            drop(manager);
            let mut value = fixture.value();
            value["schemaVersion"] = serde_json::json!("crewon.desktop-workspace-authority.v0");
            value["lastOperation"] = serde_json::json!({
                "operationId": format!("legacy-noop-{resolution}-{clear}"),
                "expectedRevision": revision,
                "resultRevision": revision,
                "candidate": value["current"].clone(),
                "resolution": resolution,
            });
            let operation_id = format!("legacy-noop-{resolution}-{clear}");
            fixture.write(&value);
            assert_eq!(
                fixture
                    .manager()
                    .replay_intent(
                        &operation_id,
                        revision,
                        if clear {
                            WorkspaceAuthorityIntent::Clear
                        } else {
                            WorkspaceAuthorityIntent::Select
                        }
                    )
                    .unwrap(),
                Some(WorkspaceAuthorityIntentReplay::LegacyNoOp)
            );
        }
    }
}

#[test]
fn invalid_v0_migration_preserves_the_exact_old_bytes() {
    let fixture = Fixture::new();
    drop(fixture.manager());
    let mut value = fixture.value();
    value["schemaVersion"] = serde_json::json!("crewon.desktop-workspace-authority.v0");
    value["pending"] = serde_json::json!({
        "operationId": "legacy-invalid-gap",
        "expectedRevision": 0,
        "resultRevision": 2,
        "candidate": null,
    });
    let bytes = fixture.write(&value);
    assert_invalid_without_rewrite(&fixture, &bytes);
}

fn assert_v1_transition_fields(fixture: &Fixture) {
    let value = fixture.value();
    assert_eq!(
        value["schemaVersion"],
        serde_json::json!("crewon.desktop-workspace-authority.v1")
    );
    let transition = value["pending"]
        .as_object()
        .or_else(|| value["lastOperation"].as_object())
        .unwrap();
    assert!(transition.contains_key("intent"));
    if value["pending"].is_object() {
        assert!(transition.contains_key("phase"));
    }
}

fn assert_invalid_without_rewrite(fixture: &Fixture, bytes: &[u8]) {
    assert_eq!(
        DesktopWorkspaceAuthorityManager::open(fixture.authority_dir.clone()).unwrap_err(),
        WorkspaceNativeError::AuthorityInvalid
    );
    assert_eq!(fs::read(fixture.catalog_path()).unwrap(), bytes);
}

fn commit(
    manager: &mut DesktopWorkspaceAuthorityManager,
    operation_id: &str,
    expected_revision: u64,
    path: &Path,
) -> super::catalog::SelectedWorkspaceAuthority {
    let WorkspaceAuthorityPrepareResult::Pending(pending) = manager
        .prepare(operation_id, expected_revision, path.to_path_buf())
        .unwrap()
    else {
        panic!("expected pending Workspace authority");
    };
    manager.commit(operation_id).unwrap();
    pending.candidate().unwrap().clone()
}

struct Fixture {
    _root: tempfile::TempDir,
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
            _root: root,
            authority_dir,
            workspace_a,
            workspace_b,
        }
    }

    fn manager(&self) -> DesktopWorkspaceAuthorityManager {
        DesktopWorkspaceAuthorityManager::open(self.authority_dir.clone()).unwrap()
    }

    fn catalog_path(&self) -> std::path::PathBuf {
        self.authority_dir.join("workspace-authority.json")
    }

    fn value(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.catalog_path()).unwrap()).unwrap()
    }

    fn write(&self, value: &serde_json::Value) -> Vec<u8> {
        let bytes = serde_json::to_vec(value).unwrap();
        fs::write(self.catalog_path(), &bytes).unwrap();
        bytes
    }

    fn write_v0_without_transition_fields(&self) {
        let mut value = self.value();
        value["schemaVersion"] = serde_json::json!("crewon.desktop-workspace-authority.v0");
        for name in ["pending", "lastOperation"] {
            if let Some(object) = value[name].as_object_mut() {
                object.remove("intent");
                object.remove("phase");
            }
        }
        self.write(&value);
    }
}
