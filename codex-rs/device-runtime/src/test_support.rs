use std::fs;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Duration;
use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device::TrustedDeviceCommandKey;
use crewon_device_protocol::DeviceFilesystemReadAcceptedData;
use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::DeviceFilesystemReadCompletedData;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::DeviceFilesystemReadEventEnvelope;
use crewon_device_protocol::DeviceFilesystemReadResult;
use crewon_device_protocol::DeviceGatewayWelcome;
use crewon_device_protocol::DeviceHello;
use crewon_device_protocol::DeviceWorkspaceListAcceptedData;
use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListCompletedData;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::DeviceWorkspaceListEventEnvelope;
use crewon_device_protocol::DeviceWorkspaceListResult;
use crewon_device_protocol::canonical_device_command_signing_payload;
use crewon_device_protocol::canonical_device_filesystem_read_command_digest;
use crewon_device_protocol::canonical_device_workspace_list_command_signing_payload;
use crewon_device_protocol::parse_device_filesystem_read_command;
use crewon_device_protocol::parse_device_workspace_list_command;
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePublicKey as _;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use rcgen::BasicConstraints;
use rcgen::CertificateParams;
use rcgen::CertifiedIssuer;
use rcgen::DistinguishedName;
use rcgen::DnType;
use rcgen::ExtendedKeyUsagePurpose;
use rcgen::IsCa;
use rcgen::KeyPair;
use rcgen::KeyUsagePurpose;
use rcgen::PKCS_ECDSA_P256_SHA256;
use rustls::RootCertStore;
use rustls::ServerConfig;
use rustls::pki_types::PrivateKeyDer;
use serde::Deserialize;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;
use tempfile::TempDir;
use url::Url;
use zeroize::Zeroizing;

use crate::DeviceRuntime;
use crate::DeviceRuntimeBootstrap;
use crate::DeviceRuntimeWorkspace;
use crate::bootstrap::DeviceRuntimeTlsMaterial;

