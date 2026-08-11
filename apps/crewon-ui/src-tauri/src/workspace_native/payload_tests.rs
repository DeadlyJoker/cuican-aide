use std::fs;

use pretty_assertions::assert_eq;
use serde_json::Value;

use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::payload::GatewayReadyAddress;
use super::payload::WorkspaceGatewayLaunchPayloads;
use super::RuntimeRouteProjection;
use super::WorkspaceLaunchMaterial;
use super::WorkspaceLaunchPayloads;
use super::WorkspaceNativeError;
use super::WorkspaceNativeLaunchSession;
use super::WorkspacePayloadConfig;

#[test]
fn payloads_cross_correlate_every_workspace_runtime_and_signing_authority() {
    let fixture = Fixture::new();
    let material = WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap();
    let gateway_launch =
        WorkspaceGatewayLaunchPayloads::build(fixture.manager.authority(), &material).unwrap();
    let payloads = fixture.payloads(&material);
    let worker = json(&payloads.worker_workspace_json().unwrap());
    let gateway = json(&gateway_launch.gateway_registry_json().unwrap());
    let device = json(&payloads.device_bootstrap_json().unwrap());
    let gateway_identity = json(&gateway_launch.gateway_identity_json().unwrap());
    let current = fixture.manager.authority().current_workspace().unwrap();
    let runtime_route =
        RuntimeRouteProjection::from_authority(fixture.manager.authority()).unwrap();

    assert_eq!(worker["authority"]["tenantId"], "standalone-tenant");
    assert_eq!(worker["authority"]["spaceId"], "standalone-space");
    assert_eq!(
        worker["authority"]["policySnapshotId"],
        runtime_route.policy_snapshot_id()
    );
    for key in ["deviceBindingId", "deviceId", "runtimeBindingId"] {
        assert_eq!(worker["authority"][key], device[key]);
    }
    for key in ["workspaceBindingId", "incarnationId"] {
        assert_eq!(worker["authority"][key], device["workspaces"][0][key]);
    }
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
    assert_eq!(
        gateway["workers"][0]["allowedRuntimeBindingIds"][0],
        current.workspace_runtime_binding_id()
    );
    assert_eq!(
        gateway["devices"][0]["deviceId"],
        fixture.manager.authority().device_id()
    );
    assert_eq!(
        worker["signing"]["keyId"],
        gateway["commandSigningKeys"][0]["keyId"]
    );
    assert_eq!(
        gateway["commandSigningKeys"][0],
        device["commandPublicKeys"][0]
    );
    assert_eq!(gateway_identity["kind"], "standaloneWorkspace");
    assert_eq!(
        gateway_identity["gatewayId"],
        material.gateway().identity_id()
    );
    assert_eq!(gateway_identity.get("endpoint"), None);
    assert_eq!(
        json(&gateway_launch.bind_json().unwrap()),
        serde_json::json!({
            "host": "127.0.0.1",
            "port": 0,
        })
    );
    assert_eq!(worker["privateServer"]["port"], 0);
    assert_eq!(worker["gateway"]["endpoint"], "https://127.0.0.1:18443");
    assert_eq!(device["gatewayWssUrl"], "wss://127.0.0.1:18443/device/v1");
    assert_eq!(
        device["tls"]["serverCertificateSha256"],
        material.gateway().certificate_sha256()
    );
    assert_keys(
        &worker,
        &["authority", "gateway", "privateServer", "signing"],
    );
    assert_keys(
        &gateway,
        &["commandSigningKeys", "devices", "schemaVersion", "workers"],
    );
    assert_keys(
        &device,
        &[
            "commandPublicKeys",
            "deviceBindingId",
            "deviceId",
            "gatewayWssUrl",
            "journalPath",
            "runtimeBindingId",
            "schemaVersion",
            "tls",
            "workspaces",
        ],
    );
}

#[test]
fn only_device_bootstrap_contains_native_paths_and_debug_is_redacted() {
    let fixture = Fixture::new();
    let material = WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap();
    let gateway_launch =
        WorkspaceGatewayLaunchPayloads::build(fixture.manager.authority(), &material).unwrap();
    let payloads = fixture.payloads(&material);
    let trusted_path = fixture
        .manager
        .authority()
        .current_workspace()
        .unwrap()
        .trusted_path();
    let worker = String::from_utf8(payloads.worker_workspace_json().unwrap().to_vec()).unwrap();
    let gateway = String::from_utf8(gateway_launch.gateway_registry_json().unwrap()).unwrap();
    let identity = String::from_utf8(gateway_launch.gateway_identity_json().unwrap()).unwrap();
    let device = String::from_utf8(payloads.device_bootstrap_json().unwrap().to_vec()).unwrap();
    assert!(!worker.contains(trusted_path));
    assert!(!gateway.contains(trusted_path));
    assert!(!identity.contains(trusted_path));
    assert!(device.contains(trusted_path));
    assert!(device.contains(fixture.journal.to_str().unwrap()));
    assert_eq!(
        format!("{payloads:?}"),
        "WorkspaceLaunchPayloads([REDACTED])"
    );
    assert!(!format!("{:?}", gateway_launch.gateway_tls()).contains("PRIVATE KEY"));
    assert!(!format!("{payloads:?}").contains(trusted_path));
}

