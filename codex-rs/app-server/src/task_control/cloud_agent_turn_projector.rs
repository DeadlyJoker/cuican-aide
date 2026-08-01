use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use crewon_state::CloudAgentProviderEventRef;
use crewon_state::CloudAgentTurnBeginFinalizationRequest;
use crewon_state::CloudAgentTurnCancellationProjectionRequest;
use crewon_state::CloudAgentTurnCompleteRequest;
use crewon_state::CloudAgentTurnFinalizationRecord;
use crewon_state::CloudAgentTurnFinalizationRetryRequest;
use crewon_state::CloudAgentTurnProjectionOutcome;
use crewon_state::CloudAgentTurnProjectionRequest;
use crewon_state::CloudAgentTurnProjectionStatus;
use crewon_state::CloudAgentTurnResultUnavailableRequest;
use crewon_state::ProviderRunEventProjection;
use crewon_state::ProviderRunFailureCode;
use crewon_state::ProviderRunJournalEventPageQuery;
use crewon_state::ProviderRunJournalEventRecord;
use crewon_state::StateRuntime;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::cloud_agent_result_reader::CloudAgentResultArtifactReader;
use super::cloud_agent_result_reader::ProductionCloudAgentResultArtifactReader;
use super::cloud_agent_turn_projector_output::CloudAgentOutputFinalizationError;
use super::cloud_agent_turn_projector_output::finalize_cloud_agent_outputs;
use super::provider_control_production::unix_now;
use super::provider_run_artifact_importer::ProviderRunOutputArtifactImporter;
use super::provider_run_artifact_importer::StateProviderRunOutputArtifactImporter;
use crate::platform_control::provider_connection_production::AgentPlatformProviderDescriptorFactory;

const PROJECTION_LIMIT: u32 = 16;
const EVENT_PAGE_LIMIT: u32 = 16;
const MAX_FINALIZATION_ATTEMPTS: u32 = 5;
const PROJECTOR_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CloudAgentTurnProjectorReport {
    inspected: u32,
    projected: u32,
    finalizing: u32,
    completed: u32,
    result_unavailable: u32,
    deferred: u32,
    duplicates: u32,
    conflicts: u32,
}

struct CloudAgentTurnProjector<Reader, Importer> {
    state: Arc<StateRuntime>,
    reader: Arc<Reader>,
    importer: Arc<Importer>,
    notification_tx: Option<mpsc::Sender<CloudAgentTurnTerminalNotice>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloudAgentTurnTerminalNotice {
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) revision: u64,
}

