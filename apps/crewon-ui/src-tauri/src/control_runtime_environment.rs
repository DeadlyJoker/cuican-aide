use std::ffi::OsStr;
use std::ffi::OsString;

use zeroize::Zeroizing;

use super::RuntimePaths;
use super::SessionMaterial;
use super::ARTIFACT_KEY_ID;
use super::CONTROL_API_PORT;
use super::DESKTOP_ORIGIN;
use crate::provider_credentials::ActiveProviderBinding;
use crate::provider_credentials::ActiveProviderRuntime;
use crate::provider_credentials::ProviderCredentialKind;

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
    "CREWON_DEVICE_TOOL_CONFIG_PATH",
    "CREWON_MCP_STDIO_CONFIG_PATH",
    "CREWON_MODEL_ADAPTER",
    "CREWON_MODEL_CONTEXT_WINDOW_TOKENS",
    "CREWON_MODEL_ID",
    "CREWON_RESPONSES_IDLE_TIMEOUT_MS",
    "CREWON_RESPONSES_REQUEST_PROFILE",
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
) -> ChildEnvironment {
    let mut environment = child_environment();
    environment.extend(shared_runtime_environment(paths));
    environment.extend([
        env("CREWON_CONTROL_ALLOWED_ORIGINS", DESKTOP_ORIGIN),
        secret_env("CREWON_CONTROL_CSRF_TOKEN", session.csrf_token.as_str()),
        env("CREWON_CONTROL_PORT", CONTROL_API_PORT.to_string()),
        secret_env(
            "CREWON_CONTROL_SESSION_TOKEN",
            session.session_token.as_str(),
        ),
    ]);
    environment
}

pub(super) fn release_environment(
    paths: &RuntimePaths,
    provider: Option<&ActiveProviderBinding>,
) -> ChildEnvironment {
    let mut environment = worker_environment(paths, None);
    if let Some(provider) = provider {
        set_env(
            &mut environment,
            "CREWON_RESPONSES_ENDPOINT",
            responses_endpoint(&provider.endpoint),
        );
    }
    environment
}

pub(super) fn worker_environment(
    paths: &RuntimePaths,
    provider: Option<&ActiveProviderRuntime>,
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
    // Endpoint and credential authority are always explicit on packaged PC.
    // Ambient parent values are intentionally not copied into the child.
    if let Some(provider) = provider {
        apply_provider_runtime(&mut environment, provider);
    }
    environment
}

fn apply_provider_runtime(environment: &mut ChildEnvironment, provider: &ActiveProviderRuntime) {
    set_env(
        environment,
        "CREWON_RESPONSES_ENDPOINT",
        responses_endpoint(&provider.binding.endpoint),
    );
    match (provider.binding.credential_kind, provider.secret.as_deref()) {
        (ProviderCredentialKind::None, _) | (_, None) => {}
        (ProviderCredentialKind::Environment | ProviderCredentialKind::Keychain, Some(secret)) => {
            set_secret_env(environment, "CREWON_MODEL_API_KEY", secret);
        }
    }
}

fn responses_endpoint(base_url: &str) -> String {
    format!("{}/responses", base_url.trim_end_matches('/'))
}

fn set_env(environment: &mut ChildEnvironment, key: &'static str, value: impl Into<OsString>) {
    remove_env(environment, key);
    environment.push(env(key, value));
}

fn set_secret_env(environment: &mut ChildEnvironment, key: &'static str, value: &str) {
    remove_env(environment, key);
    environment.push(secret_env(key, value));
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
