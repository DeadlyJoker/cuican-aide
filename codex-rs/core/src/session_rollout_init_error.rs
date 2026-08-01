use std::io::ErrorKind;
use std::path::Path;

use crate::rollout::SESSIONS_SUBDIR;
use crewon_protocol::error::CodexErr;
use crewon_thread_store::ThreadStoreError;

pub(crate) fn map_session_init_error(err: &anyhow::Error, codex_home: &Path) -> CodexErr {
    if let Some(mapped) = err
        .chain()
        .filter_map(|cause| cause.downcast_ref::<ThreadStoreError>())
        .find_map(map_thread_store_error)
    {
        return mapped;
    }

    if let Some(mapped) = err
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .find_map(|io_err| map_rollout_io_error(io_err, codex_home))
    {
        return mapped;
    }

    CodexErr::Fatal(format!("Failed to initialize session: {err:#}"))
}

fn map_thread_store_error(err: &ThreadStoreError) -> Option<CodexErr> {
    match err {
        ThreadStoreError::ThreadNotFound { thread_id } => {
            Some(CodexErr::ThreadNotFound(*thread_id))
        }
        ThreadStoreError::InvalidRequest { message } | ThreadStoreError::Conflict { message } => {
            Some(CodexErr::InvalidRequest(message.clone()))
        }
        ThreadStoreError::Unsupported { operation } => Some(CodexErr::UnsupportedOperation(
            format!("thread store operation is not supported: {operation}"),
        )),
        ThreadStoreError::Internal { .. } => None,
    }
}

fn map_rollout_io_error(io_err: &std::io::Error, codex_home: &Path) -> Option<CodexErr> {
    let sessions_dir = codex_home.join(SESSIONS_SUBDIR);
    let hint = match io_err.kind() {
        ErrorKind::PermissionDenied => format!(
            "Crewon cannot access session files at {} (permission denied). If sessions were created using sudo, fix ownership: sudo chown -R $(whoami) {}",
            sessions_dir.display(),
            codex_home.display()
        ),
        ErrorKind::NotFound => format!(
            "Session storage missing at {}. Create the directory or choose a different Crewon home.",
            sessions_dir.display()
        ),
        ErrorKind::AlreadyExists => format!(
            "Session storage path {} is blocked by an existing file. Remove or rename it so Crewon can create sessions.",
            sessions_dir.display()
        ),
        ErrorKind::InvalidData | ErrorKind::InvalidInput => format!(
            "Session data under {} looks corrupt or unreadable. Clearing the sessions directory may help (this will remove saved threads).",
            sessions_dir.display()
        ),
        ErrorKind::IsADirectory | ErrorKind::NotADirectory => format!(
            "Session storage path {} has an unexpected type. Ensure it is a directory Crewon can use for session files.",
            sessions_dir.display()
        ),
        _ => return None,
    };

    Some(CodexErr::Fatal(format!(
        "{hint} (underlying error: {io_err})"
    )))
}

#[cfg(test)]
#[path = "session_rollout_init_error_tests.rs"]
mod tests;
