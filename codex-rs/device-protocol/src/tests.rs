use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::canonical_device_command_signing_payload;
use super::canonical_device_workspace_list_command_signing_payload;
use super::parse_device_execution_ack;
use super::parse_device_execution_cancel;
use super::parse_device_execution_command;
use super::parse_device_execution_event;
use super::parse_device_gateway_welcome;
use super::parse_device_hello;
use super::parse_device_workspace_list_command;
use super::verify_device_command_authorization;
use super::verify_device_workspace_list_command_authorization;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    schema_version: String,
    signing_payload_sha256: String,
    workspace_signing_payload_sha256: String,
    valid: ValidReference,
    invalid: Vec<InvalidReference>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidReference {
    command: Value,
    workspace_command: Value,
    hello: Value,
    welcome: Value,
    ack: Value,
    cancel: Value,
    events: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct InvalidReference {
    parser: String,
    code: String,
    value: Value,
}

#[test]
fn matches_typescript_device_protocol_reference_and_fail_closed_codes() {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve shared Device Protocol fixture");
    let fixture: Reference = serde_json::from_str(
        &std::fs::read_to_string(fixture_path).expect("read shared Device Protocol fixture"),
    )
    .expect("parse shared Device Protocol fixture");
    assert_eq!(
        fixture.schema_version,
        "crewon.device-protocol-reference.v0"
    );

    assert_eq!(
        serde_json::to_value(
            parse_device_execution_command(fixture.valid.command.clone())
                .expect("parse shared command")
        )
        .expect("serialize shared command"),
        fixture.valid.command,
    );
    assert_eq!(
        serde_json::to_value(
            parse_device_workspace_list_command(fixture.valid.workspace_command.clone())
                .expect("parse shared workspace command")
        )
        .expect("serialize shared workspace command"),
        fixture.valid.workspace_command,
    );
    assert_eq!(
        serde_json::to_value(
            parse_device_hello(fixture.valid.hello.clone()).expect("parse shared hello")
        )
        .expect("serialize shared hello"),
        fixture.valid.hello,
    );
    assert_eq!(
        serde_json::to_value(
            parse_device_gateway_welcome(fixture.valid.welcome.clone())
                .expect("parse shared welcome")
        )
        .expect("serialize shared welcome"),
        fixture.valid.welcome,
    );
    assert_eq!(
        serde_json::to_value(
            parse_device_execution_ack(fixture.valid.ack.clone()).expect("parse shared ack")
        )
        .expect("serialize shared ack"),
        fixture.valid.ack,
    );
    assert_eq!(
        serde_json::to_value(
            parse_device_execution_cancel(fixture.valid.cancel.clone())
                .expect("parse shared cancel")
        )
        .expect("serialize shared cancel"),
        fixture.valid.cancel,
    );
    let events = fixture
        .valid
        .events
        .iter()
        .cloned()
        .map(|event| {
            serde_json::to_value(parse_device_execution_event(event).expect("parse shared event"))
                .expect("serialize shared event")
        })
        .collect::<Vec<_>>();
    assert_eq!(events, fixture.valid.events);

    let command = parse_device_execution_command(fixture.valid.command.clone())
        .expect("parse command for canonical signing payload");
    let payload = canonical_device_command_signing_payload(&command)
        .expect("canonicalize Device command signing payload");
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(payload.as_bytes())),
        fixture.signing_payload_sha256,
    );
    let mut changed_signature = command.clone();
    changed_signature.authorization.signature = "B".repeat(86);
    assert_eq!(
        canonical_device_command_signing_payload(&changed_signature)
            .expect("canonicalize changed signature"),
        payload,
    );
    let mut changed_lease = command;
    changed_lease.lease_epoch += 1;
    assert_ne!(
        canonical_device_command_signing_payload(&changed_lease)
            .expect("canonicalize changed lease"),
        payload,
    );

    let workspace_command =
        parse_device_workspace_list_command(fixture.valid.workspace_command.clone())
            .expect("parse workspace command for canonical signing payload");
    let workspace_payload =
        canonical_device_workspace_list_command_signing_payload(&workspace_command)
            .expect("canonicalize Device workspace command signing payload");
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(workspace_payload.as_bytes())),
        fixture.workspace_signing_payload_sha256,
    );
    let mut changed_workspace_signature = workspace_command.clone();
    changed_workspace_signature.authorization.signature = "B".repeat(86);
    assert_eq!(
        canonical_device_workspace_list_command_signing_payload(&changed_workspace_signature)
            .expect("canonicalize changed workspace signature"),
        workspace_payload,
    );
    let mut changed_workspace_binding = workspace_command;
    changed_workspace_binding.runtime_binding_id = "runtime-binding-2".to_string();
    assert_ne!(
        canonical_device_workspace_list_command_signing_payload(&changed_workspace_binding)
            .expect("canonicalize changed runtime binding"),
        workspace_payload,
    );

    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let mut authorized = parse_device_execution_command(fixture.valid.command.clone())
        .expect("parse command for authorization verification");
    authorized.authorization.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(
                canonical_device_command_signing_payload(&authorized)
                    .expect("canonicalize command before signing")
                    .as_bytes(),
            )
            .to_bytes(),
    );
    let now = DateTime::parse_from_rfc3339("2026-08-08T00:00:03Z")
        .expect("parse verification time")
        .with_timezone(&Utc);
    verify_device_command_authorization(
        &authorized,
        "control-key-1",
        &signing_key.verifying_key(),
        now,
        Duration::minutes(5),
    )
    .expect("verify signed command");
    authorized.lease_epoch += 1;
    assert_eq!(
        verify_device_command_authorization(
            &authorized,
            "control-key-1",
            &signing_key.verifying_key(),
            now,
            Duration::minutes(5),
        )
        .expect_err("reject command changed after signing")
        .code,
        "device_authorization_signature_invalid",
    );

    let mut authorized_workspace =
        parse_device_workspace_list_command(fixture.valid.workspace_command.clone())
            .expect("parse workspace command for authorization verification");
    authorized_workspace.authorization.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(
                canonical_device_workspace_list_command_signing_payload(&authorized_workspace)
                    .expect("canonicalize workspace command before signing")
                    .as_bytes(),
            )
            .to_bytes(),
    );
    verify_device_workspace_list_command_authorization(
        &authorized_workspace,
        "control-key-1",
        &signing_key.verifying_key(),
        now,
        Duration::minutes(5),
    )
    .expect("verify signed workspace command");
    authorized_workspace.lease_epoch += 1;
    assert_eq!(
        verify_device_workspace_list_command_authorization(
            &authorized_workspace,
            "control-key-1",
            &signing_key.verifying_key(),
            now,
            Duration::minutes(5),
        )
        .expect_err("reject workspace command changed after signing")
        .code,
        "device_authorization_signature_invalid",
    );

    for invalid in fixture.invalid {
        let code = match invalid.parser.as_str() {
            "command" => {
                parse_device_execution_command(invalid.value)
                    .expect_err("reject shared command")
                    .code
            }
            "workspaceCommand" => {
                parse_device_workspace_list_command(invalid.value)
                    .expect_err("reject shared workspace command")
                    .code
            }
            "event" => {
                parse_device_execution_event(invalid.value)
                    .expect_err("reject shared event")
                    .code
            }
            "hello" => {
                parse_device_hello(invalid.value)
                    .expect_err("reject shared hello")
                    .code
            }
            "welcome" => {
                parse_device_gateway_welcome(invalid.value)
                    .expect_err("reject shared welcome")
                    .code
            }
            "ack" => {
                parse_device_execution_ack(invalid.value)
                    .expect_err("reject shared ack")
                    .code
            }
            "cancel" => {
                parse_device_execution_cancel(invalid.value)
                    .expect_err("reject shared cancel")
                    .code
            }
            parser => panic!("unsupported shared parser {parser}"),
        };
        assert_eq!(code, invalid.code);
    }
}
