use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::EncodePrivateKey as _;
use ed25519_dalek::pkcs8::EncodePublicKey as _;
use ed25519_dalek::SigningKey;
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
use sha2::Digest as _;
use sha2::Sha256;
use zeroize::Zeroizing;

use super::DesktopWorkspaceAuthority;
use super::WorkspaceNativeError;

pub(crate) struct WorkspaceLaunchMaterial {
    authority_binding: LaunchAuthorityBinding,
    ca_certificate_pem: String,
    gateway: TlsIdentityMaterial,
    worker: TlsIdentityMaterial,
    device: TlsIdentityMaterial,
    command_signing: CommandSigningMaterial,
    private_server_token: Zeroizing<String>,
}

struct LaunchAuthorityBinding {
    device_id: String,
    device_binding_id: String,
    runtime_binding_id: String,
    workspace_binding_id: String,
    incarnation_id: String,
    workspace_revision: u64,
}

impl std::fmt::Debug for WorkspaceLaunchMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceLaunchMaterial([REDACTED])")
    }
}

pub(crate) struct TlsIdentityMaterial {
    identity_id: String,
    credential_id: String,
    certificate_pem: String,
    private_key_pem: Zeroizing<String>,
    fingerprint256: String,
    certificate_sha256: String,
}

impl std::fmt::Debug for TlsIdentityMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TlsIdentityMaterial([REDACTED])")
    }
}

pub(crate) struct CommandSigningMaterial {
    key_id: String,
    private_key_pem: Zeroizing<String>,
    public_key_pem: String,
}

impl std::fmt::Debug for CommandSigningMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CommandSigningMaterial([REDACTED])")
    }
}

impl WorkspaceLaunchMaterial {
    /// Creates one launch-scoped material set that must be retained across
    /// in-process Provider reloads and replaced only with the whole runtime.
    pub(crate) fn generate(
        authority: &DesktopWorkspaceAuthority,
    ) -> Result<Self, WorkspaceNativeError> {
        let workspace = authority.current_workspace()?;
        let ca = certificate_authority()?;
        let gateway = tls_identity(
            random_id("desktop-gateway")?,
            random_id("desktop-gateway-credential")?,
            CertificateRole::Server,
            &ca,
        )?;
        let worker = tls_identity(
            random_id("desktop-worker")?,
            random_id("desktop-worker-credential")?,
            CertificateRole::Client,
            &ca,
        )?;
        let device = tls_identity(
            authority.device_id().to_string(),
            random_id("desktop-device-credential")?,
            CertificateRole::Client,
            &ca,
        )?;
        Ok(Self {
            authority_binding: LaunchAuthorityBinding {
                device_id: authority.device_id().to_string(),
                device_binding_id: authority.device_binding_id().to_string(),
                runtime_binding_id: workspace.workspace_runtime_binding_id().to_string(),
                workspace_binding_id: workspace.workspace_binding_id().to_string(),
                incarnation_id: workspace.incarnation_id().to_string(),
                workspace_revision: workspace.revision(),
            },
            ca_certificate_pem: ca.certificate.pem(),
            gateway,
            worker,
            device,
            command_signing: command_signing_material()?,
            private_server_token: Zeroizing::new(random_hex(32)?),
        })
    }

    pub(crate) fn ca_certificate_pem(&self) -> &str {
        &self.ca_certificate_pem
    }

    pub(crate) fn gateway(&self) -> &TlsIdentityMaterial {
        &self.gateway
    }

    pub(crate) fn worker(&self) -> &TlsIdentityMaterial {
        &self.worker
    }

    pub(crate) fn device(&self) -> &TlsIdentityMaterial {
        &self.device
    }

    pub(crate) fn command_signing(&self) -> &CommandSigningMaterial {
        &self.command_signing
    }

    pub(crate) fn private_server_token(&self) -> &str {
        self.private_server_token.as_str()
    }

