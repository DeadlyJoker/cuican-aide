use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::AppHandle;
use zeroize::Zeroizing;

use super::environment::device_environment;
use super::environment::gateway_environment;
use super::environment::worker_bootstrap_input_with_workspace;
use super::environment::GatewayEnvironment;
use super::process::spawn_node;
use super::process::spawn_sidecar_with_input;
use super::process::wait_for_matching_ready;
use super::process::ManagedChild as CommandChild;
use super::provider_credentials::ActiveProviderRuntime;
use super::require_regular_file;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;
use super::ProcessEvents;
use super::RuntimePaths;
use super::SessionMaterial;
use super::READY_TIMEOUT;
use crate::workspace_native::DesktopWorkspaceAuthority;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::GatewayReadyAddress;
use crate::workspace_native::RuntimeRouteProjection;
use crate::workspace_native::WorkspaceNativeError;
use crate::workspace_native::WorkspaceNativeLaunchSession;
use crate::workspace_native::WorkspacePayloadConfig;

const DEVICE_RUNTIME_SIDECAR: &str = "crewon-device-runtime";
const GATEWAY_DEADLINE_MS: u32 = 40_000;

pub(super) struct WorkspaceRuntimeContext {
    authority: DesktopWorkspaceAuthority,
    launch_session: WorkspaceNativeLaunchSession,
    gateway_ready: GatewayReadyAddress,
    journal_path: PathBuf,
}

impl std::fmt::Debug for WorkspaceRuntimeContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceRuntimeContext([REDACTED])")
    }
}

