use super::*;

impl OfficeAutoDispatchContext {
    pub(super) async fn persisted_turn_for_dispatch_receipt(
        &self,
        cwd: &str,
        thread_id: &str,
        receipt_id: &str,
    ) -> Result<Option<Turn>, JSONRPCErrorError> {
        let conversation_id = ThreadId::from_string(thread_id)
            .map_err(|err| internal_error(format!("invalid Office runtime thread id: {err}")))?;
        let conversation = self
            .thread_manager
            .get_thread(conversation_id)
            .await
            .map_err(|err| {
                internal_error(format!(
                    "failed to load Office runtime thread {thread_id}: {err}"
                ))
            })?;
        conversation.ensure_rollout_materialized().await;
        let history = conversation
            .load_history(/*include_archived*/ true)
            .await
            .map_err(|err| {
                internal_error(format!(
                    "failed to load Office runtime history for {thread_id}: {err}"
                ))
            })?;
        super::office_thread_workspace::ensure_history_matches(cwd, thread_id, &history.items)?;
        let mut matches = build_api_turns_from_rollout_items(&history.items)
            .into_iter()
            .filter(|turn| {
                turn.items.iter().any(|item| {
                    matches!(
                        item,
                        ThreadItem::UserMessage {
                            client_id: Some(client_id),
                            ..
                        } if client_id == receipt_id
                    )
                })
            });
        let matched = matches.next();
        if matches.next().is_some() {
            return Err(internal_error(format!(
                "multiple Office turns matched dispatch receipt {receipt_id}"
            )));
        }
        Ok(matched)
    }

