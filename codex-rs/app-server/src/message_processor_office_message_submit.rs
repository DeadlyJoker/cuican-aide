use super::*;
use crate::platform_control::thread_execution_context_runtime::ThreadExecutionContextRequestRuntime;
use crate::request_processors::OfficeMessageDispatchMode;
use crate::request_processors::OfficeMessageSubmitAction;
use crewon_app_server_protocol::OfficeMessageDelivery;
use crewon_app_server_protocol::OfficeMessageSubmitParams;
use crewon_app_server_protocol::OfficeMessageSubmitResponse;

impl MessageProcessor {
    pub(super) async fn office_message_submit_request(
        &self,
        request_id: ConnectionRequestId,
        params: OfficeMessageSubmitParams,
        execution_context_runtime: Option<ThreadExecutionContextRequestRuntime>,
        app_server_client_name: Option<String>,
        client_version: Option<String>,
    ) -> Result<OfficeMessageSubmitResponse, JSONRPCErrorError> {
        if let Some(runtime) = execution_context_runtime.as_ref() {
            runtime
                .authorize_registered_workspace_root(std::path::Path::new(&params.cwd))
                .await?;
        }
        let resolved = self
            .crewon_domain_processor
            .office_message_submit_resolve(params)
            .await?;
        if let Some(runtime) = execution_context_runtime.as_ref() {
            runtime
                .authorize_or_create_office_thread(
                    &resolved.manager_thread_id,
                    &resolved.expected_office_record_id,
                    std::path::Path::new(&resolved.params.cwd),
                    Utc::now().timestamp(),
                )
                .await?;
        }
        let prepared = self
            .crewon_domain_processor
            .office_message_submit_prepare_resolved(resolved)
            .await?;
        let delivery = match prepared.action.clone() {
            OfficeMessageSubmitAction::Respond(delivery) => delivery,
            OfficeMessageSubmitAction::Run {
                thread_id,
                dispatch_mode,
            } => {
                self.dispatch_submitted_office_run(
                    &request_id,
                    &prepared,
                    &thread_id,
                    dispatch_mode,
                    app_server_client_name,
                    client_version,
                )
                .await?
            }
            OfficeMessageSubmitAction::Steer { run_id, .. } => {
                let (_, position) = self
                    .crewon_domain_processor
                    .office_message_mark_queued(&prepared, &run_id)
                    .await?;
                OfficeMessageDelivery::Queued {
                    after_run_id: run_id,
                    position,
                }
            }
        };
        let canonical = self
            .crewon_domain_processor
            .office_message_latest_exact(&prepared.cwd, &prepared.config)
            .await?;
        Ok(OfficeMessageSubmitResponse {
            file_path: canonical.file_path,
            config: canonical.config,
            receipt_id: prepared.receipt_id,
            client_user_message_id: prepared.client_user_message_id,
            replayed: prepared.replayed,
            delivery,
        })
    }

