use std::path::PathBuf;

use crewon_protocol::ThreadId;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::ThreadMemoryMode;
use crewon_rollout::RolloutConfig;
use crewon_rollout::RolloutRecorder;
use crewon_rollout::RolloutRecorderParams;
use tracing::warn;

use super::LocalThreadStore;
use super::create_thread;
use crate::AppendThreadItemsParams;
use crate::CreateThreadParams;
use crate::ReadThreadParams;
use crate::ResumeThreadParams;
use crate::ThreadStoreError;
use crate::ThreadStoreResult;

pub(super) async fn create_thread(
    store: &LocalThreadStore,
    params: CreateThreadParams,
) -> ThreadStoreResult<()> {
    let thread_id = params.thread_id;
    store.ensure_live_recorder_absent(thread_id).await?;
    let recorder = create_thread::create_thread(store, params).await?;
    store.insert_live_recorder(thread_id, recorder).await
}

pub(super) async fn resume_thread(
    store: &LocalThreadStore,
    params: ResumeThreadParams,
) -> ThreadStoreResult<()> {
    let ResumeThreadParams {
        thread_id,
        rollout_path,
        history,
        include_archived,
        metadata,
    } = params;
    store.ensure_live_recorder_absent(thread_id).await?;
    let rollout_path = match rollout_path {
        Some(rollout_path) => rollout_path,
        None => {
            let thread = super::read_thread::read_thread(
                store,
                ReadThreadParams {
                    thread_id,
                    include_archived,
                    include_history: history.is_none(),
                },
            )
            .await?;

            thread
                .rollout_path
                .ok_or_else(|| ThreadStoreError::Internal {
                    message: format!("thread {thread_id} does not have a rollout path"),
                })?
        }
    };
    let cwd = metadata
        .cwd
        .clone()
        .ok_or_else(|| ThreadStoreError::InvalidRequest {
            message: "local thread store requires a cwd".to_string(),
        })?;
    let config = RolloutConfig {
        codex_home: store.config.codex_home.clone(),
        sqlite_home: store.config.sqlite_home.clone(),
        cwd,
        model_provider_id: metadata.model_provider.clone(),
        generate_memories: matches!(metadata.memory_mode, ThreadMemoryMode::Enabled),
    };
    let recorder = RolloutRecorder::new(
        &config,
        RolloutRecorderParams::resume_for_thread(rollout_path, thread_id),
    )
    .await
    .map_err(map_recorder_error)?;
    if let Err(err) = validate_resumed_history(&recorder, thread_id, history.as_deref()).await {
        let _ = recorder.shutdown().await;
        return Err(err);
    }
    store.insert_live_recorder(thread_id, recorder).await
}

