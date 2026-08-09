use std::path::PathBuf;

use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::UserInput;

use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::ConnectionRequestId;

use super::OfficeAutoDispatchContext;
use super::PreparedWorkflowNodeDispatch;
use super::WorkflowRunUpdate;
use super::workflow_run_updated_notification;

impl OfficeAutoDispatchContext {
    pub(crate) async fn dispatch_prepared_workflow_node(
        &self,
        prepared: &PreparedWorkflowNodeDispatch,
        request_id: ConnectionRequestId,
        app_server_client_name: Option<String>,
        client_version: Option<String>,
        notification_reason: &str,
        connection_id: ConnectionId,
    ) -> Result<WorkflowRunUpdate, crewon_app_server_protocol::JSONRPCErrorError> {
        let turn_response = match self
            .turn_processor
            .turn_start_response(
                request_id,
                TurnStartParams {
                    thread_id: prepared.thread_id.clone(),
                    input: vec![UserInput::Text {
                        text: prepared.prompt.clone(),
                        text_elements: Vec::new(),
                    }],
                    cwd: Some(PathBuf::from(&prepared.cwd)),
                    ..TurnStartParams::default()
                },
                app_server_client_name,
                client_version,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                if let Ok(config) = self
                    .domain_processor
                    .workflow_run_mark_failed(prepared, &error.message)
                    .await
                {
                    self.outgoing
                        .send_server_notification(workflow_run_updated_notification(
                            &prepared.cwd,
                            &prepared.file_path,
                            &config,
                            "nodeDispatchFailed",
                            Some(&prepared.thread_id),
                            /*source_turn_id*/ None,
                        ))
                        .await;
                }
                return Err(error);
            }
        };
        let update = self
            .domain_processor
            .workflow_run_mark_started(prepared, &turn_response.turn.id)
            .await?;
        self.outgoing
            .send_server_notification(workflow_run_updated_notification(
                &prepared.cwd,
                &prepared.file_path,
                &update.config,
                notification_reason,
                Some(&prepared.thread_id),
                Some(&turn_response.turn.id),
            ))
            .await;
        self.spawn_completion_monitor(
            prepared.cwd.clone(),
            prepared.thread_id.clone(),
            turn_response.turn.id,
            connection_id,
        );
        Ok(update)
    }
}
