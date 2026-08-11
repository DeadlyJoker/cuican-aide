use std::fs;
use std::fs::File;
use std::sync::Arc;
use std::sync::Barrier;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use crewon_device_protocol::DeviceGatewayWelcome;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::canonical_device_workspace_list_command_signing_payload;
use crewon_device_protocol::parse_device_gateway_welcome;
use crewon_device_protocol::parse_device_workspace_list_command;
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePublicKey as _;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde_json::Value;
use tempfile::TempDir;

use super::DeviceWorkspaceListResult;
use super::admit_workspace_list;
use super::execute_admitted_workspace_list;
use crate::ConnectionEpochFence;
use crate::DeviceCommandAuthorizer;
use crate::NativeDeviceConnection;
use crate::NativeDeviceRuntimeBinding;
use crate::TrustedDeviceCommandKey;
use crate::WorkspaceDirectoryBinding;
use crate::WorkspaceDirectoryEntry;
use crate::WorkspaceDirectoryEntryKind;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;

#[derive(Debug, Deserialize)]
struct Reference {
    valid: ValidReference,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidReference {
    workspace_command: Value,
    welcome: Value,
}

#[test]
fn verifies_shared_command_and_projects_the_exact_ts_result_shape() {
    let directory = TempDir::new().expect("temporary workspace");
    File::create(directory.path().join("z")).expect("z file");
    fs::create_dir(directory.path().join("a")).expect("a directory");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", directory.path())
        .expect("register stable workspace");
    let fixture = signed_reference(&binding);
    let state = TempDir::new().expect("Native state parent");
    let fence = ConnectionEpochFence::open("device-1", state.path().join("state"))
        .expect("open epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let connection = establish(&fence, &authorizer, &fixture.welcome, runtime_binding());
    let verified = connection
        .verify_workspace_list_command(
            &serde_json::to_vec(&fixture.command).expect("serialize workspace command"),
            timestamp("2026-08-08T00:00:03Z"),
        )
        .expect("verify independent signed workspace command");
    assert_eq!(verified.command(), &fixture.command);
    let result = connection
        .start_workspace_list(
            verified,
            timestamp("2026-08-08T00:00:04Z"),
            &registry,
            &WorkspaceListCancellation::default(),
        )
        .expect("execute stable handle listing");
    assert_eq!(
        serde_json::to_value(&result).expect("serialize result"),
        serde_json::json!({
            "schemaVersion": "crewon.workspace-list-result.v0",
            "executionId": "workspace-execution-1",
            "actionDigest": format!("sha256:{}", "a".repeat(64)),
            "commandDigest": format!("sha256:{}", "b".repeat(64)),
            "entries": [
                { "name": "a", "kind": "directory" },
                { "name": "z", "kind": "file" },
            ],
            "truncated": false,
        }),
    );
}

#[test]
fn current_epoch_accepts_workspace_command_after_initial_route_lease_expires() {
    let directory = TempDir::new().expect("temporary workspace");
    File::create(directory.path().join("current")).expect("workspace file");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", directory.path())
        .expect("register stable workspace");
    let fixture = signed_reference(&binding);
    let state = TempDir::new().expect("Native state parent");
    let fence = ConnectionEpochFence::open("device-1", state.path().join("state"))
        .expect("open epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let connection = establish(&fence, &authorizer, &fixture.welcome, runtime_binding());
    let after_initial_route_lease = timestamp("2026-08-08T00:02:00Z");

    let verified = connection
        .verify_workspace_list_command(
            &serde_json::to_vec(&fixture.command).expect("serialize workspace command"),
            after_initial_route_lease,
        )
        .expect("Gateway heartbeat keeps the current epoch routable");
    let result = connection
        .start_workspace_list(
            verified,
            after_initial_route_lease,
            &registry,
            &WorkspaceListCancellation::default(),
        )
        .expect("execute under the current epoch and command lease");

    assert_eq!(
        result,
        DeviceWorkspaceListResult {
            schema_version: "crewon.workspace-list-result.v0".to_string(),
            execution_id: "workspace-execution-1".to_string(),
            action_digest: format!("sha256:{}", "a".repeat(64)),
            command_digest: format!("sha256:{}", "b".repeat(64)),
            entries: vec![WorkspaceDirectoryEntry {
                name: "current".to_string(),
                kind: WorkspaceDirectoryEntryKind::File,
            }],
            truncated: false,
        }
    );
}

#[test]
fn signature_and_current_runtime_bind_every_workspace_authority_field() {
    let directory = TempDir::new().expect("temporary workspace");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", directory.path())
        .expect("register workspace");
    let fixture = signed_reference(&binding);
    let state = TempDir::new().expect("Native state parent");
    let fence = ConnectionEpochFence::open("device-1", state.path().join("state"))
        .expect("open epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let connection = establish(&fence, &authorizer, &fixture.welcome, runtime_binding());

    let mut tampered = vec![
        fixture.command.clone(),
        fixture.command.clone(),
        fixture.command.clone(),
        fixture.command.clone(),
    ];
    tampered[0].workspace_binding_id = "workspace-binding-2".to_string();
    tampered[1].action_digest = format!("sha256:{}", "c".repeat(64));
    tampered[2].command_digest = format!("sha256:{}", "d".repeat(64));
    tampered[3].limits.max_entries -= 1;
    for command in tampered {
        assert_code(
            connection
                .verify_workspace_list_command(
                    &serde_json::to_vec(&command).expect("serialize tampered command"),
                    timestamp("2026-08-08T00:00:03Z"),
                )
                .expect_err("signature binds frozen workspace authority"),
            "device_authorization_signature_invalid",
        );
    }

    for change in [RuntimeChange::DeviceBinding, RuntimeChange::RuntimeBinding] {
        let mut command = fixture.command.clone();
        match change {
            RuntimeChange::DeviceBinding => {
                command.device_binding_id = "device-binding-2".to_string()
            }
            RuntimeChange::RuntimeBinding => {
                command.runtime_binding_id = "runtime-binding-2".to_string()
            }
        }
        sign(&mut command, &fixture.signing_key);
        assert_code(
            connection
                .verify_workspace_list_command(
                    &serde_json::to_vec(&command).expect("serialize wrong runtime command"),
                    timestamp("2026-08-08T00:00:03Z"),
                )
                .expect_err("current runtime binding is authoritative"),
            "device_workspace_runtime_binding_mismatch",
        );
    }
}

#[test]
fn stable_handle_survives_path_replacement_and_old_incarnation_fails_closed() {
    let parent = TempDir::new().expect("temporary parent");
    let workspace = parent.path().join("workspace");
    fs::create_dir(&workspace).expect("workspace");
    File::create(workspace.join("stable")).expect("stable file");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", &workspace)
        .expect("register stable workspace");
    fs::rename(&workspace, parent.path().join("moved")).expect("move workspace");
    fs::create_dir(&workspace).expect("replacement workspace");
    File::create(workspace.join("replacement")).expect("replacement file");
    let fixture = signed_reference(&binding);
    let state = TempDir::new().expect("Native state parent");
    let fence = ConnectionEpochFence::open("device-1", state.path().join("state"))
        .expect("open epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let connection = establish(&fence, &authorizer, &fixture.welcome, runtime_binding());
    assert_eq!(
        execute(&connection, &registry, &fixture.command),
        DeviceWorkspaceListResult {
            schema_version: "crewon.workspace-list-result.v0".to_string(),
            execution_id: fixture.command.execution_id.clone(),
            action_digest: fixture.command.action_digest.clone(),
            command_digest: fixture.command.command_digest.clone(),
            entries: vec![crate::WorkspaceDirectoryEntry {
                name: "stable".to_string(),
                kind: crate::WorkspaceDirectoryEntryKind::File,
            }],
            truncated: false,
        },
    );

    let mut old_incarnation = fixture.command;
    old_incarnation.incarnation_id = "incarnation-obsolete".to_string();
    sign(&mut old_incarnation, &fixture.signing_key);
    let verified = connection
        .verify_workspace_list_command(
            &serde_json::to_vec(&old_incarnation).expect("serialize old incarnation"),
            timestamp("2026-08-08T00:00:03Z"),
        )
        .expect("signature remains valid");
    assert_code(
        connection
            .start_workspace_list(
                verified,
                timestamp("2026-08-08T00:00:04Z"),
                &registry,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("registry rejects old incarnation"),
        "workspace_binding_unavailable",
    );
}

#[test]
fn takeover_cancellation_links_and_output_caps_fail_closed() {
    let directory = TempDir::new().expect("temporary workspace");
    File::create(directory.path().join("entry")).expect("entry");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", directory.path())
        .expect("register workspace");
    let fixture = signed_reference(&binding);
    let state = TempDir::new().expect("Native state parent");
    let fence = ConnectionEpochFence::open("device-1", state.path().join("state"))
        .expect("open epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let old = establish(&fence, &authorizer, &fixture.welcome, runtime_binding());
    let verified = verify(&old, &fixture.command);
    let mut newer_welcome = fixture.welcome.clone();
    newer_welcome.connection_epoch += 1;
    newer_welcome.connection_id = "connection-2".to_string();
    let current = establish(&fence, &authorizer, &newer_welcome, runtime_binding());
    assert_code(
        old.start_workspace_list(
            verified,
            timestamp("2026-08-08T00:00:04Z"),
            &registry,
            &WorkspaceListCancellation::default(),
        )
        .expect_err("new epoch fences old verified command"),
        "device_connection_epoch_stale",
    );

    let canceled = WorkspaceListCancellation::default();
    canceled.cancel();
    assert_code(
        current
            .start_workspace_list(
                verify(&current, &fixture.command),
                timestamp("2026-08-08T00:00:04Z"),
                &registry,
                &canceled,
            )
            .expect_err("cancel before handle acquisition"),
        "workspace_list_canceled",
    );

    let mut output_limited = fixture.command.clone();
    output_limited.limits.max_output_bytes = 8;
    sign(&mut output_limited, &fixture.signing_key);
    assert_code(
        current
            .start_workspace_list(
                verify(&current, &output_limited),
                timestamp("2026-08-08T00:00:04Z"),
                &registry,
                &WorkspaceListCancellation::default(),
            )
            .expect_err("final TS result exceeds command output cap"),
        "workspace_list_output_too_large",
    );

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("entry", directory.path().join("link"))
            .expect("workspace symlink");
        assert_code(
            current
                .start_workspace_list(
                    verify(&current, &fixture.command),
                    timestamp("2026-08-08T00:00:04Z"),
                    &registry,
                    &WorkspaceListCancellation::default(),
                )
                .expect_err("links are never projected"),
            "workspace_list_link_entry_unsupported",
        );
    }
}

#[test]
fn blocked_scan_does_not_block_takeover_and_its_old_epoch_result_is_rejected() {
    let directory = TempDir::new().expect("temporary workspace");
    File::create(directory.path().join("entry")).expect("entry");
    let registry = WorkspaceDirectoryRegistry::new();
    let binding = registry
        .register("workspace-binding-1", directory.path())
        .expect("register workspace");
    let fixture = signed_reference(&binding);
    let state = TempDir::new().expect("Native state parent");
    let fence = ConnectionEpochFence::open("device-1", state.path().join("state"))
        .expect("open epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let old = establish(&fence, &authorizer, &fixture.welcome, runtime_binding());
    let verified = verify(&old, &fixture.command);
    let reached_scan_barrier = Arc::new(Barrier::new(2));
    let release_scan = Arc::new(Barrier::new(2));
    let cancellation = WorkspaceListCancellation::default();
    std::thread::scope(|scope| {
        let thread_reached_scan_barrier = Arc::clone(&reached_scan_barrier);
        let thread_release_scan = Arc::clone(&release_scan);
        let scan = scope.spawn(move || {
            old.start_workspace_list_with_dispatcher(
                verified,
                timestamp("2026-08-08T00:00:04Z"),
                &cancellation,
                |command, cancellation| admit_workspace_list(&registry, command, cancellation),
                |admitted, cancellation| {
                    thread_reached_scan_barrier.wait();
                    thread_release_scan.wait();
                    execute_admitted_workspace_list(admitted, cancellation)
                },
            )
        });
        reached_scan_barrier.wait();

        let mut newer_welcome = fixture.welcome.clone();
        newer_welcome.connection_epoch += 1;
        newer_welcome.connection_id = "connection-2".to_string();
        let _current = establish(&fence, &authorizer, &newer_welcome, runtime_binding());
        release_scan.wait();
        assert_code(
            scan.join()
                .expect("join blocked scan")
                .expect_err("production post-scan fence rejects old result"),
            "device_connection_epoch_stale",
        );
    });
}

enum RuntimeChange {
    DeviceBinding,
    RuntimeBinding,
}

struct SignedReference {
    command: DeviceWorkspaceListCommand,
    welcome: DeviceGatewayWelcome,
    signing_key: SigningKey,
}

fn signed_reference(binding: &WorkspaceDirectoryBinding) -> SignedReference {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve shared Device Protocol fixture");
    let fixture: Reference = serde_json::from_str(
        &fs::read_to_string(fixture_path).expect("read shared Device Protocol fixture"),
    )
    .expect("parse shared Device Protocol fixture");
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let mut command = parse_device_workspace_list_command(fixture.valid.workspace_command)
        .expect("parse shared workspace command");
    command.workspace_binding_id = binding.workspace_binding_id.clone();
    command.incarnation_id = binding.incarnation_id.clone();
    sign(&mut command, &signing_key);
    SignedReference {
        command,
        welcome: parse_device_gateway_welcome(fixture.valid.welcome)
            .expect("parse shared Gateway welcome"),
        signing_key,
    }
}

fn sign(command: &mut DeviceWorkspaceListCommand, signing_key: &SigningKey) {
    command.authorization.signature = "A".repeat(86);
    command.authorization.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(
                canonical_device_workspace_list_command_signing_payload(command)
                    .expect("canonicalize workspace command")
                    .as_bytes(),
            )
            .to_bytes(),
    );
}

fn authorizer(signing_key: &SigningKey) -> DeviceCommandAuthorizer {
    DeviceCommandAuthorizer::new(
        [TrustedDeviceCommandKey {
            key_id: "control-key-1".to_string(),
            public_key_pem: signing_key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .expect("encode Ed25519 public key"),
        }],
        Duration::minutes(5),
    )
    .expect("Native command authorizer")
}

fn runtime_binding() -> NativeDeviceRuntimeBinding {
    NativeDeviceRuntimeBinding::new("device-binding-1", "runtime-binding-1")
        .expect("runtime binding")
}

fn establish<'a>(
    fence: &'a ConnectionEpochFence,
    authorizer: &'a DeviceCommandAuthorizer,
    welcome: &DeviceGatewayWelcome,
    binding: NativeDeviceRuntimeBinding,
) -> NativeDeviceConnection<'a> {
    NativeDeviceConnection::establish_with_runtime_binding(
        fence,
        authorizer,
        binding,
        &serde_json::to_vec(welcome).expect("serialize welcome"),
        timestamp("2026-08-08T00:00:03Z"),
    )
    .expect("establish Native Device connection")
}

fn verify<'a>(
    connection: &NativeDeviceConnection<'a>,
    command: &DeviceWorkspaceListCommand,
) -> crate::VerifiedDeviceWorkspaceListCommand {
    connection
        .verify_workspace_list_command(
            &serde_json::to_vec(command).expect("serialize workspace command"),
            timestamp("2026-08-08T00:00:03Z"),
        )
        .expect("verify workspace command")
}

fn execute(
    connection: &NativeDeviceConnection<'_>,
    registry: &WorkspaceDirectoryRegistry,
    command: &DeviceWorkspaceListCommand,
) -> DeviceWorkspaceListResult {
    connection
        .start_workspace_list(
            verify(connection, command),
            timestamp("2026-08-08T00:00:04Z"),
            registry,
            &WorkspaceListCancellation::default(),
        )
        .expect("execute workspace list")
}

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("parse test timestamp")
        .with_timezone(&Utc)
}

fn assert_code(error: crate::NativeDeviceAdmissionError, expected: &'static str) {
    assert_eq!(error.code, expected);
}
