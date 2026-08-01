use super::office_auto_dispatch_durable::DurableAutoDelegationAttempt;
use super::office_auto_dispatch_durable::DurableAutoDelegationParams;
use super::office_auto_dispatch_recovery::OfficeAutoDispatchRecovery;
use super::*;
use crewon_app_server_protocol::AutomationRunStartParams;

#[derive(Clone)]
pub(crate) struct OfficeAutoDispatchContext {
    pub(crate) domain_processor: Arc<CrewonDomainRequestProcessor>,
    pub(crate) outgoing: Arc<OutgoingMessageSender>,
    pub(crate) thread_manager: Arc<ThreadManager>,
    pub(crate) turn_processor: TurnRequestProcessor,
    pub(crate) completion_monitors: Arc<Mutex<HashSet<(String, String, String)>>>,
}

pub(crate) struct OfficeAutoDispatchStarted {
    pub(crate) file_path: String,
    pub(crate) config: serde_json::Value,
}

const OFFICE_AUTO_DISPATCH_COMPLETION_POLL_INTERVAL: Duration = Duration::from_millis(100);
const OFFICE_AUTO_DISPATCH_STATUS_FALLBACK_DELAY: Duration = Duration::from_secs(2);
const OFFICE_AUTO_DISPATCH_COMPLETION_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn office_auto_verification_start_failure_can_retry(message: &str) -> bool {
    message.contains("thread not found")
        || message.contains("no rollout found")
        || message.contains("agent loop died unexpectedly")
}

impl OfficeAutoDispatchContext {
    pub(crate) async fn dispatch_after_terminal_turn(
        &self,
        cwd: &str,
        source_thread_id: &str,
        turn: Turn,
        connection_id: ConnectionId,
    ) -> Option<OfficeAutoDispatchStarted> {
        let intent = match self
            .domain_processor
            .office_auto_dispatch_intent_queue(
                cwd,
                source_thread_id,
                &turn.id,
                "dispatchAfterTerminalTurn",
            )
            .await
        {
            Ok(intent) => intent,
            Err(err) => {
                warn!(
                thread_id = %source_thread_id,
                turn_id = %turn.id,
                error = %err.message,
                "failed to persist office auto dispatch intent"
                );
                return None;
            }
        };
        let lease_id = format!("office-auto-dispatch-{}", Uuid::new_v4());
        match self
            .domain_processor
            .office_auto_dispatch_intent_claim(
                cwd,
                &intent.intent_id,
                source_thread_id,
                &turn.id,
                &lease_id,
            )
            .await
        {
            Ok(true) => {}
            Ok(false) => return None,
            Err(err) => {
                warn!(
                    thread_id = %source_thread_id,
                    turn_id = %turn.id,
                    error = %err.message,
                    "failed to claim office auto dispatch intent"
                );
                return None;
            }
        }
        self.dispatch_claimed_after_terminal_turn(
            cwd,
            &intent.intent_id,
            source_thread_id,
            turn,
            connection_id,
            &lease_id,
        )
        .await
    }

