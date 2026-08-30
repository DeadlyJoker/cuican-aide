use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use chrono::Utc;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::RolloutLine;
use crewon_protocol::protocol::SessionSource;
use crewon_protocol::protocol::ThreadMemoryMode;
use crewon_protocol::protocol::UserInputOnceMarker;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use uuid::Uuid;

use super::LocalThreadStore;
use super::test_support::test_config;
use super::test_support::write_archived_session_file;
use super::test_support::write_session_file;
use crate::ArchiveThreadParams;
use crate::DeleteThreadParams;
use crate::ListThreadsParams;
use crate::ReadThreadParams;
use crate::ResumeThreadParams;
use crate::SortDirection;
use crate::ThreadMetadataPatch;
use crate::ThreadPersistenceMetadata;
use crate::ThreadSortKey;
use crate::ThreadStore;
use crate::ThreadStoreError;
use crate::UpdateThreadMetadataParams;

#[derive(Clone, Copy, Debug)]
enum FenceFixture {
    Marker,
    Malformed,
}

#[tokio::test]
async fn read_and_list_remain_available_for_fenced_rollouts() {
    for fixture in [FenceFixture::Marker, FenceFixture::Malformed] {
        let home = TempDir::new().expect("temp dir");
        let uuid = Uuid::from_u128(4101);
        let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
        let rollout_path =
            write_session_file(home.path(), "2025-01-03T12-00-00", uuid).expect("session file");
        apply_fence_fixture(rollout_path.as_path(), thread_id, fixture);
        let (store, _state_db) = seeded_store(home.path(), rollout_path, thread_id, false).await;

        let thread = store
            .read_thread(ReadThreadParams {
                thread_id,
                include_archived: false,
                include_history: false,
            })
            .await
            .expect("fenced rollout metadata remains readable");
        assert_eq!(thread.thread_id, thread_id);

        let page = store
            .list_threads(list_params(/*archived*/ false))
            .await
            .expect("fenced rollout remains listable from SQLite");
        assert_eq!(
            page.items
                .into_iter()
                .map(|thread| thread.thread_id)
                .collect::<Vec<_>>(),
            vec![thread_id]
        );
    }
}

#[tokio::test]
async fn resume_rejects_fenced_rollouts_without_changing_bytes() {
    for fixture in [FenceFixture::Marker, FenceFixture::Malformed] {
        let home = TempDir::new().expect("temp dir");
        let uuid = Uuid::from_u128(4102);
        let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
        let rollout_path =
            write_session_file(home.path(), "2025-01-03T12-30-00", uuid).expect("session file");
        apply_fence_fixture(rollout_path.as_path(), thread_id, fixture);
        let before = fs::read(rollout_path.as_path()).expect("rollout bytes");
        let store = LocalThreadStore::new(test_config(home.path()), /*state_db*/ None);

        let error = store
            .resume_thread(resume_params(home.path(), thread_id, rollout_path.clone()))
            .await
            .expect_err("legacy fence must reject resume");
        assert_path_free_conflict(error, home.path());
        assert_eq!(
            fs::read(rollout_path.as_path()).expect("rollout bytes after rejection"),
            before
        );
    }
}

