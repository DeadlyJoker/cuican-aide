use std::sync::Arc;

use crewon_artifact::ArtifactExecutionProjection;
use crewon_artifact::ArtifactWorkspace;
use crewon_artifact::ArtifactWorkspaceScope;
use crewon_artifact::RunId;
use crewon_artifact::SpanId;
use crewon_artifact::ThreadId;
use crewon_artifact::TraceContext;
use crewon_artifact::TraceId;
use crewon_artifact::TurnId;
use crewon_policy::PolicyActor;
use crewon_provider_agent_platform::ProviderArtifactKind;
use crewon_provider_agent_platform::ProviderArtifactRef;
use crewon_provider_agent_platform::ProviderArtifactRetention;
use crewon_state::CloudAgentTurnFinalizationRecord;
use crewon_state::CloudExecutionArtifactRefRecord;
use crewon_state::ProviderRunEventProjection;
use crewon_state::ProviderRunOutputArtifactKind;
use crewon_state::ProviderRunOutputArtifactRef;
use crewon_state::ProviderRunOutputArtifactRetention;
use crewon_state::StateRuntime;
use crewon_task_runtime::AttemptId;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::UnixTimestamp;
use sha2::Digest;
use sha2::Sha256;

use super::cloud_agent_result_reader::CloudAgentResultArtifactReadError;
use super::cloud_agent_result_reader::CloudAgentResultArtifactReadRequest;
use super::cloud_agent_result_reader::CloudAgentResultArtifactReader;
use super::provider_run_artifact_importer::ProviderRunOutputArtifactImportError;
use super::provider_run_artifact_importer::ProviderRunOutputArtifactImportRequest;
use super::provider_run_artifact_importer::ProviderRunOutputArtifactImporter;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FinalizedCloudAgentOutputs {
    pub(super) primary: CloudExecutionArtifactRefRecord,
    pub(super) additional: Vec<CloudExecutionArtifactRefRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CloudAgentOutputFinalizationError {
    InvalidProjection,
    AuthorityRevoked,
    PermanentlyUnavailable,
    TemporarilyUnavailable,
}

pub(super) async fn finalize_cloud_agent_outputs<Reader, Importer>(
    state: &Arc<StateRuntime>,
    reader: &Arc<Reader>,
    importer: &Arc<Importer>,
    finalization: &CloudAgentTurnFinalizationRecord,
    now: i64,
) -> Result<FinalizedCloudAgentOutputs, CloudAgentOutputFinalizationError>
where
    Reader: CloudAgentResultArtifactReader,
    Importer: ProviderRunOutputArtifactImporter,
{
    let event = state
        .get_provider_run_journal_event_record(&finalization.event.key, finalization.event.sequence)
        .await
        .map_err(|_| CloudAgentOutputFinalizationError::TemporarilyUnavailable)?
        .ok_or(CloudAgentOutputFinalizationError::InvalidProjection)?;
    if event.event_id != finalization.event.event_id
        || event.projection.payload_digest != finalization.event.payload_digest
        || event.event_type != "completed"
    {
        return Err(CloudAgentOutputFinalizationError::InvalidProjection);
    }
    let projection = event
        .projection
        .decode(&event.event_type, &finalization.task_id)
        .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?;
    let ProviderRunEventProjection::Completed { output_artifacts } = projection else {
        return Err(CloudAgentOutputFinalizationError::InvalidProjection);
    };
    let primary_index = preflight_outputs(&output_artifacts)?;
    let journal = state
        .get_provider_run_journal_record(&finalization.event.key)
        .await
        .map_err(|_| CloudAgentOutputFinalizationError::TemporarilyUnavailable)?
        .ok_or(CloudAgentOutputFinalizationError::InvalidProjection)?;
    if journal.provider_run_id != finalization.event.provider_run_id {
        return Err(CloudAgentOutputFinalizationError::InvalidProjection);
    }
    let context = load_import_context(state, finalization, &journal, now).await?;
    let mut imported = Vec::with_capacity(output_artifacts.len());
    for (index, artifact) in output_artifacts.into_iter().enumerate() {
        let provider_artifact = provider_artifact_ref(&artifact)?;
        let content = reader
            .read(CloudAgentResultArtifactReadRequest {
                turn_id: finalization.turn_id.clone(),
                journal: journal.clone(),
                artifact: provider_artifact,
                now,
            })
            .await
            .map_err(map_read_error)?;
        if index == primary_index
            && !matches!(
                content.media_type(),
                crewon_provider_agent_platform::ProviderArtifactMediaType::TextMarkdown
                    | crewon_provider_agent_platform::ProviderArtifactMediaType::TextPlain
            )
        {
            return Err(CloudAgentOutputFinalizationError::PermanentlyUnavailable);
        }
        let result = importer
            .import(context.import_request(content, &artifact, event.created_at, now)?)
            .await
            .map_err(map_import_error)?;
        imported.push(CloudExecutionArtifactRefRecord {
            artifact_id: result.artifact().artifact_id().as_str().to_string(),
            revision: result.artifact().revision().get(),
        });
    }
    let primary = imported.remove(primary_index);
    Ok(FinalizedCloudAgentOutputs {
        primary,
        additional: imported,
    })
}

fn preflight_outputs(
    artifacts: &[ProviderRunOutputArtifactRef],
) -> Result<usize, CloudAgentOutputFinalizationError> {
    if artifacts.is_empty() {
        return Err(CloudAgentOutputFinalizationError::InvalidProjection);
    }
    let mut primary = None;
    for (index, artifact) in artifacts.iter().enumerate() {
        if artifact.kind == ProviderRunOutputArtifactKind::Image
            || !matches!(
                artifact.retention,
                ProviderRunOutputArtifactRetention::Session
                    | ProviderRunOutputArtifactRetention::Task
            )
        {
            return Err(CloudAgentOutputFinalizationError::PermanentlyUnavailable);
        }
        if matches!(
            artifact.kind,
            ProviderRunOutputArtifactKind::File | ProviderRunOutputArtifactKind::Report
        ) && primary.replace(index).is_some()
        {
            return Err(CloudAgentOutputFinalizationError::InvalidProjection);
        }
    }
    primary.ok_or(CloudAgentOutputFinalizationError::InvalidProjection)
}

fn provider_artifact_ref(
    artifact: &ProviderRunOutputArtifactRef,
) -> Result<ProviderArtifactRef, CloudAgentOutputFinalizationError> {
    ProviderArtifactRef::new(
        &artifact.artifact_id,
        &artifact.task_id,
        match artifact.kind {
            ProviderRunOutputArtifactKind::File => ProviderArtifactKind::File,
            ProviderRunOutputArtifactKind::Image => ProviderArtifactKind::Image,
            ProviderRunOutputArtifactKind::Report => ProviderArtifactKind::Report,
            ProviderRunOutputArtifactKind::Evidence => ProviderArtifactKind::Evidence,
            ProviderRunOutputArtifactKind::ToolResult => ProviderArtifactKind::ToolResult,
        },
        artifact.revision,
        match artifact.retention {
            ProviderRunOutputArtifactRetention::Session => ProviderArtifactRetention::Session,
            ProviderRunOutputArtifactRetention::Task => ProviderArtifactRetention::Task,
            ProviderRunOutputArtifactRetention::UserManaged => {
                ProviderArtifactRetention::UserManaged
            }
            ProviderRunOutputArtifactRetention::Compliance => ProviderArtifactRetention::Compliance,
        },
        artifact.created_at,
    )
    .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)
}

