use std::io;
use std::path::Path;
use std::path::PathBuf;

use crewon_app_server_protocol::JSONRPCErrorError;
use serde::Deserialize;
use serde::Serialize;
use tokio::fs;
use tokio::io::AsyncReadExt;

use super::DomainKind;
use super::OfficeOrphanDispatch;
use super::domain_directory;
use super::map_io_error;
use super::office_authority_lock;
use super::office_storage;
use crate::error_code::internal_error;

const ORPHAN_DISPATCH_FILE_NAME: &str = ".orphan-dispatches.state";
const ORPHAN_DISPATCH_QUEUE_VERSION: u32 = 1;
const MAX_ORPHAN_DISPATCHES: usize = 64;
const MAX_ORPHAN_DISPATCH_QUEUE_BYTES: u64 = 128 * 1024;

#[cfg(test)]
#[path = "crewon_domain_office_orphan_dispatch_tests.rs"]
mod tests;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficeOrphanDispatchQueue {
    version: u32,
    entries: Vec<OfficeOrphanDispatch>,
}

pub(super) async fn enqueue(
    cwd: &str,
    entry: OfficeOrphanDispatch,
) -> Result<(), JSONRPCErrorError> {
    let _authority_guard = office_authority_lock::lock(cwd).await?;
    let path = queue_path(cwd)?;
    let mut queue = read_queue(&path).await?;
    queue.version = ORPHAN_DISPATCH_QUEUE_VERSION;
    if let Some(existing) = queue
        .entries
        .iter_mut()
        .find(|existing| existing.thread_id == entry.thread_id && existing.turn_id == entry.turn_id)
    {
        *existing = entry;
    } else {
        if queue.entries.len() >= MAX_ORPHAN_DISPATCHES {
            let evicted = queue.entries.remove(/*index*/ 0);
            tracing::error!(
                record_id = %evicted.record_id,
                run_id = %evicted.run_id,
                thread_id = %evicted.thread_id,
                turn_id = %evicted.turn_id,
                "Office orphan dispatch queue reached its hard cap; evicting its oldest entry"
            );
        }
        queue.entries.push(entry);
    }
    write_queue(&path, &queue).await
}

pub(super) async fn list(cwd: &str) -> Result<Vec<OfficeOrphanDispatch>, JSONRPCErrorError> {
    let _authority_guard = office_authority_lock::lock(cwd).await?;
    read_queue(&queue_path(cwd)?)
        .await
        .map(|queue| queue.entries)
}

pub(super) async fn resolve(
    cwd: &str,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), JSONRPCErrorError> {
    let _authority_guard = office_authority_lock::lock(cwd).await?;
    let path = queue_path(cwd)?;
    let mut queue = read_queue(&path).await?;
    let original_len = queue.entries.len();
    queue
        .entries
        .retain(|entry| entry.thread_id != thread_id || entry.turn_id != turn_id);
    if queue.entries.len() == original_len {
        return Ok(());
    }
    write_queue(&path, &queue).await
}

fn queue_path(cwd: &str) -> Result<PathBuf, JSONRPCErrorError> {
    domain_directory(cwd, DomainKind::Office)
        .map(|directory| directory.join(ORPHAN_DISPATCH_FILE_NAME))
}

async fn read_queue(path: &Path) -> Result<OfficeOrphanDispatchQueue, JSONRPCErrorError> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(OfficeOrphanDispatchQueue {
                version: ORPHAN_DISPATCH_QUEUE_VERSION,
                entries: Vec::new(),
            });
        }
        Err(error) => return Err(map_io_error(error)),
    };
    let metadata = file.metadata().await.map_err(map_io_error)?;
    if metadata.len() > MAX_ORPHAN_DISPATCH_QUEUE_BYTES {
        return Err(internal_error(
            "Office orphan dispatch queue exceeds its size limit",
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    file.take(MAX_ORPHAN_DISPATCH_QUEUE_BYTES.saturating_add(/*rhs*/ 1))
        .read_to_end(&mut bytes)
        .await
        .map_err(map_io_error)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_ORPHAN_DISPATCH_QUEUE_BYTES {
        return Err(internal_error(
            "Office orphan dispatch queue exceeded its read limit",
        ));
    }
    let queue = serde_json::from_slice::<OfficeOrphanDispatchQueue>(&bytes).map_err(|error| {
        internal_error(format!(
            "failed to parse Office orphan dispatch queue: {error}"
        ))
    })?;
    if queue.version != ORPHAN_DISPATCH_QUEUE_VERSION
        || queue.entries.len() > MAX_ORPHAN_DISPATCHES
        || queue.entries.iter().any(OfficeOrphanDispatch::is_invalid)
    {
        return Err(internal_error("Office orphan dispatch queue is invalid"));
    }
    Ok(queue)
}

async fn write_queue(
    path: &Path,
    queue: &OfficeOrphanDispatchQueue,
) -> Result<(), JSONRPCErrorError> {
    let mut bytes = serde_json::to_vec_pretty(queue).map_err(|error| {
        internal_error(format!(
            "failed to serialize Office orphan dispatch queue: {error}"
        ))
    })?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_ORPHAN_DISPATCH_QUEUE_BYTES {
        return Err(internal_error(
            "Office orphan dispatch queue exceeds its size limit",
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(map_io_error)?;
    }
    let contents = String::from_utf8(bytes).map_err(|error| {
        internal_error(format!(
            "Office orphan dispatch queue is not UTF-8: {error}"
        ))
    })?;
    office_storage::write_atomically_preserving_permissions(path, contents).await
}