#[tokio::test]
async fn sqlite_only_metadata_rejects_fenced_rollouts_without_db_or_index_changes() {
    for fixture in [FenceFixture::Marker, FenceFixture::Malformed] {
        let home = TempDir::new().expect("temp dir");
        let uuid = Uuid::from_u128(4103);
        let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
        let rollout_path =
            write_session_file(home.path(), "2025-01-03T13-00-00", uuid).expect("session file");
        apply_fence_fixture(rollout_path.as_path(), thread_id, fixture);
        let before_bytes = fs::read(rollout_path.as_path()).expect("rollout bytes");
        let (store, state_db) =
            seeded_store(home.path(), rollout_path.clone(), thread_id, false).await;
        crewon_rollout::append_thread_name(home.path(), thread_id, "before-name")
            .await
            .expect("seed name index");
        let before_metadata = state_db
            .get_thread(thread_id)
            .await
            .expect("read metadata")
            .expect("seeded metadata");

        let error = store
            .update_thread_metadata(UpdateThreadMetadataParams {
                thread_id,
                patch: ThreadMetadataPatch {
                    preview: Some("after-preview".to_string()),
                    ..Default::default()
                },
                include_archived: false,
            })
            .await
            .expect_err("legacy fence must reject SQLite-only metadata");
        assert_path_free_conflict(error, home.path());

        let after_metadata = state_db
            .get_thread(thread_id)
            .await
            .expect("read metadata after rejection")
            .expect("metadata remains present");
        assert_eq!(after_metadata, before_metadata);
        assert_eq!(
            crewon_rollout::find_thread_name_by_id(home.path(), &thread_id)
                .await
                .expect("read name index")
                .as_deref(),
            Some("before-name")
        );
        assert_eq!(
            fs::read(rollout_path.as_path()).expect("rollout bytes after rejection"),
            before_bytes
        );
    }
}

#[tokio::test]
async fn name_metadata_rejects_fenced_rollouts_without_db_or_index_changes() {
    for fixture in [FenceFixture::Marker, FenceFixture::Malformed] {
        let home = TempDir::new().expect("temp dir");
        let uuid = Uuid::from_u128(4104);
        let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
        let rollout_path =
            write_session_file(home.path(), "2025-01-03T13-30-00", uuid).expect("session file");
        apply_fence_fixture(rollout_path.as_path(), thread_id, fixture);
        let before_bytes = fs::read(rollout_path.as_path()).expect("rollout bytes");
        let (store, state_db) =
            seeded_store(home.path(), rollout_path.clone(), thread_id, false).await;
        crewon_rollout::append_thread_name(home.path(), thread_id, "before-name")
            .await
            .expect("seed name index");
        let before_metadata = state_db
            .get_thread(thread_id)
            .await
            .expect("read metadata")
            .expect("seeded metadata");

        let error = store
            .update_thread_metadata(UpdateThreadMetadataParams {
                thread_id,
                patch: ThreadMetadataPatch {
                    name: Some(Some("after-name".to_string())),
                    ..Default::default()
                },
                include_archived: false,
            })
            .await
            .expect_err("legacy fence must reject indexed metadata");
        assert_path_free_conflict(error, home.path());

        assert_eq!(
            state_db
                .get_thread(thread_id)
                .await
                .expect("read metadata after rejection")
                .expect("metadata remains present"),
            before_metadata
        );
        assert_eq!(
            crewon_rollout::find_thread_name_by_id(home.path(), &thread_id)
                .await
                .expect("read name index")
                .as_deref(),
            Some("before-name")
        );
        assert_eq!(
            fs::read(rollout_path.as_path()).expect("rollout bytes after rejection"),
            before_bytes
        );
    }
}