    pub(super) async fn recover_claimed_child_dispatch(
        &self,
        source_thread_id: &str,
        source_turn_id: &str,
        scheduler_lease_id: &str,
        recovery: ClaimedOfficeChildDispatchRecovery,
        connection_id: ConnectionId,
    ) -> Option<OfficeAutoDispatchStarted> {
        match recovery {
            ClaimedOfficeChildDispatchRecovery::Delegation {
                cwd,
                config,
                run_id,
                delegation_id,
                thread_id,
                dispatch_token,
            } => {
                let turn = match self
                    .persisted_turn_for_dispatch_receipt(
                        &cwd,
                        &thread_id,
                        &dispatch_token.receipt_id,
                    )
                    .await
                {
                    Ok(Some(turn)) => turn,
                    Ok(None) => {
                        let message = "queued Office delegation receipt had no persisted turn";
                        let _ = self
                            .domain_processor
                            .office_delegation_dispatch_mark_failed(
                                &cwd,
                                config,
                                &run_id,
                                &delegation_id,
                                &dispatch_token,
                                message,
                            )
                            .await;
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                message,
                            )
                            .await;
                        return None;
                    }
                    Err(err) => {
                        let _ = self
                            .domain_processor
                            .office_delegation_dispatch_mark_failed(
                                &cwd,
                                config,
                                &run_id,
                                &delegation_id,
                                &dispatch_token,
                                &err.message,
                            )
                            .await;
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                &err.message,
                            )
                            .await;
                        return None;
                    }
                };
                let (file_path, config) = match self
                    .domain_processor
                    .office_delegation_dispatch_mark_started(
                        &cwd,
                        config,
                        &run_id,
                        &delegation_id,
                        &dispatch_token,
                        &turn.id,
                    )
                    .await
                {
                    Ok(update) => update,
                    Err(err) => {
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                &err.message,
                            )
                            .await;
                        return None;
                    }
                };
                let started = OfficeAutoDispatchStarted { file_path, config };
                let _ = self
                    .domain_processor
                    .office_auto_dispatch_intent_dispatched(
                        &cwd,
                        source_thread_id,
                        source_turn_id,
                        OfficeAutoDispatchIntentDispatched {
                            lease_id: scheduler_lease_id,
                            run_id: &run_id,
                            dispatch_kind: "delegationRecovery",
                            delegation_id: Some(&delegation_id),
                            verification_check_id: None,
                            file_path: &started.file_path,
                            dispatched_thread_id: &thread_id,
                            dispatched_turn_id: &turn.id,
                        },
                    )
                    .await;
                self.outgoing
                    .send_server_notification(office_run_updated_notification(
                        &cwd,
                        &started.file_path,
                        &started.config,
                        "autoDispatchReceiptRecovered",
                        Some(&thread_id),
                        Some(&turn.id),
                    ))
                    .await;
                self.spawn_completion_monitor(cwd, thread_id, turn.id, connection_id);
                Some(started)
            }
            ClaimedOfficeChildDispatchRecovery::Verification {
                cwd,
                config,
                run_id,
                verification_check_id,
                automation_id,
                automation_thread_id,
                dispatch_token,
            } => {
                let turn = match self
                    .persisted_turn_for_dispatch_receipt(
                        &cwd,
                        &automation_thread_id,
                        &dispatch_token.receipt_id,
                    )
                    .await
                {
                    Ok(Some(turn)) => turn,
                    Ok(None) => {
                        let message = "queued Office verification receipt had no persisted turn";
                        let _ = self
                            .domain_processor
                            .office_verification_dispatch_mark_failed(
                                &cwd,
                                config,
                                &run_id,
                                &verification_check_id,
                                &dispatch_token,
                                message,
                            )
                            .await;
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                message,
                            )
                            .await;
                        return None;
                    }
                    Err(err) => {
                        let _ = self
                            .domain_processor
                            .office_verification_dispatch_mark_failed(
                                &cwd,
                                config,
                                &run_id,
                                &verification_check_id,
                                &dispatch_token,
                                &err.message,
                            )
                            .await;
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                &err.message,
                            )
                            .await;
                        return None;
                    }
                };
                let automation_record = match self
                    .domain_processor
                    .office_automation_read_bound_for_recovery(&cwd, &config, &automation_id)
                    .await
                {
                    Ok(Some(record)) => record,
                    Ok(None) => {
                        let message = "Office automation binding policy skipped receipt recovery";
                        let _ = self
                            .domain_processor
                            .office_verification_dispatch_mark_failed(
                                &cwd,
                                config,
                                &run_id,
                                &verification_check_id,
                                &dispatch_token,
                                message,
                            )
                            .await;
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                message,
                            )
                            .await;
                        return None;
                    }
                    Err(err) => {
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                &err.message,
                            )
                            .await;
                        return None;
                    }
                };
                if automation_record
                    .config
                    .get("threadId")
                    .and_then(serde_json::Value::as_str)
                    != Some(automation_thread_id.as_str())
                {
                    let message = "automation runtime thread changed during receipt recovery";
                    let _ = self
                        .domain_processor
                        .office_verification_dispatch_mark_failed(
                            &cwd,
                            config,
                            &run_id,
                            &verification_check_id,
                            &dispatch_token,
                            message,
                        )
                        .await;
                    let _ = self
                        .domain_processor
                        .office_auto_dispatch_intent_failed(
                            &cwd,
                            source_thread_id,
                            source_turn_id,
                            scheduler_lease_id,
                            message,
                        )
                        .await;
                    return None;
                }
                let automation_prepared = match self
                    .domain_processor
                    .automation_run_start_prepare(AutomationRunStartParams {
                        cwd: cwd.clone(),
                        config: automation_record.config,
                        note: Some("Recovered Office verification dispatch receipt".to_string()),
                        locale: None,
                        client_user_message_id: Some(dispatch_token.receipt_id.clone()),
                    })
                    .await
                {
                    Ok(prepared) => prepared,
                    Err(err) => {
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                &err.message,
                            )
                            .await;
                        return None;
                    }
                };
                let automation_run = match self
                    .domain_processor
                    .automation_run_start_record(&automation_prepared, &turn.id)
                    .await
                {
                    Ok(response) => response,
                    Err(err) => {
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                &err.message,
                            )
                            .await;
                        return None;
                    }
                };
                let (file_path, config) = match self
                    .domain_processor
                    .office_verification_dispatch_mark_started(
                        &cwd,
                        config,
                        OfficeVerificationDispatchStarted {
                            dispatch_token: &dispatch_token,
                            run_id: &run_id,
                            verification_check_id: &verification_check_id,
                            automation_run_file_path: &automation_run.file_path,
                            automation_run_id: &automation_run.run.run_id,
                            automation_thread_id: &automation_thread_id,
                            automation_turn_id: &turn.id,
                            runtime_repair_source_thread_id: automation_prepared
                                .config
                                .get("runtimeRepairSourceThreadId")
                                .and_then(serde_json::Value::as_str),
                            runtime_repaired_at: automation_prepared
                                .config
                                .get("runtimeRepairedAt")
                                .and_then(serde_json::Value::as_str),
                        },
                    )
                    .await
                {
                    Ok(update) => update,
                    Err(err) => {
                        let _ = self
                            .domain_processor
                            .office_auto_dispatch_intent_failed(
                                &cwd,
                                source_thread_id,
                                source_turn_id,
                                scheduler_lease_id,
                                &err.message,
                            )
                            .await;
                        return None;
                    }
                };
                let started = OfficeAutoDispatchStarted { file_path, config };
                let _ = self
                    .domain_processor
                    .office_auto_dispatch_intent_dispatched(
                        &cwd,
                        source_thread_id,
                        source_turn_id,
                        OfficeAutoDispatchIntentDispatched {
                            lease_id: scheduler_lease_id,
                            run_id: &run_id,
                            dispatch_kind: "verificationRecovery",
                            delegation_id: None,
                            verification_check_id: Some(&verification_check_id),
                            file_path: &started.file_path,
                            dispatched_thread_id: &automation_thread_id,
                            dispatched_turn_id: &turn.id,
                        },
                    )
                    .await;
                self.outgoing
                    .send_server_notification(office_run_updated_notification(
                        &cwd,
                        &started.file_path,
                        &started.config,
                        "autoVerificationReceiptRecovered",
                        Some(&automation_thread_id),
                        Some(&turn.id),
                    ))
                    .await;
                self.spawn_completion_monitor(cwd, automation_thread_id, turn.id, connection_id);
                Some(started)
            }
        }
    }
}
