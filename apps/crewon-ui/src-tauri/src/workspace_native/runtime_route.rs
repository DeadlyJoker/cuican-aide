use super::DesktopWorkspaceAuthority;
use super::WorkspaceNativeError;
use super::STANDALONE_POLICY_SNAPSHOT_ID;

const STANDALONE_RUNTIME_GENERATION: &str = "ts-v0";
const STANDALONE_AGENT_VERSION_ID: &str = "default-agent-v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeRouteProjection {
    pub(super) tenant_id: String,
    pub(super) agent_version_id: String,
    pub(super) runtime_generation: String,
    pub(super) policy_snapshot_id: String,
    pub(super) workspace_binding_id: Option<String>,
}

impl RuntimeRouteProjection {
    pub(crate) fn standalone() -> Self {
        Self {
            tenant_id: super::STANDALONE_TENANT_ID.to_string(),
            agent_version_id: STANDALONE_AGENT_VERSION_ID.to_string(),
            runtime_generation: STANDALONE_RUNTIME_GENERATION.to_string(),
            policy_snapshot_id: STANDALONE_POLICY_SNAPSHOT_ID.to_string(),
            workspace_binding_id: None,
        }
    }

    pub(crate) fn from_authority(
        authority: &DesktopWorkspaceAuthority,
    ) -> Result<Self, WorkspaceNativeError> {
        if authority.pending().is_some() {
            return Err(WorkspaceNativeError::AuthorityRecoveryRequired);
        }
        let Some(workspace) = authority.current_snapshot() else {
            return Ok(Self::standalone());
        };
        Ok(Self {
            tenant_id: super::STANDALONE_TENANT_ID.to_string(),
            agent_version_id: format!(
                "{STANDALONE_AGENT_VERSION_ID}:{}",
                workspace.workspace_runtime_binding_id()
            ),
            runtime_generation: workspace.workspace_runtime_binding_id().to_string(),
            policy_snapshot_id: STANDALONE_POLICY_SNAPSHOT_ID.to_string(),
            workspace_binding_id: Some(workspace.workspace_binding_id().to_string()),
        })
    }

    pub(crate) fn agent_version_id(&self) -> &str {
        &self.agent_version_id
    }

    pub(crate) fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    pub(crate) fn runtime_generation(&self) -> &str {
        &self.runtime_generation
    }

    pub(crate) fn policy_snapshot_id(&self) -> &str {
        &self.policy_snapshot_id
    }

    pub(crate) fn workspace_binding_id(&self) -> Option<&str> {
        self.workspace_binding_id.as_deref()
    }
}