#[tokio::test]
async fn archive_and_unarchive_reject_fenced_rollouts_without_file_or_db_changes() {
    for fixture in [FenceFixture::Marker, FenceFixture::Malformed] {
        let active_home = TempDir::new().expect("active temp dir");
        let active_uuid = Uuid::from_u128(4105);
        let active_thread_id =
            ThreadId::from_string(&active_uuid.to_string()).expect("valid thread id");
        let active_path =
            write_session_file(active_home.path(), "2025-01-03T14-00-00", active_uuid)
                .expect("active session file");
        apply_fence_fixture(active_path.as_path(), active_thread_id, fixture);
        let active_bytes = fs::read(active_path.as_path()).expect("active bytes");
        let (active_store, active_state_db) = seeded_store(
            active_home.path(),
            active_path.clone(),
            active_thread_id,
            false,
        )
        .await;
        let active_metadata = active_state_db
            .get_thread(active_thread_id)
            .await
            .expect("read active metadata")
            .expect("active metadata");

        let error = active_store
            .archive_thread(ArchiveThreadParams {
                thread_id: active_thread_id,
            })
            .await
            .expect_err("legacy fence must reject archive");
        assert_path_free_conflict(error, active_home.path());
        assert_eq!(
            fs::read(active_path.as_path()).expect("active bytes after rejection"),
            active_bytes
        );
        assert_eq!(
            active_state_db
                .get_thread(active_thread_id)
                .await
                .expect("read active metadata after rejection")
                .expect("active metadata remains"),
            active_metadata
        );

        let archived_home = TempDir::new().expect("archived temp dir");
        let archived_uuid = Uuid::from_u128(4106);
        let archived_thread_id =
            ThreadId::from_string(&archived_uuid.to_string()).expect("valid thread id");
        let archived_path =
            write_archived_session_file(archived_home.path(), "2025-01-03T14-30-00", archived_uuid)
                .expect("archived session file");
        apply_fence_fixture(archived_path.as_path(), archived_thread_id, fixture);
        let archived_bytes = fs::read(archived_path.as_path()).expect("archived bytes");
        let (archived_store, archived_state_db) = seeded_store(
            archived_home.path(),
            archived_path.clone(),
            archived_thread_id,
            true,
        )
        .await;
        let archived_metadata = archived_state_db
            .get_thread(archived_thread_id)
            .await
            .expect("read archived metadata")
            .expect("archived metadata");

        let error = archived_store
            .unarchive_thread(ArchiveThreadParams {
                thread_id: archived_thread_id,
            })
            .await
            .expect_err("legacy fence must reject unarchive");
        assert_path_free_conflict(error, archived_home.path());
        assert_eq!(
            fs::read(archived_path.as_path()).expect("archived bytes after rejection"),
            archived_bytes
        );
        assert_eq!(
            archived_state_db
                .get_thread(archived_thread_id)
                .await
                .expect("read archived metadata after rejection")
                .expect("archived metadata remains"),
            archived_metadata
        );
    }
}

#[tokio::test]
async fn delete_preflights_all_candidates_before_removing_any_file_or_index() {
    for fixture in [FenceFixture::Marker, FenceFixture::Malformed] {
        let home = TempDir::new().expect("temp dir");
        let uuid = Uuid::from_u128(4107);
        let thread_id = ThreadId::from_string(&uuid.to_string()).expect("valid thread id");
        let active_path = write_session_file(home.path(), "2025-01-03T15-00-00", uuid)
            .expect("active session file");
        let archived_path = write_archived_session_file(home.path(), "2025-01-03T15-30-00", uuid)
            .expect("archived session file");
        apply_fence_fixture(archived_path.as_path(), thread_id, fixture);
        let active_bytes = fs::read(active_path.as_path()).expect("active bytes");
        let archived_bytes = fs::read(archived_path.as_path()).expect("archived bytes");
        let (store, state_db) =
            seeded_store(home.path(), active_path.clone(), thread_id, false).await;
        crewon_rollout::append_thread_name(home.path(), thread_id, "kept-name")
            .await
            .expect("seed name index");
        let before_metadata = state_db
            .get_thread(thread_id)
            .await
            .expect("read metadata")
            .expect("seeded metadata");

        let error = store
            .delete_thread(DeleteThreadParams { thread_id })
            .await
            .expect_err("one fenced candidate must reject the complete delete");
        assert_path_free_conflict(error, home.path());
        assert_eq!(
            fs::read(active_path.as_path()).expect("active bytes after rejection"),
            active_bytes
        );
        assert_eq!(
            fs::read(archived_path.as_path()).expect("archived bytes after rejection"),
            archived_bytes
        );
        assert_eq!(
            crewon_rollout::find_thread_name_by_id(home.path(), &thread_id)
                .await
                .expect("read name index")
                .as_deref(),
            Some("kept-name")
        );
        assert_eq!(
            state_db
                .get_thread(thread_id)
                .await
                .expect("read metadata after rejection")
                .expect("metadata remains present"),
            before_metadata
        );
    }
}

