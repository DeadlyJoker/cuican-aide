//! Owns the packaged TypeScript Control API and runtime-worker processes.
//!
//! Session credentials exist only in this host state and the Control API child
//! environment. The renderer receives a short-lived copy through one typed Tauri
//! command; no build-time variable, URL, DOM node, log, or persistent web storage
//! is involved.

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::AppHandle;
use tauri::Manager;
use tauri::RunEvent;
use tauri::State;
use zeroize::Zeroize;
use zeroize::Zeroizing;

#[path = "control_runtime_environment.rs"]
mod environment;
#[path = "control_runtime_private_credentials.rs"]
pub(crate) mod private_credentials;
#[path = "control_runtime_process.rs"]
pub(crate) mod process;
#[path = "control_runtime_provider_coordinator.rs"]
mod provider_coordinator;
#[path = "control_runtime_provider_switch.rs"]
pub(crate) mod provider_switch;
#[path = "control_runtime_reload.rs"]
pub(crate) mod reload;
#[path = "control_runtime_remote_mcp_projection.rs"]
mod remote_mcp_projection;
#[path = "control_runtime_workspace.rs"]
mod workspace;
#[path = "control_runtime_workspace_candidate.rs"]
mod workspace_candidate;
#[path = "control_runtime_workspace_commit.rs"]
mod workspace_commit;
#[path = "control_runtime_workspace_coordinator.rs"]
pub(crate) mod workspace_coordinator;
#[path = "control_runtime_workspace_fence.rs"]
mod workspace_fence;
#[path = "control_runtime_workspace_install.rs"]
mod workspace_install;
#[path = "control_runtime_workspace_postcommit.rs"]
mod workspace_postcommit;
#[path = "control_runtime_workspace_state.rs"]
mod workspace_state;
#[path = "control_runtime_workspace_status.rs"]
pub(crate) mod workspace_status;
#[path = "control_runtime_workspace_switch.rs"]
mod workspace_switch;
#[path = "control_runtime_workspace_termination.rs"]
mod workspace_termination;
#[path = "control_runtime_workspace_wire.rs"]
mod workspace_wire;

use self::environment::control_environment;
use self::environment::effective_agent_version_id;
use self::environment::release_environment;
use self::environment::worker_bootstrap_input;
use self::environment::worker_environment;
use self::environment::ControlAdmissionMode;
use self::private_credentials::load_private_credential_bindings;
use self::process::managed_children_are_terminated;
use self::process::monitor_process;
use self::process::port_in_use;
use self::process::spawn_node;
use self::process::spawn_node_with_input;
use self::process::terminate_managed_children;
use self::process::terminate_startup_children;
use self::process::wait_for_ready;
use self::process::wait_for_successful_exit;
use self::process::ManagedChild as CommandChild;
use self::process::ProcessEvents;
use self::process::ProcessRole;
use crate::provider_credentials;
use crate::workspace_native::DesktopWorkspaceAuthority;
use crate::workspace_native::RuntimeRouteProjection;

const CONTROL_API_PORT: u16 = 3210;
const CONTROL_API_BASE_URL: &str = "http://127.0.0.1:3210/";
const PROVIDER_PROBE_PORT: u16 = 3211;
const PROVIDER_PROBE_ORIGIN: &str = "http://127.0.0.1:3211";
const DESKTOP_ORIGIN: &str = "http://tauri.localhost";
const ARTIFACT_KEY_ID: &str = "desktop-artifact-key-v1";
const SKIP_SIDECAR_ENV: &str = "CREWON_DESKTOP_SKIP_SIDECAR";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const TERMINATION_TIMEOUT: Duration = Duration::from_secs(20);
static STARTUP_QUARANTINE: Mutex<StartupQuarantine> = Mutex::new(StartupQuarantine {
    lease: None,
    processes: Vec::new(),
});

