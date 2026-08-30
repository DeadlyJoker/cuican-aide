use std::fmt;
use std::sync::Arc;

use crewon_state::CloudAgentThreadSummarySyncCandidate;
use crewon_state::CloudAgentThreadSummarySyncOutcome;
use crewon_state::CloudAgentThreadSummarySyncRequest;
use crewon_state::CloudAgentTurnStatus;
use crewon_state::MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES;
use crewon_state::MAX_CLOUD_AGENT_THREAD_SUMMARY_SYNC_PAGE_SIZE;
use crewon_state::StateRuntime;
use crewon_thread_store::LocalThreadStore;
use crewon_thread_store::ThreadStore;

use super::cloud_agent_thread_projection::artifact_projection::CloudAgentThreadArtifactProjector;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CloudAgentThreadMetadataProjectionReport {
    pub(crate) inspected: u32,
    pub(crate) applied: u32,
    pub(crate) existing_same: u32,
    pub(crate) stale: u32,
}

#[derive(Clone)]
pub(crate) struct CloudAgentThreadMetadataProjector {
    state: Arc<StateRuntime>,
    local_thread_store: bool,
}

impl CloudAgentThreadMetadataProjector {
    pub(crate) fn new(state: Arc<StateRuntime>, thread_store: Arc<dyn ThreadStore>) -> Self {
        Self {
            state,
            local_thread_store: thread_store.as_any().is::<LocalThreadStore>(),
        }
    }

    pub(crate) async fn ensure_synced(
        &self,
    ) -> Result<CloudAgentThreadMetadataProjectionReport, CloudAgentThreadMetadataProjectionError>
    {
        let mut report = CloudAgentThreadMetadataProjectionReport::default();
        loop {
            let remaining = MAX_CLOUD_AGENT_THREAD_SUMMARY_SYNC_PAGE_SIZE
                .checked_sub(report.inspected)
                .ok_or(CloudAgentThreadMetadataProjectionError::CapacityExceeded)?;
            if remaining == 0 {
                let pending = self.list_candidates(/*limit*/ 1).await?;
                return if pending.data.is_empty() {
                    Ok(report)
                } else {
                    Err(CloudAgentThreadMetadataProjectionError::CapacityExceeded)
                };
            }
            let page = self.list_candidates(remaining).await?;
            if page.data.is_empty() {
                return Ok(report);
            }
            for candidate in page.data {
                report.inspected += 1;
                match self.sync_candidate(&candidate).await? {
                    CloudAgentThreadSummarySyncOutcome::Applied => report.applied += 1,
                    CloudAgentThreadSummarySyncOutcome::ExistingSame => {
                        report.existing_same += 1;
                    }
                    CloudAgentThreadSummarySyncOutcome::Stale
                    | CloudAgentThreadSummarySyncOutcome::NotFound => report.stale += 1,
                    CloudAgentThreadSummarySyncOutcome::ThreadMetadataMissing => {
                        return Err(
                            CloudAgentThreadMetadataProjectionError::ThreadStoreUnavailable,
                        );
                    }
                }
            }
        }
    }

    async fn list_candidates(
        &self,
        limit: u32,
    ) -> Result<
        crewon_state::CloudAgentThreadSummarySyncPage,
        CloudAgentThreadMetadataProjectionError,
    > {
        self.state
            .list_cloud_agent_thread_summary_sync_candidates(limit)
            .await
            .map_err(|_| CloudAgentThreadMetadataProjectionError::StateUnavailable)
    }

    async fn sync_candidate(
        &self,
        candidate: &CloudAgentThreadSummarySyncCandidate,
    ) -> Result<CloudAgentThreadSummarySyncOutcome, CloudAgentThreadMetadataProjectionError> {
        if !self.local_thread_store {
            return Err(CloudAgentThreadMetadataProjectionError::ThreadStoreUnavailable);
        }
        let turn = self
            .state
            .get_cloud_agent_turn_record(&candidate.last_turn_id)
            .await
            .map_err(|_| CloudAgentThreadMetadataProjectionError::StateUnavailable)?
            .ok_or(CloudAgentThreadMetadataProjectionError::InvalidProjection)?;
        if turn.thread_id != candidate.thread_id || turn.updated_at != candidate.updated_at {
            return Ok(CloudAgentThreadSummarySyncOutcome::Stale);
        }
        let artifacts = CloudAgentThreadArtifactProjector::new(self.state.clone());
        let source = if turn.status == CloudAgentTurnStatus::Completed {
            artifacts.read_output(&turn).await
        } else {
            artifacts.read_prompt(&turn).await
        }
        .map_err(|_| CloudAgentThreadMetadataProjectionError::InvalidProjection)?;
        let preview = bounded_preview(&source)
            .ok_or(CloudAgentThreadMetadataProjectionError::InvalidProjection)?;
        self.state
            .mark_cloud_agent_thread_summary_synced(&CloudAgentThreadSummarySyncRequest {
                thread_id: candidate.thread_id.clone(),
                last_turn_id: candidate.last_turn_id.clone(),
                expected_projection_revision: candidate.projection_revision,
                preview,
                expected_updated_at: candidate.updated_at,
            })
            .await
            .map_err(|_| CloudAgentThreadMetadataProjectionError::StateUnavailable)
    }
}

fn bounded_preview(source: &str) -> Option<String> {
    let mut preview = String::with_capacity(
        source
            .len()
            .min(MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES),
    );
    let mut pending_space = false;
    for character in source.trim().chars() {
        if character.is_whitespace() || character.is_control() {
            pending_space = !preview.is_empty();
            continue;
        }
        let required = character.len_utf8() + usize::from(pending_space);
        if preview.len() + required > MAX_CLOUD_AGENT_THREAD_SUMMARY_PREVIEW_BYTES {
            break;
        }
        if pending_space {
            preview.push(' ');
            pending_space = false;
        }
        preview.push(character);
    }
    (!preview.is_empty()).then_some(preview)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudAgentThreadMetadataProjectionError {
    InvalidProjection,
    CapacityExceeded,
    StateUnavailable,
    ThreadStoreUnavailable,
}

impl fmt::Display for CloudAgentThreadMetadataProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Cloud Agent Thread metadata projection failed: {self:?}"
        )
    }
}

impl std::error::Error for CloudAgentThreadMetadataProjectionError {}

#[cfg(test)]
#[path = "cloud_agent_thread_metadata_projection_tests.rs"]
mod tests;
