use std::io::Cursor;
use std::sync::Arc;

use ed25519_dalek::pkcs8::DecodePrivateKey as _;
use ed25519_dalek::pkcs8::DecodePublicKey as _;
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::Verifier as _;
use ed25519_dalek::VerifyingKey;
use pretty_assertions::assert_eq;
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::PrivateKeyDer;
use rustls::pki_types::ServerName;
use rustls::server::WebPkiClientVerifier;
use rustls::ClientConfig;
use rustls::ClientConnection;
use rustls::RootCertStore;
use rustls::ServerConfig;
use rustls::ServerConnection;
use sha2::Digest as _;
use sha2::Sha256;

use super::catalog::DesktopWorkspaceAuthority;
use super::catalog::DesktopWorkspaceAuthorityManager;
use super::catalog::WorkspaceAuthorityPrepareResult;
use super::WorkspaceLaunchMaterial;

#[test]
fn generated_tls_material_has_valid_tls13_chains_san_eku_and_key_pairs() {
    let fixture = fixture();
    let material = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    assert_tls13_client(
        &material,
        material.worker().certificate_pem(),
        material.worker().private_key_pem(),
    );
    assert_tls13_client(
        &material,
        material.device().certificate_pem(),
        material.device().private_key_pem(),
    );
    assert_eq!(
        material.device().fingerprint256(),
        uppercase_fingerprint(material.device().certificate_pem())
    );
    assert_eq!(
        material.worker().fingerprint256(),
        uppercase_fingerprint(material.worker().certificate_pem())
    );
    assert_eq!(
        material.gateway().certificate_sha256(),
        lowercase_pin(material.gateway().certificate_pem())
    );
}

#[test]
fn command_private_and_public_pem_are_the_same_ed25519_identity() {
    let fixture = fixture();
    let material = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    let signing = SigningKey::from_pkcs8_pem(material.command_signing().private_key_pem()).unwrap();
    let verifying =
        VerifyingKey::from_public_key_pem(material.command_signing().public_key_pem()).unwrap();
    let payload = b"crewon workspace command identity";
    let signature = signing.sign(payload);
    verifying.verify(payload, &signature).unwrap();
    assert_eq!(signing.verifying_key(), verifying);
}

#[test]
fn launch_material_rotates_between_app_sessions_and_debug_is_redacted() {
    let fixture = fixture();
    let first = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    let second = WorkspaceLaunchMaterial::generate(&fixture.authority).unwrap();
    assert_ne!(
        first.worker().credential_id(),
        second.worker().credential_id()
    );
    assert_ne!(
        first.worker().private_key_pem(),
        second.worker().private_key_pem()
    );
    assert_ne!(
        first.command_signing().key_id(),
        second.command_signing().key_id()
    );
    assert_ne!(
        first.command_signing().private_key_pem(),
        second.command_signing().private_key_pem()
    );
    assert_eq!(format!("{first:?}"), "WorkspaceLaunchMaterial([REDACTED])");
    assert!(!format!("{first:?}").contains("PRIVATE KEY"));
}

fn assert_tls13_client(
    material: &WorkspaceLaunchMaterial,
    client_certificate_pem: &str,
    client_private_key_pem: &str,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let ca = certificate(material.ca_certificate_pem());
    let mut client_roots = RootCertStore::empty();
    client_roots.add(ca.clone()).unwrap();
    let client_config = ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_root_certificates(client_roots)
        .with_client_auth_cert(
            vec![certificate(client_certificate_pem)],
            private_key(client_private_key_pem),
        )
        .unwrap();

    let mut client_auth_roots = RootCertStore::empty();
    client_auth_roots.add(ca).unwrap();
    let client_verifier = WebPkiClientVerifier::builder(Arc::new(client_auth_roots))
        .build()
        .unwrap();
    let server_config = ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_client_cert_verifier(client_verifier)
        .with_single_cert(
            vec![certificate(material.gateway().certificate_pem())],
            private_key(material.gateway().private_key_pem()),
        )
        .unwrap();
    let mut client = ClientConnection::new(
        Arc::new(client_config),
        ServerName::try_from("localhost").unwrap().to_owned(),
    )
    .unwrap();
    let mut server = ServerConnection::new(Arc::new(server_config)).unwrap();
    for _ in 0..16 {
        transfer_client_to_server(&mut client, &mut server);
        transfer_server_to_client(&mut server, &mut client);
        if !client.is_handshaking() && !server.is_handshaking() {
            break;
        }
    }
    assert!(!client.is_handshaking());
    assert!(!server.is_handshaking());
    assert_eq!(
        client.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_3)
    );
    assert_eq!(
        server.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_3)
    );
}

fn transfer_client_to_server(client: &mut ClientConnection, server: &mut ServerConnection) {
    let mut bytes = Vec::new();
    client.write_tls(&mut bytes).unwrap();
    if !bytes.is_empty() {
        server.read_tls(&mut Cursor::new(bytes)).unwrap();
        server.process_new_packets().unwrap();
    }
}

fn transfer_server_to_client(server: &mut ServerConnection, client: &mut ClientConnection) {
    let mut bytes = Vec::new();
    server.write_tls(&mut bytes).unwrap();
    if !bytes.is_empty() {
        client.read_tls(&mut Cursor::new(bytes)).unwrap();
        client.process_new_packets().unwrap();
    }
}

fn certificate(pem: &str) -> CertificateDer<'static> {
    CertificateDer::from_pem_slice(pem.as_bytes()).unwrap()
}

fn private_key(pem: &str) -> PrivateKeyDer<'static> {
    PrivateKeyDer::from_pem_slice(pem.as_bytes()).unwrap()
}

fn uppercase_fingerprint(pem: &str) -> String {
    Sha256::digest(certificate(pem).as_ref())
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn lowercase_pin(pem: &str) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(certificate(pem).as_ref()))
    )
}

struct MaterialFixture {
    _root: tempfile::TempDir,
    authority: DesktopWorkspaceAuthority,
}

fn fixture() -> MaterialFixture {
    let root = tempfile::tempdir().unwrap();
    let authority_dir = root.path().join("authority");
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let mut manager = DesktopWorkspaceAuthorityManager::open(authority_dir).unwrap();
    let prepared = manager.prepare("operation-first", 0, workspace).unwrap();
    match prepared {
        WorkspaceAuthorityPrepareResult::Pending(_) => {}
        WorkspaceAuthorityPrepareResult::Committed(_)
        | WorkspaceAuthorityPrepareResult::Aborted => {
            panic!("expected pending authority")
        }
    }
    manager.commit("operation-first").unwrap();
    MaterialFixture {
        _root: root,
        authority: manager.authority().clone(),
    }
}
