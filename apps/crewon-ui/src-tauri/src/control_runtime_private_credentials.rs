use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::workspace_native::RuntimeRouteProjection;

const PRIVATE_CREDENTIAL_SCHEMA_VERSION: &str = "crewon.remote-mcp-private-credentials.v1";
const MAX_BINDINGS: usize = 32;
const MAX_BEARER_BYTES: usize = 4_096;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_REMOTE_CONFIG_BYTES: u64 = 512 * 1024;
const REMOTE_MCP_CREDENTIAL_SERVICE: &str = "ai.crewon.desktop.remote-mcp";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PrivateCredentialError {
    BindingInvalid,
    CredentialMissing,
    CredentialStoreUnavailable,
}

trait PrivateCredentialSecretStore {
    fn get(&self, key: &str) -> Result<Zeroizing<String>, PrivateCredentialError>;
}

struct OsPrivateCredentialSecretStore;

impl PrivateCredentialSecretStore for OsPrivateCredentialSecretStore {
    fn get(&self, key: &str) -> Result<Zeroizing<String>, PrivateCredentialError> {
        let entry = keyring::Entry::new(REMOTE_MCP_CREDENTIAL_SERVICE, key)
            .map_err(|_| PrivateCredentialError::CredentialStoreUnavailable)?;
        match entry.get_password() {
            Ok(secret) => Ok(Zeroizing::new(secret)),
            Err(keyring::Error::NoEntry) => Err(PrivateCredentialError::CredentialMissing),
            Err(_) => Err(PrivateCredentialError::CredentialStoreUnavailable),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeBindingsFile {
    schema_version: String,
    bindings: Vec<RuntimeBinding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeBinding {
    tenant_id: String,
    agent_version_id: String,
    content_digest: String,
    authority_id: String,
    workspace_binding_id: Option<String>,
    provider: serde_json::Value,
    mcp_stdio_config_path: Option<String>,
    device_tool_config_path: Option<String>,
    remote_mcp_config_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteMcpConfig {
    schema_version: String,
    servers: Vec<RemoteMcpServer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteMcpServer {
    server_id: String,
    server_binding_id: String,
    mode: RemoteMcpMode,
    endpoint: String,
    credential_binding_id: String,
    tools: serde_json::Value,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RemoteMcpMode {
    Production,
    StandaloneLoopback,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCredentialBindings {
    schema_version: &'static str,
    authority: PrivateCredentialAuthority,
    bindings: Vec<PrivateCredentialBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateCredentialAuthority {
    tenant_id: String,
    workspace_binding_id: String,
    runtime_binding_id: String,
    agent_version_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateCredentialBinding {
    credential_binding_id: String,
    bearer_token: Zeroizing<String>,
}

impl std::fmt::Debug for PrivateCredentialBindings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PrivateCredentialBindings([REDACTED])")
    }
}

impl PrivateCredentialBindings {
    pub fn new(
        tenant_id: String,
        workspace_binding_id: String,
        runtime_binding_id: String,
        agent_version_id: String,
        bindings: Vec<(String, Zeroizing<String>)>,
    ) -> Result<Self, ()> {
        if !valid_id(&tenant_id)
            || !valid_id(&workspace_binding_id)
            || !valid_id(&runtime_binding_id)
            || !valid_id(&agent_version_id)
            || bindings.is_empty()
            || bindings.len() > MAX_BINDINGS
        {
            return Err(());
        }
        let mut ids = BTreeSet::new();
        let mut parsed = Vec::with_capacity(bindings.len());
        for (credential_binding_id, bearer_token) in bindings {
            if !valid_id(&credential_binding_id)
                || bearer_token.is_empty()
                || bearer_token.len() > MAX_BEARER_BYTES
                || bearer_token
                    .bytes()
                    .any(|byte| !(0x21..=0x7e).contains(&byte))
                || !ids.insert(credential_binding_id.clone())
            {
                return Err(());
            }
            parsed.push(PrivateCredentialBinding {
                credential_binding_id,
                bearer_token,
            });
        }
        Ok(Self {
            schema_version: PRIVATE_CREDENTIAL_SCHEMA_VERSION,
            authority: PrivateCredentialAuthority {
                tenant_id,
                workspace_binding_id,
                runtime_binding_id,
                agent_version_id,
            },
            bindings: parsed,
        })
    }
}

pub(super) fn load_private_credential_bindings(
    runtime_bindings_path: Option<&Path>,
    route: &RuntimeRouteProjection,
    agent_version_id: &str,
) -> Result<Option<PrivateCredentialBindings>, PrivateCredentialError> {
    let Some(path) = runtime_bindings_path else {
        return Ok(None);
    };
    load_private_credential_bindings_from(
        path,
        route,
        agent_version_id,
        &OsPrivateCredentialSecretStore,
    )
}

fn load_private_credential_bindings_from(
    runtime_bindings_path: &Path,
    route: &RuntimeRouteProjection,
    agent_version_id: &str,
    secrets: &dyn PrivateCredentialSecretStore,
) -> Result<Option<PrivateCredentialBindings>, PrivateCredentialError> {
    let workspace_binding_id = route
        .workspace_binding_id()
        .ok_or(PrivateCredentialError::BindingInvalid)?;
    let manifest: RuntimeBindingsFile =
        read_bounded_json(runtime_bindings_path, MAX_MANIFEST_BYTES)?;
    if manifest.schema_version != "crewon.agent-version-runtime-bindings.v0"
        || manifest.bindings.len() > 1_000
    {
        return Err(PrivateCredentialError::BindingInvalid);
    }
    let mut selected = manifest.bindings.into_iter().filter(|binding| {
        binding.tenant_id == route.tenant_id()
            && binding.workspace_binding_id.as_deref() == Some(workspace_binding_id)
            && binding.agent_version_id == agent_version_id
    });
    let binding = selected
        .next()
        .ok_or(PrivateCredentialError::BindingInvalid)?;
    if selected.next().is_some() {
        return Err(PrivateCredentialError::BindingInvalid);
    }
    // These fields remain owned by the reviewed release manifest. Reading them
    // here only proves the exact wire shape; credentials never join that file.
    let _release_metadata = (
        &binding.content_digest,
        &binding.authority_id,
        &binding.provider,
        &binding.mcp_stdio_config_path,
        &binding.device_tool_config_path,
    );
    let Some(remote_path) = binding.remote_mcp_config_path else {
        return Ok(None);
    };
    let config: RemoteMcpConfig =
        read_bounded_json(Path::new(&remote_path), MAX_REMOTE_CONFIG_BYTES)?;
    if config.schema_version != "crewon.remote-mcp-runtime.v0"
        || config.servers.len() > MAX_BINDINGS
    {
        return Err(PrivateCredentialError::BindingInvalid);
    }
    let mut credential_ids = BTreeSet::new();
    for server in config.servers {
        let _reviewed_server_metadata = (
            &server.server_id,
            &server.server_binding_id,
            &server.endpoint,
            &server.tools,
        );
        if server.mode == RemoteMcpMode::Production {
            if !valid_id(&server.credential_binding_id) {
                return Err(PrivateCredentialError::BindingInvalid);
            }
            credential_ids.insert(server.credential_binding_id);
        }
    }
    if credential_ids.is_empty() {
        return Ok(None);
    }
    let bindings = credential_ids
        .into_iter()
        .map(|credential_binding_id| {
            let key = secret_key(
                route.tenant_id(),
                workspace_binding_id,
                route.runtime_generation(),
                agent_version_id,
                &credential_binding_id,
            )?;
            let secret = secrets.get(&key)?;
            Ok((credential_binding_id, secret))
        })
        .collect::<Result<Vec<_>, PrivateCredentialError>>()?;
    PrivateCredentialBindings::new(
        route.tenant_id().to_string(),
        workspace_binding_id.to_string(),
        route.runtime_generation().to_string(),
        agent_version_id.to_string(),
        bindings,
    )
    .map(Some)
    .map_err(|()| PrivateCredentialError::BindingInvalid)
}

fn secret_key(
    tenant_id: &str,
    workspace_binding_id: &str,
    runtime_binding_id: &str,
    agent_version_id: &str,
    credential_binding_id: &str,
) -> Result<String, PrivateCredentialError> {
    serde_json::to_string(&[
        tenant_id,
        workspace_binding_id,
        runtime_binding_id,
        agent_version_id,
        credential_binding_id,
    ])
    .map_err(|_| PrivateCredentialError::BindingInvalid)
}

fn read_bounded_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    maximum_bytes: u64,
) -> Result<T, PrivateCredentialError> {
    let file = File::open(path).map_err(|_| PrivateCredentialError::BindingInvalid)?;
    let metadata = file
        .metadata()
        .map_err(|_| PrivateCredentialError::BindingInvalid)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > maximum_bytes {
        return Err(PrivateCredentialError::BindingInvalid);
    }
    let mut input = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum_bytes + 1)
        .read_to_end(&mut input)
        .map_err(|_| PrivateCredentialError::BindingInvalid)?;
    if input.len() as u64 > maximum_bytes {
        return Err(PrivateCredentialError::BindingInvalid);
    }
    serde_json::from_slice(&input).map_err(|_| PrivateCredentialError::BindingInvalid)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

#[cfg(test)]
#[path = "control_runtime_private_credentials_tests.rs"]
mod tests;
