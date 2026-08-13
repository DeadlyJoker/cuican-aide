use std::path::PathBuf;

use serde::Serialize;
use zeroize::Zeroizing;

use super::DesktopWorkspaceAuthority;
use super::WorkspaceLaunchMaterial;
use super::WorkspaceNativeError;
use super::STANDALONE_POLICY_SNAPSHOT_ID;
use super::STANDALONE_SPACE_ID;
use super::STANDALONE_TENANT_ID;

const DEVICE_BOOTSTRAP_SCHEMA: &str = "crewon.device-runtime-bootstrap.v0";
const GATEWAY_REGISTRY_SCHEMA: &str = "crewon.device-registry.v0";
const GATEWAY_IDENTITY_SCHEMA: &str = "crewon.desktop-gateway-identity.v0";
const MAX_PATH_BYTES: usize = 4_096;

pub(crate) struct WorkspacePayloadConfig {
    pub(crate) gateway_ready: GatewayReadyAddress,
    pub(crate) journal_path: PathBuf,
    pub(crate) gateway_deadline_ms: u32,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct GatewayReadyAddress {
    host: &'static str,
    port: u16,
}

impl GatewayReadyAddress {
    pub(crate) fn loopback(port: u16) -> Result<Self, WorkspaceNativeError> {
        if port == 0 {
            return Err(WorkspaceNativeError::PayloadInvalid);
        }
        Ok(Self {
            host: "127.0.0.1",
            port,
        })
    }
}

impl std::fmt::Debug for GatewayReadyAddress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GatewayReadyAddress")
            .field("host", &self.host)
            .field("port", &self.port)
            .finish()
    }
}

pub(crate) struct WorkspaceGatewayLaunchPayloads<'a> {
    gateway_registry: GatewayRegistry<'a>,
    gateway_tls: GatewayTlsTempFileContents<'a>,
    gateway_identity: GatewayIdentityMetadata<'a>,
    bind: GatewayBindConfig,
}

impl std::fmt::Debug for WorkspaceGatewayLaunchPayloads<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceGatewayLaunchPayloads([REDACTED])")
    }
}

pub(crate) struct WorkspaceLaunchPayloads<'a> {
    worker_workspace: WorkerWorkspaceBootstrap<'a>,
    device_bootstrap: DeviceRuntimeBootstrap<'a>,
}

impl std::fmt::Debug for WorkspaceLaunchPayloads<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceLaunchPayloads([REDACTED])")
    }
}

impl<'a> WorkspaceGatewayLaunchPayloads<'a> {
    pub(crate) fn build(
        authority: &'a DesktopWorkspaceAuthority,
        material: &'a WorkspaceLaunchMaterial,
    ) -> Result<Self, WorkspaceNativeError> {
        if !material.matches_authority(authority)? {
            return Err(WorkspaceNativeError::PayloadInvalid);
        }
        let workspace = authority.current_workspace()?;
        let command_key = material.command_signing();
        let worker = material.worker();
        let device = material.device();
        let gateway = material.gateway();
        Ok(Self {
            gateway_registry: GatewayRegistry {
                schema_version: GATEWAY_REGISTRY_SCHEMA,
                devices: vec![GatewayDeviceRegistration {
                    device_id: authority.device_id(),
                    credential_id: device.credential_id(),
                    fingerprint256: device.fingerprint256(),
                }],
                workers: vec![GatewayWorkerRegistration {
                    worker_id: worker.identity_id(),
                    credential_id: worker.credential_id(),
                    fingerprint256: worker.fingerprint256(),
                    allowed_runtime_binding_ids: vec![workspace.workspace_runtime_binding_id()],
                }],
                command_signing_keys: vec![CommandPublicKey {
                    key_id: command_key.key_id(),
                    public_key_pem: command_key.public_key_pem(),
                }],
            },
            gateway_tls: GatewayTlsTempFileContents {
                private_key_pem: gateway.private_key_pem(),
                certificate_pem: gateway.certificate_pem(),
                ca_certificate_pem: material.ca_certificate_pem(),
            },
            gateway_identity: GatewayIdentityMetadata {
                schema_version: GATEWAY_IDENTITY_SCHEMA,
                kind: "standaloneWorkspace",
                gateway_id: gateway.identity_id(),
                credential_id: gateway.credential_id(),
                fingerprint256: gateway.fingerprint256(),
                servername: "localhost",
            },
            bind: GatewayBindConfig {
                host: "127.0.0.1",
                port: 0,
            },
        })
    }

