use crewon_core::context::ContextualUserFragment;
use crewon_core::context::GovernedContextFragment;
use crewon_state::CloudAgentTurnRecord;
use crewon_state::CloudExecutionArtifactRefRecord;
use crewon_state::StateRuntime;

use super::cloud_agent_turn_artifacts::CloudAgentTurnArtifactRefs;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CloudAgentTurnReplayError {
    Conflict,
    StateUnavailable,
}

pub(super) struct CloudAgentTurnReplayRequest<'a> {
    pub(super) state: &'a StateRuntime,
    pub(super) thread_id: &'a str,
    pub(super) client_user_message_id: &'a str,
    pub(super) task_id: &'a str,
    pub(super) execution_spec_id: &'a str,
    pub(super) artifacts: &'a CloudAgentTurnArtifactRefs,
    pub(super) prompt: &'a str,
    pub(super) context_fragments: &'a [GovernedContextFragment],
}

pub(super) async fn ensure_replay_will_not_create_orphan_artifacts(
    request: CloudAgentTurnReplayRequest<'_>,
) -> Result<Option<CloudAgentTurnRecord>, CloudAgentTurnReplayError> {
    let Some(turn) = request
        .state
        .get_cloud_agent_turn_record_by_client_message(
            request.thread_id,
            request.client_user_message_id,
        )
        .await
        .map_err(|_| CloudAgentTurnReplayError::StateUnavailable)?
    else {
        return Ok(None);
    };
    if turn.origin.task_id() != Some(request.task_id)
        || turn.prompt_artifact != request.artifacts.prompt
    {
        return Err(CloudAgentTurnReplayError::Conflict);
    }
    let spec = request
        .state
        .get_cloud_execution_spec_record(request.execution_spec_id, /*revision*/ 1)
        .await
        .map_err(|_| CloudAgentTurnReplayError::StateUnavailable)?
        .ok_or(CloudAgentTurnReplayError::Conflict)?;
    if spec.task_id != request.task_id
        || spec.prompt_artifact != request.artifacts.prompt
        || spec.context_artifacts != request.artifacts.context
    {
        return Err(CloudAgentTurnReplayError::Conflict);
    }
    ensure_artifact_content(
        request.state,
        &request.artifacts.prompt,
        request.prompt.as_bytes(),
    )
    .await?;
    if request.artifacts.context.len() != request.context_fragments.len() {
        return Err(CloudAgentTurnReplayError::Conflict);
    }
    for (artifact, fragment) in request
        .artifacts
        .context
        .iter()
        .zip(request.context_fragments)
    {
        ensure_artifact_content(request.state, artifact, fragment.render().as_bytes()).await?;
    }
    Ok(Some(turn))
}

async fn ensure_artifact_content(
    state: &StateRuntime,
    artifact: &CloudExecutionArtifactRefRecord,
    expected: &[u8],
) -> Result<(), CloudAgentTurnReplayError> {
    let record = state
        .get_artifact_record(&artifact.artifact_id, artifact.revision)
        .await
        .map_err(|_| CloudAgentTurnReplayError::StateUnavailable)?
        .ok_or(CloudAgentTurnReplayError::Conflict)?;
    if record.payload.content.as_deref() != Some(expected) {
        return Err(CloudAgentTurnReplayError::Conflict);
    }
    Ok(())
}