#[test]
fn one_launch_material_is_byte_stable_across_provider_reload() {
    let fixture = Fixture::new();
    let session = WorkspaceNativeLaunchSession::start(fixture.manager.authority()).unwrap();
    let first_gateway = session.gateway_launch(fixture.manager.authority()).unwrap();
    let second_gateway = session.gateway_launch(fixture.manager.authority()).unwrap();
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
        first_gateway.gateway_registry_json().unwrap(),
        second_gateway.gateway_registry_json().unwrap()
    );
    assert_eq!(
        first_gateway.gateway_identity_json().unwrap(),
        second_gateway.gateway_identity_json().unwrap()
    );
    assert_eq!(
        first.device_bootstrap_json().unwrap(),
        second.device_bootstrap_json().unwrap()
    );
    assert_eq!(
        first_gateway.gateway_tls().private_key_pem(),
        second_gateway.gateway_tls().private_key_pem()
    );
    assert_eq!(
        first_gateway.gateway_tls().certificate_pem(),
        second_gateway.gateway_tls().certificate_pem()
    );
    assert_eq!(
        first_gateway.gateway_tls().ca_certificate_pem(),
        second_gateway.gateway_tls().ca_certificate_pem()
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
        WorkspaceLaunchPayloads::build(fixture.manager.authority(), &material, fixture.config(),)
            .unwrap_err(),
        WorkspaceNativeError::AuthorityRecoveryRequired
    );
}

#[test]
fn committed_clear_makes_material_and_old_session_unavailable() {
    let mut fixture = Fixture::new();
    let session = WorkspaceNativeLaunchSession::start(fixture.manager.authority()).unwrap();
    let revision = fixture.manager.authority().current_revision();
    fixture
        .manager
        .prepare_clear("operation-clear", revision)
        .unwrap();
    fixture.manager.commit("operation-clear").unwrap();
    assert_eq!(
        WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap_err(),
        WorkspaceNativeError::AuthorityUnavailable
    );
    assert_eq!(
        session
            .gateway_launch(fixture.manager.authority())
            .unwrap_err(),
        WorkspaceNativeError::AuthorityUnavailable
    );
    assert_eq!(
        session
            .runtime_launch(fixture.manager.authority(), fixture.config())
            .unwrap_err(),
        WorkspaceNativeError::AuthorityUnavailable
    );
}

#[test]
fn payload_config_rejects_relative_paths_unready_ports_and_deadlines() {
    let fixture = Fixture::new();
    let material = WorkspaceLaunchMaterial::generate(fixture.manager.authority()).unwrap();
    for config in [
        WorkspacePayloadConfig {
            journal_path: "relative-journal.sqlite".into(),
            ..fixture.config()
        },
        WorkspacePayloadConfig {
            gateway_deadline_ms: 999,
            ..fixture.config()
        },
    ] {
        assert_eq!(
            WorkspaceLaunchPayloads::build(fixture.manager.authority(), &material, config)
                .unwrap_err(),
            WorkspaceNativeError::PayloadInvalid
        );
    }
    assert_eq!(
        GatewayReadyAddress::loopback(0).unwrap_err(),
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
    journal: std::path::PathBuf,
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
            | WorkspaceAuthorityPrepareResult::Aborted => {
                panic!("expected pending authority")
            }
        }
        manager.commit("operation-first").unwrap();
        let journal = root.path().join("device-journal.sqlite");
        Self {
            root,
            manager,
            journal,
        }
    }

    fn config(&self) -> WorkspacePayloadConfig {
        WorkspacePayloadConfig {
            gateway_ready: GatewayReadyAddress::loopback(18_443).unwrap(),
            journal_path: self.journal.clone(),
            gateway_deadline_ms: 30_000,
        }
    }

    fn payloads<'a>(
        &'a self,
        material: &'a WorkspaceLaunchMaterial,
    ) -> WorkspaceLaunchPayloads<'a> {
        WorkspaceLaunchPayloads::build(self.manager.authority(), material, self.config()).unwrap()
    }
}