pub(crate) struct RuntimeFixture {
    pub runtime: DeviceRuntime,
    pub server_config: Arc<ServerConfig>,
    pub signing_key: SigningKey,
    pub workspace_binding_id: String,
    pub incarnation_id: String,
    pub _temp: TempDir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServerPin {
    Required,
    Omitted,
}

#[derive(Deserialize)]
struct Reference {
    valid: ValidReference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidReference {
    workspace_command: Value,
    filesystem_read_command: Value,
}

pub(crate) fn signed_read_command(
    fixture: &RuntimeFixture,
    suffix: u16,
) -> DeviceFilesystemReadCommand {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve protocol fixture");
    let reference: Reference =
        serde_json::from_str(&fs::read_to_string(fixture_path).expect("read protocol fixture"))
            .expect("parse protocol fixture");
    let mut command = parse_device_filesystem_read_command(reference.valid.filesystem_read_command)
        .expect("parse read command");
    let now = Utc::now();
    command.command.device_id = "device-1".to_string();
    command.command.execution_id = format!("read-execution-{suffix}");
    command.command.lease_id = format!("read-lease-{suffix}");
    command.command.workspace_binding_id = fixture.workspace_binding_id.clone();
    command.arguments.workspace_incarnation_id = fixture.incarnation_id.clone();
    command.arguments.relative_path_segments = vec!["alpha.txt".to_string()];
    command.command.arguments =
        Some(serde_json::to_value(&command.arguments).expect("serialize read arguments"));
    command.command.idempotency_key = format!("read-key-{suffix}");
    command.command.expires_at = timestamp(now + Duration::minutes(5));
    command.command.authorization.key_id = "control-key-1".to_string();
    command.command.authorization.issued_at = timestamp(now - Duration::seconds(5));
    command.command.authorization.expires_at = timestamp(now + Duration::minutes(5));
    command.command.authorization.signature = "A".repeat(86);
    command.command.authorization.signature = URL_SAFE_NO_PAD.encode(
        fixture
            .signing_key
            .sign(
                canonical_device_command_signing_payload(&command.command)
                    .expect("canonical read signing payload")
                    .as_bytes(),
            )
            .to_bytes(),
    );
    command
}

pub(crate) fn read_accepted_event(
    command: &DeviceFilesystemReadCommand,
    epoch: u64,
) -> DeviceFilesystemReadEvent {
    DeviceFilesystemReadEvent::Accepted {
        envelope: read_envelope(
            command,
            format!("read-receipt-{}", command.command.execution_id),
            epoch,
            1,
        ),
        data: DeviceFilesystemReadAcceptedData {
            lease_id: command.command.lease_id.clone(),
            lease_epoch: command.command.lease_epoch,
            expires_at: command.command.expires_at.clone(),
        },
    }
}

pub(crate) fn read_completed_event(
    command: &DeviceFilesystemReadCommand,
    accepted: &DeviceFilesystemReadEvent,
    content: &str,
) -> DeviceFilesystemReadEvent {
    let DeviceFilesystemReadEvent::Accepted { envelope, .. } = accepted else {
        panic!("accepted required");
    };
    DeviceFilesystemReadEvent::Completed {
        envelope: read_envelope(
            command,
            envelope.receipt_id.clone(),
            envelope.connection_epoch,
            2,
        ),
        data: DeviceFilesystemReadCompletedData {
            result: DeviceFilesystemReadResult {
                schema_version: "crewon.workspace-file-read-result.v0".to_string(),
                encoding: "utf8".to_string(),
                content: content.to_string(),
                byte_length: content.len() as u64,
                output_digest: format!("sha256:{:x}", Sha256::digest(content.as_bytes())),
            },
        },
    }
}

fn read_envelope(
    command: &DeviceFilesystemReadCommand,
    receipt_id: String,
    connection_epoch: u64,
    sequence: u64,
) -> DeviceFilesystemReadEventEnvelope {
    DeviceFilesystemReadEventEnvelope {
        schema_version: "crewon.device-filesystem-read-event.v0".to_string(),
        protocol_version: 1,
        command_kind: "workspaceRead".to_string(),
        device_id: command.command.device_id.clone(),
        execution_id: command.command.execution_id.clone(),
        receipt_id,
        connection_epoch,
        workspace_binding_id: command.command.workspace_binding_id.clone(),
        incarnation_id: command.arguments.workspace_incarnation_id.clone(),
        command_digest: canonical_device_filesystem_read_command_digest(command)
            .expect("read digest"),
        sequence,
        observed_at: timestamp(Utc::now()),
    }
}

pub(crate) async fn runtime_fixture(gateway_url: Url, server_pin: ServerPin) -> RuntimeFixture {
    crewon_utils_rustls_provider::ensure_rustls_crypto_provider();
    let temp = tempfile::tempdir().expect("runtime tempdir");
    let workspace_path = temp.path().join("workspace-secret");
    fs::create_dir(&workspace_path).expect("create workspace");
    fs::write(workspace_path.join("alpha.txt"), b"alpha").expect("write file");
    fs::create_dir(workspace_path.join("bravo")).expect("write directory");
    let tls = tls_material();
    let signing_key = SigningKey::from_bytes(&[9; 32]);
    let workspace_binding_id = "workspace-binding-1".to_string();
    let incarnation_id = "workspace-incarnation-1".to_string();
    let bootstrap = DeviceRuntimeBootstrap {
        gateway_url,
        device_id: "device-1".to_string(),
        device_binding_id: "device-binding-1".to_string(),
        runtime_binding_id: "runtime-binding-1".to_string(),
        journal_path: temp.path().join("journal.sqlite"),
        workspaces: vec![DeviceRuntimeWorkspace {
            workspace_binding_id: workspace_binding_id.clone(),
            incarnation_id: incarnation_id.clone(),
            trusted_local_path: workspace_path,
        }],
        command_keys: vec![TrustedDeviceCommandKey {
            key_id: "control-key-1".to_string(),
            public_key_pem: signing_key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .expect("public key PEM"),
        }],
        tls: DeviceRuntimeTlsMaterial {
            client_certificate_pem: Zeroizing::new(tls.client_certificate_pem),
            client_private_key_pem: Zeroizing::new(tls.client_private_key_pem),
            ca_certificate_pem: Zeroizing::new(tls.ca_certificate_pem),
            server_certificate_sha256: match server_pin {
                ServerPin::Required => Some(tls.server_digest),
                ServerPin::Omitted => None,
            },
        },
    };
    RuntimeFixture {
        runtime: DeviceRuntime::open(bootstrap).await.expect("open runtime"),
        server_config: tls.server_config,
        signing_key,
        workspace_binding_id,
        incarnation_id,
        _temp: temp,
    }
}

pub(crate) fn signed_command(fixture: &RuntimeFixture, suffix: u16) -> DeviceWorkspaceListCommand {
    let fixture_path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("resolve protocol fixture");
    let reference: Reference =
        serde_json::from_str(&fs::read_to_string(fixture_path).expect("read protocol fixture"))
            .expect("parse protocol fixture");
    let mut command = parse_device_workspace_list_command(reference.valid.workspace_command)
        .expect("parse Workspace command");
    let now = Utc::now();
    command.device_id = "device-1".to_string();
    command.execution_id = format!("workspace-execution-{suffix}");
    command.lease_id = format!("workspace-lease-{suffix}");
    command.workspace_binding_id = fixture.workspace_binding_id.clone();
    command.incarnation_id = fixture.incarnation_id.clone();
    command.device_binding_id = "device-binding-1".to_string();
    command.runtime_binding_id = "runtime-binding-1".to_string();
    command.idempotency_key = format!("workspace-key-{suffix}");
    command.expires_at = timestamp(now + Duration::minutes(5));
    command.authorization.key_id = "control-key-1".to_string();
    command.authorization.issued_at = timestamp(now - Duration::seconds(5));
    command.authorization.expires_at = timestamp(now + Duration::minutes(5));
    if let Some(proof) = &mut command.authorization.approval_proof {
        proof.decided_at = timestamp(now - Duration::seconds(10));
    }
    sign(&mut command, &fixture.signing_key);
    command
}

pub(crate) fn welcome(hello: &DeviceHello, epoch: u64) -> DeviceGatewayWelcome {
    DeviceGatewayWelcome {
        schema_version: "crewon.device-welcome.v0".to_string(),
        protocol_version: 1,
        device_id: hello.device_id.clone(),
        connection_id: hello.connection_id.clone(),
        gateway_id: "gateway-1".to_string(),
        connection_epoch: epoch,
        lease_expires_at: timestamp(Utc::now() + Duration::minutes(5)),
        sent_at: timestamp(Utc::now()),
    }
}

pub(crate) fn ack(event: &DeviceWorkspaceListEvent, through: u64) -> DeviceWorkspaceListAck {
    let envelope = match event {
        DeviceWorkspaceListEvent::Accepted { envelope, .. }
        | DeviceWorkspaceListEvent::Completed { envelope, .. }
        | DeviceWorkspaceListEvent::Failed { envelope, .. }
        | DeviceWorkspaceListEvent::Canceled { envelope, .. }
        | DeviceWorkspaceListEvent::UnknownOutcome { envelope, .. } => envelope,
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
        through_sequence: through,
        acknowledged_at: timestamp(Utc::now()),
    }
}

pub(crate) fn accepted_event(
    command: &DeviceWorkspaceListCommand,
    epoch: u64,
) -> DeviceWorkspaceListEvent {
    DeviceWorkspaceListEvent::Accepted {
        envelope: event_envelope(
            command,
            format!("receipt-{}", command.execution_id),
            epoch,
            1,
        ),
        data: DeviceWorkspaceListAcceptedData {
            lease_id: command.lease_id.clone(),
            lease_epoch: command.lease_epoch,
            expires_at: command.expires_at.clone(),
            policy_snapshot_id: command.policy_snapshot_id.clone(),
        },
    }
}

pub(crate) fn terminal_event(
    command: &DeviceWorkspaceListCommand,
    accepted: &DeviceWorkspaceListEvent,
) -> DeviceWorkspaceListEvent {
    let DeviceWorkspaceListEvent::Accepted { envelope, .. } = accepted else {
        panic!("accepted event required");
    };
    DeviceWorkspaceListEvent::Completed {
        envelope: event_envelope(
            command,
            envelope.receipt_id.clone(),
            envelope.connection_epoch,
            2,
        ),
        data: DeviceWorkspaceListCompletedData {
            result: DeviceWorkspaceListResult {
                schema_version: "crewon.workspace-list-result.v0".to_string(),
                execution_id: command.execution_id.clone(),
                action_digest: command.action_digest.clone(),
                command_digest: command.command_digest.clone(),
                entries: Vec::new(),
                truncated: false,
            },
        },
    }
}

fn event_envelope(
    command: &DeviceWorkspaceListCommand,
    receipt_id: String,
    connection_epoch: u64,
    sequence: u64,
) -> DeviceWorkspaceListEventEnvelope {
    DeviceWorkspaceListEventEnvelope {
        schema_version: "crewon.device-workspace-list-event.v0".to_string(),
        protocol_version: 1,
        command_kind: command.command_kind.clone(),
        device_id: command.device_id.clone(),
        execution_id: command.execution_id.clone(),
        receipt_id,
        connection_epoch,
        workspace_binding_id: command.workspace_binding_id.clone(),
        incarnation_id: command.incarnation_id.clone(),
        device_binding_id: command.device_binding_id.clone(),
        runtime_binding_id: command.runtime_binding_id.clone(),
        action_digest: command.action_digest.clone(),
        command_digest: command.command_digest.clone(),
        sequence,
        observed_at: timestamp(Utc::now()),
    }
}

fn sign(command: &mut DeviceWorkspaceListCommand, key: &SigningKey) {
    command.authorization.signature = "A".repeat(86);
    command.authorization.signature = URL_SAFE_NO_PAD.encode(
        key.sign(
            canonical_device_workspace_list_command_signing_payload(command)
                .expect("canonical signing payload")
                .as_bytes(),
        )
        .to_bytes(),
    );
}

fn timestamp(value: chrono::DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct TlsFixture {
    client_certificate_pem: String,
    client_private_key_pem: String,
    ca_certificate_pem: String,
    server_digest: String,
    server_config: Arc<ServerConfig>,
}

fn tls_material() -> TlsFixture {
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "runtime integration CA");
    ca_params.distinguished_name = name;
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("CA key");
    let ca = CertifiedIssuer::self_signed(ca_params, ca_key).expect("CA certificate");

    let mut client_params =
        CertificateParams::new(vec!["device-1".to_string()]).expect("client params");
    client_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    client_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    let client_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("client key");
    let client_certificate = client_params
        .signed_by(&client_key, &ca)
        .expect("client certificate");

    let mut server_params =
        CertificateParams::new(vec!["localhost".to_string()]).expect("server params");
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    server_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    let server_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("server key");
    let server_certificate = server_params
        .signed_by(&server_key, &ca)
        .expect("server certificate");

    let mut roots = RootCertStore::empty();
    roots.add(ca.der().clone()).expect("client trust root");
    let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(roots))
        .build()
        .expect("client verifier");
    let server_config = ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_client_cert_verifier(verifier)
        .with_single_cert(
            vec![server_certificate.der().clone()],
            PrivateKeyDer::from(server_key),
        )
        .expect("server TLS config");
    let server_digest = format!(
        "sha256:{}",
        Sha256::digest(server_certificate.der().as_ref())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    TlsFixture {
        client_certificate_pem: client_certificate.pem(),
        client_private_key_pem: client_key.serialize_pem(),
        ca_certificate_pem: ca.pem(),
        server_digest,
        server_config: Arc::new(server_config),
    }
}
