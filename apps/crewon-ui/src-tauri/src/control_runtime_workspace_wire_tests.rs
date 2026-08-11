use pretty_assertions::assert_eq;
use serde_json::json;

use super::DesktopWorkspaceAvailability;
use super::DesktopWorkspaceCertainty;
use super::DesktopWorkspaceError;
use super::DesktopWorkspaceMutationRequest;
use super::DesktopWorkspaceStatus;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::WorkspaceAuthorityPrepareResult;

#[test]
fn status_wire_is_exact_and_contains_only_display_metadata() {
    let fixture = fixture();
    let status = DesktopWorkspaceStatus::project(
        fixture.manager.authority(),
        DesktopWorkspaceAvailability::Available,
        7,
    )
    .unwrap();
    let value = serde_json::to_value(status).unwrap();
    assert_eq!(
        value,
        json!({
            "schemaVersion": "crewon.desktop-workspace-status.v0",
            "availability": "available",
            "revision": 1,
            "supervisorGeneration": 7,
            "current": { "displayName": "selected-project" },
        })
    );
    let serialized = value.to_string();
    assert!(!serialized.contains(fixture.root.path().to_str().unwrap()));
    for private in [
        "trustedPath",
        "workspaceBindingId",
        "deviceBindingId",
        "runtimeBindingId",
        "incarnationId",
        "token",
        "secret",
    ] {
        assert!(!serialized.contains(private));
    }
}

#[test]
fn mutation_request_matches_renderer_and_rejects_noncanonical_keys() {
    assert_eq!(
        DesktopWorkspaceMutationRequest::parse(Some(json!({
            "expectedRevision": 4,
            "idempotencyKey": "workspace-select:test-key",
        })))
        .unwrap(),
        DesktopWorkspaceMutationRequest {
            expected_revision: 4,
            idempotency_key: "workspace-select:test-key".to_string(),
        }
    );
    for invalid in [
        None,
        Some(json!({ "expectedRevision": -1, "idempotencyKey": "key" })),
        Some(json!({ "expectedRevision": 1, "idempotencyKey": "bad key" })),
        Some(json!({ "expectedRevision": 1, "idempotencyKey": "_bad" })),
        Some(json!({
            "expectedRevision": 1,
            "idempotencyKey": "key",
            "path": "/private",
        })),
    ] {
        assert_eq!(
            DesktopWorkspaceMutationRequest::parse(invalid).unwrap_err(),
            DesktopWorkspaceError::request_invalid()
        );
    }
}

#[test]
fn error_wire_is_structured_bounded_and_has_explicit_certainty() {
    assert_eq!(
        serde_json::to_value(DesktopWorkspaceError::new(
            503,
            "desktop_workspace_mutation_aborted",
            DesktopWorkspaceCertainty::PossiblySent,
        ))
        .unwrap(),
        json!({
            "schemaVersion": "crewon.desktop-workspace-error.v0",
            "status": 503,
            "code": "desktop_workspace_mutation_aborted",
            "certainty": "possiblySent",
        })
    );
}

struct Fixture {
    root: tempfile::TempDir,
    manager: DesktopWorkspaceAuthorityManager,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("selected-project");
    std::fs::create_dir(&workspace).unwrap();
    let mut manager =
        DesktopWorkspaceAuthorityManager::open(root.path().join("authority")).unwrap();
    match manager.prepare("operation-first", 0, workspace).unwrap() {
        WorkspaceAuthorityPrepareResult::Pending(_) => {}
        WorkspaceAuthorityPrepareResult::Committed(_)
        | WorkspaceAuthorityPrepareResult::Aborted => panic!("expected pending authority"),
    }
    manager.commit("operation-first").unwrap();
    Fixture { root, manager }
}
