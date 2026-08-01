use std::fs::File;
use std::fs::OpenOptions;
use std::fs::TryLockError;
use std::io;
use std::path::Path;

use crate::WRITER_LOCKS_DIR;

const GENERATION_LOCK_FILE: &str = "generation-v1.lock";

/// Selects which rollout-writer generation may coexist in one canonical Crewon home.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RolloutWriterGenerationMode {
    /// Legacy writers take exclusive ownership and cannot coexist with lease-aware writers.
    LegacyFenceExclusive,
    /// Lease-aware writers share the generation fence while retaining per-thread exclusivity.
    LeaseAwareShared,
}

/// Owns the operating-system lock that fences incompatible rollout-writer generations.
///
/// The guard must live for the complete process/runtime period in which its generation may write
/// rollouts. Dropping it, including through process termination, releases the OS lock.
#[derive(Debug)]
pub struct RolloutWriterGenerationGuard {
    _file: File,
    _mode: RolloutWriterGenerationMode,
}

/// Acquires the fail-fast generation fence for one canonical Crewon home.
pub fn acquire_rollout_writer_generation(
    codex_home: &Path,
    mode: RolloutWriterGenerationMode,
) -> io::Result<RolloutWriterGenerationGuard> {
    std::fs::create_dir_all(codex_home)?;
    let canonical_home = std::fs::canonicalize(codex_home)?;
    let lock_path = canonical_home
        .join(WRITER_LOCKS_DIR)
        .join(GENERATION_LOCK_FILE);
    let Some(lock_dir) = lock_path.parent() else {
        return Err(io::Error::other(format!(
            "rollout writer generation lock path has no parent: {}",
            lock_path.display()
        )));
    };
    std::fs::create_dir_all(lock_dir)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    let lock_result = match mode {
        RolloutWriterGenerationMode::LegacyFenceExclusive => file.try_lock(),
        RolloutWriterGenerationMode::LeaseAwareShared => file.try_lock_shared(),
    };
    match lock_result {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!(
                    "rollout writer generation {mode:?} conflicts with an active generation (lock {})",
                    lock_path.display()
                ),
            ));
        }
        Err(TryLockError::Error(err)) => {
            return Err(io::Error::new(
                err.kind(),
                format!(
                    "failed to acquire rollout writer generation lock {}: {err}",
                    lock_path.display()
                ),
            ));
        }
    }
    Ok(RolloutWriterGenerationGuard {
        _file: file,
        _mode: mode,
    })
}

#[cfg(test)]
#[path = "generation_lock_tests.rs"]
mod tests;
