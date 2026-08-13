use serde::Serialize;
use zeroize::Zeroizing;

use super::DesktopWorkspaceAuthority;
use super::WorkspaceLaunchMaterial;
use super::WorkspaceNativeError;
use super::STANDALONE_POLICY_SNAPSHOT_ID;
use super::STANDALONE_SPACE_ID;
use super::STANDALONE_TENANT_ID;

pub(crate) struct WorkspacePayloadConfig {
    pub(crate) deadline_ms: u32,
}

pub(crate) struct WorkspaceLaunchPayloads<'a> {
    worker_workspace: WorkerWorkspaceBootstrap<'a>,
}

impl std::fmt::Debug for WorkspaceLaunchPayloads<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceLaunchPayloads([REDACTED])")
    }
}

impl<'a> WorkspaceLaunchPayloads<'a> {
    pub(crate) fn build(
        authority: &'a DesktopWorkspaceAuthority,
        material: &'a WorkspaceLaunchMaterial,
        config: WorkspacePayloadConfig,
    ) -> Result<Self, WorkspaceNativeError> {
        if !(1_000..=60_000).contains(&config.deadline_ms)
            || !material.matches_authority(authority)?
        {
            return Err(WorkspaceNativeError::PayloadInvalid);
        }
        let workspace = authority.current_workspace()?;
        let command_key = material.command_signing();
        Ok(Self {
            worker_workspace: WorkerWorkspaceBootstrap {
                trusted_local_path: workspace.trusted_path(),
                deadline_ms: config.deadline_ms,
                private_server: WorkerPrivateServer {
                    port: 0,
                    token: material.private_server_token(),
                },
                authority: WorkerWorkspaceAuthority {
                    tenant_id: STANDALONE_TENANT_ID,
                    space_id: STANDALONE_SPACE_ID,
                    workspace_binding_id: workspace.workspace_binding_id(),
                    incarnation_id: workspace.incarnation_id(),
                    device_binding_id: authority.device_binding_id(),
                    device_id: authority.device_id(),
                    runtime_binding_id: workspace.workspace_runtime_binding_id(),
                    policy_snapshot_id: STANDALONE_POLICY_SNAPSHOT_ID,
                },
                signing: WorkerSigning {
                    key_id: command_key.key_id(),
                    private_key_pem: command_key.private_key_pem(),
                },
            },
        })
    }

    pub(crate) fn worker_workspace_json(&self) -> Result<Zeroizing<Vec<u8>>, WorkspaceNativeError> {
        serde_json::to_vec(&self.worker_workspace)
            .map(Zeroizing::new)
            .map_err(|_| WorkspaceNativeError::PayloadInvalid)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWorkspaceBootstrap<'a> {
    trusted_local_path: &'a str,
    deadline_ms: u32,
    private_server: WorkerPrivateServer<'a>,
    authority: WorkerWorkspaceAuthority<'a>,
    signing: WorkerSigning<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerPrivateServer<'a> {
    port: u16,
    token: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWorkspaceAuthority<'a> {
    tenant_id: &'static str,
    space_id: &'static str,
    workspace_binding_id: &'a str,
    incarnation_id: &'a str,
    device_binding_id: &'a str,
    device_id: &'a str,
    runtime_binding_id: &'a str,
    policy_snapshot_id: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSigning<'a> {
    key_id: &'a str,
    private_key_pem: &'a str,
}
