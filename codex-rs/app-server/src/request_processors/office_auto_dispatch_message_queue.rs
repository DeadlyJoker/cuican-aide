use super::super::crewon_domain_processor::OfficeRunSyncUpdate;
use super::*;
use crewon_app_server_protocol::OfficeMessageDelivery;

const MAX_QUEUED_MESSAGE_DISPATCH_ATTEMPTS: usize = 8;

pub(super) struct OfficeQueuedMessageDispatchStarted {
    pub(super) update: OfficeAutoDispatchStarted,
    pub(super) run_id: String,
    pub(super) thread_id: String,
    pub(super) turn_id: String,
}

pub(super) enum OfficeQueuedMessageDispatchOutcome {
    Empty,
    Deferred,
    Started(OfficeQueuedMessageDispatchStarted),
}

impl OfficeAutoDispatchContext {
    pub(super) async fn dispatch_queued_message_after_terminal_turn(
        &self,
        cwd: &str,
        source_thread_id: &str,
        turn: &Turn,
        connection_id: ConnectionId,
    ) -> OfficeQueuedMessageDispatchOutcome {
        let trigger = match self
            .domain_processor
            .office_message_queue_trigger_after_thread_turn(cwd, source_thread_id, turn)
            .await
        {
            Ok(Some(trigger)) => trigger,
            Ok(None) => return OfficeQueuedMessageDispatchOutcome::Empty,
            Err(err) => {
                warn!(
                    thread_id = %source_thread_id,
                    turn_id = %turn.id,
                    error = %err.message,
                    "failed to resolve queued Office message trigger"
                );
                return OfficeQueuedMessageDispatchOutcome::Deferred;
            }
        };
        let _capability_guard = self
            .office_thread_capability
            .acquire(&trigger.manager_thread_id)
            .await;
        let mut config = trigger.config;
        for _ in 0..MAX_QUEUED_MESSAGE_DISPATCH_ATTEMPTS {
            let prepared = match self
                .domain_processor
                .office_message_prepare_next_queued(cwd, &config, &trigger.completed_run_id)
                .await
            {
                Ok(Some(prepared)) => prepared,
                Ok(None) => return OfficeQueuedMessageDispatchOutcome::Empty,
                Err(err) => {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %err.message,
                        "failed to claim queued Office message"
                    );
                    return OfficeQueuedMessageDispatchOutcome::Deferred;
                }
            };
            config.clone_from(&prepared.config);
            let (thread_id, dispatch_mode) = match prepared.action.clone() {
                OfficeMessageSubmitAction::Run {
                    thread_id,
                    dispatch_mode,
                } => (thread_id, dispatch_mode),
                OfficeMessageSubmitAction::Respond(OfficeMessageDelivery::Failed { .. }) => {
                    continue;
                }
                OfficeMessageSubmitAction::Respond(_) => {
                    return OfficeQueuedMessageDispatchOutcome::Deferred;
                }
                OfficeMessageSubmitAction::Steer { .. } => {
                    if let Ok(update) = self
                        .domain_processor
                        .office_message_mark_failed(
                            &prepared,
                            "queued Office message unexpectedly resolved to a steer action",
                        )
                        .await
                    {
                        config = update.config;
                    }
                    continue;
                }
            };
            match self
                .persisted_turn_for_dispatch_receipt(
                    &prepared.cwd,
                    &thread_id,
                    &prepared.receipt_id,
                )
                .await
            {
                Ok(Some(persisted_turn)) => {
                    let run_id = match self.domain_processor.office_message_run_id_for_client(
                        &prepared.config,
                        &prepared.client_user_message_id,
                    ) {
                        Ok(run_id) => run_id,
                        Err(err) => {
                            warn!(
                                receipt_id = %prepared.receipt_id,
                                error = %err.message,
                                "failed to recover queued Office message run identity"
                            );
                            return OfficeQueuedMessageDispatchOutcome::Deferred;
                        }
                    };
                    if !self
                        .domain_processor
                        .office_message_run_has_turn_for_client(
                            &prepared.config,
                            &prepared.client_user_message_id,
                        )
                        && let Err(err) = self
                            .domain_processor
                            .office_run_mark_started(
                                &prepared.cwd,
                                prepared.config.clone(),
                                &run_id,
                                &persisted_turn.id,
                            )
                            .await
                    {
                        warn!(
                            receipt_id = %prepared.receipt_id,
                            error = %err.message,
                            "failed to commit recovered queued Office run"
                        );
                        return OfficeQueuedMessageDispatchOutcome::Deferred;
                    }
                    let update = match self
                        .domain_processor
                        .office_message_mark_run_started(
                            &prepared,
                            &run_id,
                            &thread_id,
                            &persisted_turn.id,
                        )
                        .await
                    {
                        Ok(update) => update,
                        Err(err) => {
                            warn!(
                                receipt_id = %prepared.receipt_id,
                                error = %err.message,
                                "failed to commit recovered queued Office message receipt"
                            );
                            return OfficeQueuedMessageDispatchOutcome::Deferred;
                        }
                    };
                    self.send_queued_message_update(
                        &prepared.cwd,
                        &update,
                        "messageQueueRecovered",
                        &thread_id,
                        &persisted_turn.id,
                    )
                    .await;
                    self.spawn_completion_monitor(
                        prepared.cwd,
                        thread_id.clone(),
                        persisted_turn.id.clone(),
                        connection_id,
                    );
                    return OfficeQueuedMessageDispatchOutcome::Started(
                        OfficeQueuedMessageDispatchStarted {
                            update: OfficeAutoDispatchStarted {
                                file_path: update.file_path,
                                config: update.config,
                            },
                            run_id,
                            thread_id,
                            turn_id: persisted_turn.id,
                        },
                    );
                }
                Ok(None) => {}
                Err(err) => {
                    warn!(
                        receipt_id = %prepared.receipt_id,
                        error = %err.message,
                        "failed to inspect queued Office message recovery history"
                    );
                    return OfficeQueuedMessageDispatchOutcome::Deferred;
                }
            }
            if dispatch_mode == OfficeMessageDispatchMode::RecoverOnly {
                if let Ok(run_id) = self.domain_processor.office_message_run_id_for_client(
                    &prepared.config,
                    &prepared.client_user_message_id,
                ) {
                    let _ = self
                        .domain_processor
                        .office_run_mark_failed(
                            &prepared.cwd,
                            prepared.config.clone(),
                            &run_id,
                            "queued Office message recovery could not prove an exact persisted turn",
                        )
                        .await;
                }
                if let Ok(update) = self
                    .domain_processor
                    .office_message_mark_failed(
                        &prepared,
                        "queued Office message recovery could not prove an exact persisted turn",
                    )
                    .await
                {
                    config = update.config;
                }
                continue;
            }

            let run = match self
                .domain_processor
                .office_submitted_message_run_prepare(
                    crewon_app_server_protocol::OfficeRunParams {
                        cwd: prepared.cwd.clone(),
                        config: prepared.config.clone(),
                        message: prepared.message.clone(),
                        text: prepared.text.clone(),
                        locale: prepared.locale.clone(),
                        thread_id: Some(thread_id.clone()),
                        client_user_message_id: Some(prepared.client_user_message_id.clone()),
                    },
                    prepared.receipt_id.clone(),
                )
                .await
            {
                Ok(run) => run,
                Err(err) if self.domain_processor.office_manager_run_active_error(&err) => {
                    return OfficeQueuedMessageDispatchOutcome::Deferred;
                }
                Err(err) => {
                    if let Ok(update) = self
                        .domain_processor
                        .office_message_mark_failed(&prepared, &err.message)
                        .await
                    {
                        config = update.config;
                    }
                    continue;
                }
            };
            let request_id = ConnectionRequestId {
                connection_id,
                request_id: RequestId::String(format!("office-message-queue-{}", Uuid::new_v4())),
            };
            let turn_response = match self
                .turn_processor
                .office_manager_turn_start_response(
                    request_id.clone(),
                    &run.cwd,
                    TurnStartParams {
                        thread_id: run.thread_id.clone(),
                        client_user_message_id: run.dispatch_receipt_id.clone(),
                        input: vec![V2UserInput::Text {
                            text: run.input_text.clone(),
                            text_elements: Vec::new(),
                        }],
                        additional_context: Some(run.additional_context.clone()),
                        cwd: Some(PathBuf::from(run.cwd.clone())),
                        ..TurnStartParams::default()
                    },
                    Some("app-server-office-message-queue".to_string()),
                    None,
                )
                .await
            {
                Ok(response) => response,
                Err(err) if queued_message_start_can_defer(&err) => {
                    let _ = self
                        .domain_processor
                        .office_run_mark_failed(&run.cwd, run.config, &run.run_id, &err.message)
                        .await;
                    let _ = self
                        .domain_processor
                        .office_message_mark_queued(&prepared, &trigger.completed_run_id)
                        .await;
                    return OfficeQueuedMessageDispatchOutcome::Deferred;
                }
                Err(err) => {
                    let _ = self
                        .domain_processor
                        .office_run_mark_failed(&run.cwd, run.config, &run.run_id, &err.message)
                        .await;
                    if let Ok(update) = self
                        .domain_processor
                        .office_message_mark_failed(&prepared, &err.message)
                        .await
                    {
                        config = update.config;
                    }
                    continue;
                }
            };
            let orphan_dispatch = OfficeOrphanDispatch::manager_for_config(
                &run.config,
                run.run_id.clone(),
                run.thread_id.clone(),
                turn_response.turn.id.clone(),
            );
            let update = match self
                .domain_processor
                .office_run_mark_started(&run.cwd, run.config, &run.run_id, &turn_response.turn.id)
                .await
            {
                Ok((file_path, config)) => OfficeRunSyncUpdate { file_path, config },
                Err(err) => {
                    self.interrupt_uncommitted_turn(&request_id, &run.cwd, orphan_dispatch)
                        .await;
                    let _ = self
                        .domain_processor
                        .office_message_mark_failed(&prepared, &err.message)
                        .await;
                    return OfficeQueuedMessageDispatchOutcome::Deferred;
                }
            };
            let receipt_update = match self
                .domain_processor
                .office_message_mark_run_started(
                    &prepared,
                    &run.run_id,
                    &run.thread_id,
                    &turn_response.turn.id,
                )
                .await
            {
                Ok(update) => update,
                Err(err) => {
                    warn!(
                        receipt_id = %prepared.receipt_id,
                        error = %err.message,
                        "failed to commit queued Office message receipt"
                    );
                    return OfficeQueuedMessageDispatchOutcome::Deferred;
                }
            };
            self.send_queued_message_update(
                &run.cwd,
                &receipt_update,
                "messageQueueStarted",
                &run.thread_id,
                &turn_response.turn.id,
            )
            .await;
            self.spawn_completion_monitor(
                run.cwd,
                run.thread_id.clone(),
                turn_response.turn.id.clone(),
                connection_id,
            );
            let _ = update;
            return OfficeQueuedMessageDispatchOutcome::Started(
                OfficeQueuedMessageDispatchStarted {
                    update: OfficeAutoDispatchStarted {
                        file_path: receipt_update.file_path,
                        config: receipt_update.config,
                    },
                    run_id: run.run_id,
                    thread_id: run.thread_id,
                    turn_id: turn_response.turn.id,
                },
            );
        }
        OfficeQueuedMessageDispatchOutcome::Empty
    }

    async fn send_queued_message_update(
        &self,
        cwd: &str,
        update: &OfficeRunSyncUpdate,
        reason: &str,
        thread_id: &str,
        turn_id: &str,
    ) {
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                cwd,
                &update.file_path,
                &update.config,
                reason,
                Some(thread_id),
                Some(turn_id),
            ))
            .await;
    }
}

fn queued_message_start_can_defer(error: &JSONRPCErrorError) -> bool {
    error.message.contains("active turn")
        || error.message.contains("already has a nonterminal run")
        || error.message.contains("already running")
}
