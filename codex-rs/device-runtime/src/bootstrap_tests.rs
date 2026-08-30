use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncWriteExt as _;

use super::MAX_BOOTSTRAP_BYTES;
use super::read_bootstrap;

#[tokio::test]
async fn accepts_strict_bootstrap_and_redacts_all_sensitive_debug_output() {
    let value = valid_bootstrap();
    let encoded = serde_json::to_vec(&value).expect("encode bootstrap");
    let bootstrap = read_bootstrap(&encoded[..]).await.expect("read bootstrap");

    assert_eq!(bootstrap.gateway_url.as_str(), "wss://localhost/device/v1");
    let debug = format!("{bootstrap:?} {:?}", bootstrap.workspaces[0]);
    assert!(!debug.contains("workspace-secret"));
    assert!(!debug.contains("journal-secret"));
    assert!(!debug.contains("PRIVATE KEY"));
    assert!(!debug.contains("CERTIFICATE"));
    assert_eq!(
        debug,
        "DeviceRuntimeBootstrap([REDACTED]) DeviceRuntimeWorkspace([REDACTED])"
    );
}

#[tokio::test]
async fn accepts_one_bounded_line_without_waiting_for_stdin_eof() {
    let encoded = serde_json::to_vec(&valid_bootstrap()).expect("encode bootstrap");
    let (mut writer, reader) = tokio::io::duplex(encoded.len() + 1);
    writer.write_all(&encoded).await.expect("write bootstrap");
    writer.write_all(b"\n").await.expect("write delimiter");

    let bootstrap = read_bootstrap(reader)
        .await
        .expect("read while writer remains open");

    assert_eq!(bootstrap.gateway_url.as_str(), "wss://localhost/device/v1");
    drop(writer);
}

#[tokio::test]
async fn rejects_unknown_fields_duplicate_keys_and_unsafe_paths() {
    let mut unknown = valid_bootstrap();
    unknown["unexpected"] = json!(true);
    assert_eq!(
        read_error(unknown).await,
        "device_runtime_bootstrap_invalid"
    );

    let mut duplicate = valid_bootstrap();
    duplicate["commandPublicKeys"] = json!([
        {"keyId": "control-key-1", "publicKeyPem": "PUBLIC KEY ONE"},
        {"keyId": "control-key-1", "publicKeyPem": "PUBLIC KEY TWO"}
    ]);
    assert_eq!(
        read_error(duplicate).await,
        "device_runtime_command_keys_invalid"
    );

    let mut relative = valid_bootstrap();
    relative["journalPath"] = json!("relative.sqlite");
    assert_eq!(read_error(relative).await, "device_runtime_path_invalid");

    let mut control = valid_bootstrap();
    control["workspaces"][0]["trustedLocalPath"] = json!("/tmp/workspace\nsecret");
    assert_eq!(read_error(control).await, "device_runtime_path_invalid");
}

#[tokio::test]
async fn rejects_non_wss_or_noncanonical_gateway_and_oversized_stdin() {
    for url in [
        "ws://localhost/device/v1",
        "wss://localhost/other",
        "wss://user@localhost/device/v1",
        "wss://localhost/device/v1?token=secret",
        "wss://localhost:0/device/v1",
    ] {
        let mut value = valid_bootstrap();
        value["gatewayWssUrl"] = json!(url);
        assert_eq!(read_error(value).await, "device_runtime_gateway_invalid");
    }

    let oversized = vec![b' '; MAX_BOOTSTRAP_BYTES as usize + 1];
    assert_eq!(
        read_bootstrap(&oversized[..])
            .await
            .expect_err("reject size")
            .code,
        "device_runtime_bootstrap_size_invalid"
    );
}

#[tokio::test]
async fn rejects_non_whitespace_data_after_the_bootstrap_line() {
    let mut encoded = serde_json::to_vec(&valid_bootstrap()).expect("encode bootstrap");
    encoded.extend_from_slice(b"\n{}\n");

    assert_eq!(
        read_bootstrap(&encoded[..])
            .await
            .expect_err("reject a second record")
            .code,
        "device_runtime_bootstrap_invalid"
    );
}

async fn read_error(value: Value) -> &'static str {
    let encoded = serde_json::to_vec(&value).expect("encode bootstrap");
    read_bootstrap(&encoded[..])
        .await
        .expect_err("reject bootstrap")
        .code
}

fn valid_bootstrap() -> Value {
    json!({
        "schemaVersion": "crewon.device-runtime-bootstrap.v0",
        "gatewayWssUrl": "wss://localhost/device/v1",
        "deviceId": "device-1",
        "deviceBindingId": "device-binding-1",
        "runtimeBindingId": "runtime-binding-1",
        "journalPath": "/tmp/journal-secret.sqlite",
        "workspaces": [{
            "workspaceBindingId": "workspace-binding-1",
            "incarnationId": "workspace-incarnation-1",
            "trustedLocalPath": "/tmp/workspace-secret"
        }],
        "tls": {
            "clientCertificatePem": "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----",
            "clientPrivateKeyPem": "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
            "caCertificatePem": "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----",
            "serverCertificateSha256": null
        },
        "commandPublicKeys": [{
            "keyId": "control-key-1",
            "publicKeyPem": "PUBLIC KEY"
        }]
    })
}
