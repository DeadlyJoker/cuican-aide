use crewon_core::UserInputOnceState;

use super::crewon_domain_office_dispatch_receipt::OfficeDispatchAdmissionState;
use super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptStatus;
use super::office_auto_dispatch_durable::DurableAutoDelegationAttempt;
use super::office_auto_dispatch_durable::DurableAutoDelegationParams;
use super::*;

pub(crate) enum OfficeAutoDispatchRecovery {
    NotFound,
    Handled(Option<OfficeAutoDispatchStarted>),
}

impl OfficeAutoDispatchContext {
    pub(crate) async fn recover_durable_auto_delegation(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        source_turn_id: &str,
        lease_id: &str,
        connection_id: ConnectionId,
    ) -> Result<OfficeAutoDispatchRecovery, JSONRPCErrorError> {
        let Some(scanned) = self
            .domain_processor
            .office_auto_delegation_dispatch_recovery_scan(
                cwd,
                intent_id,
                source_thread_id,
                source_turn_id,
            )
            .await?
        else {
            return Ok(OfficeAutoDispatchRecovery::NotFound);
        };
        let recovery = scanned.recovery;
        match recovery.status {
            OfficeDispatchReceiptStatus::ExecutionUnknown => {
                let (turn_id, state) = execution_unknown_identity(&recovery)?;
                self.quarantine_execution_unknown(
                    cwd,
                    &scanned.file_path,
                    &recovery,
                    lease_id,
                    turn_id,
                    state,
                )
                .await
            }
            OfficeDispatchReceiptStatus::Starting => {
                let permitted = self
                    .domain_processor
                    .office_auto_delegation_dispatch_recovery_prepare_permitted(
                        cwd,
                        &scanned.file_path,
                        &recovery,
                    )
                    .await?;
                let prepared = permitted.prepared();
                let params = DurableAutoDelegationParams {
                    attempt: DurableAutoDelegationAttempt::Recovery,
                    cwd,
                    intent_id,
                    source_thread_id,
                    source_turn_id,
                    lease_id,
                    prepared_cwd: prepared.cwd.clone(),
                    run_id: prepared.run_id.clone(),
                    delegation_id: prepared.delegation_id.clone(),
                    thread_id: prepared.thread_id.clone(),
                    prompt: prepared.prompt.clone(),
                    connection_id,
                    permitted,
                };
                Ok(OfficeAutoDispatchRecovery::Handled(
                    self.dispatch_durable_auto_delegation(params).await,
                ))
            }
            OfficeDispatchReceiptStatus::Admitted | OfficeDispatchReceiptStatus::Started => {
                let (turn_id, state) = execution_unknown_identity(&recovery)?;
                if self
                    .has_exact_execution_evidence(cwd, &recovery, turn_id)
                    .await?
                {
                    self.attach_admitted_recovery(
                        cwd,
                        &scanned.file_path,
                        &recovery,
                        lease_id,
                        connection_id,
                    )
                    .await
                } else {
                    self.quarantine_execution_unknown(
                        cwd,
                        &scanned.file_path,
                        &recovery,
                        lease_id,
                        turn_id,
                        state,
                    )
                    .await
                }
            }
            OfficeDispatchReceiptStatus::Failed => {
                self.domain_processor
                    .office_auto_dispatch_recovery_failed(
                        cwd,
                        &scanned.file_path,
                        &recovery,
                        lease_id,
                    )
                    .await?;
                Ok(OfficeAutoDispatchRecovery::Handled(None))
            }
        }
    }

    pub(super) async fn has_exact_execution_evidence(
        &self,
        cwd: &str,
        recovery: &crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
        turn_id: &str,
    ) -> Result<bool, JSONRPCErrorError> {
        if self
            .turn_processor
            .is_exact_turn_active_in_current_runtime(&recovery.target_thread_id, turn_id)
            .await?
        {
            return Ok(true);
        }
        let persisted = self
            .persisted_turn_for_durable_receipt(
                cwd,
                &recovery.target_thread_id,
                &recovery.client_user_message_id,
            )
            .await?;
        if persisted.as_ref().is_some_and(|turn| turn.id != turn_id) {
            return Ok(false);
        };
        let terminal = persisted
            .as_ref()
            .is_some_and(|turn| durable_turn_status_is_terminal(&turn.status));
        Ok(terminal)
    }

