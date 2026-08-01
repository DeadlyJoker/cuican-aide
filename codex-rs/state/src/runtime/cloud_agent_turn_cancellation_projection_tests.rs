use pretty_assertions::assert_eq;

use super::cloud_agent_turn_tests::initialized;
use super::cloud_agent_turn_tests::runtime_bundle;
use super::cloud_agent_turn_tests::seed_authority;
use super::cloud_agent_turn_tests::seed_prompt_artifact;
use crate::CloudAgentTurnCancellationCandidate;
use crate::CloudAgentTurnCancellationProjectionRequest;
use crate::CloudAgentTurnCreateOutcome;
use crate::CloudAgentTurnProjectionOutcome;
use crate::CloudAgentTurnStatus;
use crate::StateRuntime;
use crate::TaskCommitFencingRecord;
use crate::TaskEventProducerRecord;
use crate::TaskStateCommitOutcome;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn cancelled_task_projects_turn_and_summary_exactly_once_across_restart() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let turn = create_queued_turn(&runtime).await;
    commit_queued_cancellation(&runtime).await;

    assert_eq!(
        runtime
            .list_cloud_agent_turn_cancellation_candidates(/*limit*/ 16)
            .await
            .expect("list cancellation candidates"),
        vec![CloudAgentTurnCancellationCandidate {
            turn_id: turn.turn_id.clone(),
            task_id: "task-1".to_string(),
        }]
    );
    let request = CloudAgentTurnCancellationProjectionRequest {
        turn_id: turn.turn_id.clone(),
        task_id: "task-1".to_string(),
        projected_at: 120,
    };
    assert_eq!(
        runtime
            .project_cloud_agent_turn_cancellation(&request)
            .await
            .expect("project cancelled Turn"),
        CloudAgentTurnProjectionOutcome::Applied
    );
    let cancelled = runtime
        .get_cloud_agent_turn_record(&turn.turn_id)
        .await
        .expect("read cancelled Turn")
        .expect("cancelled Turn exists");
    assert_eq!(cancelled.status, CloudAgentTurnStatus::Cancelled);
    assert_eq!(cancelled.revision, 2);
    assert_eq!(cancelled.updated_at, 120);
    assert_eq!(cancelled.completed_at, Some(120));
    assert_eq!(cancelled.error_code, None);
    assert_eq!(cancelled.last_provider_sequence, 0);
    assert_eq!(
        read_summary(&runtime, &turn.thread_id).await,
        (turn.turn_id.clone(), 2, 120)
    );
    assert_eq!(
        runtime
            .project_cloud_agent_turn_cancellation(&request)
            .await
            .expect("repeat cancelled Turn projection"),
        CloudAgentTurnProjectionOutcome::Duplicate
    );

    runtime.close().await;
    let restarted = StateRuntime::init(codex_home.clone(), "test-provider".to_string())
        .await
        .expect("restart State");
    assert_eq!(
        restarted
            .list_cloud_agent_turn_cancellation_candidates(/*limit*/ 16)
            .await
            .expect("list cancellation candidates after restart"),
        Vec::new()
    );
    assert_eq!(
        restarted
            .get_cloud_agent_turn_record(&turn.turn_id)
            .await
            .expect("read restarted Turn")
            .expect("restarted Turn exists"),
        cancelled
    );
    restarted.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn cancellation_projection_rejects_non_cancelled_or_mismatched_task_authority() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let turn = create_queued_turn(&runtime).await;

    assert_eq!(
        runtime
            .project_cloud_agent_turn_cancellation(&CloudAgentTurnCancellationProjectionRequest {
                turn_id: turn.turn_id.clone(),
                task_id: "task-1".to_string(),
                projected_at: 120,
            })
            .await
            .expect("reject non-cancelled Task"),
        CloudAgentTurnProjectionOutcome::Conflict
    );
    assert_eq!(
        runtime
            .project_cloud_agent_turn_cancellation(&CloudAgentTurnCancellationProjectionRequest {
                turn_id: turn.turn_id.clone(),
                task_id: "task-other".to_string(),
                projected_at: 120,
            })
            .await
            .expect("reject mismatched Task"),
        CloudAgentTurnProjectionOutcome::Conflict
    );
    assert_eq!(
        runtime
            .get_cloud_agent_turn_record(&turn.turn_id)
            .await
            .expect("read unchanged Turn")
            .expect("Turn exists")
            .status,
        CloudAgentTurnStatus::Queued
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn create_queued_turn(runtime: &StateRuntime) -> crate::CloudAgentTurnRecord {
    let (context, binding) = seed_authority(runtime).await;
    seed_prompt_artifact(runtime).await;
    let bundle = runtime_bundle(&context, &binding);
    assert_eq!(
        runtime
            .create_cloud_agent_turn_bundle(&bundle, /*authorized_at*/ 100)
            .await
            .expect("create queued Turn"),
        CloudAgentTurnCreateOutcome::Created(bundle.turn.clone())
    );
    bundle.turn
}

async fn commit_queued_cancellation(runtime: &StateRuntime) {
    let task = runtime
        .get_task_record("task-1")
        .await
        .expect("read queued Task")
        .expect("queued Task exists");
    assert_eq!(task.status, "queued");
    let snapshot_json = r#"{"status":"cancelled"}"#.to_string();
    let mut bundle = crate::cloud_agent_turn_records_tests::create_bundle();
    let commit = &mut bundle.accepted_commit;
    commit.expected_version = 1;
    commit.snapshot.status = "cancelled".to_string();
    commit.snapshot.snapshot_json.clone_from(&snapshot_json);
    commit.snapshot.aggregate_version = 2;
    commit.snapshot.stream_offset = 2;
    commit.snapshot.lease = None;
    commit.snapshot.updated_at = 110;
    let attempt = commit.attempt.as_mut().expect("accepted Attempt");
    attempt.status = "cancelled".to_string();
    attempt.lease = None;
    attempt.attempt_json = r#"{"status":"cancelled"}"#.to_string();
    attempt.updated_at = 110;
    commit.event.stream_offset = 2;
    commit.event.event_id = "event-cancelled-1".to_string();
    commit.event.event_type = "taskCancelled".to_string();
    commit.event.event_json = r#"{"type":"taskCancelled"}"#.to_string();
    commit.event.producer = TaskEventProducerRecord::Authority;
    commit.event.occurred_at = 110;
    commit.event.received_at = 110;
    commit.inbox.receipt_id = "command-cancel-1".to_string();
    commit.inbox.result_aggregate_version = 2;
    commit.inbox.result_stream_offset = 2;
    commit.inbox.result_snapshot_json = snapshot_json;
    commit.inbox.created_at = 110;
    commit.outbox.clear();
    commit.fencing = TaskCommitFencingRecord::Authority;
    assert!(matches!(
        runtime
            .commit_task_record(commit)
            .await
            .expect("commit queued Task cancellation"),
        TaskStateCommitOutcome::Committed(_)
    ));
}

async fn read_summary(runtime: &StateRuntime, thread_id: &str) -> (String, i64, i64) {
    sqlx::query_as::<_, (String, i64, i64)>(
        r#"
SELECT last_turn_id, projection_revision, updated_at
FROM cloud_agent_thread_summaries
WHERE thread_id = ?
        "#,
    )
    .bind(thread_id)
    .fetch_one(runtime.pool.as_ref())
    .await
    .expect("read Cloud Agent Thread summary")
}
