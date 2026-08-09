use std::cell::Cell;
use std::fs;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceGatewayWelcome;
use crewon_device_protocol::MAX_DEVICE_COMMAND_BYTES;
use crewon_device_protocol::canonical_device_command_signing_payload;
use crewon_device_protocol::parse_device_execution_command;
use crewon_device_protocol::parse_device_gateway_welcome;
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePublicKey as _;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde_json::Value;
use tempfile::TempDir;

use super::DeviceCommandAuthorizer;
use super::NativeDeviceConnection;
use super::TrustedDeviceCommandKey;
use crate::ConnectionEpochFence;

#[derive(Debug, Deserialize)]
struct Reference {
    valid: ValidReference,
}

#[derive(Debug, Deserialize)]
struct ValidReference {
    command: Value,
    welcome: Value,
}

#[test]
fn verifies_and_starts_one_signed_command_under_the_epoch_permit() {
    let fixture = signed_reference();
    let directory = TempDir::new().expect("create Native state parent");
    let fence = ConnectionEpochFence::open("device-1", directory.path().join("state"))
        .expect("open Native epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let connection = NativeDeviceConnection::establish(
        &fence,
        &authorizer,
        &serde_json::to_vec(&fixture.welcome).expect("serialize welcome"),
        timestamp("2026-08-08T00:00:03Z"),
    )
    .expect("establish Native Device connection");
    let verified = connection
        .verify_command(
            &serde_json::to_vec(&fixture.command).expect("serialize command"),
            timestamp("2026-08-08T00:00:03Z"),
        )
        .expect("verify signed Device command");
    assert_eq!(verified.command(), &fixture.command);
    let starts = Cell::new(0);
    let execution_id = connection
        .start_command(verified, timestamp("2026-08-08T00:00:04Z"), |command| {
            starts.set(starts.get() + 1);
            command.execution_id.clone()
        })
        .expect("start command under current epoch");
    assert_eq!(execution_id, "execution-1");
    assert_eq!(starts.get(), 1);
}