impl<Reader, Importer> CloudAgentTurnProjector<Reader, Importer>
where
    Reader: CloudAgentResultArtifactReader,
    Importer: ProviderRunOutputArtifactImporter,
{
    fn new(state: Arc<StateRuntime>, reader: Arc<Reader>, importer: Arc<Importer>) -> Self {
        Self {
            state,
            reader,
            importer,
            notification_tx: None,
        }
    }

    fn with_notification_sender(
        mut self,
        notification_tx: mpsc::Sender<CloudAgentTurnTerminalNotice>,
    ) -> Self {
        self.notification_tx = Some(notification_tx);
        self
    }

    async fn run_once(
        &self,
        now: i64,
    ) -> Result<CloudAgentTurnProjectorReport, CloudAgentTurnProjectorError> {
        if now < 0 {
            return Err(CloudAgentTurnProjectorError::InvalidTime);
        }
        let mut report = CloudAgentTurnProjectorReport::default();
        let cancellation_candidates = self
            .state
            .list_cloud_agent_turn_cancellation_candidates(PROJECTION_LIMIT)
            .await
            .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
        for candidate in cancellation_candidates {
            report.inspected += 1;
            let outcome = self
                .state
                .project_cloud_agent_turn_cancellation(
                    &CloudAgentTurnCancellationProjectionRequest {
                        turn_id: candidate.turn_id.clone(),
                        task_id: candidate.task_id,
                        projected_at: now,
                    },
                )
                .await
                .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
            record_outcome(outcome, &mut report)?;
            if outcome == CloudAgentTurnProjectionOutcome::Applied {
                report.projected += 1;
                self.notify_terminal_turn(&candidate.turn_id).await;
            }
        }
        let candidates = self
            .state
            .list_cloud_agent_turn_projection_candidates(now, PROJECTION_LIMIT)
            .await
            .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
        for candidate in candidates {
            report.inspected += 1;
            if let Some(finalization) = candidate.finalization {
                self.finalize(&finalization, now, &mut report).await?;
                continue;
            }
            let page = self
                .state
                .read_provider_run_journal_event_page(&ProviderRunJournalEventPageQuery {
                    key: candidate.key.clone(),
                    after_sequence: candidate.last_provider_sequence,
                    limit: EVENT_PAGE_LIMIT,
                })
                .await
                .map_err(|_| CloudAgentTurnProjectorError::InvalidProjection)?
                .ok_or(CloudAgentTurnProjectorError::InvalidProjection)?;
            for event in page.events {
                let terminal = self
                    .project_event(
                        &candidate.turn_id,
                        &candidate.provider_run_id,
                        &candidate.key,
                        event,
                        now,
                        &mut report,
                    )
                    .await?;
                if terminal {
                    break;
                }
            }
        }
        Ok(report)
    }

    async fn project_event(
        &self,
        turn_id: &str,
        provider_run_id: &str,
        key: &crewon_state::ProviderRunJournalKey,
        event: ProviderRunJournalEventRecord,
        now: i64,
        report: &mut CloudAgentTurnProjectorReport,
    ) -> Result<bool, CloudAgentTurnProjectorError> {
        let event_ref = CloudAgentProviderEventRef {
            key: key.clone(),
            provider_run_id: provider_run_id.to_string(),
            event_id: event.event_id.clone(),
            sequence: event.sequence,
            payload_digest: event.projection.payload_digest.clone(),
        };
        let projection = event
            .projection
            .decode(&event.event_type, &key.task_id)
            .map_err(|_| CloudAgentTurnProjectorError::InvalidProjection)?;
        if matches!(projection, ProviderRunEventProjection::Completed { .. }) {
            let outcome = self
                .state
                .begin_cloud_agent_turn_finalization(&CloudAgentTurnBeginFinalizationRequest {
                    turn_id: turn_id.to_string(),
                    event: event_ref,
                    available_at: now,
                })
                .await
                .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
            let accepted = record_outcome(outcome, report)?;
            if outcome == CloudAgentTurnProjectionOutcome::Applied {
                report.finalizing += 1;
            }
            if !accepted {
                return Ok(true);
            }
            let finalization = self
                .state
                .get_cloud_agent_turn_finalization_record(turn_id)
                .await
                .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?
                .ok_or(CloudAgentTurnProjectorError::InvalidProjection)?;
            self.finalize(&finalization, now, report).await?;
            return Ok(true);
        }
        let (status, error_code, trace_id, terminal) = projection_state(&projection);
        let outcome = self
            .state
            .apply_cloud_agent_turn_projection(&CloudAgentTurnProjectionRequest {
                turn_id: turn_id.to_string(),
                event: event_ref,
                status,
                error_code,
                trace_id,
                projected_at: now,
            })
            .await
            .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
        let accepted = record_outcome(outcome, report)?;
        if outcome == CloudAgentTurnProjectionOutcome::Applied {
            report.projected += 1;
            if terminal {
                self.notify_terminal_turn(turn_id).await;
            }
        }
        Ok(terminal || !accepted)
    }

    async fn finalize(
        &self,
        finalization: &CloudAgentTurnFinalizationRecord,
        now: i64,
        report: &mut CloudAgentTurnProjectorReport,
    ) -> Result<(), CloudAgentTurnProjectorError> {
        match finalize_cloud_agent_outputs(
            &self.state,
            &self.reader,
            &self.importer,
            finalization,
            now,
        )
        .await
        {
            Ok(outputs) => {
                let outcome = self
                    .state
                    .complete_cloud_agent_turn_finalization(&CloudAgentTurnCompleteRequest {
                        turn_id: finalization.turn_id.clone(),
                        event: finalization.event.clone(),
                        expected_attempts: finalization.attempts,
                        primary_output_artifact: outputs.primary,
                        additional_output_artifacts: outputs.additional,
                        completed_at: now,
                    })
                    .await
                    .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
                record_outcome(outcome, report)?;
                if outcome == CloudAgentTurnProjectionOutcome::Applied {
                    report.completed += 1;
                    self.notify_terminal_turn(&finalization.turn_id).await;
                }
                Ok(())
            }
            Err(error) => {
                self.handle_finalization_error(finalization, error, now, report)
                    .await
            }
        }
    }

    async fn handle_finalization_error(
        &self,
        finalization: &CloudAgentTurnFinalizationRecord,
        error: CloudAgentOutputFinalizationError,
        now: i64,
        report: &mut CloudAgentTurnProjectorReport,
    ) -> Result<(), CloudAgentTurnProjectorError> {
        let retry_error_code = match error {
            CloudAgentOutputFinalizationError::InvalidProjection => "resultInvalid",
            CloudAgentOutputFinalizationError::AuthorityRevoked => "authorityRevoked",
            CloudAgentOutputFinalizationError::PermanentlyUnavailable => "resultUnavailable",
            CloudAgentOutputFinalizationError::TemporarilyUnavailable => "temporarilyUnavailable",
        };
        let next_attempt = finalization.attempts.saturating_add(1);
        let terminal = error != CloudAgentOutputFinalizationError::TemporarilyUnavailable
            || next_attempt >= MAX_FINALIZATION_ATTEMPTS;
        if terminal {
            let outcome = self
                .state
                .mark_cloud_agent_turn_result_unavailable(&CloudAgentTurnResultUnavailableRequest {
                    turn_id: finalization.turn_id.clone(),
                    event: finalization.event.clone(),
                    expected_attempts: finalization.attempts,
                    final_attempts: next_attempt,
                    error_code: "resultUnavailable".to_string(),
                    completed_at: now,
                })
                .await
                .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
            record_outcome(outcome, report)?;
            if outcome == CloudAgentTurnProjectionOutcome::Applied {
                report.result_unavailable += 1;
                self.notify_terminal_turn(&finalization.turn_id).await;
            }
            return Ok(());
        }
        let available_at = now
            .checked_add(retry_delay_seconds(next_attempt))
            .ok_or(CloudAgentTurnProjectorError::InvalidTime)?;
        let outcome = self
            .state
            .reschedule_cloud_agent_turn_finalization(&CloudAgentTurnFinalizationRetryRequest {
                turn_id: finalization.turn_id.clone(),
                event: finalization.event.clone(),
                expected_attempts: finalization.attempts,
                available_at,
                error_code: retry_error_code.to_string(),
                updated_at: now,
            })
            .await
            .map_err(|_| CloudAgentTurnProjectorError::StateUnavailable)?;
        record_outcome(outcome, report)?;
        if outcome == CloudAgentTurnProjectionOutcome::Applied {
            report.deferred += 1;
        }
        Ok(())
    }

    async fn notify_terminal_turn(&self, turn_id: &str) {
        let Some(notification_tx) = self.notification_tx.as_ref() else {
            return;
        };
        let turn = match self.state.get_cloud_agent_turn_record(turn_id).await {
            Ok(Some(turn)) if turn.status.is_terminal() => turn,
            Ok(Some(_)) | Ok(None) => {
                warn!(
                    turn_id,
                    "Cloud Agent terminal notification fact was not durable"
                );
                return;
            }
            Err(error) => {
                warn!(turn_id, %error, "failed to read Cloud Agent terminal notification fact");
                return;
            }
        };
        let notice = CloudAgentTurnTerminalNotice {
            thread_id: turn.thread_id,
            turn_id: turn.turn_id,
            revision: turn.revision,
        };
        if let Err(error) = notification_tx.try_send(notice) {
            warn!(%error, "dropping ephemeral Cloud Agent terminal notification; durable read remains authoritative");
        }
    }
}

