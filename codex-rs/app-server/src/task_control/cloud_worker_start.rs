use crewon_artifact::ArtifactExecutionProjection;
use crewon_artifact::ArtifactKind;
use crewon_artifact::RetentionPolicy;
use crewon_provider_agent_platform::ProviderArtifactKind;
use crewon_provider_agent_platform::ProviderArtifactRef;
use crewon_provider_agent_platform::ProviderArtifactRetention;
use crewon_provider_agent_platform::ProviderRunAuthorizationBinding;
use crewon_provider_agent_platform::ProviderRunStartRequest;
use crewon_provider_agent_platform::ProviderRunStartResult;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_state::ProviderRunJournalKey;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::ProviderRunJournalStatus;
use crewon_task_runtime::WorkerControl;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerExecutorError;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use super::cloud_execution_resolver::ResolvedCloudExecution;
use super::cloud_worker::map_provider_error;

pub(super) struct ProviderStartIdentity {
    command_id: String,
    idempotency_key: String,
    request_digest: String,
    task_id: String,
    attempt_id: String,
    execution_spec_id: String,
    execution_spec_revision: u64,
    execution_spec_digest: String,
    provider_id: String,
    protocol_version: String,
    resource_id: String,
    resource_revision: String,
}

impl ProviderStartIdentity {
    pub(super) fn from_dispatch(
        dispatch: &WorkerDispatch,
        binding: &ResolvedResourceBinding,
    ) -> Result<Self, WorkerExecutorError> {
        Self::from_parts(
            dispatch.control(),
            dispatch.workspace_key(),
            dispatch.execution_spec(),
            dispatch.idempotency_key(),
            binding,
        )
    }

    pub(super) fn from_aggregate(
        task: &crewon_task_runtime::TaskAggregate,
        control: &WorkerControl,
        binding: &ResolvedResourceBinding,
    ) -> Result<Self, WorkerExecutorError> {
        let attempt = task
            .active_attempt()
            .ok_or(WorkerExecutorError::InvalidResponse)?;
        if task.contract().task_id() != control.task_id()
            || attempt.attempt_id() != control.attempt_id()
            || attempt.worker_run_id() != Some(control.worker_run_id())
            || attempt.lease() != Some(control.lease())
        {
            return Err(WorkerExecutorError::InvalidResponse);
        }
        Self::from_parts(
            control,
            task.contract().workspace_key(),
            task.contract().execution_spec(),
            attempt.idempotency_key(),
            binding,
        )
    }

    fn from_parts(
        control: &WorkerControl,
        workspace_key: &crewon_resource_federation::WorkspaceKey,
        execution_spec: &crewon_task_runtime::ExecutionSpecRef,
        task_idempotency_key: &crewon_task_runtime::IdempotencyKey,
        binding: &ResolvedResourceBinding,
    ) -> Result<Self, WorkerExecutorError> {
        let resource = binding.resource();
        let idempotency_digest = digest(&ProviderIdempotencyDigest {
            task_id: control.task_id().as_str(),
            attempt_id: control.attempt_id().as_str(),
            task_idempotency_key: task_idempotency_key.as_str(),
            execution_spec_digest: execution_spec.digest().as_str(),
        })?;
        let idempotency_key = format!("run:{}", digest_hex(&idempotency_digest));
        let request_digest = digest(&ProviderRequestDigest {
            task_id: control.task_id().as_str(),
            attempt_id: control.attempt_id().as_str(),
            workspace_key: workspace_key.as_str(),
            binding_id: binding.binding_id().as_str(),
            provider_id: resource.provider.provider_id.as_str(),
            protocol_version: resource.provider.protocol_version.as_str(),
            resource_id: resource.resource_id.as_str(),
            resource_revision: resource.revision.as_str(),
            execution_spec_id: execution_spec.execution_spec_id().as_str(),
            execution_spec_revision: execution_spec.revision().get(),
            execution_spec_digest: execution_spec.digest().as_str(),
            idempotency_key: &idempotency_key,
        })?;
        Ok(Self {
            command_id: format!("start:{}", digest_hex(&request_digest)),
            idempotency_key,
            request_digest,
            task_id: control.task_id().as_str().to_string(),
            attempt_id: control.attempt_id().as_str().to_string(),
            execution_spec_id: execution_spec.execution_spec_id().as_str().to_string(),
            execution_spec_revision: execution_spec.revision().get(),
            execution_spec_digest: execution_spec.digest().as_str().to_string(),
            provider_id: resource.provider.provider_id.as_str().to_string(),
            protocol_version: resource.provider.protocol_version.as_str().to_string(),
            resource_id: resource.resource_id.as_str().to_string(),
            resource_revision: resource.revision.as_str().to_string(),
        })
    }

    pub(super) fn matches_journal(&self, journal: &ProviderRunJournalRecord) -> bool {
        journal.key.task_id == self.task_id
            && journal.key.attempt_id == self.attempt_id
            && journal.execution_spec_id == self.execution_spec_id
            && journal.execution_spec_revision == self.execution_spec_revision
            && journal.execution_spec_digest == self.execution_spec_digest
            && journal.provider_id == self.provider_id
            && journal.protocol_version == self.protocol_version
            && journal.resource_id == self.resource_id
            && journal.resource_revision == self.resource_revision
            && journal.start_command_id == self.command_id
            && journal.start_idempotency_key == self.idempotency_key
            && journal.request_digest == self.request_digest
    }
}