struct ArtifactImportContext {
    actor: PolicyActor,
    workspace: ArtifactWorkspace,
    task_id: TaskId,
    run_id: RunId,
    attempt_id: AttemptId,
    thread_id: ThreadId,
    turn_id: TurnId,
    provider_run_id: String,
    trace_id: TraceId,
}

impl ArtifactImportContext {
    fn import_request(
        &self,
        content: crewon_provider_agent_platform::ProviderRunArtifactContent,
        artifact: &ProviderRunOutputArtifactRef,
        observed_at: i64,
        now: i64,
    ) -> Result<ProviderRunOutputArtifactImportRequest, CloudAgentOutputFinalizationError> {
        let span_seed = stable_digest(&[
            self.turn_id.as_str().as_bytes(),
            artifact.artifact_id.as_bytes(),
            artifact.revision.to_string().as_bytes(),
        ]);
        Ok(ProviderRunOutputArtifactImportRequest {
            actor: self.actor.clone(),
            workspace: self.workspace.clone(),
            task_id: self.task_id.clone(),
            run_id: self.run_id.clone(),
            attempt_id: self.attempt_id.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            provider_run_id: self.provider_run_id.clone(),
            trace: TraceContext::root(
                self.trace_id.clone(),
                SpanId::new(format!("cloud-agent-finalize:{span_seed}"))
                    .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
            ),
            content,
            observed_at: UnixTimestamp::new(observed_at)
                .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
            now: UnixTimestamp::new(now)
                .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
        })
    }
}

