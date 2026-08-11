use super::DesktopWorkspaceAuthority;
use super::WorkspaceGatewayLaunchPayloads;
use super::WorkspaceLaunchMaterial;
use super::WorkspaceLaunchPayloads;
use super::WorkspaceNativeError;
use super::WorkspacePayloadConfig;

/// Owns one App-lifetime credential generation. Provider reloads must rebuild
/// payload bytes from this same session rather than rotate live child identity.
pub(crate) struct WorkspaceNativeLaunchSession {
    material: WorkspaceLaunchMaterial,
}

impl std::fmt::Debug for WorkspaceNativeLaunchSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceNativeLaunchSession([REDACTED])")
    }
}

impl WorkspaceNativeLaunchSession {
    pub(crate) fn start(
        authority: &DesktopWorkspaceAuthority,
    ) -> Result<Self, WorkspaceNativeError> {
        Ok(Self {
            material: WorkspaceLaunchMaterial::generate(authority)?,
        })
    }

    pub(crate) fn gateway_launch<'a>(
        &'a self,
        authority: &'a DesktopWorkspaceAuthority,
    ) -> Result<WorkspaceGatewayLaunchPayloads<'a>, WorkspaceNativeError> {
        WorkspaceGatewayLaunchPayloads::build(authority, &self.material)
    }

    pub(crate) fn runtime_launch<'a>(
        &'a self,
        authority: &'a DesktopWorkspaceAuthority,
        config: WorkspacePayloadConfig,
    ) -> Result<WorkspaceLaunchPayloads<'a>, WorkspaceNativeError> {
        WorkspaceLaunchPayloads::build(authority, &self.material, config)
    }
}
