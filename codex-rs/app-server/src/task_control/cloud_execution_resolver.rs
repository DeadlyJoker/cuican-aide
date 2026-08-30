use std::fmt;

use crewon_artifact::ArtifactExecutionProjection;
use crewon_artifact::ExecutionCorrelation;
use crewon_artifact::PayloadBody;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::RetentionPolicy;
use crewon_artifact::VerificationStatus;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_state::ArtifactPayloadSensitivity;
use crewon_state::ArtifactPayloadStatus;
use crewon_state::ArtifactRetentionKind;
use crewon_state::CloudExecutionArtifactRefRecord;
use crewon_state::CloudExecutionSpecRecord;
use crewon_state::StateRuntime;
use crewon_state::StoredArtifactMetadataRecord;
use crewon_task_runtime::TaskContract;

use super::provider_run_authority::ProviderRunAuthorityError;
use super::provider_run_authority::ProviderRunAuthorityRequest;
use super::provider_run_authority::ResolvedProviderRunAuthority;
use super::provider_run_authority::resolve_provider_run_authority;

const MAX_PROMPT_BYTES: u64 = 64 * 1024;
const MAX_PROMPT_CHARS: usize = 10_000;

pub(crate) struct CloudExecutionResolveRequest<'a> {
    pub state: &'a StateRuntime,
    pub contract: &'a TaskContract,
    pub now: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ResolvedCloudExecution {
    execution_spec: CloudExecutionSpecRecord,
    resource: ResourceRef,
    authority: ResolvedProviderRunAuthority,
    prompt: String,
    context_artifacts: Vec<ArtifactExecutionProjection>,
}

impl ResolvedCloudExecution {
    pub(crate) fn execution_spec(&self) -> &CloudExecutionSpecRecord {
        &self.execution_spec
    }

    pub(crate) fn resource(&self) -> &ResourceRef {
        &self.resource
    }

    pub(crate) fn authority(&self) -> &ResolvedProviderRunAuthority {
        &self.authority
    }

    pub(crate) fn prompt(&self) -> &str {
        &self.prompt
    }

    pub(crate) fn context_artifacts(&self) -> &[ArtifactExecutionProjection] {
        &self.context_artifacts
    }
}

impl fmt::Debug for ResolvedCloudExecution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedCloudExecution")
            .field("execution_spec_id", &self.execution_spec.execution_spec_id)
            .field("resource", &self.resource)
            .field("credential_id", &"[REDACTED]")
            .field("credential_revision", &self.authority.credential_revision())
            .field("prompt", &"[REDACTED]")
            .field("context_artifact_count", &self.context_artifacts.len())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudExecutionResolveError {
    InvalidRequest,
    StateUnavailable,
    ExecutionSpecNotFound,
    ExecutionSpecMismatch,
    BindingCardinality,
    BindingMismatch,
    CredentialMismatch,
    ArtifactUnavailable,
    ArtifactMismatch,
    PromptInvalid,
}

impl fmt::Display for CloudExecutionResolveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "cloud execution resolution failed: {self:?}")
    }
}

impl std::error::Error for CloudExecutionResolveError {}

pub(crate) async fn resolve_cloud_execution(
    request: CloudExecutionResolveRequest<'_>,
) -> Result<ResolvedCloudExecution, CloudExecutionResolveError> {
    if request.now < 0 {
        return Err(CloudExecutionResolveError::InvalidRequest);
    }
    let execution_ref = request.contract.execution_spec();
    let spec = request
        .state
        .get_cloud_execution_spec_record(
            execution_ref.execution_spec_id().as_str(),
            execution_ref.revision().get(),
        )
        .await
        .map_err(|_| CloudExecutionResolveError::StateUnavailable)?
        .ok_or(CloudExecutionResolveError::ExecutionSpecNotFound)?;
    if spec.digest != execution_ref.digest().as_str()
        || spec.task_id != request.contract.task_id().as_str()
        || spec.workspace_key != request.contract.workspace_key().as_str()
    {
        return Err(CloudExecutionResolveError::ExecutionSpecMismatch);
    }

    let binding = unique_cloud_agent_binding(request.contract.bindings())?;
    if !binding_matches_spec(binding, &spec) {
        return Err(CloudExecutionResolveError::BindingMismatch);
    }
    let expected_binding_revision = request
        .state
        .get_cloud_agent_turn_record_by_task_id(request.contract.task_id().as_str())
        .await
        .map_err(|_| CloudExecutionResolveError::StateUnavailable)?
        .map(|turn| {
            if turn.execution_binding.binding_id == spec.binding_id {
                Ok(turn.execution_binding.revision)
            } else {
                Err(CloudExecutionResolveError::BindingMismatch)
            }
        })
        .transpose()?;
    let authority = resolve_provider_run_authority(ProviderRunAuthorityRequest {
        state: request.state,
        binding,
        expected_binding_revision,
        credential_id: &spec.credential_id,
        credential_revision: spec.credential_revision,
        now: request.now,
    })
    .await
    .map_err(map_authority_error)?;

    let prompt_metadata = load_artifact_metadata(
        request.state,
        &spec.prompt_artifact,
        &spec.task_id,
        &spec.workspace_key,
        request.now,
    )
    .await?;
    if prompt_metadata.metadata.payload.byte_len > MAX_PROMPT_BYTES
        || !prompt_media_type_is_supported(&prompt_metadata.metadata.payload.media_type)
    {
        return Err(CloudExecutionResolveError::PromptInvalid);
    }
    let prompt = load_prompt_body(request.state, prompt_metadata).await?;

    let mut context_artifacts = Vec::with_capacity(spec.context_artifacts.len());
    for artifact in &spec.context_artifacts {
        context_artifacts.push(
            load_artifact_metadata(
                request.state,
                artifact,
                &spec.task_id,
                &spec.workspace_key,
                request.now,
            )
            .await?
            .projection,
        );
    }
    Ok(ResolvedCloudExecution {
        execution_spec: spec,
        resource: binding.resource().clone(),
        authority,
        prompt,
        context_artifacts,
    })
}

