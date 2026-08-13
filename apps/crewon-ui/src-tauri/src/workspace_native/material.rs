use zeroize::Zeroizing;

use super::DesktopWorkspaceAuthority;
use super::WorkspaceNativeError;

pub(crate) struct WorkspaceLaunchMaterial {
    authority_binding: LaunchAuthorityBinding,
    private_server_token: Zeroizing<String>,
}

struct LaunchAuthorityBinding {
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

impl WorkspaceLaunchMaterial {
    /// Creates launch-scoped local runtime material retained across Provider reloads.
    pub(crate) fn generate(
        authority: &DesktopWorkspaceAuthority,
    ) -> Result<Self, WorkspaceNativeError> {
        let workspace = authority.current_workspace()?;
        Ok(Self {
            authority_binding: LaunchAuthorityBinding {
                runtime_binding_id: workspace.workspace_runtime_binding_id().to_string(),
                workspace_binding_id: workspace.workspace_binding_id().to_string(),
                incarnation_id: workspace.incarnation_id().to_string(),
                workspace_revision: workspace.revision(),
            },
            private_server_token: Zeroizing::new(random_hex(32)?),
        })
    }

    pub(crate) fn private_server_token(&self) -> &str {
        self.private_server_token.as_str()
    }

    pub(crate) fn matches_authority(
        &self,
        authority: &DesktopWorkspaceAuthority,
    ) -> Result<bool, WorkspaceNativeError> {
        let workspace = authority.current_workspace()?;
        Ok(
            self.authority_binding.runtime_binding_id == workspace.workspace_runtime_binding_id()
                && self.authority_binding.workspace_binding_id == workspace.workspace_binding_id()
                && self.authority_binding.incarnation_id == workspace.incarnation_id()
                && self.authority_binding.workspace_revision == workspace.revision(),
        )
    }
}

fn random_hex(length: usize) -> Result<String, WorkspaceNativeError> {
    let mut bytes = Zeroizing::new(vec![0_u8; length]);
    getrandom::fill(bytes.as_mut_slice())
        .map_err(|_| WorkspaceNativeError::MaterialGenerationFailed)?;
    Ok(hex::encode(bytes.as_slice()))
}
