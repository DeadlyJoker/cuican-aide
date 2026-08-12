use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use serde::Serialize;
use zeroize::Zeroizing;

use super::remote_mcp_projection::RemoteMcpProjection;
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
    workspace_binding_id: RequiredNullable,
    provider: RuntimeProvider,
    mcp_stdio_config_path: RequiredNullable,
    device_tool_config_path: RequiredNullable,
    remote_mcp_config_path: RequiredNullable,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeProvider {
    kind: String,
    endpoint: String,
    api_key_environment: RequiredNullable,
    store_responses: bool,
    request_profile: String,
    idle_timeout_ms: u64,
    sequence_policy: String,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct RequiredNullable(serde_json::Value);

impl RequiredNullable {
    fn as_str(&self) -> Result<Option<&str>, ()> {
        match &self.0 {
            serde_json::Value::Null => Ok(None),
            serde_json::Value::String(value) => Ok(Some(value)),
            _ => Err(()),
        }
    }
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
        || manifest.bindings.iter().any(|binding| !binding.valid())
    {
        return Err(PrivateCredentialError::BindingInvalid);
    }
    let mut selected = manifest.bindings.into_iter().filter(|binding| {
        binding.tenant_id == route.tenant_id()
            && binding.workspace_binding_id.as_str() == Ok(Some(workspace_binding_id))
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
    let Some(remote_path) = binding
        .remote_mcp_config_path
        .as_str()
        .map_err(|()| PrivateCredentialError::BindingInvalid)?
    else {
        return Ok(None);
    };
    let config: RemoteMcpProjection =
        read_bounded_json(Path::new(&remote_path), MAX_REMOTE_CONFIG_BYTES)?;
    if !config.valid() {
        return Err(PrivateCredentialError::BindingInvalid);
    }
    let credential_ids = config.production_credential_ids();
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

impl RuntimeBinding {
    fn valid(&self) -> bool {
        bounded(&self.tenant_id, 256)
            && bounded(&self.agent_version_id, 512)
            && valid_digest(&self.content_digest)
            && bounded(&self.authority_id, 512)
            && self
                .workspace_binding_id
                .as_str()
                .is_ok_and(|value| value.is_none_or(|value| bounded(value, 512)))
            && self.provider.valid()
            && [
                &self.mcp_stdio_config_path,
                &self.device_tool_config_path,
                &self.remote_mcp_config_path,
            ]
            .into_iter()
            .all(|path| {
                path.as_str()
                    .is_ok_and(|value| value.is_none_or(|value| bounded(value, 4_096)))
            })
    }
}

impl RuntimeProvider {
    fn valid(&self) -> bool {
        let _store_responses = self.store_responses;
        self.kind == "directResponses"
            && bounded(&self.endpoint, 2_048)
            && self.api_key_environment.as_str().is_ok_and(|value| {
                value.is_none_or(|value| {
                    bounded(value, 128)
                        && value.bytes().enumerate().all(|(index, byte)| {
                            byte.is_ascii_uppercase()
                                || (index > 0 && (byte.is_ascii_digit() || byte == b'_'))
                        })
                })
            })
            && matches!(self.request_profile.as_str(), "standard" | "responsesLite")
            && (1..=300_000).contains(&self.idle_timeout_ms)
            && matches!(self.sequence_policy.as_str(), "required" | "whenPresent")
    }
}

fn bounded(value: &str, maximum_bytes: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum_bytes
        && !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n' | 0))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
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
