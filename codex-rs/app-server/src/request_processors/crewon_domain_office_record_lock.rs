use std::collections::HashMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;

use tokio::sync::Mutex;
use tokio::sync::OwnedMutexGuard;
use tokio::task;

static OFFICE_RECORD_MUTATION_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    OnceLock::new();

pub(super) struct OfficeRecordMutationGuard {
    _process_guard: OwnedMutexGuard<()>,
    file: File,
}

impl Drop for OfficeRecordMutationGuard {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub(super) async fn lock(file_path: &Path) -> io::Result<OfficeRecordMutationGuard> {
    let lock_path = record_lock_path(file_path)?;
    let process_lock = process_lock(&lock_path).await;
    let process_guard = process_lock.lock_owned().await;
    let file = task::spawn_blocking(move || {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        file.lock()?;
        Ok::<_, io::Error>(file)
    })
    .await
    .map_err(|err| io::Error::other(format!("Office record lock task failed: {err}")))??;
    Ok(OfficeRecordMutationGuard {
        _process_guard: process_guard,
        file,
    })
}

async fn process_lock(lock_path: &Path) -> Arc<Mutex<()>> {
    let mut locks = OFFICE_RECORD_MUTATION_LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await;
    locks.retain(|_, process_lock| process_lock.strong_count() > 0);
    if let Some(process_lock) = locks.get(lock_path).and_then(Weak::upgrade) {
        return process_lock;
    }
    let process_lock = Arc::new(Mutex::new(()));
    locks.insert(lock_path.to_path_buf(), Arc::downgrade(&process_lock));
    process_lock
}

fn record_lock_path(file_path: &Path) -> io::Result<PathBuf> {
    let file_name = file_path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "Office record path {} has no file name",
                file_path.display()
            ),
        )
    })?;
    Ok(file_path.with_file_name(format!("{}.lock", file_name.to_string_lossy())))
}

#[cfg(test)]
#[path = "crewon_domain_office_record_lock_tests.rs"]
mod tests;