    async fn persisted_turn_for_durable_receipt(
        &self,
        cwd: &str,
        thread_id: &str,
        receipt_id: &str,
    ) -> Result<Option<Turn>, JSONRPCErrorError> {
        super::office_persisted_turn::for_dispatch_receipt(
            &self.turn_processor.thread_store,
            cwd,
            thread_id,
            receipt_id,
        )
        .await
    }

    async fn attach_admitted_recovery(
        &self,
        cwd: &str,
        file_path: &str,
        recovery: &crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
        lease_id: &str,
        connection_id: ConnectionId,
    ) -> Result<OfficeAutoDispatchRecovery, JSONRPCErrorError> {
        let reloaded = self
            .domain_processor
            .office_auto_dispatch_recovery_admitted(cwd, file_path, recovery, lease_id)
            .await?;
        let turn_id = reloaded.recovery.turn_id.clone().ok_or_else(|| {
            invalid_request("Office durable recovery is missing its admitted turn")
        })?;
        let admitted = OfficeAutoDispatchStarted {
            file_path: reloaded.file_path,
            config: reloaded.config,
        };
        self.notify_and_monitor_recovery(cwd, &admitted, recovery, &turn_id, connection_id)
            .await;
        Ok(OfficeAutoDispatchRecovery::Handled(Some(admitted)))
    }

    async fn notify_and_monitor_recovery(
        &self,
        cwd: &str,
        admitted: &OfficeAutoDispatchStarted,
        recovery: &crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
        turn_id: &str,
        connection_id: ConnectionId,
    ) {
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                cwd,
                &admitted.file_path,
                &admitted.config,
                "autoDispatchRecovered",
                Some(&recovery.target_thread_id),
                Some(turn_id),
            ))
            .await;
        self.spawn_completion_monitor(
            cwd.to_string(),
            recovery.target_thread_id.clone(),
            turn_id.to_string(),
            connection_id,
        );
    }

    async fn quarantine_execution_unknown(
        &self,
        cwd: &str,
        file_path: &str,
        recovery: &crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
        lease_id: &str,
        turn_id: &str,
        state: UserInputOnceState,
    ) -> Result<OfficeAutoDispatchRecovery, JSONRPCErrorError> {
        let quarantined = self
            .domain_processor
            .office_auto_dispatch_quarantine_execution_unknown(
                cwd, file_path, recovery, lease_id, turn_id, state,
            )
            .await?;
        self.outgoing
            .send_server_notification(office_run_updated_notification(
                cwd,
                &quarantined.file_path,
                &quarantined.config,
                "autoDispatchExecutionUnknown",
                Some(&quarantined.recovery.target_thread_id),
                quarantined.recovery.turn_id.as_deref(),
            ))
            .await;
        Ok(OfficeAutoDispatchRecovery::Handled(None))
    }
}

fn execution_unknown_identity(
    recovery: &crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
) -> Result<(&str, UserInputOnceState), JSONRPCErrorError> {
    let turn_id = recovery
        .turn_id
        .as_deref()
        .ok_or_else(|| invalid_request("Office durable recovery is missing its admitted turn"))?;
    let state = match recovery.admission_state {
        Some(OfficeDispatchAdmissionState::AdmissionOnly) => UserInputOnceState::AdmissionOnly,
        Some(OfficeDispatchAdmissionState::Persisted) => UserInputOnceState::Persisted,
        None => {
            return Err(invalid_request(
                "Office durable recovery is missing its admission state",
            ));
        }
    };
    Ok((turn_id, state))
}

fn durable_turn_status_is_terminal(status: &TurnStatus) -> bool {
    matches!(
        status,
        TurnStatus::Completed | TurnStatus::Interrupted | TurnStatus::Failed
    )
}
