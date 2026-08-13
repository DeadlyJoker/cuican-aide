use std::fs;

use pretty_assertions::assert_eq;
use serde_json::Value;

use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::RuntimeRouteProjection;
use super::WorkspaceLaunchMaterial;
use super::WorkspaceLaunchPayloads;
use super::WorkspaceNativeError;
use super::WorkspaceNativeLaunchSession;
use super::WorkspacePayloadConfig;

#[test]
fn worker_payload_projects_only_local_workspace_authority() {
    let fixture = Fixture::new();
    let material = WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap();
    let payloads = fixture.payloads(&material);
    let worker = json(&payloads.worker_workspace_json().unwrap());
    let current = fixture.manager.authority().current_workspace().unwrap();
    let runtime_route =
        RuntimeRouteProjection::from_authority(fixture.manager.authority()).unwrap();

    assert_eq!(worker["authority"]["tenantId"], "standalone-tenant");
    assert_eq!(worker["authority"]["spaceId"], "standalone-space");
    assert_eq!(
        worker["authority"]["policySnapshotId"],
        runtime_route.policy_snapshot_id()
    );
    assert_eq!(
        worker["authority"]["workspaceBindingId"],
        runtime_route.workspace_binding_id().unwrap()
    );
    assert_eq!(
        worker["authority"]["incarnationId"],
        current.incarnation_id()
    );
    assert_eq!(
        worker["authority"]["runtimeBindingId"],
        runtime_route.runtime_generation()
    );
    assert_eq!(worker["privateServer"]["port"], 0);
    assert_eq!(worker["dispatchMode"], "local");
    assert_eq!(worker["trustedLocalPath"], current.trusted_path());
    assert_eq!(worker["deadlineMs"], 30_000);
    assert_keys(
        &worker,
        &[
            "authority",
            "deadlineMs",
            "dispatchMode",
            "privateServer",
            "signing",
            "trustedLocalPath",
        ],
    );
}

#[test]
fn worker_bootstrap_debug_is_redacted() {
    let fixture = Fixture::new();
    let material = WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap();
    let payloads = fixture.payloads(&material);
    let trusted_path = fixture
        .manager
        .authority()
        .current_workspace()
        .unwrap()
        .trusted_path();
    let worker = String::from_utf8(payloads.worker_workspace_json().unwrap().to_vec()).unwrap();
    assert!(worker.contains(trusted_path));
    assert_eq!(
        format!("{payloads:?}"),
        "WorkspaceLaunchPayloads([REDACTED])"
    );
    assert!(!format!("{payloads:?}").contains(trusted_path));
}

#[test]
fn one_launch_material_is_byte_stable_across_provider_reload() {
    let fixture = Fixture::new();
    let session = WorkspaceNativeLaunchSession::start(fixture.manager.authority()).unwrap();
    let first = session
        .runtime_launch(fixture.manager.authority(), fixture.config())
        .unwrap();
    let second = session
        .runtime_launch(fixture.manager.authority(), fixture.config())
        .unwrap();
    assert_eq!(
        first.worker_workspace_json().unwrap(),
        second.worker_workspace_json().unwrap()
    );
    assert_eq!(
        format!("{session:?}"),
        "WorkspaceNativeLaunchSession([REDACTED])"
    );
}

#[test]
fn pending_workspace_blocks_old_material_and_payload_until_recovered() {
    let mut fixture = Fixture::new();
    let material = WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap();
    let next_workspace = fixture.root.path().join("workspace-next");
    fs::create_dir(&next_workspace).unwrap();
    fixture
        .manager
        .prepare(
            "operation-next",
            fixture.manager.authority().current_revision(),
            next_workspace,
        )
        .unwrap();
    assert_eq!(
        WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap_err(),
        WorkspaceNativeError::AuthorityRecoveryRequired
    );
    assert_eq!(
        WorkspaceLaunchPayloads::build(fixture.manager.authority(), &material, fixture.config())
            .unwrap_err(),
        WorkspaceNativeError::AuthorityRecoveryRequired
    );
}

#[test]
fn payload_rejects_unbounded_deadline() {
    let fixture = Fixture::new();
    let material = WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap();
    assert_eq!(
        WorkspaceLaunchPayloads::build(
            fixture.manager.authority(),
            &material,
            WorkspacePayloadConfig { deadline_ms: 999 },
        )
        .unwrap_err(),
        WorkspaceNativeError::PayloadInvalid
    );
}

fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

fn assert_keys(value: &Value, expected: &[&str]) {
    let mut actual = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    actual.sort_unstable();
    assert_eq!(actual, expected);
}

struct Fixture {
    root: tempfile::TempDir,
    manager: DesktopWorkspaceAuthorityManager,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace-private-name");
        fs::create_dir(&workspace).unwrap();
        let mut manager =
            DesktopWorkspaceAuthorityManager::open(root.path().join("authority")).unwrap();
        match manager.prepare("operation-first", 0, workspace).unwrap() {
            WorkspaceAuthorityPrepareResult::Pending(_) => {}
            WorkspaceAuthorityPrepareResult::Committed(_)
            | WorkspaceAuthorityPrepareResult::Aborted => panic!("expected pending authority"),
        }
        manager.commit("operation-first").unwrap();
        Self { root, manager }
    }

    fn config(&self) -> WorkspacePayloadConfig {
        WorkspacePayloadConfig {
            deadline_ms: 30_000,
        }
    }

    fn payloads<'a>(
        &'a self,
        material: &'a WorkspaceLaunchMaterial,
    ) -> WorkspaceLaunchPayloads<'a> {
        WorkspaceLaunchPayloads::build(self.manager.authority(), material, self.config()).unwrap()
    }
}
