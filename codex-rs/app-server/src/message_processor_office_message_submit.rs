use super::*;
use crate::request_processors::OfficeMessageDispatchMode;
use crate::request_processors::OfficeMessageSubmitAction;
use crate::request_processors::office_message_receipt_status;
use crewon_app_server_protocol::OfficeMessageDelivery;

impl MessageProcessor {
    pub(super) async fn office_message_submit_request(
        &self,
        request_id: ConnectionRequestId,
        params: OfficeMessageSubmitParams,
        app_server_client_name: Option<String>,
        client_version: Option<String>,
    ) -> Result<OfficeMessageSubmitResponse, JSONRPCErrorError> {
        let prepared = self
            .crewon_domain_processor
            .office_message_submit_prepare(params)
            .await?;
        let delivery = match prepared.action.clone() {
            OfficeMessageSubmitAction::Respond(delivery) => delivery,
            OfficeMessageSubmitAction::Run {
                thread_id,
                dispatch_mode,
            } => {
                self.dispatch_or_recover_submitted_run(
                    &request_id,
                    &prepared,
                    &thread_id,
                    dispatch_mode,
                    app_server_client_name,
                    client_version,
                )
                .await?
            }
            OfficeMessageSubmitAction::Steer {
                run_id,
                thread_id,
                expected_turn_id,
                dispatch_mode,
            } => {
                self.dispatch_or_recover_submitted_steer(
                    &request_id,
                    &prepared,
                    &run_id,
                    &thread_id,
                    &expected_turn_id,
                    dispatch_mode,
                )
                .await?
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

    async fn dispatch_or_recover_submitted_run(
        &self,
        request_id: &ConnectionRequestId,
        prepared: &crate::request_processors::PreparedOfficeMessageSubmit,
        thread_id: &str,
        dispatch_mode: OfficeMessageDispatchMode,
        app_server_client_name: Option<String>,
        client_version: Option<String>,
    ) -> Result<OfficeMessageDelivery, JSONRPCErrorError> {
        let persisted = self
            .persisted_submitted_message_turn(prepared, thread_id)
            .await?;
        if let Some(turn) = persisted {
            let run_id = self
                .crewon_domain_processor
                .office_message_run_id_for_client(
                    &prepared.config,
                    &prepared.client_user_message_id,
                )?;
            let repaired_missing_turn = !self
                .crewon_domain_processor
                .office_message_run_has_turn_for_client(
                    &prepared.config,
                    &prepared.client_user_message_id,
                );
            if repaired_missing_turn {
                self.crewon_domain_processor
                    .office_run_mark_started(
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
            return Ok(OfficeMessageDelivery::RunStarted {
                run_id,
                thread_id: thread_id.to_string(),
                turn,
            });
        }
        if prepared.replayed && dispatch_mode == OfficeMessageDispatchMode::RecoverOnly {
            if office_message_receipt_status(&prepared.config, &prepared.client_user_message_id)
                == Some("delivered")
            {
                return Ok(OfficeMessageDelivery::Processing {
                    phase: crewon_app_server_protocol::OfficeMessageProcessingPhase::Recovering,
                    retry_after_ms: 250,
                });
            }
            if let Ok(run_id) = self
                .crewon_domain_processor
                .office_message_run_id_for_client(
                    &prepared.config,
                    &prepared.client_user_message_id,
                )
            {
                let _ = self
                    .crewon_domain_processor
                    .office_run_mark_failed(
                        &prepared.cwd,
                        prepared.config.clone(),
                        &run_id,
                        "Office manager receipt had no exact persisted turn; refusing blind reexecution",
                    )
                    .await;
            }
            let update = self
                .crewon_domain_processor
                .office_message_mark_failed(
                    prepared,
                    "Office manager receipt had no exact persisted turn; refusing blind reexecution",
                )
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

        let run = match self
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
            .await
        {
            Ok(run) => run,
            Err(error) if manager_run_active(&error) => {
                let after_run_id = manager_run_id(&error)?;
                let (_, position) = self
                    .crewon_domain_processor
                    .office_message_mark_queued(prepared, &after_run_id)
                    .await?;
                return Ok(OfficeMessageDelivery::Queued {
                    after_run_id,
                    position,
                });
            }
            Err(error) => return Err(error),
        };
        if let Err(error) = self
            .thread_processor
            .ensure_thread_loaded_for_office_dispatch(
                &run.cwd,
                &run.thread_id,
                request_id.connection_id,
            )
            .await
        {
            let _ = self
                .crewon_domain_processor
                .office_run_mark_failed(&run.cwd, run.config, &run.run_id, &error.message)
                .await;
            let _ = self
                .crewon_domain_processor
                .office_message_mark_failed(prepared, &error.message)
                .await;
            return Err(error);
        }
        let turn_response = match self
            .turn_processor
            .office_manager_turn_start_response(
                request_id.clone(),
                &run.cwd,
                TurnStartParams {
                    thread_id: run.thread_id.clone(),
                    client_user_message_id: run.dispatch_receipt_id.clone(),
                    input: vec![UserInput::Text {
                        text: run.input_text.clone(),
                        text_elements: Vec::new(),
                    }],
                    additional_context: Some(run.additional_context.clone()),
                    cwd: Some(PathBuf::from(run.cwd.clone())),
                    ..TurnStartParams::default()
                },
                app_server_client_name,
                client_version,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let _ = self
                    .crewon_domain_processor
                    .office_run_mark_failed(&run.cwd, run.config, &run.run_id, &error.message)
                    .await;
                let _ = self
                    .crewon_domain_processor
                    .office_message_mark_failed(prepared, &error.message)
                    .await;
                return Err(error);
            }
        };
        let orphan_dispatch = OfficeOrphanDispatch::manager_for_config(
            &run.config,
            run.run_id.clone(),
            run.thread_id.clone(),
            turn_response.turn.id.clone(),
        );
        if let Err(error) = self
            .crewon_domain_processor
            .office_run_mark_started(
                &run.cwd,
                run.config.clone(),
                &run.run_id,
                &turn_response.turn.id,
            )
            .await
        {
            self.interrupt_uncommitted_office_turn(request_id, &run.cwd, orphan_dispatch)
                .await;
            let _ = self
                .crewon_domain_processor
                .office_message_mark_failed(prepared, &error.message)
                .await;
            return Err(error);
        }
        let receipt_update = self
            .crewon_domain_processor
            .office_message_mark_run_started(
                prepared,
                &run.run_id,
                &run.thread_id,
                &turn_response.turn.id,
            )
            .await?;
        self.send_office_run_updated(
            &run.cwd,
            &receipt_update.file_path,
            &receipt_update.config,
            "started",
            Some(&run.thread_id),
            Some(&turn_response.turn.id),
        )
        .await;
        self.remember_office_scheduler_cwd(&run.cwd).await;
        Ok(OfficeMessageDelivery::RunStarted {
            run_id: run.run_id,
            thread_id: run.thread_id,
            turn: turn_response.turn,
        })
    }

    async fn dispatch_or_recover_submitted_steer(
        &self,
        request_id: &ConnectionRequestId,
        prepared: &crate::request_processors::PreparedOfficeMessageSubmit,
        run_id: &str,
        thread_id: &str,
        expected_turn_id: &str,
        dispatch_mode: OfficeMessageDispatchMode,
    ) -> Result<OfficeMessageDelivery, JSONRPCErrorError> {
        if let Some(turn) = self
            .persisted_submitted_message_turn(prepared, thread_id)
            .await?
        {
            if turn.id != expected_turn_id {
                return Err(internal_error(
                    "Office message receipt matched a different turn; refusing retarget",
                ));
            }
            self.crewon_domain_processor
                .office_message_mark_steered(prepared, run_id, thread_id, &turn.id)
                .await?;
            return Ok(OfficeMessageDelivery::Steered {
                run_id: run_id.to_string(),
                thread_id: thread_id.to_string(),
                turn_id: turn.id,
            });
        }
        if prepared.replayed && dispatch_mode == OfficeMessageDispatchMode::RecoverOnly {
            if office_message_receipt_status(&prepared.config, &prepared.client_user_message_id)
                == Some("delivered")
            {
                return Ok(OfficeMessageDelivery::Processing {
                    phase: crewon_app_server_protocol::OfficeMessageProcessingPhase::Recovering,
                    retry_after_ms: 250,
                });
            }
            let (_, position) = self
                .crewon_domain_processor
                .office_message_mark_queued(prepared, run_id)
                .await?;
            return Ok(OfficeMessageDelivery::Queued {
                after_run_id: run_id.to_string(),
                position,
            });
        }
        let mut canonical = self
            .crewon_domain_processor
            .office_message_latest_exact(&prepared.cwd, &prepared.config)
            .await?;
        let mut context_attempts = 0;
        let additional_context = loop {
            context_attempts += 1;
            let revision = canonical
                .config
                .get("workspace")
                .and_then(|workspace| workspace.get("recordRevision"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| internal_error("canonical Office context has no recordRevision"))?
                .to_string();
            let context = self
                .crewon_domain_processor
                .office_submitted_message_additional_context(
                    &prepared.cwd,
                    &canonical.config,
                    &prepared.text,
                    &prepared.client_user_message_id,
                    prepared.locale.as_deref(),
                )
                .await?;
            let latest = self
                .crewon_domain_processor
                .office_message_latest_exact(&prepared.cwd, &canonical.config)
                .await?;
            let latest_revision = latest
                .config
                .get("workspace")
                .and_then(|workspace| workspace.get("recordRevision"))
                .and_then(serde_json::Value::as_str);
            if latest_revision == Some(revision.as_str()) {
                break context;
            }
            if context_attempts >= 3 {
                return Err(internal_error(
                    "canonical Office changed repeatedly while building steer context; retry",
                ));
            }
            canonical = latest;
        };
        if additional_context.is_empty() {
            return Err(internal_error(
                "Office steer context unexpectedly resolved to an empty snapshot",
            ));
        }
        let steer = self
            .turn_processor
            .office_turn_steer_response(
                request_id,
                &prepared.cwd,
                TurnSteerParams {
                    thread_id: thread_id.to_string(),
                    client_user_message_id: Some(prepared.receipt_id.clone()),
                    input: vec![UserInput::Text {
                        text: prepared.text.clone(),
                        text_elements: Vec::new(),
                    }],
                    responsesapi_client_metadata: None,
                    additional_context: Some(additional_context),
                    expected_turn_id: expected_turn_id.to_string(),
                },
            )
            .await;
        let steer = match steer {
            Ok(steer) => steer,
            Err(error) if queueable_steer_error(&error) => {
                let (_, position) = self
                    .crewon_domain_processor
                    .office_message_mark_queued(prepared, run_id)
                    .await?;
                return Ok(OfficeMessageDelivery::Queued {
                    after_run_id: run_id.to_string(),
                    position,
                });
            }
            Err(error) => return Err(error),
        };
        self.crewon_domain_processor
            .office_message_mark_steered(prepared, run_id, thread_id, &steer.turn_id)
            .await?;
        Ok(OfficeMessageDelivery::Steered {
            run_id: run_id.to_string(),
            thread_id: thread_id.to_string(),
            turn_id: steer.turn_id,
        })
    }

    async fn persisted_submitted_message_turn(
        &self,
        prepared: &crate::request_processors::PreparedOfficeMessageSubmit,
        thread_id: &str,
    ) -> Result<Option<crewon_app_server_protocol::Turn>, JSONRPCErrorError> {
        for attempt in 0..3 {
            let turn = self
                .thread_processor
                .office_persisted_turn_for_client_user_message_id(
                    &prepared.cwd,
                    thread_id,
                    &prepared.receipt_id,
                )
                .await?;
            if turn.is_some() || attempt == 2 {
                return Ok(turn);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        Ok(None)
    }
}

fn queueable_steer_error(error: &JSONRPCErrorError) -> bool {
    error.message == "no active turn to steer"
        || error.message.starts_with("expected active turn id `")
        || matches!(
            error.message.as_str(),
            "cannot steer a review turn" | "cannot steer a compact turn"
        )
}

fn manager_run_active(error: &JSONRPCErrorError) -> bool {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("type"))
        .and_then(serde_json::Value::as_str)
        == Some("officeManagerRunActive")
}

fn manager_run_id(error: &JSONRPCErrorError) -> Result<String, JSONRPCErrorError> {
    error
        .data
        .as_ref()
        .and_then(|data| data.get("runId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| internal_error("active Office manager error has no runId"))
}
