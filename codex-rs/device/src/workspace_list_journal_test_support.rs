use std::fs;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use crewon_device_protocol::DeviceGatewayWelcome;
use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::canonical_device_workspace_list_command_signing_payload;
use crewon_device_protocol::parse_device_gateway_welcome;
use crewon_device_protocol::parse_device_workspace_list_command;
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePublicKey as _;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use serde::Deserialize;
use serde_json::Value;

use crate::ConnectionEpochFence;
use crate::DeviceCommandAuthorizer;
use crate::NativeDeviceConnection;
use crate::NativeDeviceRuntimeBinding;
use crate::TrustedDeviceCommandKey;
use crate::WorkspaceDirectoryBinding;

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

pub(crate) struct SignedFixture {
    pub command: DeviceWorkspaceListCommand,
    pub welcome: DeviceGatewayWelcome,
    pub signing_key: SigningKey,
}

pub(crate) fn signed_fixture(
    binding: &WorkspaceDirectoryBinding,
    execution_suffix: u16,
) -> SignedFixture {
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
        .expect("parse shared Workspace command");
    command.workspace_binding_id = binding.workspace_binding_id.clone();
    command.incarnation_id = binding.incarnation_id.clone();
    command.execution_id = format!("workspace-execution-{execution_suffix}");
    command.lease_id = format!("workspace-lease-{execution_suffix}");
    command.idempotency_key = format!("workspace-list-key-{execution_suffix}");
    sign(&mut command, &signing_key);
    SignedFixture {
        command,
        welcome: parse_device_gateway_welcome(fixture.valid.welcome)
            .expect("parse shared Gateway welcome"),
        signing_key,
    }
}

pub(crate) fn second_command(fixture: &SignedFixture) -> DeviceWorkspaceListCommand {
    let mut command = fixture.command.clone();
    command.execution_id = format!("{}-second", fixture.command.execution_id);
    command.lease_id = format!("{}-second", fixture.command.lease_id);
    command.idempotency_key = format!("{}-second", fixture.command.idempotency_key);
    command.action_digest = format!("sha256:{}", "c".repeat(64));
    command.command_digest = format!("sha256:{}", "d".repeat(64));
    sign(&mut command, &fixture.signing_key);
    command
}

pub(crate) fn sign(command: &mut DeviceWorkspaceListCommand, signing_key: &SigningKey) {
    command.authorization.signature = "A".repeat(86);
    command.authorization.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(
                canonical_device_workspace_list_command_signing_payload(command)
                    .expect("canonicalize Workspace command")
                    .as_bytes(),
            )
            .to_bytes(),
    );
}

pub(crate) fn authorizer(signing_key: &SigningKey) -> DeviceCommandAuthorizer {
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

pub(crate) fn establish<'a>(
    fence: &'a ConnectionEpochFence,
    authorizer: &'a DeviceCommandAuthorizer,
    welcome: &DeviceGatewayWelcome,
    now: &str,
) -> NativeDeviceConnection<'a> {
    NativeDeviceConnection::establish_with_runtime_binding(
        fence,
        authorizer,
        NativeDeviceRuntimeBinding::new("device-binding-1", "runtime-binding-1")
            .expect("runtime binding"),
        &serde_json::to_vec(welcome).expect("serialize welcome"),
        timestamp(now),
    )
    .expect("establish Native Device connection")
}

pub(crate) fn newer_welcome(
    welcome: &DeviceGatewayWelcome,
    lease_expires_at: &str,
) -> DeviceGatewayWelcome {
    let mut newer = welcome.clone();
    newer.connection_epoch += 1;
    newer.connection_id = format!("connection-{}", newer.connection_epoch);
    newer.lease_expires_at = lease_expires_at.to_string();
    newer
}

pub(crate) fn command_frame(command: &DeviceWorkspaceListCommand) -> Vec<u8> {
    serde_json::to_vec(command).expect("serialize Workspace command")
}

pub(crate) fn ack(
    accepted: &DeviceWorkspaceListEvent,
    through_sequence: u64,
    acknowledged_at: &str,
) -> DeviceWorkspaceListAck {
    let DeviceWorkspaceListEvent::Accepted { envelope, .. } = accepted else {
        panic!("accepted fixture required");
    };
    DeviceWorkspaceListAck {
        schema_version: "crewon.device-workspace-list-ack.v0".to_string(),
        protocol_version: envelope.protocol_version,
        command_kind: envelope.command_kind.clone(),
        device_id: envelope.device_id.clone(),
        execution_id: envelope.execution_id.clone(),
        receipt_id: envelope.receipt_id.clone(),
        connection_epoch: envelope.connection_epoch,
        workspace_binding_id: envelope.workspace_binding_id.clone(),
        incarnation_id: envelope.incarnation_id.clone(),
        device_binding_id: envelope.device_binding_id.clone(),
        runtime_binding_id: envelope.runtime_binding_id.clone(),
        action_digest: envelope.action_digest.clone(),
        command_digest: envelope.command_digest.clone(),
        through_sequence,
        acknowledged_at: acknowledged_at.to_string(),
    }
}

pub(crate) fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("parse test timestamp")
        .with_timezone(&Utc)
}
