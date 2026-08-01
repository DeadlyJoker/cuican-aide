use std::path::Path;

use crewon_protocol::ThreadId;
use crewon_protocol::models::BaseInstructions;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::SessionSource;
use crewon_protocol::protocol::ThreadMemoryMode;
use crewon_rollout::RolloutRecorder;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

use super::LocalThreadStore;
use crate::CreateThreadParams;
use crate::GitInfoPatch;
use crate::ResumeThreadParams;
use crate::ThreadMetadataPatch;
use crate::ThreadPersistenceMetadata;
use crate::ThreadStore;
use crate::ThreadStoreError;
use crate::UpdateThreadMetadataParams;
use crate::local::test_support::test_config;
use crate::local::test_support::write_session_file;

#[tokio::test]
async fn live_created_writer_serializes_metadata_markers_without_self_conflict() {
    let home = TempDir::new().expect("temp dir");
    let config = test_config(home.path());
    let runtime = crewon_state::StateRuntime::init(
        config.sqlite_home.clone(),
        config.default_model_provider_id.clone(),
    )
    .await
    .expect("state db should initialize");
    let store = LocalThreadStore::new(config, Some(runtime));
    let thread_id = thread_id(601);

    store
        .create_thread(create_params(home.path(), thread_id))
        .await
        .expect("create live writer");
    let rollout_path = store
        .live_rollout_path(thread_id)
        .await
        .expect("live rollout path");

    apply_live_metadata_updates(&store, thread_id).await;

    assert_eq!(
        session_meta_markers(rollout_path.as_path(), thread_id).await,
        vec![
            MetadataMarker {
                memory_mode: None,
                branch: None,
            },
            MetadataMarker {
                memory_mode: Some("disabled".to_string()),
                branch: None,
            },
            MetadataMarker {
                memory_mode: Some("disabled".to_string()),
                branch: Some("lease-safe".to_string()),
            },
        ]
    );
    store
        .shutdown_thread(thread_id)
        .await
        .expect("release created live writer");
}

#[tokio::test]
async fn live_resumed_writer_serializes_metadata_markers_without_self_conflict() {
    let home = TempDir::new().expect("temp dir");
    let config = test_config(home.path());
    let runtime = crewon_state::StateRuntime::init(
        config.sqlite_home.clone(),
        config.default_model_provider_id.clone(),
    )
    .await
    .expect("state db should initialize");
    let store = LocalThreadStore::new(config, Some(runtime));
    let uuid = uuid::Uuid::from_u128(602);
    let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
    let rollout_path =
        write_session_file(home.path(), "2025-01-05T12-00-00", uuid).expect("session file");

    store
        .resume_thread(ResumeThreadParams {
            thread_id,
            rollout_path: Some(rollout_path.clone()),
            history: None,
            include_archived: false,
            metadata: thread_metadata(home.path()),
        })
        .await
        .expect("resume live writer");

    apply_live_metadata_updates(&store, thread_id).await;

    assert_eq!(
        session_meta_markers(rollout_path.as_path(), thread_id).await,
        vec![
            MetadataMarker {
                memory_mode: None,
                branch: Some("main".to_string()),
            },
            MetadataMarker {
                memory_mode: Some("disabled".to_string()),
                branch: None,
            },
            MetadataMarker {
                memory_mode: Some("disabled".to_string()),
                branch: Some("lease-safe".to_string()),
            },
        ]
    );
    store
        .shutdown_thread(thread_id)
        .await
        .expect("release resumed live writer");
}

