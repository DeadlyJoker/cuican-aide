use std::collections::HashMap;
use std::fmt;
use std::io;
use std::io::ErrorKind;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crewon_state::StateRuntime;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::cloud_worker::CloudWorkerExecutor;
use super::provider_control_supervisor::ProviderControlSupervisor;
use super::provider_control_supervisor::ProviderControlSupervisorConfig;
use super::provider_control_supervisor::ProviderEventPump;
use crate::platform_control::provider_connection_production::AgentPlatformProviderDescriptorFactory;
use crate::platform_control::provider_connection_production::SystemProviderConnectionClock;
use crate::platform_control::provider_connection_startup::PreparedProviderConnectionRuntime;
use crewon_task_runtime::WorkerExecutor;

const ENABLED_ENV: &str = "CREWON_PROVIDER_CONTROL_ENABLED";
const DURABLE_CLOUD_AGENT_ENABLED_ENV: &str = "CREWON_DURABLE_CLOUD_AGENT_ENABLED";
const OUTBOX_LIMIT: u32 = 16;
const RECOVERY_LIMIT: u32 = 16;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const BASE_BACKOFF_SECONDS: i64 = 1;
const MAX_BACKOFF_SECONDS: i64 = 300;
const SUCCESSFUL_POLL_SECONDS: i64 = 1;
const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(1);

type ProductionCloudWorker = CloudWorkerExecutor<AgentPlatformProviderDescriptorFactory>;

pub(super) struct ProviderControlRuntime<Executor> {
    supervisor: Arc<ProviderControlSupervisor<Executor>>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

pub(crate) struct PreparedProviderControlRuntime {
    inner: ProviderControlRuntime<ProductionCloudWorker>,
}

impl PreparedProviderControlRuntime {
    pub(crate) fn from_process_environment(
        state: Option<Arc<StateRuntime>>,
        provider_runtime: Option<&PreparedProviderConnectionRuntime<SystemProviderConnectionClock>>,
    ) -> io::Result<Option<Self>> {
        let environment = std::env::vars().collect::<HashMap<_, _>>();
        prepare_provider_control_runtime(&environment, state, provider_runtime)
    }

    pub(crate) fn start(self, shutdown: CancellationToken) -> JoinHandle<()> {
        self.inner.start(shutdown)
    }
}

pub(crate) fn durable_cloud_agent_enabled_from_process_environment(
    provider_control_available: bool,
) -> io::Result<bool> {
    let environment = std::env::vars().collect::<HashMap<_, _>>();
    durable_cloud_agent_enabled(&environment, provider_control_available)
}

impl<Executor> ProviderControlRuntime<Executor>
where
    Executor: WorkerExecutor + ProviderEventPump + 'static,
{
    pub(super) fn new(
        supervisor: Arc<ProviderControlSupervisor<Executor>>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self { supervisor, clock }
    }

    pub(super) fn start(self, shutdown: CancellationToken) -> JoinHandle<()> {
        tokio::spawn(async move { self.run(shutdown).await })
    }

    async fn run(self, shutdown: CancellationToken) {
        loop {
            let tick = self.supervisor.run_once((self.clock)());
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                result = tick => {
                    if let Err(error) = result {
                        warn!(%error, "Provider control supervisor tick failed");
                    }
                }
            }
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                () = tokio::time::sleep(SUPERVISOR_INTERVAL) => {}
            }
        }
    }
}

impl fmt::Debug for PreparedProviderControlRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PreparedProviderControlRuntime([REDACTED])")
    }
}

pub(super) fn prepare_provider_control_runtime(
    environment: &HashMap<String, String>,
    state: Option<Arc<StateRuntime>>,
    provider_runtime: Option<&PreparedProviderConnectionRuntime<SystemProviderConnectionClock>>,
) -> io::Result<Option<PreparedProviderControlRuntime>> {
    if !enabled(environment)? {
        return Ok(None);
    }
    let state = state.ok_or_else(missing_dependencies)?;
    let provider_runtime = provider_runtime.ok_or_else(missing_dependencies)?;
    let config = ProviderControlSupervisorConfig {
        outbox_limit: OUTBOX_LIMIT,
        recovery_limit: RECOVERY_LIMIT,
        operation_timeout: OPERATION_TIMEOUT,
        base_backoff_seconds: BASE_BACKOFF_SECONDS,
        max_backoff_seconds: MAX_BACKOFF_SECONDS,
        successful_poll_seconds: SUCCESSFUL_POLL_SECONDS,
    }
    .validate()
    .map_err(|_| invalid_configuration())?;
    let worker = Arc::new(CloudWorkerExecutor::new(
        state.clone(),
        provider_runtime.provider_client_factory(),
        Arc::new(unix_now),
    ));
    Ok(Some(PreparedProviderControlRuntime {
        inner: ProviderControlRuntime::new(
            Arc::new(ProviderControlSupervisor::new(state, worker, config)),
            Arc::new(unix_now),
        ),
    }))
}

fn enabled(environment: &HashMap<String, String>) -> io::Result<bool> {
    match environment
        .get(ENABLED_ENV)
        .map(String::as_str)
        .unwrap_or("false")
    {
        "false" => Ok(false),
        "true" => Ok(true),
        _ => Err(invalid_configuration()),
    }
}

pub(in crate::task_control) fn durable_cloud_agent_enabled(
    environment: &HashMap<String, String>,
    provider_control_available: bool,
) -> io::Result<bool> {
    let enabled = parse_enabled(environment, DURABLE_CLOUD_AGENT_ENABLED_ENV)?;
    if enabled && !provider_control_available {
        return Err(missing_dependencies());
    }
    Ok(enabled)
}

fn parse_enabled(environment: &HashMap<String, String>, name: &str) -> io::Result<bool> {
    match environment.get(name).map(String::as_str) {
        None | Some("") | Some("0") | Some("false") | Some("FALSE") => Ok(false),
        Some("1") | Some("true") | Some("TRUE") => Ok(true),
        Some(_) => Err(invalid_configuration()),
    }
}

pub(super) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(-1)
}

fn missing_dependencies() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidInput,
        "Provider control requires Provider connection runtime and sqlite state",
    )
}

fn invalid_configuration() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidInput,
        "Provider control configuration is invalid",
    )
}
