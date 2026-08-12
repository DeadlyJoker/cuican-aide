use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use chrono::Duration as ChronoDuration;
use crewon_device::ConnectionEpochFence;
use crewon_device::DeviceCommandAuthorizer;
use crewon_device::NativeDeviceRuntimeBinding;
use crewon_device::NativeFilesystemReadOrchestrator;
use crewon_device::NativeToolOrchestrator;
use crewon_device::NativeWorkspaceListOrchestrator;
use crewon_device::WorkspaceDirectoryRegistry;
use crewon_device::WorkspaceListCancellation;
use crewon_device_journal::DeviceWorkspaceJournal;
use rustls::ClientConfig;
use tokio_tungstenite::Connector;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::client_async_tls_with_config;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use url::Url;

use crate::DeviceRuntimeBootstrap;
use crate::DeviceRuntimeError;
use crate::bootstrap::read_bootstrap;
use crate::diagnostics::DiagnosticReporter;
use crate::session::run_socket_with_ready;
use crate::tls::build_client_config;

pub(crate) const MAX_ACKNOWLEDGED_EXECUTIONS: usize = 256;
pub(crate) const MAX_UNACKNOWLEDGED_EXECUTIONS: usize = 64;
pub(crate) const MAX_SOCKET_MESSAGE_BYTES: usize = 128 * 1024;
pub(crate) const WORKSPACE_LIST_CAPABILITY: &str = "workspace.list_top_level.v0";
pub(crate) const WORKSPACE_READ_CAPABILITY: &str = "workspace.read_file.v0";
pub(crate) const RAW_WORKSPACE_READ_CAPABILITY: &str = "workspace.read_file.raw_tool.v0";
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(15);

pub struct DeviceRuntime {
    pub(crate) state: Arc<DeviceRuntimeState>,
}

/// Non-secret proof that the native runtime accepted a concrete Gateway epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRuntimeReady {
    pub device_id: String,
    pub runtime_binding_id: String,
    pub connection_epoch: u64,
}

impl DeviceRuntimeReady {
    /// Stable stdout line consumed by the desktop process supervisor.
    pub fn supervisor_line(&self) -> String {
        format!(
            "CrewON Device Runtime ready:{}:{}:{}",
            self.device_id, self.runtime_binding_id, self.connection_epoch
        )
    }
}

pub(crate) struct DeviceRuntimeState {
    pub gateway_url: Url,
    pub device_id: String,
    pub runtime_binding: NativeDeviceRuntimeBinding,
    pub journal: DeviceWorkspaceJournal,
    pub orchestrator: NativeWorkspaceListOrchestrator,
    pub read_orchestrator: NativeFilesystemReadOrchestrator,
    pub tool_orchestrator: NativeToolOrchestrator,
    pub registry: Arc<WorkspaceDirectoryRegistry>,
    pub fence: Arc<ConnectionEpochFence>,
    pub authorizer: Arc<DeviceCommandAuthorizer>,
    pub tls: Arc<ClientConfig>,
    pub generation: AtomicU64,
    pub events: tokio::sync::broadcast::Sender<RuntimeEvent>,
    pub cancellations: Mutex<HashMap<String, ActiveCancellation>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RuntimeEvent {
    WorkspaceList(crewon_device_protocol::DeviceWorkspaceListEvent),
    FilesystemRead(crewon_device_protocol::DeviceFilesystemReadEvent),
    Tool(crewon_device_protocol::DeviceExecutionEvent),
}

#[derive(Clone)]
pub(crate) struct ActiveCancellation {
    pub lease_id: String,
    pub lease_epoch: u64,
    pub cancellation: WorkspaceListCancellation,
}

impl std::fmt::Debug for DeviceRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DeviceRuntime([REDACTED])")
    }
}

