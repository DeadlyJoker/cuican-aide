use std::ffi::OsStr;
use std::ffi::OsString;

use serde::Serialize;
use zeroize::Zeroizing;

use super::private_credentials::PrivateCredentialBindings;
use super::RuntimePaths;
use super::SessionMaterial;
use super::ARTIFACT_KEY_ID;
use super::CONTROL_API_PORT;
use super::DESKTOP_ORIGIN;
use super::PROVIDER_PROBE_ORIGIN;
use super::PROVIDER_PROBE_PORT;
use crate::provider_credentials::ActiveProviderBinding;
use crate::provider_credentials::ActiveProviderRuntime;
use crate::provider_credentials::ProviderCredentialKind;
use crate::workspace_native::RuntimeRouteProjection;

const DEFAULT_DESKTOP_MODEL_ID: &str = "gpt-5.6";

pub(super) enum ChildEnvironmentValue {
    Plain(OsString),
    Sensitive(Zeroizing<String>),
}

impl ChildEnvironmentValue {
    pub(super) fn as_os_str(&self) -> &OsStr {
        match self {
            Self::Plain(value) => value.as_os_str(),
            Self::Sensitive(value) => OsStr::new(value.as_str()),
        }
    }
}

pub(super) struct ChildEnvironmentVariable {
    pub(super) key: OsString,
    pub(super) value: ChildEnvironmentValue,
}

pub(super) type ChildEnvironment = Vec<ChildEnvironmentVariable>;

const INHERITED_PROCESS_ENV: &[&str] = &[
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "PATH",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
];

const WORKER_CONFIG_ENV: &[&str] = &[
    "CREWON_AGENT_INSTRUCTIONS",
    "CREWON_AGENT_VERSION_CONTENT_DIGEST",
    "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH",
    "CREWON_AUTO_COMPACT_AT_TOKENS",
    "CREWON_MCP_STDIO_CONFIG_PATH",
    "CREWON_MODEL_CONTEXT_WINDOW_TOKENS",
    "CREWON_MODEL_ID",
    "CREWON_RESPONSES_IDLE_TIMEOUT_MS",
    "CREWON_RESPONSES_SEQUENCE_POLICY",
    "CREWON_RESPONSES_STORE",
    "CREWON_RESPONSES_STREAM_MAX_RETRIES",
    "CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS",
    "CREWON_RESPONSES_WEBSOCKET_ENABLED",
    "CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES",
    "CREWON_TOOL_APPROVAL_RECHECK_MS",
    "CREWON_TOOL_APPROVAL_TTL_MS",
    "CREWON_WORKER_CANCELLATION_POLL_INTERVAL_MS",
    "CREWON_WORKER_LEASE_DURATION_MS",
    "CREWON_WORKER_RETRY_AFTER_MS",
    "CREWON_WORKER_SCAN_INTERVAL_MS",
];

pub(super) fn control_environment(
    paths: &RuntimePaths,
    session: &SessionMaterial,
    workspace_worker: Option<&WorkspaceWorkerEnvironment<'_>>,
    route: &RuntimeRouteProjection,
    admission: ControlAdmissionMode,
) -> ChildEnvironment {
    let mut environment = child_environment();
    environment.extend(shared_runtime_environment(paths));
    environment.extend([
        env("CREWON_CONTROL_ALLOWED_ORIGINS", DESKTOP_ORIGIN),
        secret_env("CREWON_CONTROL_CSRF_TOKEN", session.csrf_token.as_str()),
        env("CREWON_CONTROL_PORT", CONTROL_API_PORT.to_string()),
        env("CREWON_PROVIDER_PROBE_WORKER_ORIGIN", PROVIDER_PROBE_ORIGIN),
        secret_env(
            "CREWON_PROVIDER_PROBE_WORKER_TOKEN",
            session.provider_probe_token.as_str(),
        ),
        secret_env(
            "CREWON_CONTROL_SESSION_TOKEN",
            session.session_token.as_str(),
        ),
    ]);
    apply_agent_version_id(&mut environment, route);
    if let Some(workspace_worker) = workspace_worker {
        environment.extend([
            env("CREWON_WORKSPACE_WORKER_ORIGIN", workspace_worker.origin),
            secret_env("CREWON_WORKSPACE_WORKER_TOKEN", workspace_worker.token),
            env(
                "CREWON_WORKSPACE_WORKER_DEADLINE_MS",
                workspace_worker.deadline_ms.to_string(),
            ),
        ]);
        if let Some(workspace_binding_id) = route.workspace_binding_id() {
            environment.push(env("CREWON_WORKSPACE_BINDING_ID", workspace_binding_id));
        }
    }
    if admission == ControlAdmissionMode::Paused {
        environment.push(env("CREWON_CONTROL_PAUSED_ADMISSION", "1"));
    }
    environment
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ControlAdmissionMode {
    Active,
    Paused,
}

pub(super) struct WorkspaceWorkerEnvironment<'a> {
    pub(super) origin: &'a str,
    pub(super) token: &'a str,
    pub(super) deadline_ms: u32,
}