async fn load_import_context(
    state: &StateRuntime,
    finalization: &CloudAgentTurnFinalizationRecord,
    journal: &crewon_state::ProviderRunJournalRecord,
    now: i64,
) -> Result<ArtifactImportContext, CloudAgentOutputFinalizationError> {
    if now < 0 {
        return Err(CloudAgentOutputFinalizationError::InvalidProjection);
    }
    let turn = state
        .get_cloud_agent_turn_record(&finalization.turn_id)
        .await
        .map_err(|_| CloudAgentOutputFinalizationError::TemporarilyUnavailable)?
        .ok_or(CloudAgentOutputFinalizationError::InvalidProjection)?;
    if turn.origin.task_id() != Some(finalization.task_id.as_str())
        || turn.status != crewon_state::CloudAgentTurnStatus::Finalizing
        || turn.last_provider_sequence != finalization.event.sequence
    {
        return Err(CloudAgentOutputFinalizationError::InvalidProjection);
    }
    let prompt = state
        .get_artifact_metadata_record(
            &turn.prompt_artifact.artifact_id,
            turn.prompt_artifact.revision,
        )
        .await
        .map_err(|_| CloudAgentOutputFinalizationError::TemporarilyUnavailable)?
        .ok_or(CloudAgentOutputFinalizationError::InvalidProjection)?;
    let projection =
        ArtifactExecutionProjection::from_manifest_json(&prompt.manifest.manifest_json)
            .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?;
    if projection.artifact_ref().artifact_id().as_str() != turn.prompt_artifact.artifact_id
        || projection.artifact_ref().revision().get() != turn.prompt_artifact.revision
        || projection.workspace().workspace_key().as_str() != turn.workspace_key
        || projection.workspace().scope() != ArtifactWorkspaceScope::Conversation
        || projection.workspace().scope_id().as_str() != turn.thread_id
    {
        return Err(CloudAgentOutputFinalizationError::InvalidProjection);
    }
    Ok(ArtifactImportContext {
        actor: PolicyActor::space_user(
            &turn.local_actor_id,
            &turn.local_tenant_id,
            &turn.local_space_id,
        )
        .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
        workspace: projection.workspace().clone(),
        task_id: TaskId::new(&finalization.task_id)
            .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
        run_id: RunId::new(&journal.key.worker_run_id)
            .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
        attempt_id: AttemptId::new(&journal.key.attempt_id)
            .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
        thread_id: ThreadId::new(&turn.thread_id)
            .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
        turn_id: TurnId::new(&turn.turn_id)
            .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
        provider_run_id: journal.provider_run_id.clone(),
        trace_id: TraceId::new(
            turn.trace_id
                .ok_or(CloudAgentOutputFinalizationError::InvalidProjection)?,
        )
        .map_err(|_| CloudAgentOutputFinalizationError::InvalidProjection)?,
    })
}

fn map_read_error(error: CloudAgentResultArtifactReadError) -> CloudAgentOutputFinalizationError {
    match error {
        CloudAgentResultArtifactReadError::InvalidCorrelation => {
            CloudAgentOutputFinalizationError::InvalidProjection
        }
        CloudAgentResultArtifactReadError::Unauthorized => {
            CloudAgentOutputFinalizationError::AuthorityRevoked
        }
        CloudAgentResultArtifactReadError::PermanentlyUnavailable => {
            CloudAgentOutputFinalizationError::PermanentlyUnavailable
        }
        CloudAgentResultArtifactReadError::TemporarilyUnavailable => {
            CloudAgentOutputFinalizationError::TemporarilyUnavailable
        }
    }
}

fn map_import_error(
    error: ProviderRunOutputArtifactImportError,
) -> CloudAgentOutputFinalizationError {
    match error {
        ProviderRunOutputArtifactImportError::StateUnavailable => {
            CloudAgentOutputFinalizationError::TemporarilyUnavailable
        }
        ProviderRunOutputArtifactImportError::InvalidCorrelation
        | ProviderRunOutputArtifactImportError::Conflict => {
            CloudAgentOutputFinalizationError::InvalidProjection
        }
        ProviderRunOutputArtifactImportError::UnsupportedArtifact
        | ProviderRunOutputArtifactImportError::Expired => {
            CloudAgentOutputFinalizationError::PermanentlyUnavailable
        }
    }
}

fn stable_digest(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.cloud-agent-finalize.v1\0");
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}