    pub(crate) async fn dispatch_claimed_after_terminal_turn(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        turn: Turn,
        connection_id: ConnectionId,
        lease_id: &str,
    ) -> Option<OfficeAutoDispatchStarted> {
        match self
            .recover_durable_auto_delegation(
                cwd,
                intent_id,
                source_thread_id,
                &turn.id,
                lease_id,
                connection_id,
            )
            .await
        {
            Ok(OfficeAutoDispatchRecovery::NotFound) => {}
            Ok(OfficeAutoDispatchRecovery::Handled(recovered)) => return recovered,
            Err(error) => {
                warn!(
                    thread_id = %source_thread_id,
                    turn_id = %turn.id,
                    error = %error.message,
                    "durable Office dispatch recovery failed closed"
                );
                return None;
            }
        }
        let permitted = match self
            .domain_processor
            .office_auto_delegation_dispatch_prepare_after_thread_turn_permitted(
                cwd,
                source_thread_id,
                &turn,
            )
            .await
        {
            Ok(Some(permitted)) => permitted,
            Ok(None) => {
                return self
                    .dispatch_verification_after_terminal_turn(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn,
                        connection_id,
                        lease_id,
                    )
                    .await;
            }
            Err(err) => {
                warn!(
                    thread_id = %source_thread_id,
                    turn_id = %turn.id,
                    error = %err.message,
                    "failed to prepare office auto delegation dispatch"
                );
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let (prepared_cwd, run_id, delegation_id, thread_id, client_user_message_id, prompt) = {
            let prepared = permitted.prepared();
            (
                prepared.cwd.clone(),
                prepared.run_id.clone(),
                prepared.delegation_id.clone(),
                prepared.thread_id.clone(),
                prepared.client_user_message_id.clone(),
                prepared.prompt.clone(),
            )
        };
        match self
            .turn_processor
            .resolve_office_auto_delegation_admission_mode(&thread_id)
            .await
        {
            Ok(OfficeAutoDelegationAdmissionMode::Legacy) => {}
            Ok(OfficeAutoDelegationAdmissionMode::Durable) => {
                return self
                    .dispatch_durable_auto_delegation(DurableAutoDelegationParams {
                        attempt: DurableAutoDelegationAttempt::New,
                        cwd,
                        intent_id,
                        source_thread_id,
                        source_turn_id: &turn.id,
                        lease_id,
                        prepared_cwd,
                        run_id,
                        delegation_id,
                        thread_id,
                        prompt,
                        connection_id,
                        permitted,
                    })
                    .await;
            }
            Err(error) => {
                let message = error.to_string();
                if let Err(mark_error) = self
                    .domain_processor
                    .office_delegation_dispatch_mark_failed_permitted(permitted, &message)
                    .await
                {
                    warn!(
                        run_id = %run_id,
                        delegation_id = %delegation_id,
                        error = %mark_error.message,
                        "failed to mark disabled durable Office dispatch as failed"
                    );
                }
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark disabled durable Office dispatch intent as failed"
                    );
                }
                return None;
            }
        }
        let request_id = ConnectionRequestId {
            connection_id,
            request_id: RequestId::String(format!("office-auto-delegation-{}", Uuid::new_v4())),
        };
        let turn_response = match self
            .turn_processor
            .turn_start_response(
                request_id,
                TurnStartParams {
                    thread_id: thread_id.clone(),
                    client_user_message_id,
                    input: vec![V2UserInput::Text {
                        text: prompt,
                        text_elements: Vec::new(),
                    }],
                    cwd: Some(PathBuf::from(&prepared_cwd)),
                    ..TurnStartParams::default()
                },
                Some("app-server-office-auto-dispatch".to_string()),
                /*app_server_client_version*/ None,
            )
            .await
        {
            Ok(response) => response,
            Err(err) => {
                if let Err(mark_error) = self
                    .domain_processor
                    .office_delegation_dispatch_mark_failed_permitted(permitted, &err.message)
                    .await
                {
                    warn!(
                        run_id = %run_id,
                        delegation_id = %delegation_id,
                        error = %mark_error.message,
                        "failed to mark office auto delegation dispatch as failed"
                    );
                }
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let (file_path, config) = match self
            .domain_processor
            .office_delegation_dispatch_mark_started_permitted(permitted, &turn_response.turn.id)
            .await
        {
            Ok(update) => update,
            Err(err) => {
                warn!(
                    run_id = %run_id,
                    delegation_id = %delegation_id,
                    turn_id = %turn_response.turn.id,
                    error = %err.message,
                    "failed to mark office auto delegation dispatch as started"
                );
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let started = OfficeAutoDispatchStarted { file_path, config };
        if let Err(err) = self
            .domain_processor
            .office_auto_dispatch_intent_dispatched(
                cwd,
                intent_id,
                source_thread_id,
                &turn.id,
                lease_id,
                OfficeAutoDispatchIntentDispatched {
                    run_id: &run_id,
                    dispatch_kind: "delegation",
                    delegation_id: Some(&delegation_id),
                    verification_check_id: None,
                    file_path: &started.file_path,
                    dispatched_thread_id: &thread_id,
                    dispatched_turn_id: &turn_response.turn.id,
                },
            )
            .await
        {
            warn!(
                thread_id = %source_thread_id,
                turn_id = %turn.id,
                error = %err.message,
                "failed to mark office auto dispatch intent as dispatched"
            );
        }
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                &prepared_cwd,
                &started.file_path,
                &started.config,
                "autoDispatchStarted",
                Some(&thread_id),
                Some(&turn_response.turn.id),
            ))
            .await;
        self.spawn_completion_monitor(
            prepared_cwd,
            thread_id,
            turn_response.turn.id.clone(),
            connection_id,
        );
        Some(started)
    }

    async fn dispatch_verification_after_terminal_turn(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        turn: &Turn,
        connection_id: ConnectionId,
        lease_id: &str,
    ) -> Option<OfficeAutoDispatchStarted> {
        let permitted = match self
            .domain_processor
            .office_auto_verification_dispatch_prepare_after_thread_turn_permitted(
                cwd,
                source_thread_id,
                turn,
            )
            .await
        {
            Ok(Some(permitted)) => permitted,
            Ok(None) => {
                return self
                    .dispatch_retry_after_terminal_turn(
                        cwd,
                        intent_id,
                        source_thread_id,
                        turn,
                        connection_id,
                        lease_id,
                    )
                    .await;
            }
            Err(err) => {
                warn!(
                    thread_id = %source_thread_id,
                    turn_id = %turn.id,
                    error = %err.message,
                    "failed to prepare office auto verification dispatch"
                );
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let (
            prepared_cwd,
            run_id,
            verification_check_id,
            automation_config,
            note,
            locale,
            client_user_message_id,
        ) = {
            let prepared = permitted.prepared();
            (
                prepared.cwd.clone(),
                prepared.run_id.clone(),
                prepared.verification_check_id.clone(),
                prepared.automation_config.clone(),
                prepared.note.clone(),
                prepared.locale.clone(),
                prepared.client_user_message_id.clone(),
            )
        };
        let automation_prepared = match self
            .domain_processor
            .automation_run_start_prepare(AutomationRunStartParams {
                cwd: prepared_cwd.clone(),
                config: automation_config,
                note: Some(note),
                locale,
                client_user_message_id,
            })
            .await
        {
            Ok(prepared) => prepared,
            Err(err) => {
                if let Err(mark_error) = self
                    .domain_processor
                    .office_verification_dispatch_mark_failed_permitted(permitted, &err.message)
                    .await
                {
                    warn!(
                        run_id = %run_id,
                        verification_check_id = %verification_check_id,
                        error = %mark_error.message,
                        "failed to mark office auto verification dispatch as failed"
                    );
                }
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let request_id = ConnectionRequestId {
            connection_id,
            request_id: RequestId::String(format!("office-auto-verification-{}", Uuid::new_v4())),
        };
        let turn_response = match self
            .turn_processor
            .turn_start_response(
                request_id,
                TurnStartParams {
                    thread_id: automation_prepared.thread_id.clone(),
                    client_user_message_id: automation_prepared.client_user_message_id.clone(),
                    input: vec![V2UserInput::Text {
                        text: automation_prepared.prompt.clone(),
                        text_elements: Vec::new(),
                    }],
                    cwd: Some(PathBuf::from(&prepared_cwd)),
                    ..TurnStartParams::default()
                },
                Some("app-server-office-auto-verification".to_string()),
                /*app_server_client_version*/ None,
            )
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let mark_result = if office_auto_verification_start_failure_can_retry(&err.message)
                {
                    self.domain_processor
                        .office_verification_dispatch_mark_retryable_start_failure_permitted(
                            permitted,
                            &err.message,
                        )
                        .await
                } else {
                    self.domain_processor
                        .office_verification_dispatch_mark_failed_permitted(permitted, &err.message)
                        .await
                };
                if let Err(mark_error) = mark_result {
                    warn!(
                        run_id = %run_id,
                        verification_check_id = %verification_check_id,
                        error = %mark_error.message,
                        "failed to mark office auto verification dispatch start failure"
                    );
                }
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let automation_run_response = match self
            .domain_processor
            .automation_run_start_record(&automation_prepared, &turn_response.turn.id)
            .await
        {
            Ok(response) => response,
            Err(err) => {
                if let Err(mark_error) = self
                    .domain_processor
                    .office_verification_dispatch_mark_failed_permitted(permitted, &err.message)
                    .await
                {
                    warn!(
                        run_id = %run_id,
                        verification_check_id = %verification_check_id,
                        error = %mark_error.message,
                        "failed to mark office auto verification dispatch record failure"
                    );
                }
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let (file_path, config) = match self
            .domain_processor
            .office_verification_dispatch_mark_started_permitted(
                permitted,
                OfficeVerificationDispatchStarted {
                    run_id: &run_id,
                    verification_check_id: &verification_check_id,
                    automation_run_file_path: &automation_run_response.file_path,
                    automation_run_id: &automation_run_response.run.run_id,
                    automation_thread_id: &automation_prepared.thread_id,
                    automation_turn_id: &turn_response.turn.id,
                    runtime_repair_source_thread_id: None,
                    runtime_repaired_at: None,
                },
            )
            .await
        {
            Ok(update) => update,
            Err(err) => {
                warn!(
                    run_id = %run_id,
                    verification_check_id = %verification_check_id,
                    turn_id = %turn_response.turn.id,
                    error = %err.message,
                    "failed to mark office auto verification dispatch as started"
                );
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let started = OfficeAutoDispatchStarted { file_path, config };
        if let Err(err) = self
            .domain_processor
            .office_auto_dispatch_intent_dispatched(
                cwd,
                intent_id,
                source_thread_id,
                &turn.id,
                lease_id,
                OfficeAutoDispatchIntentDispatched {
                    run_id: &run_id,
                    dispatch_kind: "verification",
                    delegation_id: None,
                    verification_check_id: Some(&verification_check_id),
                    file_path: &started.file_path,
                    dispatched_thread_id: &automation_prepared.thread_id,
                    dispatched_turn_id: &turn_response.turn.id,
                },
            )
            .await
        {
            warn!(
                thread_id = %source_thread_id,
                turn_id = %turn.id,
                error = %err.message,
                "failed to mark office auto dispatch intent as dispatched"
            );
        }
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                &prepared_cwd,
                &started.file_path,
                &started.config,
                "autoVerificationStarted",
                Some(&automation_prepared.thread_id),
                Some(&turn_response.turn.id),
            ))
            .await;
        self.spawn_completion_monitor(
            prepared_cwd,
            automation_prepared.thread_id.clone(),
            turn_response.turn.id.clone(),
            connection_id,
        );
        Some(started)
    }

    async fn dispatch_retry_after_terminal_turn(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        turn: &Turn,
        connection_id: ConnectionId,
        lease_id: &str,
    ) -> Option<OfficeAutoDispatchStarted> {
        let permitted = match self
            .domain_processor
            .office_auto_retry_prepare_after_thread_turn_permitted(cwd, source_thread_id, turn)
            .await
        {
            Ok(Some(permitted)) => permitted,
            Ok(None) => {
                if let Err(err) = self
                    .domain_processor
                    .office_auto_dispatch_intent_clear(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %err.message,
                        "failed to clear empty office auto dispatch intent"
                    );
                }
                return None;
            }
            Err(err) => {
                warn!(
                    thread_id = %source_thread_id,
                    turn_id = %turn.id,
                    error = %err.message,
                    "failed to prepare office auto replan"
                );
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let (prepared_cwd, run_id, thread_id, client_user_message_id, prompt) = {
            let prepared = permitted.prepared();
            (
                prepared.cwd.clone(),
                prepared.run_id.clone(),
                prepared.thread_id.clone(),
                prepared.client_user_message_id.clone(),
                prepared.prompt.clone(),
            )
        };
        let request_id = ConnectionRequestId {
            connection_id,
            request_id: RequestId::String(format!("office-auto-replan-{}", Uuid::new_v4())),
        };
        let turn_response = match self
            .turn_processor
            .turn_start_response(
                request_id,
                TurnStartParams {
                    thread_id: thread_id.clone(),
                    client_user_message_id,
                    input: vec![V2UserInput::Text {
                        text: prompt,
                        text_elements: Vec::new(),
                    }],
                    cwd: Some(PathBuf::from(&prepared_cwd)),
                    ..TurnStartParams::default()
                },
                Some("app-server-office-auto-replan".to_string()),
                /*app_server_client_version*/ None,
            )
            .await
        {
            Ok(response) => response,
            Err(err) => {
                if let Err(mark_error) = self
                    .domain_processor
                    .office_run_mark_failed_permitted(permitted, &err.message)
                    .await
                {
                    warn!(
                        run_id = %run_id,
                        error = %mark_error.message,
                        "failed to mark office auto replan as failed"
                    );
                }
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let (file_path, config) = match self
            .domain_processor
            .office_run_mark_started_permitted(permitted, &turn_response.turn.id)
            .await
        {
            Ok(update) => update,
            Err(err) => {
                warn!(
                    run_id = %run_id,
                    turn_id = %turn_response.turn.id,
                    error = %err.message,
                    "failed to mark office auto replan as started"
                );
                if let Err(mark_error) = self
                    .domain_processor
                    .office_auto_dispatch_intent_failed(
                        cwd,
                        intent_id,
                        source_thread_id,
                        &turn.id,
                        lease_id,
                        &err.message,
                    )
                    .await
                {
                    warn!(
                        thread_id = %source_thread_id,
                        turn_id = %turn.id,
                        error = %mark_error.message,
                        "failed to mark office auto dispatch intent as failed"
                    );
                }
                return None;
            }
        };
        let started = OfficeAutoDispatchStarted { file_path, config };
        if let Err(err) = self
            .domain_processor
            .office_auto_dispatch_intent_dispatched(
                cwd,
                intent_id,
                source_thread_id,
                &turn.id,
                lease_id,
                OfficeAutoDispatchIntentDispatched {
                    run_id: &run_id,
                    dispatch_kind: "replan",
                    delegation_id: None,
                    verification_check_id: None,
                    file_path: &started.file_path,
                    dispatched_thread_id: &thread_id,
                    dispatched_turn_id: &turn_response.turn.id,
                },
            )
            .await
        {
            warn!(
                thread_id = %source_thread_id,
                turn_id = %turn.id,
                error = %err.message,
                "failed to mark office auto dispatch intent as dispatched"
            );
        }
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                &prepared_cwd,
                &started.file_path,
                &started.config,
                "autoReplanStarted",
                Some(&thread_id),
                Some(&turn_response.turn.id),
            ))
            .await;
        self.spawn_completion_monitor(
            prepared_cwd,
            thread_id,
            turn_response.turn.id.clone(),
            connection_id,
        );
        Some(started)
    }

    pub(crate) fn spawn_completion_monitor(
        &self,
        cwd: String,
        thread_id: String,
        turn_id: String,
        connection_id: ConnectionId,
    ) {
        let context = self.clone();
        tokio::spawn(async move {
            let monitor_key = (cwd.clone(), thread_id.clone(), turn_id.clone());
            {
                let mut completion_monitors = context.completion_monitors.lock().await;
                if !completion_monitors.insert(monitor_key.clone()) {
                    return;
                }
            }
            context
                .monitor_dispatched_turn_completion(cwd, thread_id, turn_id, connection_id)
                .await;
            context
                .completion_monitors
                .lock()
                .await
                .remove(&monitor_key);
        });
    }

    async fn monitor_dispatched_turn_completion(
        &self,
        cwd: String,
        thread_id: String,
        turn_id: String,
        connection_id: ConnectionId,
    ) {
        let conversation_id = match ThreadId::from_string(&thread_id) {
            Ok(conversation_id) => conversation_id,
            Err(err) => {
                warn!(
                    thread_id,
                    turn_id,
                    error = %err,
                    "failed to parse office auto-dispatched thread id"
                );
                return;
            }
        };
        let conversation = match self.thread_manager.get_thread(conversation_id).await {
            Ok(conversation) => conversation,
            Err(err) => {
                warn!(
                    thread_id,
                    turn_id,
                    error = %err,
                    "failed to load office auto-dispatched thread for completion monitor"
                );
                return;
            }
        };

        let monitor_started_at = Instant::now();
        let deadline = monitor_started_at + OFFICE_AUTO_DISPATCH_COMPLETION_TIMEOUT;
        let mut target_turn_seen = false;
        let turn = loop {
            if let Some(turn) = office_turn_from_thread_history(&conversation, &turn_id).await {
                target_turn_seen = true;
                if office_turn_status_is_terminal(&turn.status) {
                    break turn;
                }
            }
            let status = conversation.agent_status().await;
            if office_status_fallback_ready(&status, monitor_started_at.elapsed(), target_turn_seen)
            {
                warn!(
                    thread_id,
                    turn_id,
                    status = ?status,
                    "office auto-dispatched completion monitor could not load terminal turn; using status fallback"
                );
                break office_turn_from_agent_status(&turn_id, &status);
            }
            if Instant::now() >= deadline {
                warn!(
                    thread_id,
                    turn_id, "timed out waiting for office auto-dispatched turn completion"
                );
                return;
            }
            tokio::time::sleep(OFFICE_AUTO_DISPATCH_COMPLETION_POLL_INTERVAL).await;
        };

        match self
            .domain_processor
            .sync_office_run_updates_for_thread_turn(&cwd, &thread_id, &turn)
            .await
        {
            Ok(updates) => {
                for update in updates {
                    self.outgoing
                        .send_server_notification(office_run_updated_notification(
                            &cwd,
                            &update.file_path,
                            &update.config,
                            "autoDispatchCompletion",
                            Some(&thread_id),
                            Some(&turn_id),
                        ))
                        .await;
                }
            }
            Err(err) => {
                warn!(
                    thread_id,
                    turn_id,
                    error = %err.message,
                    "failed to sync office auto-dispatched completion"
                );
                return;
            }
        }

        let _ = self
            .dispatch_after_terminal_turn(&cwd, &thread_id, turn, connection_id)
            .await;
    }
}

fn office_agent_status_allows_completion_fallback(status: &AgentStatus) -> bool {
    matches!(status, AgentStatus::Completed(_) | AgentStatus::Errored(_))
}

fn office_turn_status_is_terminal(status: &TurnStatus) -> bool {
    matches!(
        status,
        TurnStatus::Completed | TurnStatus::Interrupted | TurnStatus::Failed
    )
}

fn office_status_fallback_ready(
    status: &AgentStatus,
    waited: Duration,
    target_turn_seen: bool,
) -> bool {
    target_turn_seen
        && office_agent_status_allows_completion_fallback(status)
        && waited >= OFFICE_AUTO_DISPATCH_STATUS_FALLBACK_DELAY
}

async fn office_turn_from_thread_history(
    conversation: &CrewonThread,
    turn_id: &str,
) -> Option<Turn> {
    let history = conversation
        .load_history(/*include_archived*/ true)
        .await
        .ok()?;
    build_api_turns_from_rollout_items(&history.items)
        .into_iter()
        .find(|turn| turn.id == turn_id)
}

fn office_turn_from_agent_status(turn_id: &str, status: &AgentStatus) -> Turn {
    let (status, error, items) = match status {
        AgentStatus::Completed(message) => (
            TurnStatus::Completed,
            None,
            message
                .as_ref()
                .filter(|message| !message.trim().is_empty())
                .map(|message| {
                    vec![ThreadItem::AgentMessage {
                        id: format!("{turn_id}-final-message"),
                        text: message.clone(),
                        phase: None,
                        memory_citation: None,
                    }]
                })
                .unwrap_or_default(),
        ),
        AgentStatus::Interrupted => (TurnStatus::Interrupted, None, Vec::new()),
        AgentStatus::Errored(message) => (
            TurnStatus::Failed,
            Some(TurnError {
                message: message.clone(),
                codex_error_info: None,
                additional_details: None,
            }),
            Vec::new(),
        ),
        AgentStatus::Shutdown => (
            TurnStatus::Failed,
            Some(TurnError {
                message: "office delegation thread shutdown before completion sync".to_string(),
                codex_error_info: None,
                additional_details: None,
            }),
            Vec::new(),
        ),
        AgentStatus::NotFound => (
            TurnStatus::Failed,
            Some(TurnError {
                message: "office delegation thread not found during completion sync".to_string(),
                codex_error_info: None,
                additional_details: None,
            }),
            Vec::new(),
        ),
        AgentStatus::PendingInit | AgentStatus::Running => {
            (TurnStatus::InProgress, None, Vec::new())
        }
    };
    Turn {
        id: turn_id.to_string(),
        items,
        items_view: TurnItemsView::Full,
        error,
        status,
        started_at: None,
        completed_at: None,
        duration_ms: None,
    }
}

pub(super) fn office_terminal_turn_from_event(
    event_turn_id: &str,
    event: &EventMsg,
) -> Option<Turn> {
    match event {
        EventMsg::TurnComplete(turn) => Some(Turn {
            id: turn.turn_id.clone(),
            items: Vec::new(),
            items_view: TurnItemsView::NotLoaded,
            error: None,
            status: TurnStatus::Completed,
            started_at: None,
            completed_at: turn.completed_at,
            duration_ms: turn.duration_ms,
        }),
        EventMsg::TurnAborted(turn) => Some(Turn {
            id: turn
                .turn_id
                .clone()
                .unwrap_or_else(|| event_turn_id.to_string()),
            items: Vec::new(),
            items_view: TurnItemsView::NotLoaded,
            error: None,
            status: TurnStatus::Interrupted,
            started_at: None,
            completed_at: turn.completed_at,
            duration_ms: turn.duration_ms,
        }),
        _ => None,
    }
}

#[cfg(test)]
#[path = "office_auto_dispatch_tests.rs"]
mod tests;