pub(super) fn release_environment(
    paths: &RuntimePaths,
    provider: Option<&ActiveProviderBinding>,
    route: &RuntimeRouteProjection,
) -> ChildEnvironment {
    let mut environment = worker_environment(paths, None, route);
    if let Some(provider) = provider {
        set_env(
            &mut environment,
            "CREWON_RESPONSES_ENDPOINT",
            responses_endpoint(&provider.endpoint),
        );
    }
    environment
}

pub(super) fn coordinator_environment(paths: &RuntimePaths) -> ChildEnvironment {
    let mut environment = child_environment();
    environment.extend(shared_runtime_environment(paths));
    environment
}

pub(super) fn worker_environment(
    paths: &RuntimePaths,
    provider: Option<&ActiveProviderRuntime>,
    route: &RuntimeRouteProjection,
) -> ChildEnvironment {
    let mut environment = child_environment();
    for name in WORKER_CONFIG_ENV {
        if let Some(value) = std::env::var_os(name) {
            environment.push(env(name, value));
        }
    }
    if std::env::var_os("CREWON_MODEL_ID").is_none() {
        environment.push(env("CREWON_MODEL_ID", DEFAULT_DESKTOP_MODEL_ID));
    }
    environment.extend(shared_runtime_environment(paths));
    apply_runtime_route(&mut environment, route);
    // Endpoint and credential authority are always explicit on packaged PC.
    // Ambient parent values are intentionally not copied into the child.
    if let Some(provider) = provider {
        apply_provider_runtime(&mut environment, provider);
    }
    environment
}

fn apply_runtime_route(environment: &mut ChildEnvironment, route: &RuntimeRouteProjection) {
    apply_agent_version_id(environment, route);
    set_env(
        environment,
        "CREWON_RUNTIME_GENERATION",
        route.runtime_generation(),
    );
    set_env(
        environment,
        "CREWON_POLICY_SNAPSHOT_ID",
        route.policy_snapshot_id(),
    );
    match route.workspace_binding_id() {
        Some(workspace_binding_id) => {
            set_env(
                environment,
                "CREWON_WORKSPACE_BINDING_ID",
                workspace_binding_id,
            );
            set_env(environment, "CREWON_NATIVE_WORKSPACE_READ_ENABLED", "1");
        }
        None => {
            remove_env(environment, "CREWON_WORKSPACE_BINDING_ID");
            remove_env(environment, "CREWON_NATIVE_WORKSPACE_READ_ENABLED");
        }
    }
}

fn apply_agent_version_id(environment: &mut ChildEnvironment, route: &RuntimeRouteProjection) {
    set_env(
        environment,
        "CREWON_AGENT_VERSION_ID",
        effective_agent_version_id(route),
    );
}

