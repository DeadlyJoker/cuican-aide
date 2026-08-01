use chrono::DateTime;
use chrono::Utc;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::SessionSource;
use pretty_assertions::assert_eq;

use super::*;
use crate::CloudAgentTurnCreateOutcome;
use crate::MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES;
use crate::runtime::cloud_agent_turn_tests::initialized;
use crate::runtime::cloud_agent_turn_tests::runtime_bundle;
use crate::runtime::cloud_agent_turn_tests::seed_authority;
use crate::runtime::cloud_agent_turn_tests::seed_prompt_artifact;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn summary_sync_is_bounded_cas_bound_idempotent_and_restart_durable() {
    let codex_home = unique_temp_dir();
    let state = initialized(&codex_home).await;
    let (context, binding) = seed_authority(&state).await;
    seed_prompt_artifact(&state).await;
    let bundle = runtime_bundle(&context, &binding);
    let thread_id = ThreadId::from_string(&bundle.turn.thread_id).expect("Thread ID");
    let mut builder = crate::ThreadMetadataBuilder::new(
        thread_id,
        codex_home.join("sessions/cloud-agent.jsonl"),
        DateTime::<Utc>::from_timestamp(90, 0).expect("createdAt"),
        SessionSource::Mcp,
    );
    builder.updated_at = Some(DateTime::<Utc>::from_timestamp(90, 0).expect("updatedAt"));
    let mut metadata = builder.build("test-provider");
    metadata.preview = Some("stale preview".to_string());
    state
        .upsert_thread(&metadata)
        .await
        .expect("seed Thread metadata");
    assert_eq!(
        state
            .create_cloud_agent_turn_bundle(&bundle, /*authorized_at*/ 100)
            .await
            .expect("create Cloud Agent Turn"),
        CloudAgentTurnCreateOutcome::Created(bundle.turn.clone())
    );

    let page = state
        .list_cloud_agent_thread_summary_sync_candidates(/*limit*/ 1)
        .await
        .expect("list pending summary");
    assert_eq!(page.data.len(), 1);
    assert!(!page.has_more);
    let candidate = &page.data[0];
    assert_eq!(candidate.thread_id, bundle.turn.thread_id);
    assert_eq!(candidate.last_turn_id, bundle.turn.turn_id);
    assert_eq!(candidate.projection_revision, 1);
    assert_eq!(candidate.metadata_sync_revision, 0);
    assert!(
        state
            .is_cloud_agent_thread_summary_managed(thread_id)
            .await
            .expect("detect Cloud Agent summary")
    );
    assert!(
        state
            .has_cloud_agent_thread_summaries()
            .await
            .expect("detect Cloud Agent summaries")
    );
    sqlx::query("UPDATE threads SET preview = '' WHERE id = ?")
        .bind(thread_id.to_string())
        .execute(state.pool.as_ref())
        .await
        .expect("clear preview for ownership check");
    assert!(
        !state
            .set_thread_preview_if_empty(thread_id, "core preview")
            .await
            .expect("guard Cloud-owned preview")
    );
    assert!(
        !state
            .touch_thread_updated_at(
                thread_id,
                DateTime::<Utc>::from_timestamp(999, 0).expect("updatedAt"),
            )
            .await
            .expect("guard Cloud-owned updatedAt")
    );

    let request = CloudAgentThreadSummarySyncRequest {
        thread_id: candidate.thread_id.clone(),
        last_turn_id: candidate.last_turn_id.clone(),
        expected_projection_revision: candidate.projection_revision,
        preview: "durable preview".to_string(),
        expected_updated_at: candidate.updated_at,
    };
    assert_eq!(
        state
            .mark_cloud_agent_thread_summary_synced(&request)
            .await
            .expect("mark summary synced"),
        CloudAgentThreadSummarySyncOutcome::Applied
    );
    assert_eq!(
        state
            .mark_cloud_agent_thread_summary_synced(&request)
            .await
            .expect("repeat summary sync"),
        CloudAgentThreadSummarySyncOutcome::ExistingSame
    );

    sqlx::query(
        "UPDATE cloud_agent_thread_summaries SET projection_revision = 2, updated_at = 101 WHERE thread_id = ?",
    )
    .bind(&bundle.turn.thread_id)
    .execute(state.pool.as_ref())
    .await
    .expect("advance summary projection");
    assert_eq!(
        state
            .mark_cloud_agent_thread_summary_synced(&request)
            .await
            .expect("reject stale summary sync"),
        CloudAgentThreadSummarySyncOutcome::Stale
    );

    let next = state
        .list_cloud_agent_thread_summary_sync_candidates(/*limit*/ 1)
        .await
        .expect("list advanced summary")
        .data
        .into_iter()
        .next()
        .expect("advanced summary");
    assert_eq!(next.projection_revision, 2);
    assert_eq!(next.metadata_sync_revision, 1);
    assert_eq!(next.preview.as_deref(), Some("durable preview"));
    let next_request = CloudAgentThreadSummarySyncRequest {
        expected_projection_revision: next.projection_revision,
        preview: "new durable preview".to_string(),
        expected_updated_at: next.updated_at,
        ..request
    };
    assert_eq!(
        state
            .mark_cloud_agent_thread_summary_synced(&next_request)
            .await
            .expect("sync advanced summary"),
        CloudAgentThreadSummarySyncOutcome::Applied
    );
    assert!(
        state
            .list_cloud_agent_thread_summary_sync_candidates(/*limit*/ 1)
            .await
            .expect("list synchronized summaries")
            .data
            .is_empty()
    );
    let synced_metadata = state
        .get_thread(thread_id)
        .await
        .expect("read synced Thread metadata")
        .expect("Thread metadata exists");
    assert_eq!(
        synced_metadata.preview.as_deref(),
        Some("new durable preview")
    );
    assert!(synced_metadata.updated_at.timestamp() >= 101);
    let mut stale_rollout_metadata = synced_metadata.clone();
    stale_rollout_metadata.preview = Some("stale rollout preview".to_string());
    stale_rollout_metadata.updated_at =
        DateTime::<Utc>::from_timestamp(50, 0).expect("stale updatedAt");
    stale_rollout_metadata.title = "updated user title".to_string();
    state
        .upsert_thread(&stale_rollout_metadata)
        .await
        .expect("reconcile stale rollout metadata");
    let preserved_metadata = state
        .get_thread(thread_id)
        .await
        .expect("read preserved Thread metadata")
        .expect("Thread metadata exists");
    assert_eq!(
        preserved_metadata.preview.as_deref(),
        Some("new durable preview")
    );
    assert_eq!(preserved_metadata.updated_at, synced_metadata.updated_at);
    assert_eq!(preserved_metadata.title, "updated user title");
    assert!(
        state
            .list_cloud_agent_thread_summary_sync_candidates(/*limit*/ 0)
            .await
            .is_err()
    );
    let oversized = CloudAgentThreadSummarySyncRequest {
        preview: "x".repeat(MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES + 1),
        ..next_request
    };
    assert!(
        state
            .mark_cloud_agent_thread_summary_synced(&oversized)
            .await
            .is_err()
    );

    state.close().await;
    let reopened = initialized(&codex_home).await;
    assert!(
        reopened
            .list_cloud_agent_thread_summary_sync_candidates(/*limit*/ 1)
            .await
            .expect("list summaries after restart")
            .data
            .is_empty()
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}