    pub(crate) fn gateway_registry_json(&self) -> Result<Vec<u8>, WorkspaceNativeError> {
        serde_json::to_vec(&self.gateway_registry).map_err(|_| WorkspaceNativeError::PayloadInvalid)
    }

    pub(crate) fn gateway_tls(&self) -> &GatewayTlsTempFileContents<'a> {
        &self.gateway_tls
    }

    pub(crate) fn gateway_identity_json(&self) -> Result<Vec<u8>, WorkspaceNativeError> {
        serde_json::to_vec(&self.gateway_identity).map_err(|_| WorkspaceNativeError::PayloadInvalid)
    }

    pub(crate) fn bind_json(&self) -> Result<Vec<u8>, WorkspaceNativeError> {
        serde_json::to_vec(&self.bind).map_err(|_| WorkspaceNativeError::PayloadInvalid)
    }
}

impl<'a> WorkspaceLaunchPayloads<'a> {
    pub(crate) fn build(
        authority: &'a DesktopWorkspaceAuthority,
        material: &'a WorkspaceLaunchMaterial,
        config: WorkspacePayloadConfig,
    ) -> Result<Self, WorkspaceNativeError> {
        if !(1_000..=60_000).contains(&config.gateway_deadline_ms)
            || !material.matches_authority(authority)?
        {
            return Err(WorkspaceNativeError::PayloadInvalid);
        }
        let workspace = authority.current_workspace()?;
        let journal_path = absolute_path(config.journal_path)?;
        let gateway_https_endpoint = format!(
            "https://{}:{}",
            config.gateway_ready.host, config.gateway_ready.port
        );
        let gateway_wss_url = format!(
            "wss://{}:{}/device/v1",
            config.gateway_ready.host, config.gateway_ready.port
        );
        let command_key = material.command_signing();
        let worker = material.worker();
        let device = material.device();
        let gateway = material.gateway();
        Ok(Self {
            worker_workspace: WorkerWorkspaceBootstrap {
                dispatch_mode: "local",
                trusted_local_path: workspace.trusted_path(),
                private_server: WorkerPrivateServer {
                    port: 0,
                    token: material.private_server_token(),
                },
                authority: WorkerWorkspaceAuthority {
                    tenant_id: STANDALONE_TENANT_ID,
                    space_id: STANDALONE_SPACE_ID,
                    workspace_binding_id: workspace.workspace_binding_id(),
                    incarnation_id: workspace.incarnation_id(),
                    device_binding_id: authority.device_binding_id(),
                    device_id: authority.device_id(),
                    runtime_binding_id: workspace.workspace_runtime_binding_id(),
                    policy_snapshot_id: STANDALONE_POLICY_SNAPSHOT_ID,
                },
                signing: WorkerSigning {
                    key_id: command_key.key_id(),
                    private_key_pem: command_key.private_key_pem(),
                },
                gateway: WorkerGateway {
                    endpoint: gateway_https_endpoint,
                    deadline_ms: config.gateway_deadline_ms,
                    tls: WorkerGatewayTls {
                        key_pem: worker.private_key_pem(),
                        certificate_pem: worker.certificate_pem(),
                        ca_certificate_pem: material.ca_certificate_pem(),
                        servername: "localhost",
                    },
                },
            },
            device_bootstrap: DeviceRuntimeBootstrap {
                schema_version: DEVICE_BOOTSTRAP_SCHEMA,
                gateway_wss_url,
                device_id: authority.device_id(),
                device_binding_id: authority.device_binding_id(),
                runtime_binding_id: workspace.workspace_runtime_binding_id(),
                journal_path,
                workspaces: vec![DeviceRuntimeWorkspace {
                    workspace_binding_id: workspace.workspace_binding_id(),
                    incarnation_id: workspace.incarnation_id(),
                    trusted_local_path: workspace.trusted_path(),
                }],
                tls: DeviceRuntimeTls {
                    client_certificate_pem: device.certificate_pem(),
                    client_private_key_pem: device.private_key_pem(),
                    ca_certificate_pem: material.ca_certificate_pem(),
                    server_certificate_sha256: gateway.certificate_sha256(),
                },
                command_public_keys: vec![CommandPublicKey {
                    key_id: command_key.key_id(),
                    public_key_pem: command_key.public_key_pem(),
                }],
            },
        })
    }