    async fn dispatch_submitted_office_run(
        &self,
        request_id: &ConnectionRequestId,
        prepared: &crate::request_processors::PreparedOfficeMessageSubmit,
        thread_id: &str,
        dispatch_mode: OfficeMessageDispatchMode,
        app_server_client_name: Option<String>,
        client_version: Option<String>,
    ) -> Result<OfficeMessageDelivery, JSONRPCErrorError> {
        if prepared.replayed
            && let Some(turn) = self
                .persisted_submitted_message_turn(prepared, thread_id)
                .await?
        {
            return self
                .recover_submitted_office_run(request_id, prepared, thread_id, turn)
                .await;
        }
        if prepared.replayed && dispatch_mode == OfficeMessageDispatchMode::RecoverOnly {
            let message =
                "Office manager receipt had no exact persisted turn; refusing blind reexecution";
            if let Ok(run_id) = self
                .crewon_domain_processor
                .office_message_run_id_for_client(
                    &prepared.config,
                    &prepared.client_user_message_id,
                )
            {
                let _ = self
                    .crewon_domain_processor
                    .office_run_recovery_mark_failed(
                        &prepared.cwd,
                        prepared.config.clone(),
                        &run_id,
                        message,
                    )
                    .await;
            }
            let update = self
                .crewon_domain_processor
                .office_message_mark_failed(prepared, message)
                .await?;
            return Ok(OfficeMessageDelivery::Failed {
                code: "officeMessageRecoveryUnproven".to_string(),
                message: format!(
                    "Office message remains visible in canonical config {}, but exact execution could not be proven",
                    update.file_path
                ),
                retryable: false,
            });
        }

        let permitted = self
            .crewon_domain_processor
            .office_submitted_message_run_prepare(
                crewon_app_server_protocol::OfficeRunParams {
                    cwd: prepared.cwd.clone(),
                    config: prepared.config.clone(),
                    message: prepared.message.clone(),
                    text: prepared.text.clone(),
                    locale: prepared.locale.clone(),
                    thread_id: Some(thread_id.to_string()),
                    client_user_message_id: Some(prepared.client_user_message_id.clone()),
                },
                prepared.receipt_id.clone(),
            )
            .await?;
        let run = permitted.prepared();
        let run_id = run.run_id.clone();
        let run_thread_id = run.thread_id.clone();
        self.thread_processor
            .ensure_thread_loaded_for_office_dispatch(&run_thread_id, request_id.connection_id)
            .await?;
        let turn_response = match self
            .turn_processor
            .turn_start_response(
                request_id.clone(),
                TurnStartParams {
                    thread_id: run_thread_id.clone(),
                    client_user_message_id: run.dispatch_receipt_id.clone(),
                    input: vec![UserInput::Text {
                        text: run.prompt.clone(),
                        text_elements: Vec::new(),
                    }],
                    cwd: Some(std::path::PathBuf::from(run.cwd.clone())),
                    ..TurnStartParams::default()
                },
                app_server_client_name,
                client_version,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                drop(permitted);
                if let Some(turn) = self
                    .persisted_submitted_message_turn(prepared, thread_id)
                    .await?
                {
                    return self
                        .recover_submitted_office_run(request_id, prepared, thread_id, turn)
                        .await;
                }
                return Err(error);
            }
        };
        let (_file_path, _config) = self
            .crewon_domain_processor
            .office_run_mark_started_permitted(permitted, &turn_response.turn.id)
            .await?;
        let receipt_update = self
            .crewon_domain_processor
            .office_message_mark_run_started(
                prepared,
                &run_id,
                &run_thread_id,
                &turn_response.turn.id,
            )
            .await?;
        self.send_office_run_updated(
            &prepared.cwd,
            &receipt_update.file_path,
            &receipt_update.config,
            "started",
            Some(&run_thread_id),
            Some(&turn_response.turn.id),
        )
        .await;
        self.remember_office_scheduler_cwd(&prepared.cwd).await;
        Ok(OfficeMessageDelivery::RunStarted {
            run_id,
            thread_id: run_thread_id,
            turn: turn_response.turn,
        })
    }

    async fn persisted_submitted_message_turn(
        &self,
        prepared: &crate::request_processors::PreparedOfficeMessageSubmit,
        thread_id: &str,
    ) -> Result<Option<crewon_app_server_protocol::Turn>, JSONRPCErrorError> {
        for attempt in 0..3 {
            let turn = self
                .turn_processor
                .persisted_office_turn_for_receipt(&prepared.cwd, thread_id, &prepared.receipt_id)
                .await?;
            if turn.is_some() || attempt == 2 {
                return Ok(turn);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        Ok(None)
    }

    async fn recover_submitted_office_run(
        &self,
        request_id: &ConnectionRequestId,
        prepared: &crate::request_processors::PreparedOfficeMessageSubmit,
        thread_id: &str,
        turn: crewon_app_server_protocol::Turn,
    ) -> Result<OfficeMessageDelivery, JSONRPCErrorError> {
        let run_id = self
            .crewon_domain_processor
            .office_message_run_id_for_client(&prepared.config, &prepared.client_user_message_id)?;
        let repaired_missing_turn = !self
            .crewon_domain_processor
            .office_message_run_has_turn_for_client(
                &prepared.config,
                &prepared.client_user_message_id,
            );
        if repaired_missing_turn {
            self.crewon_domain_processor
                .office_run_recover_started(
                    &prepared.cwd,
                    prepared.config.clone(),
                    &run_id,
                    &turn.id,
                )
                .await?;
        }
        let update = self
            .crewon_domain_processor
            .office_message_mark_run_started(prepared, &run_id, thread_id, &turn.id)
            .await?;
        self.send_office_run_updated(
            &prepared.cwd,
            &update.file_path,
            &update.config,
            "messageReceiptRecovered",
            Some(thread_id),
            Some(&turn.id),
        )
        .await;
        if repaired_missing_turn {
            self.thread_processor
                .monitor_office_dispatched_turn_completion(
                    &prepared.cwd,
                    thread_id,
                    &turn.id,
                    request_id.connection_id,
                )
                .await;
        }
        Ok(OfficeMessageDelivery::RunStarted {
            run_id,
            thread_id: thread_id.to_string(),
            turn,
        })
    }
}
