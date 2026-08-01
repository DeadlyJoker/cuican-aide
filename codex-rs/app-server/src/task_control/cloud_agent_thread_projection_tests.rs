use crewon_app_server_protocol::SortDirection;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::ThreadResumeInitialTurnsPageParams;
use crewon_app_server_protocol::ThreadStatus;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStatus;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;

use super::*;
use crate::platform_control::authenticated_identity_in_space;
use crate::task_control::cloud_agent_turn_coordinator::tests::fixture;
use crate::task_control::cloud_agent_turn_coordinator::tests::start;
use crate::task_control::cloud_agent_turn_projector::tests::completed_turn_harness;

#[tokio::test]
async fn queued_turn_projects_standard_user_item_and_owner_is_enforced() {
    let fixture = fixture().await;
    let started = start(
        &fixture.state,
        &fixture.identity,
        "projection-message-1",
        "Explain the durable result",
        /*now*/ 150,
    )
    .await
    .expect("start Cloud Agent Turn");
    let runtime =
        CloudAgentThreadProjectionRuntime::new(fixture.state.clone(), fixture.identity.clone());
    let projected = runtime
        .project_exact_turn(
            &started.turn.thread_id,
            &started.turn.turn_id,
            Some(started.turn.revision),
            TurnItemsView::Full,
        )
        .await
        .expect("project queued Turn")
        .expect("Cloud Agent Turn");
    assert_eq!(projected.status, TurnStatus::InProgress);
    assert_eq!(projected.started_at, Some(150));
    assert_eq!(projected.items.len(), 1);
    assert!(matches!(
        &projected.items[0],
        ThreadItem::UserMessage { id, client_id, content }
            if id == &user_item_id(&started.turn.turn_id)
                && client_id.as_deref() == Some("projection-message-1")
                && matches!(content.as_slice(), [crewon_app_server_protocol::UserInput::Text { text, .. }] if text == "Explain the durable result")
    ));

    let cross_space = CloudAgentThreadProjectionRuntime::new(
        fixture.state.clone(),
        authenticated_identity_in_space("projection-cross-space", "space-other"),
    );
    assert_eq!(
        cross_space
            .project_exact_turn(
                &started.turn.thread_id,
                &started.turn.turn_id,
                /*expected_revision*/ None,
                TurnItemsView::Full,
            )
            .await,
        Err(CloudAgentThreadProjectionError::Unauthorized)
    );
    assert_eq!(
        runtime
            .list_page(
                &started.turn.thread_id,
                Some(r#"{"turnId":"missing","includeAnchor":false}"#),
                Some(1),
                SortDirection::Desc,
                TurnItemsView::Summary,
            )
            .await,
        Err(CloudAgentThreadProjectionError::InvalidCursor)
    );
    let oversized_cursor = serde_json::json!({
        "turnId": "x".repeat(513),
        "includeAnchor": false,
    })
    .to_string();
    assert_eq!(
        runtime
            .list_page(
                &started.turn.thread_id,
                Some(&oversized_cursor),
                Some(1),
                SortDirection::Desc,
                TurnItemsView::Summary,
            )
            .await,
        Err(CloudAgentThreadProjectionError::InvalidCursor)
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn completed_turn_projects_one_verified_agent_item_and_paginated_recovery() {
    let harness = completed_turn_harness().await;
    let runtime = CloudAgentThreadProjectionRuntime::new(
        harness.fixture.state.clone(),
        harness.fixture.identity.clone(),
    );
    let full = runtime
        .read_all(&harness.turn.thread_id, TurnItemsView::Full)
        .await
        .expect("read Cloud Agent Thread")
        .expect("Cloud Agent Thread");
    assert_eq!(full.status, ThreadStatus::Idle);
    assert_eq!(full.turns.len(), 1);
    let turn = &full.turns[0];
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(turn.completed_at, Some(200));
    assert_eq!(turn.items.len(), 2);
    assert!(matches!(
        &turn.items[1],
        ThreadItem::AgentMessage { id, text, .. }
            if id == &assistant_item_id(&turn.id) && text == "verified cloud agent result"
    ));

    let page = runtime
        .list_page(
            &harness.turn.thread_id,
            /*cursor*/ None,
            Some(1),
            SortDirection::Desc,
            TurnItemsView::Summary,
        )
        .await
        .expect("list Cloud Agent Turns")
        .expect("Cloud Agent page");
    assert_eq!(page.data.len(), 1);
    assert_eq!(page.data[0].id, full.turns[0].id);
    assert_eq!(page.data[0].items, full.turns[0].items);
    assert_eq!(page.data[0].items_view, TurnItemsView::Summary);
    assert!(page.next_cursor.is_none());
    assert!(page.backwards_cursor.is_some());

    let resume = runtime
        .resume_projection(
            &harness.turn.thread_id,
            /*include_turns*/ true,
            Some(&ThreadResumeInitialTurnsPageParams {
                limit: Some(1),
                sort_direction: Some(SortDirection::Desc),
                items_view: Some(TurnItemsView::Summary),
            }),
        )
        .await
        .expect("resume projection")
        .expect("Cloud Agent resume projection");
    assert_eq!(resume.turns.as_deref(), Some(full.turns.as_slice()));
    assert_eq!(
        resume
            .initial_turns_page
            .as_ref()
            .map(|page| page.data[0].id.as_str()),
        Some(harness.turn.turn_id.as_str())
    );

    harness.fixture.state.close().await;
    let restarted = StateRuntime::init(
        harness.fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let recovered =
        CloudAgentThreadProjectionRuntime::new(restarted.clone(), harness.fixture.identity)
            .read_all(&harness.turn.thread_id, TurnItemsView::Full)
            .await
            .expect("recover Cloud Agent Thread after restart")
            .expect("recovered Cloud Agent Thread");
    assert_eq!(recovered, full);
    restarted.close().await;
}