#[tokio::test]
async fn cold_metadata_writer_conflicts_with_live_writer_and_retries_after_shutdown() {
    let home = TempDir::new().expect("temp dir");
    let uuid = uuid::Uuid::from_u128(603);
    let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
    let rollout_path =
        write_session_file(home.path(), "2025-01-05T12-30-00", uuid).expect("session file");
    let runtime =
        crewon_state::StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
            .await
            .expect("state db should initialize");
    let live_store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);
    let cold_store = LocalThreadStore::new(test_config(home.path()), Some(runtime.clone()));

    live_store
        .resume_thread(ResumeThreadParams {
            thread_id,
            rollout_path: Some(rollout_path.clone()),
            history: None,
            include_archived: false,
            metadata: thread_metadata(home.path()),
        })
        .await
        .expect("resume live writer");

    let error = update_memory_mode(&cold_store, thread_id)
        .await
        .expect_err("cold metadata writer must not bypass a live writer lease");
    assert!(matches!(error, ThreadStoreError::Conflict { .. }));
    assert_eq!(
        runtime
            .get_thread_memory_mode(thread_id)
            .await
            .expect("read memory mode after conflict"),
        None
    );

    live_store
        .shutdown_thread(thread_id)
        .await
        .expect("release live writer");
    update_memory_mode(&cold_store, thread_id)
        .await
        .expect("cold metadata writer should retry after live shutdown");
    assert_eq!(
        runtime
            .get_thread_memory_mode(thread_id)
            .await
            .expect("read memory mode after retry"),
        Some("disabled".to_string())
    );

    assert_eq!(
        session_meta_markers(rollout_path.as_path(), thread_id).await,
        vec![
            MetadataMarker {
                memory_mode: None,
                branch: Some("main".to_string()),
            },
            MetadataMarker {
                memory_mode: Some("disabled".to_string()),
                branch: None,
            },
        ]
    );
}

async fn apply_live_metadata_updates(store: &LocalThreadStore, thread_id: ThreadId) {
    update_memory_mode(store, thread_id)
        .await
        .expect("update live memory mode without reacquiring its writer lease");
    let updated = store
        .update_thread_metadata(UpdateThreadMetadataParams {
            thread_id,
            patch: ThreadMetadataPatch {
                git_info: Some(GitInfoPatch {
                    branch: Some(Some("lease-safe".to_string())),
                    ..Default::default()
                }),
                ..Default::default()
            },
            include_archived: false,
        })
        .await
        .expect("update live git info without reacquiring its writer lease");
    assert_eq!(
        updated.git_info.and_then(|git| git.branch),
        Some("lease-safe".to_string())
    );
    store
        .flush_thread(thread_id)
        .await
        .expect("flush ordered live metadata markers");
}

async fn update_memory_mode(
    store: &LocalThreadStore,
    thread_id: ThreadId,
) -> Result<crate::StoredThread, ThreadStoreError> {
    store
        .update_thread_metadata(UpdateThreadMetadataParams {
            thread_id,
            patch: ThreadMetadataPatch {
                memory_mode: Some(ThreadMemoryMode::Disabled),
                ..Default::default()
            },
            include_archived: false,
        })
        .await
}

async fn session_meta_markers(path: &Path, expected_thread_id: ThreadId) -> Vec<MetadataMarker> {
    let (items, thread_id, parse_errors) = RolloutRecorder::load_rollout_items(path)
        .await
        .expect("load flushed rollout items");
    assert_eq!(thread_id, Some(expected_thread_id));
    assert_eq!(parse_errors, 0);
    items
        .into_iter()
        .filter_map(|item| match item {
            RolloutItem::SessionMeta(session_meta) => Some(MetadataMarker {
                memory_mode: session_meta.meta.memory_mode,
                branch: session_meta.git.and_then(|git| git.branch),
            }),
            RolloutItem::ResponseItem(_)
            | RolloutItem::Compacted(_)
            | RolloutItem::TurnContext(_)
            | RolloutItem::EventMsg(_)
            | RolloutItem::UserInputOnceMarker(_) => None,
        })
        .collect()
}

fn create_params(codex_home: &Path, thread_id: ThreadId) -> CreateThreadParams {
    CreateThreadParams {
        thread_id,
        extra_config: None,
        forked_from_id: None,
        parent_thread_id: None,
        source: SessionSource::Exec,
        thread_source: None,
        base_instructions: BaseInstructions::default(),
        dynamic_tools: Vec::new(),
        multi_agent_version: None,
        metadata: thread_metadata(codex_home),
    }
}

fn thread_metadata(codex_home: &Path) -> ThreadPersistenceMetadata {
    ThreadPersistenceMetadata {
        cwd: Some(codex_home.to_path_buf()),
        model_provider: "test-provider".to_string(),
        memory_mode: ThreadMemoryMode::Enabled,
    }
}

fn thread_id(value: u128) -> ThreadId {
    ThreadId::from_string(&uuid::Uuid::from_u128(value).to_string()).expect("valid thread id")
}

#[derive(Debug, PartialEq, Eq)]
struct MetadataMarker {
    memory_mode: Option<String>,
    branch: Option<String>,
}
