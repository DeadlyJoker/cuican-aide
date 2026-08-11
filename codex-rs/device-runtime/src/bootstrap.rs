use std::path::PathBuf;

use crewon_device::TrustedDeviceCommandKey;
use serde::Deserialize;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt as _;
use url::Url;
use zeroize::Zeroizing;

use crate::DeviceRuntimeError;

const BOOTSTRAP_SCHEMA: &str = "crewon.device-runtime-bootstrap.v0";
const MAX_BOOTSTRAP_BYTES: u64 = 512 * 1024;
const MAX_PEM_BYTES: usize = 128 * 1024;
const MAX_WORKSPACES: usize = 32;
const MAX_COMMAND_KEYS: usize = 32;

pub struct DeviceRuntimeBootstrap {
    pub gateway_url: Url,
    pub device_id: String,
    pub device_binding_id: String,
    pub runtime_binding_id: String,
    pub journal_path: PathBuf,
    pub workspaces: Vec<DeviceRuntimeWorkspace>,
    pub command_keys: Vec<TrustedDeviceCommandKey>,
    pub(crate) tls: DeviceRuntimeTlsMaterial,
}

impl std::fmt::Debug for DeviceRuntimeBootstrap {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DeviceRuntimeBootstrap([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct DeviceRuntimeWorkspace {
    pub workspace_binding_id: String,
    pub incarnation_id: String,
    pub trusted_local_path: PathBuf,
}

impl std::fmt::Debug for DeviceRuntimeWorkspace {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DeviceRuntimeWorkspace([REDACTED])")
    }
}

pub(crate) struct DeviceRuntimeTlsMaterial {
    pub client_certificate_pem: Zeroizing<String>,
    pub client_private_key_pem: Zeroizing<String>,
    pub ca_certificate_pem: Zeroizing<String>,
    pub server_certificate_sha256: Option<String>,
}

impl std::fmt::Debug for DeviceRuntimeTlsMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DeviceRuntimeTlsMaterial([REDACTED])")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawBootstrap {
    schema_version: String,
    gateway_wss_url: String,
    device_id: String,
    device_binding_id: String,
    runtime_binding_id: String,
    journal_path: String,
    workspaces: Vec<RawWorkspace>,
    tls: RawTls,
    command_public_keys: Vec<RawCommandKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawWorkspace {
    workspace_binding_id: String,
    incarnation_id: String,
    trusted_local_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawTls {
    client_certificate_pem: Zeroizing<String>,
    client_private_key_pem: Zeroizing<String>,
    ca_certificate_pem: Zeroizing<String>,
    server_certificate_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCommandKey {
    key_id: String,
    public_key_pem: String,
}

pub async fn read_bootstrap(
    mut input: impl AsyncRead + Unpin,
) -> Result<DeviceRuntimeBootstrap, DeviceRuntimeError> {
    let mut bytes = Zeroizing::new(Vec::new());
    let mut chunk = Zeroizing::new(vec![0_u8; 8 * 1024]);
    loop {
        let read = input
            .read(chunk.as_mut_slice())
            .await
            .map_err(|error| DeviceRuntimeError::with_source("device_runtime_bootstrap_io", error))?;
        if read == 0 {
            break;
        }
        let received = &chunk[..read];
        if let Some(newline) = received.iter().position(|byte| *byte == b'\n') {
            append_bootstrap_bytes(&mut bytes, &received[..newline])?;
            if received[newline + 1..]
                .iter()
                .any(|byte| !matches!(byte, b'\t' | b'\r' | b' '))
            {
                return Err(DeviceRuntimeError::new("device_runtime_bootstrap_invalid"));
            }
            break;
        }
        append_bootstrap_bytes(&mut bytes, received)?;
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    if bytes.is_empty() {
        return Err(DeviceRuntimeError::new("device_runtime_bootstrap_size_invalid"));
    }
    let raw: RawBootstrap = serde_json::from_slice(&bytes).map_err(|error| {
        DeviceRuntimeError::with_source("device_runtime_bootstrap_invalid", error)
    })?;
    validate(raw)
}

fn append_bootstrap_bytes(
    destination: &mut Vec<u8>,
    source: &[u8],
) -> Result<(), DeviceRuntimeError> {
    if destination.len().saturating_add(source.len()) > MAX_BOOTSTRAP_BYTES as usize {
        return Err(DeviceRuntimeError::new("device_runtime_bootstrap_size_invalid"));
    }
    destination.extend_from_slice(source);
    Ok(())
}

fn validate(raw: RawBootstrap) -> Result<DeviceRuntimeBootstrap, DeviceRuntimeError> {
    if raw.schema_version != BOOTSTRAP_SCHEMA {
        return Err(DeviceRuntimeError::new(
            "device_runtime_bootstrap_unsupported",
        ));
    }
    let gateway_url = Url::parse(&raw.gateway_wss_url)
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_gateway_invalid", error))?;
    if gateway_url.scheme() != "wss"
        || gateway_url.path() != "/device/v1"
        || gateway_url.host_str().is_none()
        || gateway_url.port() == Some(0)
        || !gateway_url.username().is_empty()
        || gateway_url.password().is_some()
        || gateway_url.query().is_some()
        || gateway_url.fragment().is_some()
    {
        return Err(DeviceRuntimeError::new("device_runtime_gateway_invalid"));
    }
    for value in [
        &raw.device_id,
        &raw.device_binding_id,
        &raw.runtime_binding_id,
    ] {
        require_opaque_id(value)?;
    }
    let journal_path = require_absolute_path(&raw.journal_path)?;
    if raw.workspaces.is_empty() || raw.workspaces.len() > MAX_WORKSPACES {
        return Err(DeviceRuntimeError::new(
            "device_runtime_workspace_config_invalid",
        ));
    }
    let mut workspaces = Vec::with_capacity(raw.workspaces.len());
    let mut workspace_ids = std::collections::HashSet::new();
    for workspace in raw.workspaces {
        require_opaque_id(&workspace.workspace_binding_id)?;
        require_opaque_id(&workspace.incarnation_id)?;
        if !workspace_ids.insert(workspace.workspace_binding_id.clone()) {
            return Err(DeviceRuntimeError::new(
                "device_runtime_workspace_config_invalid",
            ));
        }
        workspaces.push(DeviceRuntimeWorkspace {
            workspace_binding_id: workspace.workspace_binding_id,
            incarnation_id: workspace.incarnation_id,
            trusted_local_path: require_absolute_path(&workspace.trusted_local_path)?,
        });
    }
    if raw.command_public_keys.is_empty() || raw.command_public_keys.len() > MAX_COMMAND_KEYS {
        return Err(DeviceRuntimeError::new(
            "device_runtime_command_keys_invalid",
        ));
    }
    let mut key_ids = std::collections::HashSet::new();
    let command_keys = raw
        .command_public_keys
        .into_iter()
        .map(|key| {
            require_opaque_id(&key.key_id)?;
            require_pem_bound(&key.public_key_pem)?;
            if !key_ids.insert(key.key_id.clone()) {
                return Err(DeviceRuntimeError::new(
                    "device_runtime_command_keys_invalid",
                ));
            }
            Ok(TrustedDeviceCommandKey {
                key_id: key.key_id,
                public_key_pem: key.public_key_pem,
            })
        })
        .collect::<Result<Vec<_>, DeviceRuntimeError>>()?;
    require_pem_bound(&raw.tls.client_certificate_pem)?;
    require_pem_bound(&raw.tls.client_private_key_pem)?;
    require_pem_bound(&raw.tls.ca_certificate_pem)?;
    if raw
        .tls
        .server_certificate_sha256
        .as_deref()
        .is_some_and(|pin| !valid_digest(pin))
    {
        return Err(DeviceRuntimeError::new("device_runtime_tls_pin_invalid"));
    }
    Ok(DeviceRuntimeBootstrap {
        gateway_url,
        device_id: raw.device_id,
        device_binding_id: raw.device_binding_id,
        runtime_binding_id: raw.runtime_binding_id,
        journal_path,
        workspaces,
        command_keys,
        tls: DeviceRuntimeTlsMaterial {
            client_certificate_pem: raw.tls.client_certificate_pem,
            client_private_key_pem: raw.tls.client_private_key_pem,
            ca_certificate_pem: raw.tls.ca_certificate_pem,
            server_certificate_sha256: raw.tls.server_certificate_sha256,
        },
    })
}

fn require_absolute_path(value: &str) -> Result<PathBuf, DeviceRuntimeError> {
    if value.is_empty()
        || value.len() > 4_096
        || value.chars().any(char::is_control)
    {
        return Err(DeviceRuntimeError::new("device_runtime_path_invalid"));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(DeviceRuntimeError::new("device_runtime_path_invalid"));
    }
    Ok(path)
}

fn require_opaque_id(value: &str) -> Result<(), DeviceRuntimeError> {
    let mut bytes = value.bytes();
    if value.len() > 512
        || !bytes.next().is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(DeviceRuntimeError::new("device_runtime_identity_invalid"));
    }
    Ok(())
}

fn require_pem_bound(value: &str) -> Result<(), DeviceRuntimeError> {
    if value.is_empty() || value.len() > MAX_PEM_BYTES || value.contains('\0') {
        return Err(DeviceRuntimeError::new("device_runtime_pem_invalid"));
    }
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
#[path = "bootstrap_tests.rs"]
mod tests;