pub(super) struct StartedWorkspaceFoundation {
    pub(super) context: Arc<WorkspaceRuntimeContext>,
    pub(super) device: CommandChild,
    pub(super) device_events: ProcessEvents,
    pub(super) gateway: CommandChild,
    pub(super) gateway_events: ProcessEvents,
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
    ) -> Result<WorkspaceWorkerBootstrap, ControlRuntimeStartError> {
        let payloads = self
            .launch_session
            .runtime_launch(
                &self.authority,
                WorkspacePayloadConfig {
                    gateway_ready: self.gateway_ready.clone(),
                    journal_path: self.journal_path.clone(),
                    gateway_deadline_ms: GATEWAY_DEADLINE_MS,
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
        let input = worker_bootstrap_input_with_workspace(provider, session, &workspace)
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
            deadline_ms: GATEWAY_DEADLINE_MS,
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
    app: &AppHandle,
    paths: &RuntimePaths,
    authority: DesktopWorkspaceAuthority,
    supervisor: Option<&ControlRuntimeSupervisor>,
) -> Result<StartedWorkspaceFoundation, ControlRuntimeStartError> {
    require_regular_file(&paths.device_gateway_bundle)?;
    let runtime_binding_id = authority
        .current_workspace()
        .map_err(map_workspace_error)?
        .workspace_runtime_binding_id();
    let runtime_directory =
        prepare_runtime_directory(&paths.workspace_runtime_root, runtime_binding_id)?;
    let gateway_database = runtime_directory.join("gateway.sqlite");
    let journal_path = runtime_directory.join("device-journal.sqlite");
    let launch_session =
        WorkspaceNativeLaunchSession::start(&authority).map_err(map_workspace_error)?;
    let gateway_payloads = launch_session
        .gateway_launch(&authority)
        .map_err(map_workspace_error)?;
    let identity: GatewayIdentity = serde_json::from_slice(
        &gateway_payloads
            .gateway_identity_json()
            .map_err(map_workspace_error)?,
    )
    .map_err(|_| workspace_failed())?;
    let bind: GatewayBind =
        serde_json::from_slice(&gateway_payloads.bind_json().map_err(map_workspace_error)?)
            .map_err(|_| workspace_failed())?;
    if identity.schema_version != "crewon.desktop-gateway-identity.v0"
        || identity.kind != "standaloneWorkspace"
        || identity.servername != "localhost"
        || !opaque(&identity.gateway_id)
        || !opaque(&identity.credential_id)
        || !certificate_fingerprint(&identity.fingerprint256)
        || bind.host != "127.0.0.1"
        || bind.port != 0
    {
        return Err(workspace_failed());
    }
    let workspace_runtime_binding_id = authority
        .current_workspace()
        .map_err(map_workspace_error)?
        .workspace_runtime_binding_id()
        .to_string();
    let device_id = authority.device_id().to_string();
    let mut files = GatewayLaunchFiles::create(paths, &gateway_payloads)?;
    let (gateway_events, gateway) = spawn_node(
        app,
        &paths.device_gateway_bundle,
        &paths.root,
        gateway_environment(GatewayEnvironment {
            database_path: &gateway_database,
            gateway_id: &identity.gateway_id,
            registry_path: &files.registry,
            tls_key_path: &files.tls_key,
            tls_certificate_path: &files.tls_certificate,
            tls_ca_path: &files.tls_ca,
        }),
        "crewon-device-gateway-events",
    )?;
    let gateway_port =
        match wait_for_matching_ready(&gateway_events, READY_TIMEOUT, project_gateway_ready) {
            Ok(port) => port,
            Err(()) => {
                stop_candidate_or_startup(supervisor, vec![gateway]);
                return Err(ControlRuntimeStartError::GatewayNotReady);
            }
        };
    if files.cleanup().is_err() {
        stop_candidate_or_startup(supervisor, vec![gateway]);
        return Err(workspace_failed());
    }
    let gateway_ready = match GatewayReadyAddress::loopback(gateway_port) {
        Ok(address) => address,
        Err(error) => {
            stop_candidate_or_startup(supervisor, vec![gateway]);
            return Err(map_workspace_error(error));
        }
    };
    let runtime_payloads = match launch_session.runtime_launch(
        &authority,
        WorkspacePayloadConfig {
            gateway_ready: gateway_ready.clone(),
            journal_path: journal_path.clone(),
            gateway_deadline_ms: GATEWAY_DEADLINE_MS,
        },
    ) {
        Ok(payloads) => payloads,
        Err(error) => {
            stop_candidate_or_startup(supervisor, vec![gateway]);
            return Err(map_workspace_error(error));
        }
    };
    let device_bootstrap = match runtime_payloads.device_bootstrap_json() {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            stop_candidate_or_startup(supervisor, vec![gateway]);
            return Err(map_workspace_error(error));
        }
    };
    let (device_events, device) = match spawn_sidecar_with_input(
        app,
        supervisor,
        DEVICE_RUNTIME_SIDECAR,
        &paths.root,
        device_environment(),
        "crewon-device-runtime-events",
        &device_bootstrap,
    ) {
        Ok(started) => started,
        Err(error) => {
            stop_candidate_or_startup(supervisor, vec![gateway]);
            return Err(error);
        }
    };
    if wait_for_matching_ready(&device_events, READY_TIMEOUT, |line| {
        project_device_ready(line, &device_id, &workspace_runtime_binding_id)
    })
    .is_err()
    {
        stop_candidate_or_startup(supervisor, vec![device, gateway]);
        return Err(ControlRuntimeStartError::DeviceNotReady);
    }
    Ok(StartedWorkspaceFoundation {
        context: Arc::new(WorkspaceRuntimeContext {
            authority,
            launch_session,
            gateway_ready,
            journal_path,
        }),
        device,
        device_events,
        gateway,
        gateway_events,
    })
}

fn stop_candidate_or_startup(
    supervisor: Option<&ControlRuntimeSupervisor>,
    children: Vec<CommandChild>,
) {
    match supervisor {
        Some(supervisor) => supervisor.quarantine_candidate_processes(children),
        None => super::process::terminate_startup_children(children),
    }
}

pub(super) fn stop_workspace_foundation(foundation: Option<StartedWorkspaceFoundation>) {
    let Some(foundation) = foundation else {
        return;
    };
    super::process::terminate_startup_children(vec![foundation.device, foundation.gateway]);
}

pub(super) fn quarantine_workspace_foundation(
    supervisor: &ControlRuntimeSupervisor,
    foundation: Option<StartedWorkspaceFoundation>,
) {
    let Some(foundation) = foundation else {
        return;
    };
    supervisor.quarantine_candidate_processes(vec![foundation.device, foundation.gateway]);
}

include!("control_runtime_workspace_material.rs");
fn project_gateway_ready(line: &[u8]) -> Option<u16> {
    let value = std::str::from_utf8(line).ok()?;
    let port = value
        .strip_prefix("CrewON Device Gateway listening on wss://127.0.0.1:")?
        .strip_suffix("/device/v1")?;
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse::<u16>().ok().filter(|port| *port != 0)
}

fn project_device_ready(line: &[u8], device_id: &str, runtime_binding_id: &str) -> Option<()> {
    let value = std::str::from_utf8(line).ok()?;
    let epoch = value.strip_prefix(&format!(
        "CrewON Device Runtime ready:{device_id}:{runtime_binding_id}:"
    ))?;
    if epoch.is_empty() || !epoch.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    epoch
        .parse::<u64>()
        .ok()
        .filter(|epoch| *epoch > 0)
        .map(|_| ())
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

fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn certificate_fingerprint(value: &str) -> bool {
    value.len() == 95
        && value.split(':').count() == 32
        && value.split(':').all(|pair| {
            pair.len() == 2
                && pair
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
        })
}

fn map_workspace_error(_error: WorkspaceNativeError) -> ControlRuntimeStartError {
    workspace_failed()
}

fn workspace_failed() -> ControlRuntimeStartError {
    ControlRuntimeStartError::WorkspaceRuntimeFailed
}

#[cfg(test)]
#[path = "control_runtime_workspace_tests.rs"]
mod tests;