fn map_authority_error(error: ProviderRunAuthorityError) -> CloudExecutionResolveError {
    match error {
        ProviderRunAuthorityError::StateUnavailable => CloudExecutionResolveError::StateUnavailable,
        ProviderRunAuthorityError::InvalidRequest
        | ProviderRunAuthorityError::BindingMismatch
        | ProviderRunAuthorityError::ConnectionMismatch
        | ProviderRunAuthorityError::GrantMismatch
        | ProviderRunAuthorityError::IdentityMismatch => {
            CloudExecutionResolveError::CredentialMismatch
        }
    }
}

struct ResolvedArtifactMetadata {
    metadata: StoredArtifactMetadataRecord,
    projection: ArtifactExecutionProjection,
}

async fn load_artifact_metadata(
    state: &StateRuntime,
    artifact: &CloudExecutionArtifactRefRecord,
    task_id: &str,
    workspace_key: &str,
    now: i64,
) -> Result<ResolvedArtifactMetadata, CloudExecutionResolveError> {
    let metadata = state
        .get_artifact_metadata_record(&artifact.artifact_id, artifact.revision)
        .await
        .map_err(|_| CloudExecutionResolveError::StateUnavailable)?
        .ok_or(CloudExecutionResolveError::ArtifactUnavailable)?;
    let projection =
        ArtifactExecutionProjection::from_manifest_json(&metadata.manifest.manifest_json)
            .map_err(|_| CloudExecutionResolveError::ArtifactMismatch)?;
    if !artifact_metadata_matches(
        &metadata,
        &projection,
        artifact,
        task_id,
        workspace_key,
        now,
    ) {
        return Err(CloudExecutionResolveError::ArtifactMismatch);
    }
    Ok(ResolvedArtifactMetadata {
        metadata,
        projection,
    })
}

async fn load_prompt_body(
    state: &StateRuntime,
    resolved: ResolvedArtifactMetadata,
) -> Result<String, CloudExecutionResolveError> {
    let artifact_ref = resolved.projection.artifact_ref();
    let stored = state
        .get_artifact_record(
            artifact_ref.artifact_id().as_str(),
            artifact_ref.revision().get(),
        )
        .await
        .map_err(|_| CloudExecutionResolveError::StateUnavailable)?
        .ok_or(CloudExecutionResolveError::ArtifactUnavailable)?;
    if stored.manifest != resolved.metadata.manifest
        || stored.payload.status != ArtifactPayloadStatus::Available
        || stored.payload.payload_id != resolved.metadata.payload.payload_id
        || stored.payload.sha256 != resolved.metadata.payload.sha256
        || stored.payload.byte_len != resolved.metadata.payload.byte_len
        || stored.payload.media_type != resolved.metadata.payload.media_type
        || stored.payload.sensitivity != resolved.metadata.payload.sensitivity
        || stored.payload.retention_kind != resolved.metadata.payload.retention_kind
        || stored.payload.expires_at != resolved.metadata.payload.expires_at
        || stored.payload.created_at != resolved.metadata.payload.created_at
    {
        return Err(CloudExecutionResolveError::ArtifactMismatch);
    }
    let content = stored
        .payload
        .content
        .ok_or(CloudExecutionResolveError::ArtifactUnavailable)?;
    let body = PayloadBody::new(
        content,
        projection_sensitivity(resolved.metadata.payload.sensitivity),
    )
    .map_err(|_| CloudExecutionResolveError::ArtifactMismatch)?;
    resolved
        .projection
        .payload()
        .verify_body(&body)
        .map_err(|_| CloudExecutionResolveError::ArtifactMismatch)?;
    let prompt = String::from_utf8(body.as_bytes().to_vec())
        .map_err(|_| CloudExecutionResolveError::PromptInvalid)?;
    if prompt.is_empty()
        || prompt.chars().count() > MAX_PROMPT_CHARS
        || prompt.chars().any(forbidden_prompt_character)
    {
        return Err(CloudExecutionResolveError::PromptInvalid);
    }
    Ok(prompt)
}

