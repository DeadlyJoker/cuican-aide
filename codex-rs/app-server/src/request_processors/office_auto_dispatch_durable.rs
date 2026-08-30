use super::*;

pub(crate) struct DurableAutoDelegationParams<'a> {
    pub(crate) attempt: DurableAutoDelegationAttempt,
    pub(crate) cwd: &'a str,
    pub(crate) intent_id: &'a str,
    pub(crate) source_thread_id: &'a str,
    pub(crate) source_turn_id: &'a str,
    pub(crate) lease_id: &'a str,
    pub(crate) prepared_cwd: String,
    pub(crate) run_id: String,
    pub(crate) delegation_id: String,
    pub(crate) thread_id: String,
    pub(crate) prompt: String,
    pub(crate) connection_id: ConnectionId,
    pub(crate) permitted: PermittedOfficeDelegationDispatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DurableAutoDelegationAttempt {
    New,
    Recovery,
}

impl OfficeAutoDispatchContext {
    pub(crate) async fn dispatch_durable_auto_delegation(
        &self,
        params: DurableAutoDelegationParams<'_>,
    ) -> Option<OfficeAutoDispatchStarted> {
        let DurableAutoDelegationParams {
            attempt,
            cwd,
            intent_id,
            source_thread_id,
            source_turn_id,
            lease_id,
            prepared_cwd,
            run_id,
            delegation_id,
            thread_id,
            prompt,
            connection_id,
            mut permitted,
        } = params;
        let expected_cwd = match resolve_request_cwd(Some(PathBuf::from(&prepared_cwd))) {
            Ok(Some(cwd)) => cwd,
            Ok(None) => {
                let message = "Office durable dispatch cwd is unavailable";
                if let Err(error) = self
                    .domain_processor
                    .office_delegation_dispatch_mark_failed_permitted(permitted, message)
                    .await
                {
                    warn!(
                        run_id = %run_id,
                        delegation_id = %delegation_id,
                        error = %error.message,
                        "failed to close Office dispatch after cwd validation failed"
                    );
                    return None;
                }
                self.fail_durable_auto_delegation_intent(
                    cwd,
                    intent_id,
                    source_thread_id,
                    source_turn_id,
                    lease_id,
                    message,
                )
                .await;
                return None;
            }
            Err(error) => {
                let message = error.message;
                if let Err(mark_error) = self
                    .domain_processor
                    .office_delegation_dispatch_mark_failed_permitted(permitted, &message)
                    .await
                {
                    warn!(
                        run_id = %run_id,
                        delegation_id = %delegation_id,
                        error = %mark_error.message,
                        "failed to close Office dispatch after cwd validation failed"
                    );
                    return None;
                }
                self.fail_durable_auto_delegation_intent(
                    cwd,
                    intent_id,
                    source_thread_id,
                    source_turn_id,
                    lease_id,
                    &message,
                )
                .await;
                return None;
            }
        };
        if crewon_domain_office_dispatch_receipt::validate_prompt_snapshot(&prompt).is_err() {
            let message = "Office durable dispatch prompt is invalid";
            if let Err(error) = self
                .domain_processor
                .office_delegation_dispatch_mark_failed_permitted(permitted, message)
                .await
            {
                warn!(
                    run_id = %run_id,
                    delegation_id = %delegation_id,
                    error = %error.message,
                    "failed to close Office dispatch after prompt validation failed"
                );
                return None;
            }
            self.fail_durable_auto_delegation_intent(
                cwd,
                intent_id,
                source_thread_id,
                source_turn_id,
                lease_id,
                message,
            )
            .await;
            return None;
        }
        let record_id = permitted.record_id().to_string();
        let token = crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken {
            record_id: &record_id,
            intent_id,
            source_thread_id,
            source_turn_id,
            run_id: &run_id,
            delegation_id: &delegation_id,
            target_thread_id: &thread_id,
            prompt: &prompt,
        };
        let receipt = match self
            .domain_processor
            .office_auto_delegation_reserve_starting(&mut permitted, token)
            .await
        {
            Ok(receipt) => receipt,
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    delegation_id = %delegation_id,
                    error = %error.message,
                    "Office durable dispatch receipt reserve is ambiguous"
                );
                drop(permitted);
                return None;
            }
        };

        let request_id = ConnectionRequestId {
            connection_id,
            request_id: RequestId::String(format!("office-auto-delegation-{}", Uuid::new_v4())),
        };
        let repeated_receipt = receipt.reserve_count > 1;
        let receipt_client_id = receipt.client_user_message_id.clone();
        let outcome = match self
            .turn_processor
            .start_office_durable_turn(
                &request_id,
                OfficeDurableTurnParams {
                    thread_id: thread_id.clone(),
                    client_id: receipt.client_user_message_id,
                    payload_hash: receipt.payload_hash,
                    prompt: prompt.clone(),
                    expected_cwd,
                    existing_policy: crewon_core::ExistingUserInputOncePolicy::StartIfNotStarted,
                },
            )
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                let certainty = error.certainty();
                warn!(
                    run_id = %run_id,
                    delegation_id = %delegation_id,
                    certainty = ?certainty,
                    error = %error,
                    "failed to establish durable Office delegation admission"
                );
                if attempt == DurableAutoDelegationAttempt::Recovery
                    || repeated_receipt
                    || certainty == OfficeDurableAdmissionCertainty::Ambiguous
                {
                    drop(permitted);
                    return None;
                }
                let message = error.to_string();
                let failed = match self
                    .domain_processor
                    .office_auto_delegation_fail_starting(permitted, token, &message)
                    .await
                {
                    Ok(failed) => failed,
                    Err(mark_error) => {
                        warn!(
                            run_id = %run_id,
                            delegation_id = %delegation_id,
                            error = %mark_error.message,
                            "failed to close a definitely rejected Office durable admission"
                        );
                        return None;
                    }
                };
                self.fail_durable_auto_delegation_intent(
                    cwd,
                    intent_id,
                    source_thread_id,
                    source_turn_id,
                    lease_id,
                    &message,
                )
                .await;
                self.outgoing
                    .send_server_notification(office_run_updated_notification(
                        &prepared_cwd,
                        &failed.0,
                        &failed.1,
                        "autoDispatchFailed",
                        Some(&thread_id),
                        None,
                    ))
                    .await;
                return None;
            }
        };

        tracing::debug!(
            run_id = %run_id,
            delegation_id = %delegation_id,
            already_accepted = outcome.already_accepted,
            "established durable Office delegation admission"
        );
        let turn_id = outcome.turn.id.clone();
        if outcome.already_accepted {
            let current =
                match crewon_domain_office_dispatch_recovery::locate_office_dispatch_recovery(
                    &permitted.prepared().config,
                    intent_id,
                    source_thread_id,
                    source_turn_id,
                ) {
                    Ok(Some(current)) => current,
                    Ok(None) => {
                        warn!(
                            run_id = %run_id,
                            delegation_id = %delegation_id,
                            "Office durable recovery receipt disappeared before execution classification"
                        );
                        drop(permitted);
                        return None;
                    }
                    Err(_) => {
                        warn!(
                            run_id = %run_id,
                            delegation_id = %delegation_id,
                            "Office durable recovery receipt became corrupt before execution classification"
                        );
                        drop(permitted);
                        return None;
                    }
                };
            let can_attach = match self
                .has_exact_execution_evidence(cwd, &current, &turn_id)
                .await
            {
                Ok(can_attach) => can_attach,
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        delegation_id = %delegation_id,
                        turn_id = %turn_id,
                        error = %error.message,
                        "failed to classify existing Office durable execution"
                    );
                    drop(permitted);
                    return None;
                }
            };
            if !can_attach {
                let quarantined = match self
                    .domain_processor
                    .office_auto_delegation_quarantine_execution_unknown(
                        permitted,
                        token,
                        &turn_id,
                        outcome.state,
                        lease_id,
                    )
                    .await
                {
                    Ok(quarantined) => quarantined,
                    Err(error) => {
                        warn!(
                            run_id = %run_id,
                            delegation_id = %delegation_id,
                            turn_id = %turn_id,
                            error = %error.message,
                            "failed to quarantine unknown Office durable execution"
                        );
                        return None;
                    }
                };
                self.outgoing
                    .send_server_notification(office_run_updated_notification(
                        &prepared_cwd,
                        &quarantined.file_path,
                        &quarantined.config,
                        "autoDispatchExecutionUnknown",
                        Some(&thread_id),
                        Some(&turn_id),
                    ))
                    .await;
                return None;
            }
            tracing::debug!(
                receipt_id = %receipt_client_id,
                turn_id = %turn_id,
                "recovered Office durable execution has exact active or terminal evidence"
            );
        }
        let (file_path, config, _) = match self
            .domain_processor
            .office_auto_delegation_commit_admitted(permitted, token, &turn_id, outcome.state)
            .await
        {
            Ok(committed) => committed,
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    delegation_id = %delegation_id,
                    turn_id = %turn_id,
                    error = %error.message,
                    "durable Office admission was established but its receipt commit failed"
                );
                return None;
            }
        };
        let admitted = OfficeAutoDispatchStarted { file_path, config };
        if let Err(error) = self
            .domain_processor
            .office_auto_dispatch_intent_dispatched(
                cwd,
                intent_id,
                source_thread_id,
                source_turn_id,
                lease_id,
                OfficeAutoDispatchIntentDispatched {
                    run_id: &run_id,
                    dispatch_kind: "delegation",
                    delegation_id: Some(&delegation_id),
                    verification_check_id: None,
                    file_path: &admitted.file_path,
                    dispatched_thread_id: &thread_id,
                    dispatched_turn_id: &turn_id,
                },
            )
            .await
        {
            warn!(
                thread_id = %source_thread_id,
                turn_id = %source_turn_id,
                error = %error.message,
                "failed to mark durable Office dispatch intent as admitted"
            );
        }
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                &prepared_cwd,
                &admitted.file_path,
                &admitted.config,
                "autoDispatchAdmitted",
                Some(&thread_id),
                Some(&turn_id),
            ))
            .await;
        self.spawn_completion_monitor(prepared_cwd, thread_id, turn_id, connection_id);
        Some(admitted)
    }

    async fn fail_durable_auto_delegation_intent(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        source_turn_id: &str,
        lease_id: &str,
        message: &str,
    ) {
        if let Err(error) = self
            .domain_processor
            .office_auto_dispatch_intent_failed(
                cwd,
                intent_id,
                source_thread_id,
                source_turn_id,
                lease_id,
                message,
            )
            .await
        {
            warn!(
                thread_id = %source_thread_id,
                turn_id = %source_turn_id,
                error = %error.message,
                "failed to mark durable Office dispatch intent as failed"
            );
        }
    }
}
