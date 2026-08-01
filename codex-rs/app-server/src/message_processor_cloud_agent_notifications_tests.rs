use crewon_app_server_protocol::ServerNotification;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::ThreadStatus;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::UserInput;

use super::cloud_agent_turn_completed_notifications;
use super::cloud_agent_turn_started_notifications;

#[test]
fn cloud_agent_notifications_use_standard_turn_item_lifecycle_without_system_bubbles() {
    let thread_id = "019f550e-ba52-7490-a248-b0d3a84103c1";
    let user_item = ThreadItem::UserMessage {
        id: "turn-1:user".to_string(),
        client_id: Some("client-1".to_string()),
        content: vec![UserInput::Text {
            text: "Ship it".to_string(),
            text_elements: Vec::new(),
        }],
    };
    let active_turn = Turn {
        id: "turn-1".to_string(),
        items: vec![user_item.clone()],
        items_view: TurnItemsView::Full,
        status: TurnStatus::InProgress,
        error: None,
        started_at: Some(100),
        completed_at: None,
        duration_ms: None,
    };
    let started = cloud_agent_turn_started_notifications(thread_id, &active_turn);
    assert!(matches!(started.as_slice(), [
        ServerNotification::TurnStarted(_),
        ServerNotification::ItemStarted(started_item),
        ServerNotification::ItemCompleted(completed_item),
        ServerNotification::ThreadStatusChanged(status),
    ] if started_item.item == user_item
        && completed_item.item == user_item
        && matches!(&status.status, ThreadStatus::Active { active_flags } if active_flags.is_empty())));

    let agent_item = ThreadItem::AgentMessage {
        id: "turn-1:assistant".to_string(),
        text: "Done".to_string(),
        phase: None,
        memory_citation: None,
    };
    let completed_turn = Turn {
        items: vec![user_item, agent_item.clone()],
        status: TurnStatus::Completed,
        completed_at: Some(110),
        duration_ms: Some(10_000),
        ..active_turn
    };
    let completed = cloud_agent_turn_completed_notifications(thread_id, &completed_turn);
    assert!(matches!(completed.as_slice(), [
        ServerNotification::ItemStarted(started_item),
        ServerNotification::ItemCompleted(completed_item),
        ServerNotification::TurnCompleted(turn_completed),
        ServerNotification::ThreadStatusChanged(status),
    ] if started_item.item == agent_item
        && completed_item.item == agent_item
        && turn_completed.turn.items.is_empty()
        && turn_completed.turn.items_view == TurnItemsView::NotLoaded
        && status.status == ThreadStatus::Idle));
}
