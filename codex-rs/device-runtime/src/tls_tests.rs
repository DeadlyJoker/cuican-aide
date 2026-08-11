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
use zeroize::Zeroizing;

use super::build_client_config;
use crate::bootstrap::DeviceRuntimeTlsMaterial;

#[test]
fn builds_tls13_mutual_tls_client_material_and_rejects_malformed_pem() {
    let material = valid_material();
    build_client_config(&material).expect("build strict mTLS config");

    let invalid = DeviceRuntimeTlsMaterial {
        client_certificate_pem: Zeroizing::new("not a certificate".to_string()),
        client_private_key_pem: Zeroizing::new("not a key".to_string()),
        ca_certificate_pem: Zeroizing::new("not a certificate".to_string()),
        server_certificate_sha256: None,
    };
    assert_eq!(
        build_client_config(&invalid).expect_err("reject malformed TLS material").code,
        "device_runtime_tls_invalid"
    );
}

fn valid_material() -> DeviceRuntimeTlsMaterial {
    let mut ca_params = CertificateParams::default();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "device runtime test CA");
    ca_params.distinguished_name = name;
    let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("generate CA key");
    let ca = CertifiedIssuer::self_signed(ca_params, ca_key).expect("generate CA");

    let mut client_params =
        CertificateParams::new(vec!["device-1".to_string()]).expect("client params");
    client_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    client_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    let client_key =
        KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("generate client key");
    let client_certificate = client_params
        .signed_by(&client_key, &ca)
        .expect("sign client certificate");

    DeviceRuntimeTlsMaterial {
        client_certificate_pem: Zeroizing::new(client_certificate.pem()),
        client_private_key_pem: Zeroizing::new(client_key.serialize_pem()),
        ca_certificate_pem: Zeroizing::new(ca.pem()),
        server_certificate_sha256: None,
    }
}