async fn seeded_store(
    home: &Path,
    rollout_path: PathBuf,
    thread_id: ThreadId,
    archived: bool,
) -> (LocalThreadStore, crewon_rollout::StateDbHandle) {
    let config = test_config(home);
    let state_db = crewon_state::StateRuntime::init(
        config.sqlite_home.clone(),
        config.default_model_provider_id.clone(),
    )
    .await
    .expect("state db should initialize");
    state_db
        .mark_backfill_complete(/*last_watermark*/ None)
        .await
        .expect("backfill should be complete");
    let mut builder = crewon_state::ThreadMetadataBuilder::new(
        thread_id,
        rollout_path,
        Utc::now(),
        SessionSource::LegacyCli,
    );
    builder.model_provider = Some(config.default_model_provider_id.clone());
    builder.cwd = home.to_path_buf();
    builder.cli_version = Some("legacy-fence-test".to_string());
    let mut metadata = builder.build(config.default_model_provider_id.as_str());
    metadata.title = "before-title".to_string();
    metadata.preview = Some("before-preview".to_string());
    if archived {
        metadata.archived_at = Some(metadata.updated_at);
    }
    state_db
        .upsert_thread(&metadata)
        .await
        .expect("seed thread metadata");
    (
        LocalThreadStore::new(config, Some(state_db.clone())),
        state_db,
    )
}

fn apply_fence_fixture(path: &Path, thread_id: ThreadId, fixture: FenceFixture) {
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open rollout fixture");
    match fixture {
        FenceFixture::Marker => {
            let line = RolloutLine {
                timestamp: "2026-07-26T00:00:00Z".to_string(),
                item: RolloutItem::UserInputOnceMarker(UserInputOnceMarker {
                    version: 1,
                    phase: UserInputOnceMarkerPhase::Admission,
                    thread_id,
                    client_id: "thread-store-legacy-fence-test".to_string(),
                    payload_hash: "hash".to_string(),
                    turn_id: "turn".to_string(),
                }),
            };
            writeln!(
                file,
                "{}",
                serde_json::to_string(&line).expect("serialize marker")
            )
            .expect("append marker");
        }
        FenceFixture::Malformed => {
            writeln!(file, "{{not-json}}").expect("append malformed line");
        }
    }
}

fn assert_path_free_conflict(error: ThreadStoreError, home: &Path) {
    let ThreadStoreError::Conflict { message } = error else {
        panic!("expected thread-store conflict, got {error}");
    };
    assert!(
        message.contains("legacy fence rejected"),
        "unexpected conflict: {message}"
    );
    assert!(
        !message.contains(home.to_string_lossy().as_ref()),
        "legacy fence conflict must not disclose paths: {message}"
    );
}

fn resume_params(cwd: &Path, thread_id: ThreadId, rollout_path: PathBuf) -> ResumeThreadParams {
    ResumeThreadParams {
        thread_id,
        rollout_path: Some(rollout_path),
        history: None,
        include_archived: true,
        metadata: ThreadPersistenceMetadata {
            cwd: Some(cwd.to_path_buf()),
            model_provider: "test-provider".to_string(),
            memory_mode: ThreadMemoryMode::Enabled,
        },
    }
}

fn list_params(archived: bool) -> ListThreadsParams {
    ListThreadsParams {
        page_size: 10,
        cursor: None,
        sort_key: ThreadSortKey::CreatedAt,
        sort_direction: SortDirection::Desc,
        allowed_sources: Vec::new(),
        model_providers: None,
        cwd_filters: None,
        archived,
        search_term: None,
        use_state_db_only: true,
    }
}