impl DeviceRuntime {
    pub async fn open(bootstrap: DeviceRuntimeBootstrap) -> Result<Self, DeviceRuntimeError> {
        let tls = build_client_config(&bootstrap.tls)?;
        let journal = DeviceWorkspaceJournal::open(&bootstrap.journal_path)
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_journal_unavailable", error)
            })?;
        let registry = Arc::new(WorkspaceDirectoryRegistry::new());
        for workspace in &bootstrap.workspaces {
            registry
                .register_with_incarnation(
                    workspace.workspace_binding_id.clone(),
                    workspace.incarnation_id.clone(),
                    &workspace.trusted_local_path,
                )
                .map_err(|error| {
                    DeviceRuntimeError::with_source("device_runtime_workspace_unavailable", error)
                })?;
        }
        let runtime_binding = NativeDeviceRuntimeBinding::new(
            bootstrap.device_binding_id,
            bootstrap.runtime_binding_id,
        )
        .map_err(|error| {
            DeviceRuntimeError::with_source("device_runtime_binding_invalid", error)
        })?;
        let authorizer =
            DeviceCommandAuthorizer::new(bootstrap.command_keys, ChronoDuration::seconds(30))
                .map_err(|error| {
                    DeviceRuntimeError::with_source("device_runtime_command_keys_invalid", error)
                })?;
        let fence = ConnectionEpochFence::open(
            bootstrap.device_id.clone(),
            authority_directory(&bootstrap.journal_path),
        )
        .map_err(|error| {
            DeviceRuntimeError::with_source("device_runtime_epoch_authority_unavailable", error)
        })?;
        let orchestrator = NativeWorkspaceListOrchestrator::new(journal.clone());
        let read_orchestrator = NativeFilesystemReadOrchestrator::new(journal.clone());
        let tool_orchestrator = NativeToolOrchestrator::new(journal.clone());
        let (events, _) = tokio::sync::broadcast::channel(256);
        Ok(Self {
            state: Arc::new(DeviceRuntimeState {
                gateway_url: bootstrap.gateway_url,
                device_id: bootstrap.device_id,
                runtime_binding,
                journal,
                orchestrator,
                read_orchestrator,
                tool_orchestrator,
                registry,
                fence: Arc::new(fence),
                authorizer: Arc::new(authorizer),
                tls,
                generation: AtomicU64::new(0),
                events,
                cancellations: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub async fn run(&self) -> Result<(), DeviceRuntimeError> {
        self.run_with_ready(|_| {}).await
    }

    /// Reconnects forever and reports each strictly accepted Gateway epoch.
    pub async fn run_with_ready(
        &self,
        on_ready: impl Fn(DeviceRuntimeReady) + Send + Sync,
    ) -> Result<(), DeviceRuntimeError> {
        let mut retry_delay = Duration::from_millis(250);
        let diagnostics_started_at = std::time::Instant::now();
        let mut diagnostics =
            DiagnosticReporter::new(std::io::stderr(), move || diagnostics_started_at.elapsed());
        loop {
            let result = match self.connect_socket().await {
                Ok(socket) => {
                    retry_delay = Duration::from_millis(250);
                    run_socket_with_ready(Arc::clone(&self.state), socket, &on_ready).await
                }
                Err(error) => Err(error),
            };
            diagnostics.observe(&result);
            tokio::time::sleep(retry_delay).await;
            retry_delay = retry_delay.saturating_mul(2).min(Duration::from_secs(5));
        }
    }

    pub(crate) async fn connect_socket(
        &self,
    ) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, DeviceRuntimeError> {
        tokio::time::timeout(CONNECTION_TIMEOUT, self.connect_socket_inner())
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_socket_timeout", error)
            })?
    }

    async fn connect_socket_inner(
        &self,
    ) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, DeviceRuntimeError> {
        let host = self
            .state
            .gateway_url
            .host_str()
            .ok_or_else(|| DeviceRuntimeError::new("device_runtime_gateway_invalid"))?;
        let port = self
            .state
            .gateway_url
            .port_or_known_default()
            .ok_or_else(|| DeviceRuntimeError::new("device_runtime_gateway_invalid"))?;
        let socket = tokio::net::TcpStream::connect((host, port))
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_socket_failed", error)
            })?;
        let connector = Connector::Rustls(Arc::clone(&self.state.tls));
        client_async_tls_with_config(
            self.state.gateway_url.as_str(),
            socket,
            Some(socket_config()),
            Some(connector),
        )
        .await
        .map(|(socket, _response)| socket)
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_socket_failed", error))
    }
}

pub async fn run_from_stdin() -> Result<(), DeviceRuntimeError> {
    run_from_stdin_with_ready(|_| {}).await
}

/// Reads the one-line native bootstrap and reports accepted Gateway epochs.
pub async fn run_from_stdin_with_ready(
    on_ready: impl Fn(DeviceRuntimeReady) + Send + Sync,
) -> Result<(), DeviceRuntimeError> {
    let bootstrap = read_bootstrap(tokio::io::stdin()).await?;
    DeviceRuntime::open(bootstrap)
        .await?
        .run_with_ready(on_ready)
        .await
}

fn authority_directory(journal_path: &std::path::Path) -> PathBuf {
    let mut directory = journal_path.as_os_str().to_owned();
    directory.push(".connection-authority");
    PathBuf::from(directory)
}

fn socket_config() -> WebSocketConfig {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_SOCKET_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_SOCKET_MESSAGE_BYTES);
    config.max_write_buffer_size = MAX_SOCKET_MESSAGE_BYTES * 4;
    config
}
