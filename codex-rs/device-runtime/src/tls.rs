use std::fmt::Debug;
use std::sync::Arc;

use crewon_utils_rustls_provider::ensure_rustls_crypto_provider;
use rustls::ClientConfig;
use rustls::DigitallySignedStruct;
use rustls::RootCertStore;
use rustls::SignatureScheme;
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::HandshakeSignatureValid;
use rustls::client::danger::ServerCertVerified;
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::PrivateKeyDer;
use rustls::pki_types::ServerName;
use rustls::pki_types::UnixTime;
use rustls::pki_types::pem::PemObject as _;
use sha2::Digest as _;
use sha2::Sha256;

use crate::DeviceRuntimeError;
use crate::bootstrap::DeviceRuntimeTlsMaterial;

pub(crate) fn build_client_config(
    material: &DeviceRuntimeTlsMaterial,
) -> Result<Arc<ClientConfig>, DeviceRuntimeError> {
    ensure_rustls_crypto_provider();
    let certificates = CertificateDer::pem_slice_iter(material.client_certificate_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_tls_invalid", error))?;
    if certificates.is_empty() {
        return Err(DeviceRuntimeError::new("device_runtime_tls_invalid"));
    }
    let private_key = PrivateKeyDer::from_pem_slice(material.client_private_key_pem.as_bytes())
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_tls_invalid", error))?;
    let authorities = CertificateDer::pem_slice_iter(material.ca_certificate_pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_tls_invalid", error))?;
    if authorities.is_empty() {
        return Err(DeviceRuntimeError::new("device_runtime_tls_invalid"));
    }
    let mut roots = RootCertStore::empty();
    for authority in authorities {
        roots.add(authority).map_err(|error| {
            DeviceRuntimeError::with_source("device_runtime_tls_invalid", error)
        })?;
    }

    let builder = ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13]);
    let config = if let Some(pin) = &material.server_certificate_sha256 {
        let verifier = WebPkiServerVerifier::builder(Arc::new(roots))
            .build()
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_tls_invalid", error)
            })?;
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedServerVerifier {
                verifier,
                expected_digest: pin.clone(),
            }))
            .with_client_auth_cert(certificates, private_key)
    } else {
        builder
            .with_root_certificates(roots)
            .with_client_auth_cert(certificates, private_key)
    }
    .map_err(|error| DeviceRuntimeError::with_source("device_runtime_tls_invalid", error))?;
    Ok(Arc::new(config))
}

struct PinnedServerVerifier {
    verifier: Arc<WebPkiServerVerifier>,
    expected_digest: String,
}

impl Debug for PinnedServerVerifier {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PinnedServerVerifier([REDACTED])")
    }
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let verified = self.verifier.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )?;
        let actual = format!("sha256:{}", lower_hex(&Sha256::digest(end_entity.as_ref())));
        if actual != self.expected_digest {
            return Err(rustls::Error::General(
                "device runtime server certificate pin mismatch".to_string(),
            ));
        }
        Ok(verified)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.verifier.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.verifier.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.verifier.supported_verify_schemes()
    }
}

fn lower_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
        encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[cfg(test)]
#[path = "tls_tests.rs"]
mod tests;
