use std::cell::Cell;
use std::fs;

use pretty_assertions::assert_eq;

use super::prepare_selection_intent;
use super::DesktopWorkspaceMutationRequest;
use super::SelectionIntentOutcome;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;

#[test]
fn same_key_is_durable_before_dialog_and_never_opens_a_second_dialog() {
    let root = tempfile::tempdir().unwrap();
    let authority = root.path().join("authority");
    let mut manager = DesktopWorkspaceAuthorityManager::open(authority.clone()).unwrap();
    let request = DesktopWorkspaceMutationRequest {
        expected_revision: 0,
        idempotency_key: "selection-once".to_string(),
    };
    let calls = Cell::new(0);
    assert!(matches!(
        prepare_selection_intent(&mut manager, &request, || {
            calls.set(calls.get() + 1);
            Ok(None)
        }),
        Ok(SelectionIntentOutcome::UserCanceled)
    ));
    drop(manager);

    let mut reopened = DesktopWorkspaceAuthorityManager::open(authority).unwrap();
    assert!(matches!(
        prepare_selection_intent(&mut reopened, &request, || {
            calls.set(calls.get() + 1);
            Ok(None)
        }),
        Ok(SelectionIntentOutcome::UserCanceled)
    ));
    assert_eq!(calls.get(), 1);
    assert_eq!(reopened.authority().current_revision(), 0);
}

#[test]
fn selected_path_is_frozen_in_the_same_durable_intent() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let mut manager =
        DesktopWorkspaceAuthorityManager::open(root.path().join("authority")).unwrap();
    let request = DesktopWorkspaceMutationRequest {
        expected_revision: 0,
        idempotency_key: "selection-prepared".to_string(),
    };
    assert!(matches!(
        prepare_selection_intent(&mut manager, &request, || Ok(Some(workspace))),
        Ok(SelectionIntentOutcome::Prepared)
    ));
    let pending = manager.authority().pending().unwrap();
    assert_eq!(pending.operation_id(), request.idempotency_key);
    assert_eq!(pending.expected_revision(), request.expected_revision);
    assert_eq!(pending.result_revision(), 1);
}
