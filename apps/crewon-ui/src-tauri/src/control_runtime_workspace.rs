use std::sync::Arc;

use serde::Deserialize;
use zeroize::Zeroizing;

use super::environment::worker_bootstrap_input_with_workspace_and_credentials;
use super::private_credentials::PrivateCredentialBindings;
use super::process::wait_for_matching_ready;
use super::provider_credentials::ActiveProviderRuntime;
use super::ControlRuntimeStartError;
use super::ProcessEvents;
use super::RuntimePaths;
use super::SessionMaterial;
use super::READY_TIMEOUT;
use crate::workspace_native::DesktopWorkspaceAuthority;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::RuntimeRouteProjection;
use crate::workspace_native::WorkspaceNativeError;
use crate::workspace_native::WorkspaceNativeLaunchSession;
use crate::workspace_native::WorkspacePayloadConfig;

const WORKSPACE_DEADLINE_MS: u32 = 40_000;

pub(super) struct WorkspaceRuntimeContext {
    authority: DesktopWorkspaceAuthority,
    launch_session: WorkspaceNativeLaunchSession,
}

impl std::fmt::Debug for WorkspaceRuntimeContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceRuntimeContext([REDACTED])")
    }
}

pub(super) struct StartedWorkspaceFoundation {
    pub(super) context: Arc<WorkspaceRuntimeContext>,
}

#[derive(Clone)]
pub(super) struct WorkspaceWorkerRoute {
    pub(super) deadline_ms: u32,
    pub(super) origin: String,
    pub(super) token: Zeroizing<String>,
}

pub(super) struct WorkspaceWorkerBootstrap {
    pub(super) input: Zeroizing<Vec<u8>>,
    expected_runtime_binding_id: String,
    token: Zeroizing<String>,
}

impl WorkspaceRuntimeContext {
    pub(super) fn matches_authority(&self, authority: &DesktopWorkspaceAuthority) -> bool {
        self.authority.device_id() == authority.device_id()
            && self.authority.device_binding_id() == authority.device_binding_id()
            && self.authority.current_revision() == authority.current_revision()
            && self.authority.current_snapshot() == authority.current_snapshot()
    }

    pub(super) fn runtime_route(&self) -> Result<RuntimeRouteProjection, ControlRuntimeStartError> {
        RuntimeRouteProjection::from_authority(&self.authority).map_err(map_workspace_error)
    }

    pub(super) fn worker_bootstrap(
        &self,
        provider: Option<&ActiveProviderRuntime>,
        session: &SessionMaterial,
        credentials: Option<&PrivateCredentialBindings>,
    ) -> Result<WorkspaceWorkerBootstrap, ControlRuntimeStartError> {
        let payloads = self
            .launch_session
            .runtime_launch(
                &self.authority,
                WorkspacePayloadConfig {
                    deadline_ms: WORKSPACE_DEADLINE_MS,
                },
            )
            .map_err(map_workspace_error)?;
        let workspace = payloads
            .worker_workspace_json()
            .map_err(map_workspace_error)?;
        let projection: WorkspaceControlProjection =
            serde_json::from_slice(&workspace).map_err(|_| workspace_failed())?;
        if projection.private_server.port != 0
            || projection.private_server.token.len() < 32
            || projection.private_server.token.len() > 8_192
            || projection
                .private_server
                .token
                .chars()
                .any(char::is_control)
        {
            return Err(workspace_failed());
        }
        let input = worker_bootstrap_input_with_workspace_and_credentials(
            provider,
            session,
            &workspace,
            credentials,
        )
        .map_err(|()| workspace_failed())?;
        Ok(WorkspaceWorkerBootstrap {
            input,
            expected_runtime_binding_id: self
                .authority
                .current_workspace()
                .map_err(map_workspace_error)?
                .workspace_runtime_binding_id()
                .to_string(),
            token: projection.private_server.token,
        })
    }
}

impl WorkspaceWorkerBootstrap {
    pub(super) fn wait_ready(
        self,
        events: &ProcessEvents,
    ) -> Result<WorkspaceWorkerRoute, ControlRuntimeStartError> {
        let expected = self.expected_runtime_binding_id;
        let origin = wait_for_matching_ready(events, READY_TIMEOUT, |line| {
            project_workspace_ready(line, &expected)
        })
        .map_err(|()| ControlRuntimeStartError::WorkerNotReady)?;
        Ok(WorkspaceWorkerRoute {
            deadline_ms: WORKSPACE_DEADLINE_MS,
            origin,
            token: self.token,
        })
    }
}

pub(super) fn selected_workspace_authority(
    paths: &RuntimePaths,
) -> Result<Option<DesktopWorkspaceAuthority>, ControlRuntimeStartError> {
    let manager = DesktopWorkspaceAuthorityManager::open_durable(paths.workspace_authority.clone())
        .map_err(map_workspace_error)?;
    match manager.authority().current_workspace() {
        Ok(_) => Ok(Some(manager.authority().clone())),
        Err(WorkspaceNativeError::AuthorityUnavailable) => Ok(None),
        Err(error) => Err(map_workspace_error(error)),
    }
}

pub(super) fn recover_pending_workspace_authority(
    paths: &RuntimePaths,
) -> Result<(), ControlRuntimeStartError> {
    let mut manager =
        DesktopWorkspaceAuthorityManager::open_durable(paths.workspace_authority.clone())
            .map_err(map_workspace_error)?;
    manager
        .recover_orphaned_pending()
        .map_err(map_workspace_error)
}

pub(super) fn start_workspace_foundation(
    authority: DesktopWorkspaceAuthority,
) -> Result<StartedWorkspaceFoundation, ControlRuntimeStartError> {
    let launch_session =
        WorkspaceNativeLaunchSession::start(&authority).map_err(map_workspace_error)?;
    Ok(StartedWorkspaceFoundation {
        context: Arc::new(WorkspaceRuntimeContext {
            authority,
            launch_session,
        }),
    })
}

fn project_workspace_ready(line: &[u8], runtime_binding_id: &str) -> Option<String> {
    let value = std::str::from_utf8(line).ok()?;
    let origin = value
        .strip_prefix("CrewON Workspace Runtime ready:")?
        .strip_suffix(&format!(":{runtime_binding_id}"))?;
    let port = origin.strip_prefix("http://127.0.0.1:")?;
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .map(|_| origin.to_string())
}

fn map_workspace_error(_error: WorkspaceNativeError) -> ControlRuntimeStartError {
    workspace_failed()
}

fn workspace_failed() -> ControlRuntimeStartError {
    ControlRuntimeStartError::WorkspaceRuntimeFailed
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceControlProjection {
    private_server: WorkspacePrivateServerProjection,
}

#[derive(Deserialize)]
struct WorkspacePrivateServerProjection {
    port: u16,
    token: Zeroizing<String>,
}

#[cfg(test)]
#[path = "control_runtime_workspace_tests.rs"]
mod tests;