#[derive(Debug, Clone, Copy)]
pub enum ControlRuntimeStartError {
    AppDataUnavailable,
    ArtifactKeyInvalid,
    ControlApiNotReady,
    ProcessEventUnavailable,
    ProcessSpawnFailed,
    RandomnessUnavailable,
    ReleaseFailed,
    ProviderCredentialUnavailable,
    ProviderCoordinatorFailed,
    ActiveRun,
    RuntimeDatabaseUnavailable,
    RuntimeUnavailable,
    RuntimeRollbackFailed,
    ResourceUnavailable,
    RuntimeStateAlreadyInstalled,
    WorkerNotReady,
    GatewayNotReady,
    DeviceNotReady,
    WorkspaceRuntimeFailed,
}

impl ControlRuntimeStartError {
    pub fn code(self) -> &'static str {
        match self {
            Self::AppDataUnavailable => "control_runtime_app_data_unavailable",
            Self::ArtifactKeyInvalid => "control_runtime_artifact_key_invalid",
            Self::ControlApiNotReady => "control_runtime_control_api_not_ready",
            Self::ProcessEventUnavailable => "control_runtime_process_event_unavailable",
            Self::ProcessSpawnFailed => "control_runtime_process_spawn_failed",
            Self::RandomnessUnavailable => "control_runtime_randomness_unavailable",
            Self::ReleaseFailed => "control_runtime_release_failed",
            Self::ProviderCredentialUnavailable => {
                "control_runtime_provider_credential_unavailable"
            }
            Self::ProviderCoordinatorFailed => "control_runtime_provider_coordinator_failed",
            Self::ActiveRun => "control_runtime_active_run",
            Self::RuntimeDatabaseUnavailable => "control_runtime_database_unavailable",
            Self::RuntimeUnavailable => "control_runtime_unavailable",
            Self::RuntimeRollbackFailed => "control_runtime_rollback_failed",
            Self::ResourceUnavailable => "control_runtime_resource_unavailable",
            Self::RuntimeStateAlreadyInstalled => "control_runtime_state_already_installed",
            Self::WorkerNotReady => "control_runtime_worker_not_ready",
            Self::GatewayNotReady => "control_runtime_gateway_not_ready",
            Self::DeviceNotReady => "control_runtime_device_not_ready",
            Self::WorkspaceRuntimeFailed => "control_runtime_workspace_failed",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRuntimeBootstrap {
    base_url: String,
    csrf_token: String,
    origin: String,
    session_token: String,
}

impl Drop for ControlRuntimeBootstrap {
    fn drop(&mut self) {
        self.csrf_token.zeroize();
        self.session_token.zeroize();
    }
}

struct SessionMaterial {
    csrf_token: Zeroizing<String>,
    provider_probe_token: Zeroizing<String>,
    session_token: Zeroizing<String>,
}

impl SessionMaterial {
    fn generate() -> Result<Self, ControlRuntimeStartError> {
        let csrf_token = random_secret()?;
        let provider_probe_token = random_secret()?;
        let session_token = random_secret()?;
        if csrf_token == session_token
            || csrf_token == provider_probe_token
            || session_token == provider_probe_token
        {
            return Err(ControlRuntimeStartError::RandomnessUnavailable);
        }
        Ok(Self {
            csrf_token,
            provider_probe_token,
            session_token,
        })
    }

    fn public_bootstrap(&self) -> ControlRuntimeBootstrap {
        ControlRuntimeBootstrap {
            base_url: CONTROL_API_BASE_URL.to_string(),
            csrf_token: self.csrf_token.to_string(),
            origin: DESKTOP_ORIGIN.to_string(),
            session_token: self.session_token.to_string(),
        }
    }
}

include!("control_runtime_lifecycle.rs");

include!("control_runtime_startup.rs");

pub fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    if !matches!(event, RunEvent::Exit) {
        return;
    }
    shutdown_managed_supervisor(app);
}

#[cfg(test)]
#[path = "control_runtime_tests.rs"]
mod tests;