pub(super) fn effective_agent_version_id(route: &RuntimeRouteProjection) -> String {
    let configured = std::env::var("CREWON_AGENT_VERSION_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    configured.unwrap_or_else(|| route.agent_version_id().to_string())
}

fn apply_provider_runtime(environment: &mut ChildEnvironment, provider: &ActiveProviderRuntime) {
    set_env(
        environment,
        "CREWON_RESPONSES_ENDPOINT",
        responses_endpoint(&provider.binding.endpoint),
    );
    set_env(
        environment,
        "CREWON_PROVIDER_RUNTIME_BINDING_ID",
        &provider.binding.runtime_binding_id,
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerBootstrap<'a> {
    schema_version: &'static str,
    provider: Option<WorkerProviderBinding<'a>>,
    api_key: Option<&'a str>,
    probe: WorkerProbeBootstrap<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerProviderBinding<'a> {
    credential_kind: ProviderCredentialKind,
    endpoint: &'a str,
    environment_variable: Option<&'a str>,
    provider_id: &'a str,
    runtime_binding_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerProbeBootstrap<'a> {
    port: u16,
    token: &'a str,
}

pub(super) fn worker_bootstrap_input(
    provider: Option<&ActiveProviderRuntime>,
    session: &SessionMaterial,
) -> Result<Zeroizing<Vec<u8>>, ()> {
    serialize_worker_bootstrap(provider, session, None, None)
}

#[cfg(test)]
pub(super) fn worker_bootstrap_input_with_workspace(
    provider: Option<&ActiveProviderRuntime>,
    session: &SessionMaterial,
    workspace_json: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ()> {
    worker_bootstrap_input_with_workspace_and_credentials(provider, session, workspace_json, None)
}

pub(super) fn worker_bootstrap_input_with_workspace_and_credentials(
    provider: Option<&ActiveProviderRuntime>,
    session: &SessionMaterial,
    workspace_json: &[u8],
    credentials: Option<&PrivateCredentialBindings>,
) -> Result<Zeroizing<Vec<u8>>, ()> {
    if workspace_json.is_empty() {
        return Err(());
    }
    serialize_worker_bootstrap(provider, session, Some(workspace_json), credentials)
}

fn serialize_worker_bootstrap(
    provider: Option<&ActiveProviderRuntime>,
    session: &SessionMaterial,
    workspace_json: Option<&[u8]>,
    credentials: Option<&PrivateCredentialBindings>,
) -> Result<Zeroizing<Vec<u8>>, ()> {
    let mut bootstrap = serde_json::to_vec(&WorkerBootstrap {
        schema_version: "crewon.worker-native-bootstrap.v4",
        provider: provider.map(|runtime| WorkerProviderBinding {
            credential_kind: runtime.binding.credential_kind,
            endpoint: &runtime.binding.endpoint,
            environment_variable: runtime.binding.environment_variable.as_deref(),
            provider_id: &runtime.binding.provider_id,
            runtime_binding_id: &runtime.binding.runtime_binding_id,
        }),
        api_key: provider
            .and_then(|runtime| runtime.secret.as_deref())
            .map(String::as_str),
        probe: WorkerProbeBootstrap {
            port: PROVIDER_PROBE_PORT,
            token: session.provider_probe_token.as_str(),
        },
    })
    .map(Zeroizing::new)
    .map_err(|_| ())?;
    if bootstrap.pop() != Some(b'}') {
        return Err(());
    }
    bootstrap.extend_from_slice(b",\"workspace\":");
    match workspace_json {
        Some(workspace_json) => bootstrap.extend_from_slice(workspace_json),
        None => bootstrap.extend_from_slice(b"null"),
    }
    bootstrap.extend_from_slice(b",\"credentialBindings\":");
    match credentials {
        Some(credentials) => {
            serde_json::to_writer(&mut *bootstrap, credentials).map_err(|_| ())?;
        }
        None => bootstrap.extend_from_slice(b"null"),
    }
    bootstrap.push(b'}');
    Ok(bootstrap)
}

fn responses_endpoint(base_url: &str) -> String {
    format!("{}/responses", base_url.trim_end_matches('/'))
}

fn set_env(environment: &mut ChildEnvironment, key: &'static str, value: impl Into<OsString>) {
    remove_env(environment, key);
    environment.push(env(key, value));
}

fn remove_env(environment: &mut ChildEnvironment, key: &str) {
    environment.retain(|candidate| candidate.key != key);
}

fn child_environment() -> ChildEnvironment {
    let mut environment = vec![env("NODE_ENV", "production")];
    for name in INHERITED_PROCESS_ENV {
        if let Some(value) = std::env::var_os(name) {
            environment.push(env(name, value));
        }
    }
    environment
}

fn shared_runtime_environment(paths: &RuntimePaths) -> [ChildEnvironmentVariable; 5] {
    [
        env("CREWON_ARTIFACT_DB_PATH", &paths.artifact_database),
        env("CREWON_ARTIFACT_ENCRYPTION_KEY_ID", ARTIFACT_KEY_ID),
        env("CREWON_ARTIFACT_ENCRYPTION_KEY_PATH", &paths.artifact_key),
        env("CREWON_ARTIFACT_ROOT", &paths.artifact_root),
        env("CREWON_CONTROL_DB_PATH", &paths.control_database),
    ]
}

fn env(key: impl Into<OsString>, value: impl Into<OsString>) -> ChildEnvironmentVariable {
    ChildEnvironmentVariable {
        key: key.into(),
        value: ChildEnvironmentValue::Plain(value.into()),
    }
}

fn secret_env(key: impl Into<OsString>, value: &str) -> ChildEnvironmentVariable {
    ChildEnvironmentVariable {
        key: key.into(),
        value: ChildEnvironmentValue::Sensitive(Zeroizing::new(value.to_string())),
    }
}