    pub(crate) fn worker_workspace_json(&self) -> Result<Zeroizing<Vec<u8>>, WorkspaceNativeError> {
        sensitive_json(&self.worker_workspace)
    }

    pub(crate) fn device_bootstrap_json(&self) -> Result<Zeroizing<Vec<u8>>, WorkspaceNativeError> {
        sensitive_json(&self.device_bootstrap)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWorkspaceBootstrap<'a> {
    dispatch_mode: &'static str,
    trusted_local_path: &'a str,
    private_server: WorkerPrivateServer<'a>,
    authority: WorkerWorkspaceAuthority<'a>,
    signing: WorkerSigning<'a>,
    gateway: WorkerGateway<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerPrivateServer<'a> {
    port: u16,
    token: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerWorkspaceAuthority<'a> {
    tenant_id: &'static str,
    space_id: &'static str,
    workspace_binding_id: &'a str,
    incarnation_id: &'a str,
    device_binding_id: &'a str,
    device_id: &'a str,
    runtime_binding_id: &'a str,
    policy_snapshot_id: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerSigning<'a> {
    key_id: &'a str,
    private_key_pem: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerGateway<'a> {
    endpoint: String,
    deadline_ms: u32,
    tls: WorkerGatewayTls<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerGatewayTls<'a> {
    key_pem: &'a str,
    certificate_pem: &'a str,
    ca_certificate_pem: &'a str,
    servername: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayRegistry<'a> {
    schema_version: &'static str,
    devices: Vec<GatewayDeviceRegistration<'a>>,
    workers: Vec<GatewayWorkerRegistration<'a>>,
    command_signing_keys: Vec<CommandPublicKey<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayDeviceRegistration<'a> {
    device_id: &'a str,
    credential_id: &'a str,
    fingerprint256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayWorkerRegistration<'a> {
    worker_id: &'a str,
    credential_id: &'a str,
    fingerprint256: &'a str,
    allowed_runtime_binding_ids: Vec<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandPublicKey<'a> {
    key_id: &'a str,
    public_key_pem: &'a str,
}

pub(crate) struct GatewayTlsTempFileContents<'a> {
    private_key_pem: &'a str,
    certificate_pem: &'a str,
    ca_certificate_pem: &'a str,
}

impl std::fmt::Debug for GatewayTlsTempFileContents<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("GatewayTlsTempFileContents([REDACTED])")
    }
}

impl GatewayTlsTempFileContents<'_> {
    pub(crate) fn private_key_pem(&self) -> &str {
        self.private_key_pem
    }

    pub(crate) fn certificate_pem(&self) -> &str {
        self.certificate_pem
    }

    pub(crate) fn ca_certificate_pem(&self) -> &str {
        self.ca_certificate_pem
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayIdentityMetadata<'a> {
    schema_version: &'static str,
    kind: &'static str,
    gateway_id: &'a str,
    credential_id: &'a str,
    fingerprint256: &'a str,
    servername: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayBindConfig {
    host: &'static str,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRuntimeBootstrap<'a> {
    schema_version: &'static str,
    gateway_wss_url: String,
    device_id: &'a str,
    device_binding_id: &'a str,
    runtime_binding_id: &'a str,
    journal_path: String,
    workspaces: Vec<DeviceRuntimeWorkspace<'a>>,
    tls: DeviceRuntimeTls<'a>,
    command_public_keys: Vec<CommandPublicKey<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRuntimeWorkspace<'a> {
    workspace_binding_id: &'a str,
    incarnation_id: &'a str,
    trusted_local_path: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRuntimeTls<'a> {
    client_certificate_pem: &'a str,
    client_private_key_pem: &'a str,
    ca_certificate_pem: &'a str,
    server_certificate_sha256: &'a str,
}

fn sensitive_json(value: &impl Serialize) -> Result<Zeroizing<Vec<u8>>, WorkspaceNativeError> {
    serde_json::to_vec(value)
        .map(Zeroizing::new)
        .map_err(|_| WorkspaceNativeError::PayloadInvalid)
}

fn absolute_path(path: PathBuf) -> Result<String, WorkspaceNativeError> {
    if !path.is_absolute() {
        return Err(WorkspaceNativeError::PayloadInvalid);
    }
    path.to_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_PATH_BYTES
                && !value.chars().any(char::is_control)
        })
        .map(str::to_string)
        .ok_or(WorkspaceNativeError::PayloadInvalid)
}
