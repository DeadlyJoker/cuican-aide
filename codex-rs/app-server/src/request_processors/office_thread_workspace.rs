use std::path::Path;
use std::path::PathBuf;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_core::path_utils;
use crewon_protocol::protocol::RolloutItem;
use crewon_utils_absolute_path::AbsolutePathBuf;

use crate::error_code::invalid_request;

pub(super) fn ensure_matches(
    requested_cwd: &str,
    thread_id: &str,
    thread_cwd: &Path,
) -> Result<(), JSONRPCErrorError> {
    if requested_cwd.trim().is_empty() {
        return Err(invalid_request("Office workspace cwd must not be empty"));
    }
    if thread_cwd.as_os_str().is_empty() {
        return Err(invalid_request(format!(
            "Office thread {thread_id} is missing persisted workspace metadata"
        )));
    }
    let requested_cwd = absolute_path(requested_cwd).map_err(|err| {
        invalid_request(format!(
            "invalid Office workspace cwd `{requested_cwd}`: {err}"
        ))
    })?;
    let thread_cwd = absolute_path(thread_cwd).map_err(|err| {
        invalid_request(format!(
            "Office thread {thread_id} has an invalid persisted cwd `{}`: {err}",
            thread_cwd.display()
        ))
    })?;
    if path_utils::paths_match_after_normalization(&requested_cwd, &thread_cwd) {
        return Ok(());
    }
    Err(invalid_request(format!(
        "Office thread {thread_id} belongs to a different workspace; requested `{}`, thread cwd `{}`",
        requested_cwd.display(),
        thread_cwd.display()
    )))
}

pub(super) fn ensure_history_matches(
    requested_cwd: &str,
    thread_id: &str,
    items: &[RolloutItem],
) -> Result<(), JSONRPCErrorError> {
    let mut thread_cwd = None;
    for item in items {
        let RolloutItem::SessionMeta(meta_line) = item else {
            continue;
        };
        if meta_line.meta.id.to_string() != thread_id {
            continue;
        }
        let candidate_cwd = meta_line.meta.cwd.as_path();
        if candidate_cwd.as_os_str().is_empty() {
            return Err(invalid_request(format!(
                "Office thread {thread_id} is missing persisted workspace metadata"
            )));
        }
        if let Some(existing_cwd) = thread_cwd {
            let existing_absolute = absolute_path(existing_cwd).map_err(|err| {
                invalid_request(format!(
                    "Office thread {thread_id} has invalid persisted workspace metadata: {err}"
                ))
            })?;
            let candidate_absolute = absolute_path(candidate_cwd).map_err(|err| {
                invalid_request(format!(
                    "Office thread {thread_id} has invalid persisted workspace metadata: {err}"
                ))
            })?;
            if !path_utils::paths_match_after_normalization(&existing_absolute, &candidate_absolute)
            {
                return Err(invalid_request(format!(
                    "Office thread {thread_id} has conflicting persisted workspace metadata"
                )));
            }
        } else {
            thread_cwd = Some(candidate_cwd);
        }
    }
    let Some(thread_cwd) = thread_cwd else {
        return Err(invalid_request(format!(
            "Office thread {thread_id} is missing persisted workspace metadata"
        )));
    };
    ensure_matches(requested_cwd, thread_id, thread_cwd)
}

fn absolute_path(path: impl AsRef<Path>) -> Result<PathBuf, String> {
    AbsolutePathBuf::relative_to_current_dir(path_utils::normalize_for_native_workdir(path))
        .map(AbsolutePathBuf::into_path_buf)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
#[path = "office_thread_workspace_tests.rs"]
mod tests;
