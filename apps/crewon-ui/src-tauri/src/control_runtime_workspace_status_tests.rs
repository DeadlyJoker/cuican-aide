use pretty_assertions::assert_eq;
use serde_json::json;

use super::project_status;
use crate::control_runtime::ControlRuntimeSupervisor;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;

#[test]
fn unavailable_supervisor_projects_redacted_catalog_without_claiming_runtime() {
    let root = tempfile::tempdir().unwrap();
    let manager = DesktopWorkspaceAuthorityManager::open(root.path().join("authority")).unwrap();
    let status = project_status(
        &ControlRuntimeSupervisor::unavailable(),
        manager.authority(),
        false,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(status).unwrap(),
        json!({
            "schemaVersion": "crewon.desktop-workspace-status.v0",
            "availability": "unavailable",
            "revision": 0,
            "supervisorGeneration": 0,
            "current": null,
        })
    );
}