async fn validate_resumed_history(
    recorder: &RolloutRecorder,
    expected_thread_id: ThreadId,
    expected_history: Option<&[RolloutItem]>,
) -> ThreadStoreResult<()> {
    let (actual_history, actual_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(recorder.rollout_path())
            .await
            .map_err(map_recorder_error)?;
    if actual_thread_id != Some(expected_thread_id) {
        return Err(ThreadStoreError::InvalidRequest {
            message: format!(
                "rollout thread id mismatch after acquiring writer ownership: expected {expected_thread_id}, found {actual_thread_id:?}"
            ),
        });
    }
    if parse_errors != 0 {
        return Err(ThreadStoreError::InvalidRequest {
            message: format!(
                "rollout contains {parse_errors} unreadable item(s); refusing to resume writer"
            ),
        });
    }
    let Some(expected_history) = expected_history else {
        return Ok(());
    };
    let expected =
        serde_json::to_value(expected_history).map_err(|err| ThreadStoreError::Internal {
            message: format!("failed to compare expected rollout history: {err}"),
        })?;
    let actual =
        serde_json::to_value(actual_history).map_err(|err| ThreadStoreError::Internal {
            message: format!("failed to compare current rollout history: {err}"),
        })?;
    if actual != expected {
        return Err(ThreadStoreError::Conflict {
            message: "rollout changed while acquiring writer ownership; retry resume".to_string(),
        });
    }
    Ok(())
}

pub(super) async fn append_items(
    store: &LocalThreadStore,
    params: AppendThreadItemsParams,
) -> ThreadStoreResult<()> {
    let recorder = store.live_recorder(params.thread_id).await?;
    recorder
        .record_canonical_items(params.items.as_slice())
        .await
        .map_err(thread_store_io_error)?;
    // LiveThread applies metadata immediately after append_items returns. Wait for the local
    // writer so SQLite never gets ahead of JSONL for accepted live appends.
    recorder.flush().await.map_err(thread_store_io_error)
}

pub(super) async fn persist_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()> {
    store
        .live_recorder(thread_id)
        .await?
        .persist()
        .await
        .map_err(thread_store_io_error)?;
    sync_materialized_rollout_path(store, thread_id).await
}

pub(super) async fn flush_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()> {
    store
        .live_recorder(thread_id)
        .await?
        .flush()
        .await
        .map_err(thread_store_io_error)?;
    sync_materialized_rollout_path(store, thread_id).await
}

pub(super) async fn shutdown_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()> {
    let recorder = store.live_recorder(thread_id).await?;
    recorder.shutdown().await.map_err(thread_store_io_error)?;
    sync_materialized_rollout_path(store, thread_id).await?;
    store.live_recorders.lock().await.remove(&thread_id);
    Ok(())
}

pub(super) async fn discard_thread(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()> {
    let recorder = store
        .live_recorders
        .lock()
        .await
        .remove(&thread_id)
        .ok_or(ThreadStoreError::ThreadNotFound { thread_id })?;
    recorder.discard().await.map_err(thread_store_io_error)
}

pub(super) async fn rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<PathBuf> {
    Ok(store
        .live_recorders
        .lock()
        .await
        .get(&thread_id)
        .ok_or(ThreadStoreError::ThreadNotFound { thread_id })?
        .rollout_path()
        .to_path_buf())
}

async fn sync_materialized_rollout_path(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> ThreadStoreResult<()> {
    let rollout_path = rollout_path(store, thread_id).await?;
    if crewon_rollout::existing_rollout_path(rollout_path.as_path())
        .await
        .is_none()
    {
        return Ok(());
    }
    let Some(state_db) = store.state_db().await else {
        return Ok(());
    };
    let result: ThreadStoreResult<()> = async {
        let Some(mut metadata) =
            state_db
                .get_thread(thread_id)
                .await
                .map_err(|err| ThreadStoreError::Internal {
                    message: format!("failed to read thread metadata for {thread_id}: {err}"),
                })?
        else {
            return Ok(());
        };
        if metadata.rollout_path != rollout_path {
            metadata.rollout_path = rollout_path;
            state_db
                .upsert_thread(&metadata)
                .await
                .map_err(|err| ThreadStoreError::Internal {
                    message: format!("failed to update thread metadata for {thread_id}: {err}"),
                })?;
        }
        Ok(())
    }
    .await;
    if let Err(err) = result {
        warn!("failed to sync materialized rollout path for thread {thread_id}: {err}");
    }
    Ok(())
}

fn thread_store_io_error(err: std::io::Error) -> ThreadStoreError {
    map_recorder_error(err)
}

pub(super) fn map_recorder_error(err: std::io::Error) -> ThreadStoreError {
    match err.kind() {
        std::io::ErrorKind::WouldBlock => ThreadStoreError::Conflict {
            message: "thread already has an active rollout writer".to_string(),
        },
        std::io::ErrorKind::InvalidData => ThreadStoreError::InvalidRequest {
            message: err.to_string(),
        },
        _ => ThreadStoreError::Internal {
            message: err.to_string(),
        },
    }
}
