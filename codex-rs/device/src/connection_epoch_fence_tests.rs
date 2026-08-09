use std::fs;

use chrono::DateTime;
use chrono::Utc;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceGatewayWelcome;
use crewon_device_protocol::parse_device_execution_command;
use crewon_device_protocol::parse_device_gateway_welcome;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde_json::Value;
use tempfile::TempDir;

use super::ConnectionEpochFence;

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
fn persists_the_highest_epoch_and_rejects_rollback_after_restart() {
    let fixture = reference();
    let directory = TempDir::new().expect("create private state parent");
    let state_directory = directory.path().join("device-state");
    let fence = ConnectionEpochFence::open("device-1", &state_directory)
        .expect("open connection epoch fence");
    let now = timestamp("2026-08-08T00:00:03Z");
    let accepted = fence
        .accept_welcome(&fixture.welcome, now)
        .expect("accept first connection epoch");
    assert_eq!(accepted.connection_epoch, 3);
    drop(fence);

    let reopened = ConnectionEpochFence::open("device-1", &state_directory)
        .expect("reopen connection epoch fence");
    assert_eq!(
        reopened
            .accept_welcome(&fixture.welcome, now)
            .expect_err("reject replayed connection epoch")
            .code,
        "device_connection_epoch_stale",
    );
    let mut older = fixture.welcome.clone();
    older.connection_epoch = 2;
    assert_eq!(
        reopened
            .accept_welcome(&older, now)
            .expect_err("reject older connection epoch")
            .code,
        "device_connection_epoch_stale",
    );
    let mut newer = fixture.welcome;
    newer.connection_epoch = 4;
    let accepted = reopened
        .accept_welcome(&newer, now)
        .expect("accept higher connection epoch");
    assert_eq!(accepted.connection_epoch, 4);
    assert_eq!(
        fs::read_dir(state_directory)
            .expect("read state directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".json"))
            .count(),
        2,
    );
}

#[test]
fn a_new_welcome_fences_the_old_socket_before_command_start() {
    let fixture = reference();
    let directory = TempDir::new().expect("create private state parent");
    let fence = ConnectionEpochFence::open("device-1", directory.path().join("device-state"))
        .expect("open connection epoch fence");
    let now = timestamp("2026-08-08T00:00:03Z");
    let old_connection = fence
        .accept_welcome(&fixture.welcome, now)
        .expect("accept old connection");
    let old_permit = fence
        .authorize_command(&old_connection, &fixture.command)
        .expect("old connection is current before takeover");
    assert_eq!(old_permit.connection(), &old_connection);
    drop(old_permit);

    let mut newer = fixture.welcome;
    newer.connection_epoch += 1;
    newer.connection_id = "connection-2".to_string();
    newer.gateway_id = "gateway-2".to_string();
    let new_connection = fence
        .accept_welcome(&newer, now)
        .expect("accept new connection");
    assert_eq!(
        fence
            .authorize_command(&old_connection, &fixture.command)
            .expect_err("old socket cannot start a command after takeover")
            .code,
        "device_connection_epoch_stale",
    );
    let _permit = fence
        .authorize_command(&new_connection, &fixture.command)
        .expect("new socket can start a command");
}

#[test]
fn expired_or_wrong_device_welcome_never_advances_the_fence() {
    let fixture = reference();
    let directory = TempDir::new().expect("create private state parent");
    let state_directory = directory.path().join("device-state");
    let fence = ConnectionEpochFence::open("device-1", &state_directory)
        .expect("open connection epoch fence");
    assert_eq!(
        fence
            .accept_welcome(&fixture.welcome, timestamp("2026-08-08T00:01:01Z"),)
            .expect_err("reject expired welcome")
            .code,
        "device_connection_lease_expired",
    );
    let mut wrong_device = fixture.welcome;
    wrong_device.device_id = "device-2".to_string();
    assert_eq!(
        fence
            .accept_welcome(&wrong_device, timestamp("2026-08-08T00:00:03Z"))
            .expect_err("reject wrong Device identity")
            .code,
        "device_connection_identity_mismatch",
    );
    assert_eq!(
        fs::read_dir(state_directory)
            .expect("read state directory")
            .filter_map(Result::ok)
            .count(),
        0,
    );
}

#[test]
fn command_admission_does_not_expire_with_the_initial_route_lease() {
    let fixture = reference();
    let directory = TempDir::new().expect("create private state parent");
    let fence = ConnectionEpochFence::open("device-1", directory.path().join("device-state"))
        .expect("open connection epoch fence");
    let connection = fence
        .accept_welcome(&fixture.welcome, timestamp("2026-08-08T00:00:03Z"))
        .expect("accept connection epoch");

    let _permit = fence
        .authorize_command(&connection, &fixture.command)
        .expect("route heartbeat renewal does not require a repeated welcome");
}

#[test]
fn corrupt_durable_epoch_state_fails_closed() {
    let directory = TempDir::new().expect("create private state parent");
    let state_directory = directory.path().join("device-state");
    fs::create_dir(&state_directory).expect("create state directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&state_directory, fs::Permissions::from_mode(0o700))
            .expect("restrict state directory");
    }
    fs::write(
        state_directory.join("connection-epoch-00000000000000000003.json"),
        b"{\"schemaVersion\":\"corrupt\"}\n",
    )
    .expect("write corrupt state");
    assert_eq!(
        ConnectionEpochFence::open("device-1", state_directory)
            .expect_err("corrupt durable state must fail closed")
            .code,
        "device_connection_epoch_state_invalid",
    );
}

struct ParsedReference {
    command: DeviceExecutionCommand,
    welcome: DeviceGatewayWelcome,
}

fn reference() -> ParsedReference {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve shared Device Protocol fixture");
    let fixture: Reference = serde_json::from_str(
        &fs::read_to_string(fixture_path).expect("read shared Device Protocol fixture"),
    )
    .expect("parse shared Device Protocol fixture");
    ParsedReference {
        command: parse_device_execution_command(fixture.valid.command)
            .expect("parse shared Device command"),
        welcome: parse_device_gateway_welcome(fixture.valid.welcome)
            .expect("parse shared Gateway welcome"),
    }
}

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("parse test timestamp")
        .with_timezone(&Utc)
}
