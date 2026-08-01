use chrono::DateTime;
use chrono::Utc;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::SessionSource;
use crewon_state::ThreadMetadataBuilder;
use crewon_thread_store::ListThreadsParams;
use crewon_thread_store::LocalThreadStore;
use crewon_thread_store::LocalThreadStoreConfig;
use crewon_thread_store::ReadThreadParams;
use crewon_thread_store::SortDirection;
use crewon_thread_store::ThreadSortKey;
use crewon_thread_store::ThreadStore;
use pretty_assertions::assert_eq;

use super::*;
use crate::task_control::cloud_agent_turn_coordinator::tests::fixture;
use crate::task_control::cloud_agent_turn_coordinator::tests::start;
use crate::task_control::cloud_agent_turn_projector::tests::completed_turn_harness;

#[tokio::test]
async fn queued_turn_syncs_prompt_preview_and_thread_updated_at() {
    let fixture = fixture().await;
    let started = start(
        &fixture.state,
        &fixture.identity,
        "metadata-message-1",
        "  Explain\n the durable result  ",
        /*now*/ 150,
    )
    .await
    .expect("start Cloud Agent Turn");
    let cloud_rollout_path =
        seed_thread_metadata(&fixture, &started.turn.thread_id, /*updated_at*/ 100).await;
    set_modified_at(&cloud_rollout_path, /*seconds*/ 100);
    let store = thread_store(&fixture);
    let report = CloudAgentThreadMetadataProjector::new(fixture.state.clone(), store.clone())
        .ensure_synced()
        .await
        .expect("sync Cloud Agent summary");
    assert_eq!(
        report,
        CloudAgentThreadMetadataProjectionReport {
            inspected: 1,
            applied: 1,
            ..CloudAgentThreadMetadataProjectionReport::default()
        }
    );
    let stored = read_thread(&store, &started.turn.thread_id).await;
    assert_eq!(stored.preview, "Explain the durable result");
    assert!(stored.updated_at.timestamp() >= 150);
    let local_thread_id = "019f550e-ba52-7490-a248-b0d3a84103c4";
    let local_rollout_path =
        seed_thread_metadata(&fixture, local_thread_id, /*updated_at*/ 50).await;
    set_modified_at(&local_rollout_path, /*seconds*/ 200);
    let local_thread_id_value = ThreadId::from_string(local_thread_id).expect("local Thread ID");
    let cloud_metadata = fixture
        .state
        .get_thread(ThreadId::from_string(&started.turn.thread_id).expect("Cloud Thread ID"))
        .await
        .expect("read Cloud Thread metadata")
        .expect("Cloud Thread metadata exists");
    let local_metadata = fixture
        .state
        .get_thread(local_thread_id_value)
        .await
        .expect("read local Thread metadata")
        .expect("local Thread metadata exists");
    assert!(cloud_metadata.updated_at > local_metadata.updated_at);
    assert!(
        fixture
            .state
            .is_cloud_agent_thread_summary_managed(cloud_metadata.id)
            .await
            .expect("detect governed Thread in list page")
    );
    let list_params = ListThreadsParams {
        page_size: 10,
        cursor: None,
        sort_key: ThreadSortKey::UpdatedAt,
        sort_direction: SortDirection::Desc,
        allowed_sources: vec![SessionSource::Mcp],
        model_providers: None,
        cwd_filters: None,
        archived: false,
        search_term: None,
        use_state_db_only: false,
    };
    store
        .list_threads(list_params.clone())
        .await
        .expect_err("Cloud Thread list must fail closed before index backfill is complete");
    fixture
        .state
        .mark_backfill_complete(/*last_watermark*/ None)
        .await
        .expect("mark Thread index backfill complete");
    let listed = store
        .list_threads(list_params)
        .await
        .expect("list Cloud Agent Thread through normal ThreadStore path");
    assert_eq!(listed.items.len(), 2);
    assert_eq!(
        listed.items[0].thread_id.to_string(),
        started.turn.thread_id
    );
    assert_eq!(listed.items[0].preview, "Explain the durable result");
    assert!(
        fixture
            .state
            .list_cloud_agent_thread_summary_sync_candidates(/*limit*/ 1)
            .await
            .expect("list pending summary")
            .data
            .is_empty()
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn restart_recovers_pending_summary_atomically_without_timestamp_drift() {
    let harness = completed_turn_harness().await;
    let _ = seed_thread_metadata(
        &harness.fixture,
        &harness.turn.thread_id,
        /*updated_at*/ 100,
    )
    .await;
    let store = thread_store(&harness.fixture);
    let before_restart = read_thread(&store, &harness.turn.thread_id).await;
    assert_eq!(before_restart.preview, "stale preview");
    drop(store);
    harness.fixture.state.close().await;

    let restarted = crewon_state::StateRuntime::init(
        harness.fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let store: std::sync::Arc<dyn ThreadStore> = std::sync::Arc::new(LocalThreadStore::new(
        local_store_config(harness.fixture.home.path()),
        Some(restarted.clone()),
    ));
    let report = CloudAgentThreadMetadataProjector::new(restarted.clone(), store.clone())
        .ensure_synced()
        .await
        .expect("recover summary acknowledgement");
    assert_eq!(report.inspected, 1);
    assert_eq!(report.applied, 1);
    let recovered = read_thread(&store, &harness.turn.thread_id).await;
    assert_eq!(recovered.preview, "verified cloud agent result");
    assert!(recovered.updated_at >= before_restart.updated_at);
    assert!(
        restarted
            .list_cloud_agent_thread_summary_sync_candidates(/*limit*/ 1)
            .await
            .expect("list pending summaries after recovery")
            .data
            .is_empty()
    );
    restarted.close().await;
}

async fn seed_thread_metadata(
    fixture: &crate::task_control::cloud_agent_turn_coordinator::tests::Fixture,
    thread_id: &str,
    updated_at: i64,
) -> std::path::PathBuf {
    let thread_id = ThreadId::from_string(thread_id).expect("Thread ID");
    let created_at = DateTime::<Utc>::from_timestamp(100, 0).expect("createdAt");
    let rollout_dir = fixture.home.path().join("sessions/2025/01/03");
    std::fs::create_dir_all(&rollout_dir).expect("create rollout directory");
    let rollout_path = rollout_dir.join(format!("rollout-2025-01-03T12-00-00-{thread_id}.jsonl"));
    let session_meta = serde_json::json!({
        "timestamp": "2025-01-03T12:00:00Z",
        "type": "session_meta",
        "payload": {
            "id": thread_id.to_string(),
            "timestamp": "2025-01-03T12:00:00Z",
            "cwd": fixture.home.path(),
            "originator": "test_originator",
            "cli_version": "test",
            "source": "mcp",
            "model_provider": "test-provider"
        }
    });
    let user_event = serde_json::json!({
        "timestamp": "2025-01-03T12:00:00Z",
        "type": "event_msg",
        "payload": {
            "type": "user_message",
            "message": "stale rollout preview",
            "kind": "plain"
        }
    });
    std::fs::write(&rollout_path, format!("{session_meta}\n{user_event}\n"))
        .expect("write rollout fixture");
    let mut builder = ThreadMetadataBuilder::new(
        thread_id,
        rollout_path.clone(),
        created_at,
        SessionSource::Mcp,
    );
    builder.updated_at =
        Some(DateTime::<Utc>::from_timestamp(updated_at, 0).expect("thread updatedAt"));
    builder.cwd = fixture.home.path().to_path_buf();
    builder.cli_version = Some("test".to_string());
    let mut metadata = builder.build("test-provider");
    metadata.preview = Some("stale preview".to_string());
    fixture
        .state
        .upsert_thread(&metadata)
        .await
        .expect("seed ThreadStore metadata");
    rollout_path
}

fn set_modified_at(path: &std::path::Path, seconds: u64) {
    let modified = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("open rollout fixture")
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .expect("set rollout fixture modifiedAt");
}

fn thread_store(
    fixture: &crate::task_control::cloud_agent_turn_coordinator::tests::Fixture,
) -> std::sync::Arc<dyn ThreadStore> {
    std::sync::Arc::new(LocalThreadStore::new(
        local_store_config(fixture.home.path()),
        Some(fixture.state.clone()),
    ))
}

fn local_store_config(home: &std::path::Path) -> LocalThreadStoreConfig {
    LocalThreadStoreConfig {
        codex_home: home.to_path_buf(),
        sqlite_home: home.to_path_buf(),
        default_model_provider_id: "test-provider".to_string(),
    }
}

async fn read_thread(
    store: &std::sync::Arc<dyn ThreadStore>,
    thread_id: &str,
) -> crewon_thread_store::StoredThread {
    store
        .read_thread(ReadThreadParams {
            thread_id: ThreadId::from_string(thread_id).expect("Thread ID"),
            include_archived: true,
            include_history: false,
        })
        .await
        .expect("read ThreadStore metadata")
}