pub(super) fn unique_cloud_agent_binding(
    bindings: &[ResolvedResourceBinding],
) -> Result<&ResolvedResourceBinding, CloudExecutionResolveError> {
    let mut eligible = bindings.iter().filter(|binding| {
        binding.mode() == BindingMode::ProviderManaged
            && binding.execution_location() == ExecutionLocation::Provider
            && binding.resource().kind == ResourceKind::Agent
    });
    let binding = eligible
        .next()
        .ok_or(CloudExecutionResolveError::BindingCardinality)?;
    if eligible.next().is_some() {
        return Err(CloudExecutionResolveError::BindingCardinality);
    }
    Ok(binding)
}

pub(super) fn binding_matches_spec(
    binding: &ResolvedResourceBinding,
    spec: &CloudExecutionSpecRecord,
) -> bool {
    let resource = binding.resource();
    binding.binding_id().as_str() == spec.binding_id
        && binding.workspace_key().as_str() == spec.workspace_key
        && resource.provider.provider_id.as_str() == spec.provider_id
        && resource.provider.protocol_version.as_str() == spec.protocol_version
        && resource.kind == ResourceKind::Agent
        && spec.resource_kind == "agent"
        && resource.resource_id.as_str() == spec.resource_id
        && resource.revision.as_str() == spec.resource_revision
}

fn artifact_metadata_matches(
    metadata: &StoredArtifactMetadataRecord,
    projection: &ArtifactExecutionProjection,
    expected: &CloudExecutionArtifactRefRecord,
    task_id: &str,
    workspace_key: &str,
    now: i64,
) -> bool {
    let artifact_ref = projection.artifact_ref();
    let payload = projection.payload();
    metadata.payload.status == ArtifactPayloadStatus::Available
        && metadata
            .payload
            .expires_at
            .is_none_or(|expires_at| expires_at > now)
        && projection.verification() != VerificationStatus::Rejected
        && artifact_ref.artifact_id().as_str() == expected.artifact_id
        && artifact_ref.revision().get() == expected.revision
        && metadata.manifest.artifact_id == expected.artifact_id
        && metadata.manifest.revision == expected.revision
        && metadata.manifest.payload_id == metadata.payload.payload_id
        && metadata.manifest.created_at == metadata.payload.created_at
        && payload.payload_id().as_str() == metadata.payload.payload_id
        && payload.digest().as_str() == metadata.payload.sha256
        && payload.byte_len() == metadata.payload.byte_len
        && payload.media_type().as_str() == metadata.payload.media_type
        && payload.sensitivity() == projection_sensitivity(metadata.payload.sensitivity)
        && retention_matches(&metadata.payload, projection.retention())
        && projection.created_at().get() == metadata.payload.created_at
        && projection.workspace().workspace_key().as_str() == workspace_key
        && execution_matches_task(projection.execution(), task_id)
}

fn execution_matches_task(execution: &ExecutionCorrelation, expected_task_id: &str) -> bool {
    match execution {
        ExecutionCorrelation::Conversation { .. } => true,
        ExecutionCorrelation::Task { task_id, .. } => task_id.as_str() == expected_task_id,
    }
}

fn retention_matches(
    payload: &crewon_state::StoredArtifactPayloadMetadataRecord,
    retention: &RetentionPolicy,
) -> bool {
    match (payload.retention_kind, retention) {
        (ArtifactRetentionKind::Session, RetentionPolicy::Session { expires_at })
        | (ArtifactRetentionKind::Task, RetentionPolicy::Task { expires_at })
        | (ArtifactRetentionKind::Compliance, RetentionPolicy::Compliance { expires_at }) => {
            payload.expires_at == Some(expires_at.get())
        }
        (ArtifactRetentionKind::UserManaged, RetentionPolicy::UserManaged) => {
            payload.expires_at.is_none()
        }
        _ => false,
    }
}

const fn projection_sensitivity(sensitivity: ArtifactPayloadSensitivity) -> PayloadSensitivity {
    match sensitivity {
        ArtifactPayloadSensitivity::Public => PayloadSensitivity::Public,
        ArtifactPayloadSensitivity::Internal => PayloadSensitivity::Internal,
        ArtifactPayloadSensitivity::WorkspaceSensitive => PayloadSensitivity::WorkspaceSensitive,
    }
}

fn prompt_media_type_is_supported(media_type: &str) -> bool {
    media_type.starts_with("text/") || media_type == "application/json"
}

fn forbidden_prompt_character(character: char) -> bool {
    character.is_control() && !matches!(character, '\n' | '\r' | '\t')
}

#[cfg(test)]
#[path = "cloud_execution_resolver_tests.rs"]
pub(super) mod tests;
