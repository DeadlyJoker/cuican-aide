use std::path::PathBuf;
use std::sync::Arc;

use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResourceKind;
use crewon_state::CloudAgentLegacyImportCommit;
use crewon_state::CloudAgentLegacyImportCommitOutcome;
use crewon_state::CloudAgentLegacyImportStart;
use crewon_state::CloudAgentLegacyImportStartOutcome;
use crewon_state::CloudAgentTurnOrigin;
use crewon_state::CloudAgentTurnRecord;
use crewon_state::CloudAgentTurnStatus;
use crewon_state::StateRuntime;
use crewon_state::ThreadExecutionContextBindingRef;
use sha2::Digest;
use sha2::Sha256;

use super::cloud_agent_legacy_import_artifact::commit_legacy_artifact;
use super::cloud_agent_legacy_import_source::LegacySessionSource;
use super::cloud_agent_legacy_import_source::LegacySessionSourceError;
use super::cloud_agent_legacy_import_source::read_legacy_session_source;
use crate::platform_control::RequestIdentity;

const LEGACY_RESPONSE_MISSING: &str = "legacyResponseMissing";

pub(super) struct CloudAgentLegacySessionImporter {
    state: Arc<StateRuntime>,
    history_root: PathBuf,
    deployment_namespace: String,
}

