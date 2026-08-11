#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GatewayIdentity {
    schema_version: String,
    kind: String,
    gateway_id: String,
    credential_id: String,
    fingerprint256: String,
    servername: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayBind {
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceControlProjection {
    private_server: WorkspacePrivateServerProjection,
}

#[derive(Deserialize)]
struct WorkspacePrivateServerProjection {
    port: u16,
    token: Zeroizing<String>,
}

struct GatewayLaunchFiles {
    directory: PathBuf,
    registry: PathBuf,
    tls_key: PathBuf,
    tls_certificate: PathBuf,
    tls_ca: PathBuf,
    cleaned: bool,
}

impl GatewayLaunchFiles {
    fn create(
        paths: &RuntimePaths,
        payloads: &crate::workspace_native::WorkspaceGatewayLaunchPayloads<'_>,
    ) -> Result<Self, ControlRuntimeStartError> {
        prepare_launch_root(&paths.workspace_launch_root)?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| ControlRuntimeStartError::RandomnessUnavailable)?;
        let directory = paths
            .workspace_launch_root
            .join(format!("generation-{}", hex::encode(random)));
        crate::workspace_native::prepare_private_directory(&directory)
            .map_err(map_workspace_error)?;
        let files = Self {
            registry: directory.join("registry.json"),
            tls_key: directory.join("gateway.key.pem"),
            tls_certificate: directory.join("gateway.cert.pem"),
            tls_ca: directory.join("ca.cert.pem"),
            directory,
            cleaned: false,
        };
        write_private(
            &files.registry,
            &payloads
                .gateway_registry_json()
                .map_err(map_workspace_error)?,
        )?;
        write_private(
            &files.tls_key,
            payloads.gateway_tls().private_key_pem().as_bytes(),
        )?;
        write_private(
            &files.tls_certificate,
            payloads.gateway_tls().certificate_pem().as_bytes(),
        )?;
        write_private(
            &files.tls_ca,
            payloads.gateway_tls().ca_certificate_pem().as_bytes(),
        )?;
        Ok(files)
    }

    fn cleanup(&mut self) -> Result<(), ()> {
        for path in [
            &self.registry,
            &self.tls_key,
            &self.tls_certificate,
            &self.tls_ca,
        ] {
            fs::remove_file(path).map_err(|_| ())?;
        }
        fs::remove_dir(&self.directory).map_err(|_| ())?;
        self.cleaned = true;
        Ok(())
    }
}

impl Drop for GatewayLaunchFiles {
    fn drop(&mut self) {
        if self.cleaned {
            return;
        }
        for path in [
            &self.registry,
            &self.tls_key,
            &self.tls_certificate,
            &self.tls_ca,
        ] {
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir(&self.directory);
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ControlRuntimeStartError> {
    if bytes.is_empty() {
        return Err(workspace_failed());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|_| workspace_failed())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| workspace_failed())
}

fn prepare_runtime_directory(
    root: &Path,
    runtime_binding_id: &str,
) -> Result<PathBuf, ControlRuntimeStartError> {
    crate::workspace_native::prepare_private_directory(root).map_err(map_workspace_error)?;
    let directory = root.join(runtime_binding_id);
    crate::workspace_native::prepare_private_directory(&directory).map_err(map_workspace_error)?;
    Ok(directory)
}

fn prepare_launch_root(root: &Path) -> Result<(), ControlRuntimeStartError> {
    crate::workspace_native::prepare_private_directory(root).map_err(map_workspace_error)
}
