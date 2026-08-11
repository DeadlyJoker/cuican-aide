use std::fs;

use pretty_assertions::assert_eq;

use super::DesktopWorkspaceAuthorityManager;
use super::RuntimeRouteProjection;
use super::WorkspaceAuthorityPrepareResult;

#[test]
fn projects_unselected_and_selected_authority_into_exact_runtime_routes() {
    let root = tempfile::tempdir().unwrap();
    let mut manager =
        DesktopWorkspaceAuthorityManager::open(root.path().join("authority")).unwrap();
    assert_eq!(
        RuntimeRouteProjection::from_authority(manager.authority()).unwrap(),
        RuntimeRouteProjection::standalone()
    );

    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let prepared = manager.prepare("operation-select", 0, workspace).unwrap();
    let candidate = match prepared {
        WorkspaceAuthorityPrepareResult::Pending(pending) => pending.candidate().unwrap().clone(),
        WorkspaceAuthorityPrepareResult::Committed(_)
        | WorkspaceAuthorityPrepareResult::Aborted => panic!("expected pending authority"),
    };
    manager.commit("operation-select").unwrap();

    assert_eq!(
        RuntimeRouteProjection::from_authority(manager.authority()).unwrap(),
        RuntimeRouteProjection {
            tenant_id: "standalone-tenant".to_string(),
            agent_version_id: format!(
                "default-agent-v1:{}",
                candidate.workspace_runtime_binding_id()
            ),
            runtime_generation: candidate.workspace_runtime_binding_id().to_string(),
            policy_snapshot_id: "standalone-policy-v0".to_string(),
            workspace_binding_id: Some(candidate.workspace_binding_id().to_string()),
        }
    );
}