pub(super) struct CloudAgentLegacySessionImportRequest<'a> {
    pub(super) identity: &'a RequestIdentity,
    pub(super) workspace: &'a WorkspaceRef,
    pub(super) execution_binding: &'a ResolvedResourceBinding,
    pub(super) execution_binding_revision: u64,
    pub(super) user_id: i64,
    pub(super) thread_id: &'a str,
    pub(super) legacy_agent_id: &'a str,
    pub(super) now: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CloudAgentLegacySessionImportOutcome {
    Imported { turn_count: usize },
    Existing { turn_count: usize },
    NoHistory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(super) enum CloudAgentLegacySessionImportError {
    #[error("legacy session was not found")]
    SourceNotFound,
    #[error("legacy session source is invalid")]
    InvalidSource,
    #[error("legacy session import request is invalid")]
    InvalidRequest,
    #[error("legacy session requires one exact Agent binding")]
    MappingRequired,
    #[error("legacy session import conflicts with durable state")]
    Conflict,
    #[error("legacy session import dependency changed")]
    DependencyMissing,
    #[error("legacy session import capacity was exceeded")]
    CapacityExceeded,
    #[error("legacy session import is not authorized")]
    Unauthorized,
    #[error("legacy session Artifact conflicts with durable state")]
    ArtifactConflict,
    #[error("legacy session import state is unavailable")]
    StateUnavailable,
}

impl CloudAgentLegacySessionImporter {
    pub(super) fn new(
        state: Arc<StateRuntime>,
        codex_home: PathBuf,
        agent_platform_base_url: Option<&str>,
    ) -> Self {
        let namespace_source = agent_platform_base_url
            .map(|value| value.trim_end_matches('/'))
            .filter(|value| !value.is_empty())
            .unwrap_or("unconfigured");
        let deployment_namespace = format!("{:x}", Sha256::digest(namespace_source));
        let history_root = codex_home
            .join("agent-platform-sessions")
            .join(&deployment_namespace);
        Self {
            state,
            history_root,
            deployment_namespace,
        }
    }

    pub(super) async fn import(
        &self,
        request: CloudAgentLegacySessionImportRequest<'_>,
    ) -> Result<CloudAgentLegacySessionImportOutcome, CloudAgentLegacySessionImportError> {
        validate_request(&request)?;
        self.authorize_request(&request).await?;
        let source = read_legacy_session_source(
            self.history_root.clone(),
            self.deployment_namespace.clone(),
            request.user_id,
            request.thread_id.to_string(),
            request.legacy_agent_id.to_string(),
        )
        .await
        .map_err(map_source_error)?;
        if source.rounds.is_empty() {
            return Ok(CloudAgentLegacySessionImportOutcome::NoHistory);
        }
        let journal_id = stable_id("legacy-journal", source.source_key.as_bytes());
        let binding_ref = ThreadExecutionContextBindingRef {
            binding_id: request.execution_binding.binding_id().as_str().to_string(),
            revision: request.execution_binding_revision,
        };
        let start = CloudAgentLegacyImportStart {
            journal_id: journal_id.clone(),
            source_key: source.source_key.clone(),
            source_digest: source.source_digest.clone(),
            source_bytes: source.source_bytes,
            thread_id: request.thread_id.to_string(),
            execution_binding: binding_ref.clone(),
            expected_turn_count: source.rounds.len(),
            imported_at: request.now,
        };
        let journal = match self
            .state
            .start_cloud_agent_legacy_import(&start)
            .await
            .map_err(|_| CloudAgentLegacySessionImportError::StateUnavailable)?
        {
            CloudAgentLegacyImportStartOutcome::Started(record)
            | CloudAgentLegacyImportStartOutcome::ExistingPending(record) => record,
            CloudAgentLegacyImportStartOutcome::ExistingCompleted(record) => {
                return Ok(CloudAgentLegacySessionImportOutcome::Existing {
                    turn_count: record.expected_turn_count,
                });
            }
            CloudAgentLegacyImportStartOutcome::Conflict => {
                return Err(CloudAgentLegacySessionImportError::Conflict);
            }
            CloudAgentLegacyImportStartOutcome::DependencyMissing => {
                return Err(CloudAgentLegacySessionImportError::DependencyMissing);
            }
            CloudAgentLegacyImportStartOutcome::CapacityExceeded => {
                return Err(CloudAgentLegacySessionImportError::CapacityExceeded);
            }
        };
        let turns = self
            .materialize_turns(
                &request,
                &source,
                &journal_id,
                &binding_ref,
                journal.imported_at,
            )
            .await?;
        let commit = CloudAgentLegacyImportCommit {
            journal_id,
            source_digest: source.source_digest,
            turns,
        };
        match self
            .state
            .commit_cloud_agent_legacy_import(&commit)
            .await
            .map_err(|_| CloudAgentLegacySessionImportError::StateUnavailable)?
        {
            CloudAgentLegacyImportCommitOutcome::Committed => {
                Ok(CloudAgentLegacySessionImportOutcome::Imported {
                    turn_count: commit.turns.len(),
                })
            }
            CloudAgentLegacyImportCommitOutcome::ExistingSame => {
                Ok(CloudAgentLegacySessionImportOutcome::Existing {
                    turn_count: commit.turns.len(),
                })
            }
            CloudAgentLegacyImportCommitOutcome::Conflict => {
                Err(CloudAgentLegacySessionImportError::Conflict)
            }
            CloudAgentLegacyImportCommitOutcome::DependencyMissing => {
                Err(CloudAgentLegacySessionImportError::DependencyMissing)
            }
            CloudAgentLegacyImportCommitOutcome::CapacityExceeded => {
                Err(CloudAgentLegacySessionImportError::CapacityExceeded)
            }
        }
    }

    async fn authorize_request(
        &self,
        request: &CloudAgentLegacySessionImportRequest<'_>,
    ) -> Result<(), CloudAgentLegacySessionImportError> {
        let context = self
            .state
            .get_thread_execution_context_record(request.thread_id)
            .await
            .map_err(|_| CloudAgentLegacySessionImportError::StateUnavailable)?
            .ok_or(CloudAgentLegacySessionImportError::DependencyMissing)?;
        let reference = request.identity.reference();
        if context.local_actor_id != reference.actor_id
            || context.local_tenant_id != reference.tenant_id.as_deref().unwrap_or_default()
            || context.local_space_id != reference.space_id.as_deref().unwrap_or_default()
        {
            return Err(CloudAgentLegacySessionImportError::Unauthorized);
        }
        let expected_binding = ThreadExecutionContextBindingRef {
            binding_id: request.execution_binding.binding_id().as_str().to_string(),
            revision: request.execution_binding_revision,
        };
        if context.workspace_key != request.workspace.workspace_key
            || context.workspace_scope_id != request.thread_id
            || context.execution_binding.as_ref() != Some(&expected_binding)
        {
            return Err(CloudAgentLegacySessionImportError::DependencyMissing);
        }
        Ok(())
    }

    async fn materialize_turns(
        &self,
        request: &CloudAgentLegacySessionImportRequest<'_>,
        source: &LegacySessionSource,
        journal_id: &str,
        binding_ref: &ThreadExecutionContextBindingRef,
        imported_at: i64,
    ) -> Result<Vec<CloudAgentTurnRecord>, CloudAgentLegacySessionImportError> {
        let mut turns = Vec::with_capacity(source.rounds.len());
        let turn_group = stable_id("legacy-turn-group", journal_id.as_bytes());
        for (ordinal, round) in source.rounds.iter().enumerate() {
            let turn_id = format!("{turn_group}:{ordinal:04}");
            let prompt = commit_legacy_artifact(
                self.state.as_ref(),
                request,
                source,
                &turn_id,
                ordinal,
                "prompt",
                &round.prompt,
                imported_at,
            )
            .await?;
            let output = match round.output.as_deref() {
                Some(output) => Some(
                    commit_legacy_artifact(
                        self.state.as_ref(),
                        request,
                        source,
                        &turn_id,
                        ordinal,
                        "output",
                        output,
                        imported_at,
                    )
                    .await?,
                ),
                None => None,
            };
            let import_id = format!("legacy-import:{journal_id}:{ordinal:04}");
            let mut turn = CloudAgentTurnRecord {
                thread_id: request.thread_id.to_string(),
                turn_id,
                client_user_message_id: format!("legacy-message:{journal_id}:{ordinal:04}"),
                origin: CloudAgentTurnOrigin::LegacyImport { import_id },
                local_actor_id: request.identity.reference().actor_id.clone(),
                local_tenant_id: request
                    .identity
                    .reference()
                    .tenant_id
                    .clone()
                    .ok_or(CloudAgentLegacySessionImportError::InvalidRequest)?,
                local_space_id: request
                    .identity
                    .reference()
                    .space_id
                    .clone()
                    .ok_or(CloudAgentLegacySessionImportError::InvalidRequest)?,
                workspace_key: request.workspace.workspace_key.clone(),
                execution_binding: binding_ref.clone(),
                prompt_artifact: prompt,
                status: if output.is_some() {
                    CloudAgentTurnStatus::Completed
                } else {
                    CloudAgentTurnStatus::Failed
                },
                last_provider_sequence: 0,
                primary_output_artifact: output,
                additional_output_artifacts: Vec::new(),
                error_code: round
                    .output
                    .is_none()
                    .then(|| LEGACY_RESPONSE_MISSING.to_string()),
                trace_id: Some(stable_id("legacy-trace", journal_id.as_bytes())),
                revision: 1,
                creation_digest: stable_digest(&[
                    source.source_digest.as_bytes(),
                    journal_id.as_bytes(),
                    ordinal.to_string().as_bytes(),
                ]),
                record_hash: String::new(),
                created_at: imported_at,
                updated_at: imported_at,
                completed_at: Some(imported_at),
            };
            turn.record_hash = turn.canonical_hash();
            turn.validate()
                .map_err(|_| CloudAgentLegacySessionImportError::InvalidRequest)?;
            turns.push(turn);
        }
        Ok(turns)
    }
}

fn validate_request(
    request: &CloudAgentLegacySessionImportRequest<'_>,
) -> Result<(), CloudAgentLegacySessionImportError> {
    if request.now < 0
        || request.execution_binding_revision == 0
        || request.workspace.scope != WorkspaceScope::Conversation
        || request.workspace.scope_id != request.thread_id
        || request.workspace.workspace_key != request.execution_binding.workspace_key().as_str()
        || request.identity.reference().tenant_id.is_none()
        || request.identity.reference().space_id.is_none()
    {
        return Err(CloudAgentLegacySessionImportError::InvalidRequest);
    }
    if request.execution_binding.resource().kind != ResourceKind::Agent
        || request.execution_binding.mode() != BindingMode::ProviderManaged
        || request.execution_binding.execution_location() != ExecutionLocation::Provider
    {
        return Err(CloudAgentLegacySessionImportError::MappingRequired);
    }
    Ok(())
}

fn map_source_error(error: LegacySessionSourceError) -> CloudAgentLegacySessionImportError {
    match error {
        LegacySessionSourceError::NotFound => CloudAgentLegacySessionImportError::SourceNotFound,
        LegacySessionSourceError::InvalidSource => {
            CloudAgentLegacySessionImportError::InvalidSource
        }
    }
}

pub(super) fn stable_digest(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.cloud-agent-legacy-import.v1\0");
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("sha256:{:x}", hasher.finalize())
}

pub(super) fn stable_id(prefix: &str, seed: &[u8]) -> String {
    format!("{prefix}:{:x}", Sha256::digest(seed))
}

#[cfg(test)]
#[path = "cloud_agent_legacy_importer_tests.rs"]
mod tests;
