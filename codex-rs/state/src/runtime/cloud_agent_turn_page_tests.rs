use pretty_assertions::assert_eq;

use super::*;
use crate::CloudAgentTurnCreateOutcome;
use crate::CloudAgentTurnPageAnchor;
use crate::CloudAgentTurnStatus;
use crate::MAX_CLOUD_AGENT_TURN_PAGE_SIZE;
use crate::runtime::cloud_agent_turn_tests::initialized;
use crate::runtime::cloud_agent_turn_tests::reidentify_bundle;
use crate::runtime::cloud_agent_turn_tests::runtime_bundle;
use crate::runtime::cloud_agent_turn_tests::seed_authority;
use crate::runtime::cloud_agent_turn_tests::seed_prompt_artifact;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn cloud_agent_turn_page_is_bounded_stable_and_anchor_checked() {
    let codex_home = unique_temp_dir();
    let state = initialized(&codex_home).await;
    let (context, binding) = seed_authority(&state).await;
    seed_prompt_artifact(&state).await;
    let first = runtime_bundle(&context, &binding);
    assert_eq!(
        state
            .create_cloud_agent_turn_bundle(&first, /*authorized_at*/ 100)
            .await
            .expect("create first Turn"),
        CloudAgentTurnCreateOutcome::Created(first.turn.clone())
    );
    make_terminal(&state, &first.turn).await;

    let second = reidentify_bundle(first.clone(), "page-2");
    assert_eq!(
        state
            .create_cloud_agent_turn_bundle(&second, /*authorized_at*/ 100)
            .await
            .expect("create second Turn"),
        CloudAgentTurnCreateOutcome::Created(second.turn.clone())
    );

    let first_page = state
        .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
            thread_id: first.turn.thread_id.clone(),
            anchor: None,
            limit: 1,
            sort_direction: CloudAgentTurnSortDirection::Desc,
        })
        .await
        .expect("first page");
    assert_eq!(first_page.data, vec![second.turn.clone()]);
    assert!(first_page.has_more);

    let second_page = state
        .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
            thread_id: first.turn.thread_id.clone(),
            anchor: Some(CloudAgentTurnPageAnchor {
                turn_id: second.turn.turn_id.clone(),
                include_anchor: false,
            }),
            limit: 1,
            sort_direction: CloudAgentTurnSortDirection::Desc,
        })
        .await
        .expect("second page");
    let mut expected_first = first.turn.clone();
    expected_first.status = CloudAgentTurnStatus::Failed;
    expected_first.error_code = Some("internal".to_string());
    expected_first.revision += 1;
    expected_first.updated_at = 101;
    expected_first.completed_at = Some(101);
    expected_first.record_hash = expected_first.canonical_hash();
    assert_eq!(second_page.data, vec![expected_first]);
    assert!(!second_page.has_more);

    assert!(
        state
            .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
                thread_id: first.turn.thread_id.clone(),
                anchor: Some(CloudAgentTurnPageAnchor {
                    turn_id: "missing-turn".to_string(),
                    include_anchor: false,
                }),
                limit: 1,
                sort_direction: CloudAgentTurnSortDirection::Asc,
            })
            .await
            .is_err()
    );
    assert!(
        state
            .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
                thread_id: first.turn.thread_id,
                anchor: None,
                limit: MAX_CLOUD_AGENT_TURN_PAGE_SIZE + 1,
                sort_direction: CloudAgentTurnSortDirection::Asc,
            })
            .await
            .is_err()
    );

    state.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn make_terminal(state: &StateRuntime, turn: &crate::CloudAgentTurnRecord) {
    let mut terminal = turn.clone();
    terminal.status = CloudAgentTurnStatus::Failed;
    terminal.error_code = Some("internal".to_string());
    terminal.revision += 1;
    terminal.updated_at = 101;
    terminal.completed_at = Some(101);
    terminal.record_hash = terminal.canonical_hash();
    sqlx::query(
        r#"
UPDATE cloud_agent_turns
SET status = 'failed', error_code = ?, revision = ?, record_hash = ?,
    updated_at = ?, completed_at = ?
WHERE turn_id = ?
        "#,
    )
    .bind(terminal.error_code.as_deref())
    .bind(i64::try_from(terminal.revision).expect("revision"))
    .bind(&terminal.record_hash)
    .bind(terminal.updated_at)
    .bind(terminal.completed_at)
    .bind(&terminal.turn_id)
    .execute(state.pool.as_ref())
    .await
    .expect("make first Turn terminal");
}
