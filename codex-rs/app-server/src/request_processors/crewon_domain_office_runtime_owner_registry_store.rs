use std::io;
use std::path::Path;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_core::path_utils::write_atomically;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::task;

use super::office_runtime_owner_registry::REGISTRY_VERSION;
use super::office_runtime_owner_registry::RuntimeOwnerRegistry;
use super::office_runtime_owner_registry::validate_loaded_registry;
use crate::error_code::internal_error;

const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;

pub(super) async fn read(path: &Path) -> Result<RuntimeOwnerRegistry, JSONRPCErrorError> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(RuntimeOwnerRegistry {
                version: REGISTRY_VERSION,
                bootstrap_complete: false,
                quarantined_unreadable_records: false,
                entries: Default::default(),
            });
        }
        Err(err) => return Err(map_io_error(err)),
    };
    let metadata = file.metadata().await.map_err(map_io_error)?;
    if metadata.len() > MAX_REGISTRY_BYTES {
        return Err(registry_too_large_error());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    file.take(MAX_REGISTRY_BYTES.saturating_add(/*rhs*/ 1))
        .read_to_end(&mut bytes)
        .await
        .map_err(map_io_error)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_REGISTRY_BYTES {
        return Err(registry_too_large_error());
    }
    let registry = serde_json::from_slice::<RuntimeOwnerRegistry>(&bytes).map_err(|err| {
        internal_error(format!(
            "failed to parse Office runtime owner registry: {err}"
        ))
    })?;
    validate_loaded_registry(&registry)?;
    Ok(registry)
}

pub(super) async fn write(
    path: &Path,
    registry: &RuntimeOwnerRegistry,
) -> Result<(), JSONRPCErrorError> {
    let mut bytes = serde_json::to_vec_pretty(registry).map_err(|err| {
        internal_error(format!(
            "failed to serialize Office runtime owner registry: {err}"
        ))
    })?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_REGISTRY_BYTES {
        return Err(registry_too_large_error());
    }
    let contents = String::from_utf8(bytes).map_err(|err| {
        internal_error(format!(
            "failed to encode Office runtime owner registry: {err}"
        ))
    })?;
    let path = path.to_path_buf();
    task::spawn_blocking(move || write_atomically(&path, &contents))
        .await
        .map_err(|err| internal_error(format!("Office runtime registry task failed: {err}")))?
        .map_err(map_io_error)
}

fn registry_too_large_error() -> JSONRPCErrorError {
    internal_error(format!(
        "Office runtime owner registry exceeds {MAX_REGISTRY_BYTES} bytes"
    ))
}

fn map_io_error(err: io::Error) -> JSONRPCErrorError {
    internal_error(format!("Office runtime owner registry I/O failed: {err}"))
}
