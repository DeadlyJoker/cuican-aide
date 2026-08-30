use crewon_app_server_protocol::ItemCompletedNotification;
use crewon_app_server_protocol::ItemStartedNotification;
use crewon_app_server_protocol::ServerNotification;
use crewon_app_server_protocol::ThreadStatus;
use crewon_app_server_protocol::ThreadStatusChangedNotification;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnCompletedNotification;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStartedNotification;
use crewon_app_server_protocol::TurnStatus;

use super::MessageProcessor;
use crate::outgoing_message::ConnectionId;
use crate::platform_control::RequestIdentity;
use crate::task_control::cloud_agent_thread_projection::CloudAgentThreadProjectionError;
use crate::task_control::cloud_agent_turn_projector::CloudAgentTurnTerminalNotice;

impl MessageProcessor {
    pub(crate) async fn deliver_cloud_agent_terminal_notice(
        &self,
        notice: &CloudAgentTurnTerminalNotice,
        recipients: Vec<(ConnectionId, RequestIdentity)>,
    ) {
        self.sync_cloud_agent_thread_metadata_best_effort().await;
        for (connection_id, identity) in recipients {
            let Some(runtime) = self.cloud_agent_thread_projection_runtime(&identity) else {
                continue;
            };
            let turn = match runtime
                .project_exact_turn(
                    &notice.thread_id,
                    &notice.turn_id,
                    Some(notice.revision),
                    TurnItemsView::Full,
                )
                .await
            {
                Ok(Some(turn)) => turn,
                Ok(None)
                | Err(CloudAgentThreadProjectionError::Unauthorized)
                | Err(CloudAgentThreadProjectionError::NotFound) => continue,
                Err(error) => {
                    tracing::warn!(
                        thread_id = notice.thread_id,
                        turn_id = notice.turn_id,
                        ?error,
                        "failed to project Cloud Agent terminal notification"
                    );
                    continue;
                }
            };
            if turn.status == TurnStatus::InProgress {
                continue;
            }
            self.send_cloud_agent_turn_completed(connection_id, &notice.thread_id, &turn)
                .await;
        }
    }

    pub(super) async fn send_cloud_agent_turn_started(
        &self,
        connection_id: ConnectionId,
        thread_id: &str,
        turn: &Turn,
    ) {
        for notification in cloud_agent_turn_started_notifications(thread_id, turn) {
            self.outgoing
                .send_server_notification_to_connections(&[connection_id], notification)
                .await;
        }
    }

    async fn send_cloud_agent_turn_completed(
        &self,
        connection_id: ConnectionId,
        thread_id: &str,
        turn: &Turn,
    ) {
        for notification in cloud_agent_turn_completed_notifications(thread_id, turn) {
            self.outgoing
                .send_server_notification_to_connections(&[connection_id], notification)
                .await;
        }
    }
}

fn timestamp_ms(timestamp: Option<i64>) -> i64 {
    timestamp.unwrap_or_default().saturating_mul(1_000)
}

fn cloud_agent_turn_started_notifications(thread_id: &str, turn: &Turn) -> Vec<ServerNotification> {
    let mut notification_turn = turn.clone();
    notification_turn.items.clear();
    notification_turn.items_view = TurnItemsView::NotLoaded;
    let mut notifications = vec![ServerNotification::TurnStarted(TurnStartedNotification {
        thread_id: thread_id.to_string(),
        turn: notification_turn,
    })];
    if let Some(item) = turn
        .items
        .iter()
        .find(|item| {
            matches!(
                item,
                crewon_app_server_protocol::ThreadItem::UserMessage { .. }
            )
        })
        .cloned()
    {
        let started_at_ms = timestamp_ms(turn.started_at);
        notifications.push(ServerNotification::ItemStarted(ItemStartedNotification {
            item: item.clone(),
            thread_id: thread_id.to_string(),
            turn_id: turn.id.clone(),
            started_at_ms,
        }));
        notifications.push(ServerNotification::ItemCompleted(
            ItemCompletedNotification {
                item,
                thread_id: thread_id.to_string(),
                turn_id: turn.id.clone(),
                completed_at_ms: started_at_ms,
            },
        ));
    }
    notifications.push(ServerNotification::ThreadStatusChanged(
        ThreadStatusChangedNotification {
            thread_id: thread_id.to_string(),
            status: ThreadStatus::Active {
                active_flags: Vec::new(),
            },
        },
    ));
    notifications
}

fn cloud_agent_turn_completed_notifications(
    thread_id: &str,
    turn: &Turn,
) -> Vec<ServerNotification> {
    let mut notifications = Vec::new();
    if let Some(item) = turn
        .items
        .iter()
        .find(|item| {
            matches!(
                item,
                crewon_app_server_protocol::ThreadItem::AgentMessage { .. }
            )
        })
        .cloned()
    {
        let completed_at_ms = timestamp_ms(turn.completed_at);
        notifications.push(ServerNotification::ItemStarted(ItemStartedNotification {
            item: item.clone(),
            thread_id: thread_id.to_string(),
            turn_id: turn.id.clone(),
            started_at_ms: completed_at_ms,
        }));
        notifications.push(ServerNotification::ItemCompleted(
            ItemCompletedNotification {
                item,
                thread_id: thread_id.to_string(),
                turn_id: turn.id.clone(),
                completed_at_ms,
            },
        ));
    }
    let mut notification_turn = turn.clone();
    notification_turn.items.clear();
    notification_turn.items_view = TurnItemsView::NotLoaded;
    notifications.push(ServerNotification::TurnCompleted(
        TurnCompletedNotification {
            thread_id: thread_id.to_string(),
            turn: notification_turn,
        },
    ));
    notifications.push(ServerNotification::ThreadStatusChanged(
        ThreadStatusChangedNotification {
            thread_id: thread_id.to_string(),
            status: ThreadStatus::Idle,
        },
    ));
    notifications
}

#[cfg(test)]
#[path = "message_processor_cloud_agent_notifications_tests.rs"]
mod tests;