pub(super) fn provider_start_request(
    dispatch: &WorkerDispatch,
    identity: &ProviderStartIdentity,
    resolved: &ResolvedCloudExecution,
) -> Result<ProviderRunStartRequest, WorkerExecutorError> {
    let authorization = ProviderRunAuthorizationBinding::new(
        resolved.resource().clone(),
        dispatch.control().task_id().as_str(),
        resolved.authority().credential_id(),
        resolved.authority().credential_revision(),
    )
    .map_err(|_| WorkerExecutorError::Unauthorized)?;
    let context_refs = resolved
        .context_artifacts()
        .iter()
        .map(|artifact| provider_artifact_ref(dispatch, artifact))
        .collect::<Result<Vec<_>, WorkerExecutorError>>()?;
    ProviderRunStartRequest::new(
        authorization,
        &identity.command_id,
        &identity.idempotency_key,
        &identity.request_digest,
        resolved.prompt(),
        context_refs,
    )
    .map_err(map_provider_error)
}

pub(super) fn journal_record(
    dispatch: &WorkerDispatch,
    identity: &ProviderStartIdentity,
    resolved: &ResolvedCloudExecution,
    result: &ProviderRunStartResult,
    now: i64,
) -> ProviderRunJournalRecord {
    let spec = resolved.execution_spec();
    let mut record = ProviderRunJournalRecord {
        key: ProviderRunJournalKey {
            task_id: identity.task_id.clone(),
            attempt_id: identity.attempt_id.clone(),
            worker_run_id: dispatch.control().worker_run_id().as_str().to_string(),
        },
        journal_version: 0,
        execution_spec_id: identity.execution_spec_id.clone(),
        execution_spec_revision: identity.execution_spec_revision,
        execution_spec_digest: identity.execution_spec_digest.clone(),
        provider_id: identity.provider_id.clone(),
        protocol_version: identity.protocol_version.clone(),
        resource_id: identity.resource_id.clone(),
        resource_revision: identity.resource_revision.clone(),
        credential_id: spec.credential_id.clone(),
        credential_revision: spec.credential_revision,
        provider_run_id: result.provider_run_id().to_string(),
        provider_attempt_id: result.attempt_id().to_string(),
        provider_revision: None,
        last_sequence: 0,
        last_cursor: None,
        status: ProviderRunJournalStatus::Starting,
        start_command_id: identity.command_id.clone(),
        start_idempotency_key: identity.idempotency_key.clone(),
        request_digest: identity.request_digest.clone(),
        record_hash: String::new(),
        created_at: now,
        updated_at: now,
    };
    record.record_hash = record.canonical_hash();
    record
}

fn provider_artifact_ref(
    dispatch: &WorkerDispatch,
    artifact: &ArtifactExecutionProjection,
) -> Result<ProviderArtifactRef, WorkerExecutorError> {
    ProviderArtifactRef::new(
        artifact.artifact_ref().artifact_id().as_str(),
        dispatch.control().task_id().as_str(),
        provider_artifact_kind(artifact.kind()),
        artifact.artifact_ref().revision().get(),
        provider_retention(artifact.retention()),
        artifact.created_at().get(),
    )
    .map_err(map_provider_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderIdempotencyDigest<'a> {
    task_id: &'a str,
    attempt_id: &'a str,
    task_idempotency_key: &'a str,
    execution_spec_digest: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRequestDigest<'a> {
    task_id: &'a str,
    attempt_id: &'a str,
    workspace_key: &'a str,
    binding_id: &'a str,
    provider_id: &'a str,
    protocol_version: &'a str,
    resource_id: &'a str,
    resource_revision: &'a str,
    execution_spec_id: &'a str,
    execution_spec_revision: u64,
    execution_spec_digest: &'a str,
    idempotency_key: &'a str,
}

pub(super) fn digest<T: Serialize>(value: &T) -> Result<String, WorkerExecutorError> {
    let encoded = serde_json::to_vec(value).map_err(|_| WorkerExecutorError::InvalidResponse)?;
    let digest = Sha256::digest(encoded);
    Ok(format!("sha256:{digest:x}"))
}

pub(super) fn digest_hex(digest: &str) -> &str {
    digest.strip_prefix("sha256:").unwrap_or(digest)
}

fn provider_artifact_kind(kind: ArtifactKind) -> ProviderArtifactKind {
    match kind {
        ArtifactKind::Report => ProviderArtifactKind::Report,
        ArtifactKind::Image => ProviderArtifactKind::Image,
        ArtifactKind::EvidenceBundle => ProviderArtifactKind::Evidence,
        ArtifactKind::StructuredResult => ProviderArtifactKind::ToolResult,
        ArtifactKind::Document | ArtifactKind::Dataset | ArtifactKind::CodePatch => {
            ProviderArtifactKind::File
        }
    }
}

fn provider_retention(retention: &RetentionPolicy) -> ProviderArtifactRetention {
    match retention {
        RetentionPolicy::Session { .. } => ProviderArtifactRetention::Session,
        RetentionPolicy::Task { .. } => ProviderArtifactRetention::Task,
        RetentionPolicy::UserManaged => ProviderArtifactRetention::UserManaged,
        RetentionPolicy::Compliance { .. } => ProviderArtifactRetention::Compliance,
    }
}
