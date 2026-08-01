use chrono::DateTime;
use chrono::Utc;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::SessionSource;
use crewon_state::StateRuntime;
use crewon_state::ThreadMetadataBuilder;
use pretty_assertions::assert_eq;

use super::*;
use crate::LocalThreadStoreConfig;
use crate::ThreadStore;
use crate::local::test_support::write_session_file_with;

#[tokio::test]
async fn search_threads_includes_sqlite_preview_without_rollout_match() {
    let home = tempfile::tempdir().expect("temporary thread store");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State");
    let uuid = uuid::Uuid::parse_str("019f550e-ba52-7490-a248-b0d3a84103c1").expect("Thread UUID");
    let thread_id = ThreadId::from_string(&uuid.to_string()).expect("Thread ID");
    let rollout_path = write_session_file_with(
        home.path(),
        home.path().join("sessions/2025/01/03"),
        "2025-01-03T12-00-00",
        uuid,
        "unrelated rollout content",
        Some("test-provider"),
    )
    .expect("write rollout fixture");
    let created_at = DateTime::<Utc>::from_timestamp(100, 0).expect("createdAt");
    let mut builder = ThreadMetadataBuilder::new(
        thread_id,
        rollout_path,
        created_at,
        SessionSource::LegacyCli,
    );
    builder.updated_at = Some(DateTime::<Utc>::from_timestamp(200, 0).expect("updatedAt"));
    builder.cwd = home.path().to_path_buf();
    let mut metadata = builder.build("test-provider");
    metadata.preview = Some("verified cloud result".to_string());
    state
        .upsert_thread(&metadata)
        .await
        .expect("seed Thread metadata");
    let store = LocalThreadStore::new(
        LocalThreadStoreConfig {
            codex_home: home.path().to_path_buf(),
            sqlite_home: home.path().to_path_buf(),
            default_model_provider_id: "test-provider".to_string(),
        },
        Some(state.clone()),
    );

    let page = store
        .search_threads(SearchThreadsParams {
            cursor: None,
            page_size: 10,
            sort_key: ThreadSortKey::UpdatedAt,
            sort_direction: SortDirection::Desc,
            allowed_sources: vec![SessionSource::LegacyCli],
            archived: false,
            search_term: "cloud result".to_string(),
        })
        .await
        .expect("search Thread metadata preview");
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].thread.thread_id, thread_id);
    assert_eq!(page.items[0].thread.preview, "verified cloud result");
    assert_eq!(page.items[0].snippet, "verified cloud result");

    let missing = store
        .search_threads(SearchThreadsParams {
            cursor: None,
            page_size: 10,
            sort_key: ThreadSortKey::UpdatedAt,
            sort_direction: SortDirection::Desc,
            allowed_sources: vec![SessionSource::LegacyCli],
            archived: false,
            search_term: "not present".to_string(),
        })
        .await
        .expect("search missing preview");
    assert!(missing.items.is_empty());
    state.close().await;
}

#[tokio::test]
async fn search_threads_merges_metadata_and_rollout_matches_without_duplicates() {
    let home = tempfile::tempdir().expect("temporary thread store");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State");
    let older_uuid =
        uuid::Uuid::parse_str("019f550e-ba52-7490-a248-b0d3a84103c2").expect("older Thread UUID");
    let newer_uuid =
        uuid::Uuid::parse_str("019f550e-ba52-7490-a248-b0d3a84103c3").expect("newer Thread UUID");
    let older_path = write_session_file_with(
        home.path(),
        home.path().join("sessions/2025/01/03"),
        "2025-01-03T12-00-00",
        older_uuid,
        "needle in durable rollout",
        Some("test-provider"),
    )
    .expect("write older rollout fixture");
    let newer_path = write_session_file_with(
        home.path(),
        home.path().join("sessions/2025/01/03"),
        "2025-01-03T13-00-00",
        newer_uuid,
        "unrelated rollout content",
        Some("test-provider"),
    )
    .expect("write newer rollout fixture");
    let older_thread_id = seed_metadata(
        &state,
        home.path(),
        older_uuid,
        older_path,
        "needle metadata older",
        /*updated_at*/ 100,
    )
    .await;
    let newer_thread_id = seed_metadata(
        &state,
        home.path(),
        newer_uuid,
        newer_path,
        "needle metadata newer",
        /*updated_at*/ 200,
    )
    .await;
    let store = LocalThreadStore::new(
        LocalThreadStoreConfig {
            codex_home: home.path().to_path_buf(),
            sqlite_home: home.path().to_path_buf(),
            default_model_provider_id: "test-provider".to_string(),
        },
        Some(state.clone()),
    );

    let page = store
        .search_threads(SearchThreadsParams {
            cursor: None,
            page_size: 10,
            sort_key: ThreadSortKey::UpdatedAt,
            sort_direction: SortDirection::Desc,
            allowed_sources: vec![SessionSource::LegacyCli],
            archived: false,
            search_term: "needle".to_string(),
        })
        .await
        .expect("merge Thread search sources");

    assert_eq!(page.items.len(), 2);
    assert_eq!(page.items[0].thread.thread_id, newer_thread_id);
    assert_eq!(page.items[1].thread.thread_id, older_thread_id);
    assert_eq!(page.items[0].snippet, "needle metadata newer");
    assert_eq!(page.items[1].snippet, "needle in durable rollout");
    state.close().await;
}

async fn seed_metadata(
    state: &StateRuntime,
    home: &std::path::Path,
    uuid: uuid::Uuid,
    rollout_path: std::path::PathBuf,
    preview: &str,
    updated_at: i64,
) -> ThreadId {
    let thread_id = ThreadId::from_string(&uuid.to_string()).expect("Thread ID");
    let created_at = DateTime::<Utc>::from_timestamp(50, 0).expect("createdAt");
    let mut builder = ThreadMetadataBuilder::new(
        thread_id,
        rollout_path,
        created_at,
        SessionSource::LegacyCli,
    );
    builder.updated_at = Some(DateTime::<Utc>::from_timestamp(updated_at, 0).expect("updatedAt"));
    builder.cwd = home.to_path_buf();
    let mut metadata = builder.build("test-provider");
    metadata.preview = Some(preview.to_string());
    state
        .upsert_thread(&metadata)
        .await
        .expect("seed Thread metadata");
    thread_id
}
