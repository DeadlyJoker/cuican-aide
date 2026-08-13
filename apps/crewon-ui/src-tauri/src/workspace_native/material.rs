use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::EncodePrivateKey as _;
use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

use super::DesktopWorkspaceAuthority;
use super::WorkspaceNativeError;

pub(crate) struct WorkspaceLaunchMaterial {
    authority_binding: LaunchAuthorityBinding,
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

pub(crate) struct CommandSigningMaterial {
    key_id: String,
    private_key_pem: Zeroizing<String>,
}

impl std::fmt::Debug for CommandSigningMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CommandSigningMaterial([REDACTED])")
    }
}

impl WorkspaceLaunchMaterial {
    /// Creates one launch-scoped signing identity retained across in-process
    /// Provider reloads and replaced only with the whole local runtime.
    pub(crate) fn generate(
        authority: &DesktopWorkspaceAuthority,
    ) -> Result<Self, WorkspaceNativeError> {
        let workspace = authority.current_workspace()?;
        Ok(Self {
            authority_binding: LaunchAuthorityBinding {
                device_id: authority.device_id().to_string(),
                device_binding_id: authority.device_binding_id().to_string(),
                runtime_binding_id: workspace.workspace_runtime_binding_id().to_string(),
                workspace_binding_id: workspace.workspace_binding_id().to_string(),
                incarnation_id: workspace.incarnation_id().to_string(),
                workspace_revision: workspace.revision(),
            },
            command_signing: command_signing_material()?,
            private_server_token: Zeroizing::new(random_hex(32)?),
        })
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

impl CommandSigningMaterial {
    pub(crate) fn key_id(&self) -> &str {
        &self.key_id
    }

    pub(crate) fn private_key_pem(&self) -> &str {
        self.private_key_pem.as_str()
    }
}

fn command_signing_material() -> Result<CommandSigningMaterial, WorkspaceNativeError> {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    let signing_key = SigningKey::from_bytes(&bytes);
    let private_key_pem = signing_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    Ok(CommandSigningMaterial {
        key_id: random_id("desktop-workspace-command-key")?,
        private_key_pem,
    })
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