    pub(crate) fn matches_authority(
        &self,
        authority: &DesktopWorkspaceAuthority,
    ) -> Result<bool, WorkspaceNativeError> {
        let workspace = authority.current_workspace()?;
        Ok(self.authority_binding.device_id == authority.device_id()
            && self.authority_binding.device_binding_id == authority.device_binding_id()
            && self.authority_binding.runtime_binding_id
                == workspace.workspace_runtime_binding_id()
            && self.authority_binding.workspace_binding_id == workspace.workspace_binding_id()
            && self.authority_binding.incarnation_id == workspace.incarnation_id()
            && self.authority_binding.workspace_revision == workspace.revision())
    }
}

impl TlsIdentityMaterial {
    pub(crate) fn identity_id(&self) -> &str {
        &self.identity_id
    }

    pub(crate) fn credential_id(&self) -> &str {
        &self.credential_id
    }

    pub(crate) fn certificate_pem(&self) -> &str {
        &self.certificate_pem
    }

    pub(crate) fn private_key_pem(&self) -> &str {
        self.private_key_pem.as_str()
    }

    pub(crate) fn fingerprint256(&self) -> &str {
        &self.fingerprint256
    }

    pub(crate) fn certificate_sha256(&self) -> &str {
        &self.certificate_sha256
    }
}

impl CommandSigningMaterial {
    pub(crate) fn key_id(&self) -> &str {
        &self.key_id
    }

    pub(crate) fn private_key_pem(&self) -> &str {
        self.private_key_pem.as_str()
    }

    pub(crate) fn public_key_pem(&self) -> &str {
        &self.public_key_pem
    }
}

struct CertificateAuthority {
    certificate: CertifiedIssuer<'static, KeyPair>,
}

enum CertificateRole {
    Server,
    Client,
}

fn certificate_authority() -> Result<CertificateAuthority, WorkspaceNativeError> {
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.distinguished_name = distinguished_name("CrewON Desktop Ephemeral CA");
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    let certificate = CertifiedIssuer::self_signed(params, key)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    Ok(CertificateAuthority { certificate })
}

fn tls_identity(
    identity_id: String,
    credential_id: String,
    role: CertificateRole,
    authority: &CertificateAuthority,
) -> Result<TlsIdentityMaterial, WorkspaceNativeError> {
    let subject_alt_names = match role {
        CertificateRole::Server => vec!["localhost".to_string(), "127.0.0.1".to_string()],
        CertificateRole::Client => vec![identity_id.clone()],
    };
    let mut params = CertificateParams::new(subject_alt_names)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    params.distinguished_name = distinguished_name(&identity_id);
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![match role {
        CertificateRole::Server => ExtendedKeyUsagePurpose::ServerAuth,
        CertificateRole::Client => ExtendedKeyUsagePurpose::ClientAuth,
    }];
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    let certificate = params
        .signed_by(&key, &authority.certificate)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    let digest = Sha256::digest(certificate.der().as_ref());
    Ok(TlsIdentityMaterial {
        identity_id,
        credential_id,
        certificate_pem: certificate.pem(),
        private_key_pem: Zeroizing::new(key.serialize_pem()),
        fingerprint256: uppercase_colon_hex(&digest),
        certificate_sha256: format!("sha256:{}", hex::encode(digest)),
    })
}

fn command_signing_material() -> Result<CommandSigningMaterial, WorkspaceNativeError> {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    let signing_key = SigningKey::from_bytes(&bytes);
    let private_key_pem = signing_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    let public_key_pem = signing_key
        .verifying_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    Ok(CommandSigningMaterial {
        key_id: random_id("desktop-workspace-command-key")?,
        private_key_pem,
        public_key_pem,
    })
}

fn distinguished_name(common_name: &str) -> DistinguishedName {
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, common_name);
    name
}

fn random_id(prefix: &str) -> Result<String, WorkspaceNativeError> {
    Ok(format!("{prefix}-{}", random_hex(16)?))
}

fn random_hex(length: usize) -> Result<String, WorkspaceNativeError> {
    let mut bytes = Zeroizing::new(vec![0_u8; length]);
    getrandom::fill(bytes.as_mut_slice())
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    Ok(hex::encode(bytes.as_slice()))
}

fn uppercase_colon_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}