#[test]
fn a_takeover_between_verification_and_start_fences_the_old_socket() {
    let fixture = signed_reference();
    let directory = TempDir::new().expect("create Native state parent");
    let fence = ConnectionEpochFence::open("device-1", directory.path().join("state"))
        .expect("open Native epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let old = establish(&fence, &authorizer, &fixture.welcome);
    let verified = old
        .verify_command(
            &serde_json::to_vec(&fixture.command).expect("serialize command"),
            timestamp("2026-08-08T00:00:03Z"),
        )
        .expect("verify command on old socket");
    let mut newer_welcome = fixture.welcome;
    newer_welcome.connection_epoch += 1;
    newer_welcome.connection_id = "connection-2".to_string();
    newer_welcome.gateway_id = "gateway-2".to_string();
    let newer = establish(&fence, &authorizer, &newer_welcome);
    let starts = Cell::new(0);

    assert_eq!(
        old.start_command(verified, timestamp("2026-08-08T00:00:04Z"), |_| starts
            .set(starts.get() + 1),)
            .expect_err("takeover fences command verified on old socket")
            .code,
        "device_connection_epoch_stale",
    );
    assert_eq!(starts.get(), 0);
    let verified = newer
        .verify_command(
            &serde_json::to_vec(&fixture.command).expect("serialize command"),
            timestamp("2026-08-08T00:00:04Z"),
        )
        .expect("verify command on new socket");
    newer
        .start_command(verified, timestamp("2026-08-08T00:00:04Z"), |_| {
            starts.set(starts.get() + 1)
        })
        .expect("new socket starts command");
    assert_eq!(starts.get(), 1);
}

#[test]
fn rejects_signature_mutation_unknown_key_and_expiry_before_start() {
    let fixture = signed_reference();
    let directory = TempDir::new().expect("create Native state parent");
    let fence = ConnectionEpochFence::open("device-1", directory.path().join("state"))
        .expect("open Native epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    let connection = establish(&fence, &authorizer, &fixture.welcome);
    let mut mutated = fixture.command.clone();
    mutated.lease_epoch += 1;
    assert_eq!(
        connection
            .verify_command(
                &serde_json::to_vec(&mutated).expect("serialize mutated command"),
                timestamp("2026-08-08T00:00:03Z"),
            )
            .expect_err("reject mutation after signing")
            .code,
        "device_authorization_signature_invalid",
    );
    let mut unknown = fixture.command.clone();
    unknown.authorization.key_id = "unknown-key".to_string();
    assert_eq!(
        connection
            .verify_command(
                &serde_json::to_vec(&unknown).expect("serialize unknown-key command"),
                timestamp("2026-08-08T00:00:03Z"),
            )
            .expect_err("reject unknown command key")
            .code,
        "device_authorization_key_unknown",
    );
    let verified = connection
        .verify_command(
            &serde_json::to_vec(&fixture.command).expect("serialize command"),
            timestamp("2026-08-08T00:00:03Z"),
        )
        .expect("verify command before authorization expiry");
    assert_eq!(
        connection
            .start_command(verified, timestamp("2026-08-08T00:30:01Z"), |_| panic!(
                "expired command must not start"
            ),)
            .expect_err("recheck authorization expiry at side-effect start")
            .code,
        "device_authorization_expired",
    );
}

#[test]
fn rejects_malformed_and_oversized_raw_frames_before_protocol_admission() {
    let fixture = signed_reference();
    let directory = TempDir::new().expect("create Native state parent");
    let fence = ConnectionEpochFence::open("device-1", directory.path().join("state"))
        .expect("open Native epoch fence");
    let authorizer = authorizer(&fixture.signing_key);
    assert_eq!(
        NativeDeviceConnection::establish(
            &fence,
            &authorizer,
            b"not-json",
            timestamp("2026-08-08T00:00:03Z"),
        )
        .expect_err("reject malformed welcome frame")
        .code,
        "device_welcome_invalid",
    );
    let connection = establish(&fence, &authorizer, &fixture.welcome);
    assert_eq!(
        connection
            .verify_command(
                &vec![b' '; MAX_DEVICE_COMMAND_BYTES + 1],
                timestamp("2026-08-08T00:00:03Z"),
            )
            .expect_err("reject oversized command before JSON parse")
            .code,
        "device_command_too_large",
    );
}

#[test]
fn command_key_registry_is_strict_and_rotation_safe() {
    let first = SigningKey::from_bytes(&[7; 32]);
    let second = SigningKey::from_bytes(&[8; 32]);
    DeviceCommandAuthorizer::new(
        [
            trusted_key("control-key-1", &first),
            trusted_key("control-key-2", &second),
        ],
        Duration::minutes(5),
    )
    .expect("accept distinct current and previous keys");
    assert_eq!(
        DeviceCommandAuthorizer::new(
            [
                trusted_key("control-key-1", &first),
                trusted_key("control-key-1", &second)
            ],
            Duration::minutes(5),
        )
        .expect_err("reject duplicate command key ID")
        .code,
        "device_authorization_key_config_invalid",
    );
    assert_eq!(
        DeviceCommandAuthorizer::new(
            [TrustedDeviceCommandKey {
                key_id: "control-key-1".to_string(),
                public_key_pem: "not-a-public-key".to_string(),
            }],
            Duration::minutes(5),
        )
        .expect_err("reject malformed Ed25519 key")
        .code,
        "device_authorization_key_config_invalid",
    );
}

struct SignedReference {
    command: DeviceExecutionCommand,
    welcome: DeviceGatewayWelcome,
    signing_key: SigningKey,
}

fn signed_reference() -> SignedReference {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve shared Device Protocol fixture");
    let fixture: Reference = serde_json::from_str(
        &fs::read_to_string(fixture_path).expect("read shared Device Protocol fixture"),
    )
    .expect("parse shared Device Protocol fixture");
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let mut command =
        parse_device_execution_command(fixture.valid.command).expect("parse shared Device command");
    command.authorization.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(
                canonical_device_command_signing_payload(&command)
                    .expect("canonicalize command")
                    .as_bytes(),
            )
            .to_bytes(),
    );
    SignedReference {
        command,
        welcome: parse_device_gateway_welcome(fixture.valid.welcome)
            .expect("parse shared Gateway welcome"),
        signing_key,
    }
}

fn authorizer(signing_key: &SigningKey) -> DeviceCommandAuthorizer {
    DeviceCommandAuthorizer::new(
        [trusted_key("control-key-1", signing_key)],
        Duration::minutes(5),
    )
    .expect("create Native command authorizer")
}

fn trusted_key(key_id: &str, signing_key: &SigningKey) -> TrustedDeviceCommandKey {
    TrustedDeviceCommandKey {
        key_id: key_id.to_string(),
        public_key_pem: signing_key
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .expect("encode Ed25519 public key"),
    }
}

fn establish<'a>(
    fence: &'a ConnectionEpochFence,
    authorizer: &'a DeviceCommandAuthorizer,
    welcome: &DeviceGatewayWelcome,
) -> NativeDeviceConnection<'a> {
    NativeDeviceConnection::establish(
        fence,
        authorizer,
        &serde_json::to_vec(welcome).expect("serialize welcome"),
        timestamp("2026-08-08T00:00:03Z"),
    )
    .expect("establish Native Device connection")
}

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("parse test timestamp")
        .with_timezone(&Utc)
}