pub(crate) fn start_cloud_agent_turn_projector(
    state: Arc<StateRuntime>,
    factory: Arc<AgentPlatformProviderDescriptorFactory>,
    notification_tx: mpsc::Sender<CloudAgentTurnTerminalNotice>,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let reader = Arc::new(ProductionCloudAgentResultArtifactReader::new(
            state.clone(),
            factory,
        ));
        let importer = Arc::new(StateProviderRunOutputArtifactImporter::new(state.clone()));
        let projector = CloudAgentTurnProjector::new(state, reader, importer)
            .with_notification_sender(notification_tx);
        loop {
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                result = projector.run_once(unix_now()) => {
                    if let Err(error) = result {
                        warn!(%error, "Cloud Agent Turn projector tick failed");
                    }
                }
            }
            tokio::select! {
                biased;
                () = shutdown.cancelled() => break,
                () = tokio::time::sleep(PROJECTOR_INTERVAL) => {}
            }
        }
    })
}

fn projection_state(
    projection: &ProviderRunEventProjection,
) -> (
    CloudAgentTurnProjectionStatus,
    Option<String>,
    Option<String>,
    bool,
) {
    match projection {
        ProviderRunEventProjection::RunStarted { .. }
        | ProviderRunEventProjection::Progress { .. } => {
            (CloudAgentTurnProjectionStatus::Running, None, None, false)
        }
        ProviderRunEventProjection::ApprovalRequired { .. }
        | ProviderRunEventProjection::ToolResultRequired { .. }
        | ProviderRunEventProjection::ToolResultAccepted { .. } => {
            (CloudAgentTurnProjectionStatus::Suspended, None, None, false)
        }
        ProviderRunEventProjection::Failed {
            code: ProviderRunFailureCode::UnknownOutcome,
            ..
        } => (CloudAgentTurnProjectionStatus::Running, None, None, false),
        ProviderRunEventProjection::Failed { code, trace_id, .. } => (
            CloudAgentTurnProjectionStatus::Failed,
            Some(failure_code(*code).to_string()),
            Some(trace_id.clone()),
            true,
        ),
        ProviderRunEventProjection::Cancelled { .. } => {
            (CloudAgentTurnProjectionStatus::Cancelled, None, None, true)
        }
        ProviderRunEventProjection::Completed { .. } => unreachable!("completed handled earlier"),
    }
}

