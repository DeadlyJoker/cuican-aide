use std::fs::File;
use std::fs::OpenOptions;
use std::fs::TryLockError;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use crewon_protocol::ThreadId;

use crate::ARCHIVED_SESSIONS_SUBDIR;
use crate::SESSIONS_SUBDIR;
use crate::WRITER_LOCKS_DIR;
use crate::compression;
use crate::legacy_fence;
use crate::legacy_fence::RolloutMutation;

/// Owns the operating-system lock that grants exclusive write access to a rollout.
///
/// The lock is deliberately advisory and fail-fast. Every rollout writer must hold one for its
/// complete lifetime; dropping this value (including task cancellation or process exit) releases
/// the operating-system lock.
#[derive(Debug)]
pub struct RolloutWriterLease {
    _file: File,
    thread_id: ThreadId,
}

impl RolloutWriterLease {
    /// Acquire exclusive writer ownership for a thread in a rollout store.
    pub fn acquire(codex_home: &Path, thread_id: ThreadId) -> io::Result<Self> {
        Self::acquire_for_create(codex_home, thread_id)
    }

    /// Acquire writer ownership and admit a mutation against an existing rollout.
    ///
    /// Legacy Fence artifacts inspect the exact rollout while this lease is held, so a marker
    /// cannot appear between admission and mutation by another cooperating writer.
    pub fn acquire_for_existing_mutation(
        codex_home: &Path,
        rollout_path: &Path,
        thread_id: ThreadId,
        mutation: RolloutMutation,
    ) -> io::Result<Self> {
        let lease = Self::acquire_for_create(codex_home, thread_id)?;
        lease.ensure_existing_mutation_allowed(rollout_path, thread_id, mutation)?;
        Ok(lease)
    }

    /// Admit another existing-rollout mutation while retaining this thread lease.
    ///
    /// This supports atomic multi-path operations such as deleting active and archived aliases:
    /// callers acquire once, admit every candidate, and mutate only after all candidates pass.
    pub fn ensure_existing_mutation_allowed(
        &self,
        rollout_path: &Path,
        thread_id: ThreadId,
        mutation: RolloutMutation,
    ) -> io::Result<()> {
        self.ensure_thread_id(thread_id)?;
        legacy_fence::ensure_existing_rollout_mutation_allowed(rollout_path, thread_id, mutation)
    }

    pub(crate) fn acquire_for_create(codex_home: &Path, thread_id: ThreadId) -> io::Result<Self> {
        std::fs::create_dir_all(codex_home)?;
        let canonical_home = std::fs::canonicalize(codex_home)?;
        Self::acquire_path(
            lock_path_in_root(canonical_home.as_path(), thread_id),
            thread_id,
        )
    }

    pub(crate) fn acquire_for_existing(
        rollout_path: &Path,
        thread_id: ThreadId,
    ) -> io::Result<Self> {
        let lease = Self::acquire_path(
            lock_path_for_existing_rollout(rollout_path, thread_id)?,
            thread_id,
        )?;
        lease.ensure_existing_mutation_allowed(rollout_path, thread_id, RolloutMutation::Append)?;
        Ok(lease)
    }

    pub(crate) fn ensure_thread_id(&self, expected_thread_id: ThreadId) -> io::Result<()> {
        if self.thread_id == expected_thread_id {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "rollout writer lease belongs to thread {}, not {expected_thread_id}",
                    self.thread_id
                ),
            ))
        }
    }

    fn acquire_path(lock_path: PathBuf, thread_id: ThreadId) -> io::Result<Self> {
        let Some(parent) = lock_path.parent() else {
            return Err(io::Error::other(format!(
                "rollout writer lock path has no parent: {}",
                lock_path.display()
            )));
        };
        std::fs::create_dir_all(parent)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    format!(
                        "rollout already has an active writer (lock {})",
                        lock_path.display()
                    ),
                ));
            }
            Err(TryLockError::Error(err)) => {
                return Err(io::Error::new(
                    err.kind(),
                    format!(
                        "failed to acquire rollout writer lock {}: {err}",
                        lock_path.display()
                    ),
                ));
            }
        }
        Ok(Self {
            _file: file,
            thread_id,
        })
    }
}

fn lock_path_for_existing_rollout(rollout_path: &Path, thread_id: ThreadId) -> io::Result<PathBuf> {
    let plain_path = compression::plain_rollout_path(rollout_path);
    let parent = plain_path.parent().ok_or_else(|| {
        io::Error::other(format!(
            "rollout path has no parent: {}",
            rollout_path.display()
        ))
    })?;
    let canonical_parent = std::fs::canonicalize(parent)?;

    if let Some(codex_home) = rollout_store_root(canonical_parent.as_path()) {
        return Ok(lock_path_in_root(codex_home.as_path(), thread_id));
    }

    Ok(canonical_parent
        .join(WRITER_LOCKS_DIR)
        .join(format!("{thread_id}.lock")))
}

fn rollout_store_root(path: &Path) -> Option<PathBuf> {
    path.ancestors().find_map(|ancestor| {
        let collection = ancestor.file_name()?.to_str()?;
        if collection == SESSIONS_SUBDIR || collection == ARCHIVED_SESSIONS_SUBDIR {
            ancestor.parent().map(Path::to_path_buf)
        } else {
            None
        }
    })
}

fn lock_path_in_root(root: &Path, thread_id: ThreadId) -> PathBuf {
    root.join(WRITER_LOCKS_DIR)
        .join(format!("{thread_id}.lock"))
}

#[cfg(test)]
#[path = "writer_lock_tests.rs"]
mod tests;
