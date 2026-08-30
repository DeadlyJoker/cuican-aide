use std::path::Path;
use std::path::PathBuf;

use crewon_protocol::ThreadId;
use crewon_rollout::find_archived_thread_path_by_id_str;
use crewon_rollout::find_thread_path_by_id_str;

use super::LocalThreadStore;
use super::helpers::matching_rollout_file_name;
use super::helpers::scoped_rollout_path;
use super::live_writer;
use crate::ThreadStoreError;
use crate::ThreadStoreResult;

pub(super) struct ResolvedRolloutPath {
    pub(super) path: PathBuf,
    pub(super) archived: bool,
}

pub(super) async fn resolve_rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    include_archived: bool,
) -> ThreadStoreResult<ResolvedRolloutPath> {
    if let Ok(path) = live_writer::rollout_path(store, thread_id).await {
        let archived = rollout_path_is_archived(store, path.as_path());
        return Ok(ResolvedRolloutPath { path, archived });
    }

    let state_db_ctx = store.state_db().await;
    let active_path = find_thread_path_by_id_str(
        store.config.codex_home.as_path(),
        &thread_id.to_string(),
        state_db_ctx.as_deref(),
    )
    .await
    .map_err(|err| ThreadStoreError::InvalidRequest {
        message: format!("failed to locate thread id {thread_id}: {err}"),
    })?;
    if let Some(path) = active_path {
        return Ok(ResolvedRolloutPath {
            path,
            archived: false,
        });
    }
    if !include_archived {
        return Err(ThreadStoreError::InvalidRequest {
            message: format!("thread not found: {thread_id}"),
        });
    }
    find_archived_thread_path_by_id_str(
        store.config.codex_home.as_path(),
        &thread_id.to_string(),
        state_db_ctx.as_deref(),
    )
    .await
    .map_err(|err| ThreadStoreError::InvalidRequest {
        message: format!("failed to locate archived thread id {thread_id}: {err}"),
    })?
    .map(|path| ResolvedRolloutPath {
        path,
        archived: true,
    })
    .ok_or_else(|| ThreadStoreError::InvalidRequest {
        message: format!("thread not found: {thread_id}"),
    })
}

pub(super) async fn resolve_metadata_rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
    requested_path: Option<&Path>,
    include_archived: bool,
) -> ThreadStoreResult<ResolvedRolloutPath> {
    let resolved = match requested_path {
        Some(path) => ResolvedRolloutPath {
            path: path.to_path_buf(),
            archived: rollout_path_is_archived(store, path),
        },
        None => {
            if let Ok(path) = live_writer::rollout_path(store, thread_id).await {
                ResolvedRolloutPath {
                    archived: rollout_path_is_archived(store, path.as_path()),
                    path,
                }
            } else {
                let active_path = find_thread_path_by_id_str(
                    store.config.codex_home.as_path(),
                    &thread_id.to_string(),
                    /*state_db_ctx*/ None,
                )
                .await
                .map_err(|err| ThreadStoreError::InvalidRequest {
                    message: format!("failed to locate thread id {thread_id}: {err}"),
                })?;
                match active_path {
                    Some(path) => ResolvedRolloutPath {
                        path,
                        archived: false,
                    },
                    None if include_archived => {
                        let path = find_archived_thread_path_by_id_str(
                            store.config.codex_home.as_path(),
                            &thread_id.to_string(),
                            /*state_db_ctx*/ None,
                        )
                        .await
                        .map_err(|err| ThreadStoreError::InvalidRequest {
                            message: format!(
                                "failed to locate archived thread id {thread_id}: {err}"
                            ),
                        })?
                        .ok_or_else(|| {
                            ThreadStoreError::InvalidRequest {
                                message: format!("thread not found: {thread_id}"),
                            }
                        })?;
                        ResolvedRolloutPath {
                            path,
                            archived: true,
                        }
                    }
                    None => {
                        return Err(ThreadStoreError::InvalidRequest {
                            message: format!("thread not found: {thread_id}"),
                        });
                    }
                }
            }
        }
    };
    let existing_path = crewon_rollout::existing_rollout_path(resolved.path.as_path())
        .await
        .ok_or_else(|| ThreadStoreError::InvalidRequest {
            message: format!("thread {thread_id} rollout is unavailable for metadata mutation"),
        })?;
    let canonical_existing_path =
        std::fs::canonicalize(existing_path.as_path()).map_err(|err| {
            ThreadStoreError::InvalidRequest {
                message: format!("failed to resolve thread {thread_id} rollout: {err}"),
            }
        })?;
    let is_live_rollout = match live_writer::rollout_path(store, thread_id).await {
        Ok(live_path) => std::fs::canonicalize(live_path)
            .is_ok_and(|canonical_live_path| canonical_live_path == canonical_existing_path),
        Err(_) => false,
    };
    let canonical_path = if is_live_rollout {
        canonical_existing_path
    } else {
        scoped_rollout_path(
            store
                .config
                .codex_home
                .join(crewon_rollout::SESSIONS_SUBDIR),
            canonical_existing_path.as_path(),
            "sessions",
        )
        .or_else(|active_error| {
            if include_archived {
                scoped_rollout_path(
                    store
                        .config
                        .codex_home
                        .join(crewon_rollout::ARCHIVED_SESSIONS_SUBDIR),
                    canonical_existing_path.as_path(),
                    "archived sessions",
                )
            } else {
                Err(active_error)
            }
        })?
    };
    matching_rollout_file_name(&canonical_path, thread_id, existing_path.as_path())?;
    Ok(ResolvedRolloutPath {
        archived: rollout_path_is_archived(store, canonical_path.as_path()),
        path: canonical_path,
    })
}

pub(super) fn rollout_path_is_archived(store: &LocalThreadStore, path: &Path) -> bool {
    super::helpers::rollout_path_is_archived(store.config.codex_home.as_path(), path)
}
