use crewon_provider_agent_platform::ProviderArtifactKind;
use crewon_provider_agent_platform::ProviderArtifactRef;
use crewon_provider_agent_platform::ProviderArtifactRetention;
use crewon_provider_agent_platform::ProviderRunEvent;
use crewon_provider_agent_platform::ProviderRunEventPayload;
use crewon_provider_agent_platform::ProviderRunFailureCode;
use crewon_state::ProviderRunEventProjection;
use crewon_state::ProviderRunEventProjectionRecord;
use crewon_state::ProviderRunFailureCode as StoredProviderRunFailureCode;
use crewon_state::ProviderRunOutputArtifactKind;
use crewon_state::ProviderRunOutputArtifactRef;
use crewon_state::ProviderRunOutputArtifactRetention;
use crewon_task_runtime::WorkerExecutorError;

pub(super) fn provider_event_projection(
    event: &ProviderRunEvent,
    event_type: &str,
    task_id: &str,
) -> Result<ProviderRunEventProjectionRecord, WorkerExecutorError> {
    let projection = match event.payload() {
        ProviderRunEventPayload::RunStarted { revision } => {
            ProviderRunEventProjection::RunStarted {
                revision: *revision,
            }
        }
        ProviderRunEventPayload::Progress { summary } => ProviderRunEventProjection::Progress {
            summary: summary.clone(),
        },
        ProviderRunEventPayload::ApprovalRequired {
            approval_id,
            action_digest,
            expires_at,
        } => ProviderRunEventProjection::ApprovalRequired {
            approval_id: approval_id.clone(),
            action_digest: action_digest.clone(),
            expires_at: *expires_at,
        },
        ProviderRunEventPayload::ToolResultRequired {
            tool_call_id,
            tool_schema_revision,
            arguments_digest,
            intent_digest,
            nonce,
            expires_at,
        } => ProviderRunEventProjection::ToolResultRequired {
            tool_call_id: tool_call_id.clone(),
            tool_schema_revision: tool_schema_revision.clone(),
            arguments_digest: arguments_digest.clone(),
            intent_digest: intent_digest.clone(),
            nonce: nonce.clone(),
            expires_at: *expires_at,
        },
        ProviderRunEventPayload::ToolResultAccepted {
            tool_call_id,
            intent_digest,
            result_digest,
        } => ProviderRunEventProjection::ToolResultAccepted {
            tool_call_id: tool_call_id.clone(),
            intent_digest: intent_digest.clone(),
            result_digest: result_digest.clone(),
        },
        ProviderRunEventPayload::Completed { output_artifacts } => {
            ProviderRunEventProjection::Completed {
                output_artifacts: output_artifacts.iter().map(output_artifact_ref).collect(),
            }
        }
        ProviderRunEventPayload::Failed { error } => ProviderRunEventProjection::Failed {
            code: failure_code(error.code()),
            retryable: error.retryable(),
            provider_run_id: error.provider_run_id().to_string(),
            trace_id: error.trace_id().to_string(),
        },
        ProviderRunEventPayload::Cancelled { reason } => ProviderRunEventProjection::Cancelled {
            reason: reason.clone(),
        },
        _ => return Err(WorkerExecutorError::Unsupported),
    };
    if projection.event_type() != event_type {
        return Err(WorkerExecutorError::InvalidResponse);
    }
    ProviderRunEventProjectionRecord::from_projection(task_id, &projection)
        .map_err(|_| WorkerExecutorError::InvalidResponse)
}

fn output_artifact_ref(artifact: &ProviderArtifactRef) -> ProviderRunOutputArtifactRef {
    ProviderRunOutputArtifactRef {
        artifact_id: artifact.artifact_id().to_string(),
        task_id: artifact.task_id().to_string(),
        kind: match artifact.kind() {
            ProviderArtifactKind::File => ProviderRunOutputArtifactKind::File,
            ProviderArtifactKind::Image => ProviderRunOutputArtifactKind::Image,
            ProviderArtifactKind::Report => ProviderRunOutputArtifactKind::Report,
            ProviderArtifactKind::Evidence => ProviderRunOutputArtifactKind::Evidence,
            ProviderArtifactKind::ToolResult => ProviderRunOutputArtifactKind::ToolResult,
        },
        revision: artifact.revision(),
        retention: match artifact.retention() {
            ProviderArtifactRetention::Session => ProviderRunOutputArtifactRetention::Session,
            ProviderArtifactRetention::Task => ProviderRunOutputArtifactRetention::Task,
            ProviderArtifactRetention::UserManaged => {
                ProviderRunOutputArtifactRetention::UserManaged
            }
            ProviderArtifactRetention::Compliance => ProviderRunOutputArtifactRetention::Compliance,
        },
        created_at: artifact.created_at(),
    }
}

const fn failure_code(code: ProviderRunFailureCode) -> StoredProviderRunFailureCode {
    match code {
        ProviderRunFailureCode::InvalidRequest => StoredProviderRunFailureCode::InvalidRequest,
        ProviderRunFailureCode::Unauthorized => StoredProviderRunFailureCode::Unauthorized,
        ProviderRunFailureCode::Forbidden => StoredProviderRunFailureCode::Forbidden,
        ProviderRunFailureCode::NotFound => StoredProviderRunFailureCode::NotFound,
        ProviderRunFailureCode::Conflict => StoredProviderRunFailureCode::Conflict,
        ProviderRunFailureCode::CapabilityUnsupported => {
            StoredProviderRunFailureCode::CapabilityUnsupported
        }
        ProviderRunFailureCode::ProviderUnavailable => {
            StoredProviderRunFailureCode::ProviderUnavailable
        }
        ProviderRunFailureCode::Timeout => StoredProviderRunFailureCode::Timeout,
        ProviderRunFailureCode::UnknownOutcome => StoredProviderRunFailureCode::UnknownOutcome,
        ProviderRunFailureCode::Internal => StoredProviderRunFailureCode::Internal,
    }
}

#[cfg(test)]
#[path = "cloud_worker_event_projection_tests.rs"]
mod tests;