fn record_outcome(
    outcome: CloudAgentTurnProjectionOutcome,
    report: &mut CloudAgentTurnProjectorReport,
) -> Result<bool, CloudAgentTurnProjectorError> {
    match outcome {
        CloudAgentTurnProjectionOutcome::Applied => return Ok(true),
        CloudAgentTurnProjectionOutcome::Duplicate => {
            report.duplicates += 1;
            return Ok(true);
        }
        CloudAgentTurnProjectionOutcome::Conflict => report.conflicts += 1,
        CloudAgentTurnProjectionOutcome::NotFound => {
            return Err(CloudAgentTurnProjectorError::InvalidProjection);
        }
    }
    Ok(false)
}

const fn retry_delay_seconds(attempt: u32) -> i64 {
    match attempt {
        0 | 1 => 1,
        2 => 5,
        3 => 30,
        _ => 60,
    }
}

const fn failure_code(code: ProviderRunFailureCode) -> &'static str {
    match code {
        ProviderRunFailureCode::InvalidRequest => "invalidRequest",
        ProviderRunFailureCode::Unauthorized => "unauthorized",
        ProviderRunFailureCode::Forbidden => "forbidden",
        ProviderRunFailureCode::NotFound => "notFound",
        ProviderRunFailureCode::Conflict => "conflict",
        ProviderRunFailureCode::CapabilityUnsupported => "capabilityUnsupported",
        ProviderRunFailureCode::ProviderUnavailable => "providerUnavailable",
        ProviderRunFailureCode::Timeout => "timeout",
        ProviderRunFailureCode::UnknownOutcome => "unknownOutcome",
        ProviderRunFailureCode::Internal => "internal",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudAgentTurnProjectorError {
    InvalidTime,
    InvalidProjection,
    StateUnavailable,
}

impl fmt::Display for CloudAgentTurnProjectorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Cloud Agent Turn projector failed: {self:?}")
    }
}

impl std::error::Error for CloudAgentTurnProjectorError {}

#[cfg(test)]
#[path = "cloud_agent_turn_projector_tests.rs"]
pub(crate) mod tests;
