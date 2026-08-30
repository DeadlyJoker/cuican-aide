use std::fmt;

use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_core::context::GovernedContextFragment;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_state::CloudAgentTurnCreateBundle;
use crewon_state::CloudAgentTurnCreateOutcome;
use crewon_state::CloudAgentTurnOrigin;
use crewon_state::CloudAgentTurnRecord;
use crewon_state::CloudAgentTurnStatus;
use crewon_state::CloudExecutionSpecRecord;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_state::StateRuntime;
use crewon_task_runtime::AttemptId;
use crewon_task_runtime::CommandId;
use crewon_task_runtime::EventId;
use crewon_task_runtime::ExecutionSpecDigest;
use crewon_task_runtime::ExecutionSpecId;
use crewon_task_runtime::ExecutionSpecRef;
use crewon_task_runtime::ExecutionSpecRevision;
use crewon_task_runtime::IdempotencyKey;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::StrategyKind;
use crewon_task_runtime::TASK_CONTRACT_SCHEMA_VERSION;
use crewon_task_runtime::TaskAggregate;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskContract;
use crewon_task_runtime::TaskContractSchemaVersion;
use crewon_task_runtime::TaskContractSpec;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::decide_command;
use sha2::Digest;
use sha2::Sha256;

use super::cloud_agent_turn_artifacts::CloudAgentTurnArtifactRequest;
use super::cloud_agent_turn_artifacts::expected_cloud_agent_turn_artifact_refs;
use super::cloud_agent_turn_artifacts::materialize_cloud_agent_turn_artifacts;
use super::cloud_agent_turn_replay::CloudAgentTurnReplayError;
use super::cloud_agent_turn_replay::CloudAgentTurnReplayRequest;
use super::cloud_agent_turn_replay::ensure_replay_will_not_create_orphan_artifacts;
use super::provider_run_authority::ProviderRunAuthorityRequest;
use super::provider_run_authority::resolve_provider_run_authority;
use super::task_state_store_adapter::task_commit_record;
use super::task_state_store_adapter::task_record;
use crate::platform_control::RequestIdentity;
use crate::platform_control::thread_execution_context_adapter::authorize_thread_execution_context_record;

const EXECUTION_SPEC_REVISION: u64 = 1;

pub(crate) struct CloudAgentTurnStartRequest<'a> {
    pub(crate) state: &'a StateRuntime,
    pub(crate) identity: &'a RequestIdentity,
    pub(crate) workspace: &'a WorkspaceRef,
    pub(crate) thread_id: &'a str,
    pub(crate) client_user_message_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) context_fragments: Vec<GovernedContextFragment>,
    pub(crate) now: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct CloudAgentTurnStartResult {
    pub(crate) turn: CloudAgentTurnRecord,
    pub(crate) created: bool,
}

impl fmt::Debug for CloudAgentTurnStartResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudAgentTurnStartResult")
            .field("turn_id", &self.turn.turn_id)
            .field("task_id", &self.turn.origin.task_id())
            .field("created", &self.created)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum CloudAgentTurnStartError {
    #[error("Cloud Agent Turn request is invalid")]
    InvalidRequest,
    #[error("Cloud Agent Turn request is not authorized")]
    Unauthorized,
    #[error("Cloud Agent execution capability is unsupported")]
    CapabilityUnsupported,
    #[error("Cloud Agent execution authority changed")]
    AuthorityChanged,
    #[error("Cloud Agent Turn conflicts with durable state")]
    Conflict,
    #[error("Another Cloud Agent Turn is active")]
    ActiveTurnExists,
    #[error("Cloud Agent Turn capacity was exceeded")]
    CapacityExceeded,
    #[error("Cloud Agent Turn state is unavailable")]
    StateUnavailable,
}

pub(crate) async fn start_cloud_agent_turn(
    request: CloudAgentTurnStartRequest<'_>,
) -> Result<CloudAgentTurnStartResult, CloudAgentTurnStartError> {
    validate_request(&request)?;
    let context = request
        .state
        .get_thread_execution_context_record(request.thread_id)
        .await
        .map_err(|_| CloudAgentTurnStartError::StateUnavailable)?
        .ok_or(CloudAgentTurnStartError::AuthorityChanged)?;
    authorize_thread_execution_context_record(request.identity, &context)
        .map_err(|_| CloudAgentTurnStartError::Unauthorized)?;
    if context.workspace_key != request.workspace.workspace_key
        || context.workspace_scope != ProviderResourceWorkspaceScope::Conversation
        || context.workspace_scope_id != request.workspace.scope_id
    {
        return Err(CloudAgentTurnStartError::Unauthorized);
    }
    let execution_ref = context
        .execution_binding
        .as_ref()
        .ok_or(CloudAgentTurnStartError::CapabilityUnsupported)?;
    let binding_record = request
        .state
        .get_provider_resource_binding_record(&execution_ref.binding_id)
        .await
        .map_err(|_| CloudAgentTurnStartError::StateUnavailable)?
        .ok_or(CloudAgentTurnStartError::AuthorityChanged)?;
    if !binding_matches_context(&binding_record, execution_ref.revision, &context) {
        return Err(CloudAgentTurnStartError::AuthorityChanged);
    }
    let binding = restore_cloud_agent_binding(&binding_record)?;
    let connection = request
        .state
        .get_provider_connection_record(&binding_record.connection_id)
        .await
        .map_err(|_| CloudAgentTurnStartError::StateUnavailable)?
        .ok_or(CloudAgentTurnStartError::AuthorityChanged)?;
    resolve_provider_run_authority(ProviderRunAuthorityRequest {
        state: request.state,
        binding: &binding,
        expected_binding_revision: Some(execution_ref.revision),
        credential_id: &connection.credential_id,
        credential_revision: connection.credential_revision,
        now: request.now,
    })
    .await
    .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?;

    let ids = TurnIds::new(request.thread_id, request.client_user_message_id);
    let artifact_request = CloudAgentTurnArtifactRequest {
        state: request.state,
        identity: request.identity,
        workspace: request.workspace,
        execution_binding: &binding,
        thread_id: request.thread_id,
        turn_id: &ids.turn_id,
        client_user_message_id: request.client_user_message_id,
        prompt: request.prompt,
        context_fragments: request.context_fragments.clone(),
        now: request.now,
    };
    let expected_artifacts = expected_cloud_agent_turn_artifact_refs(&artifact_request)
        .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?;
    let replay = ensure_replay_will_not_create_orphan_artifacts(CloudAgentTurnReplayRequest {
        state: request.state,
        thread_id: request.thread_id,
        client_user_message_id: request.client_user_message_id,
        task_id: &ids.task_id,
        execution_spec_id: &ids.execution_spec_id,
        artifacts: &expected_artifacts,
        prompt: request.prompt,
        context_fragments: &request.context_fragments,
    })
    .await
    .map_err(|error| match error {
        CloudAgentTurnReplayError::Conflict => CloudAgentTurnStartError::Conflict,
        CloudAgentTurnReplayError::StateUnavailable => CloudAgentTurnStartError::StateUnavailable,
    })?;
    if let Some(turn) = replay {
        return Ok(CloudAgentTurnStartResult {
            turn,
            created: false,
        });
    }
    let artifacts = materialize_cloud_agent_turn_artifacts(artifact_request)
        .await
        .map_err(|error| match error {
            super::cloud_agent_turn_artifacts::CloudAgentTurnArtifactError::InvalidInput
            | super::cloud_agent_turn_artifacts::CloudAgentTurnArtifactError::InvalidContext => {
                CloudAgentTurnStartError::InvalidRequest
            }
            super::cloud_agent_turn_artifacts::CloudAgentTurnArtifactError::ArtifactConflict => {
                CloudAgentTurnStartError::Conflict
            }
            super::cloud_agent_turn_artifacts::CloudAgentTurnArtifactError::StateUnavailable => {
                CloudAgentTurnStartError::StateUnavailable
            }
        })?;
    let created_at = artifacts.created_at;
    let mut execution_spec = CloudExecutionSpecRecord {
        execution_spec_id: ids.execution_spec_id.clone(),
        revision: EXECUTION_SPEC_REVISION,
        digest: String::new(),
        task_id: ids.task_id.clone(),
        workspace_key: context.workspace_key.clone(),
        binding_id: binding_record.binding_id.clone(),
        provider_id: binding_record.provider_id.clone(),
        protocol_version: binding_record.protocol_version.clone(),
        resource_kind: "agent".to_string(),
        resource_id: binding_record.resource_id.clone(),
        resource_revision: binding_record.resource_revision.clone(),
        credential_id: connection.credential_id,
        credential_revision: connection.credential_revision,
        prompt_artifact: artifacts.prompt.clone(),
        context_artifacts: artifacts.context,
        created_at,
    };
    execution_spec.digest = execution_spec.canonical_digest();
    let (genesis, accepted) = task_records(&ids, &execution_spec, binding, created_at)?;
    let turn = CloudAgentTurnRecord {
        thread_id: request.thread_id.to_string(),
        turn_id: ids.turn_id,
        client_user_message_id: request.client_user_message_id.to_string(),
        origin: CloudAgentTurnOrigin::DurableTask {
            task_id: ids.task_id,
        },
        local_actor_id: context.local_actor_id,
        local_tenant_id: context.local_tenant_id,
        local_space_id: context.local_space_id,
        workspace_key: context.workspace_key,
        execution_binding: execution_ref.clone(),
        prompt_artifact: artifacts.prompt,
        status: CloudAgentTurnStatus::Queued,
        last_provider_sequence: 0,
        primary_output_artifact: None,
        additional_output_artifacts: Vec::new(),
        error_code: None,
        trace_id: Some(request.identity.reference().trace_id.clone()),
        revision: 1,
        creation_digest: zero_digest(),
        record_hash: String::new(),
        created_at,
        updated_at: created_at,
        completed_at: None,
    };
    let mut bundle = CloudAgentTurnCreateBundle {
        task_genesis: genesis,
        accepted_commit: accepted,
        execution_spec,
        turn,
    };
    bundle.turn.creation_digest = bundle.canonical_digest();
    bundle.turn.record_hash = bundle.turn.canonical_hash();
    bundle
        .validate()
        .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?;
    match request
        .state
        .create_cloud_agent_turn_bundle(&bundle, request.now)
        .await
        .map_err(|_| CloudAgentTurnStartError::StateUnavailable)?
    {
        CloudAgentTurnCreateOutcome::Created(turn) => Ok(CloudAgentTurnStartResult {
            turn,
            created: true,
        }),
        CloudAgentTurnCreateOutcome::ExistingSame(turn) => Ok(CloudAgentTurnStartResult {
            turn,
            created: false,
        }),
        CloudAgentTurnCreateOutcome::Conflict => Err(CloudAgentTurnStartError::Conflict),
        CloudAgentTurnCreateOutcome::DependencyMissing => {
            Err(CloudAgentTurnStartError::AuthorityChanged)
        }
        CloudAgentTurnCreateOutcome::ActiveTurnExists => {
            Err(CloudAgentTurnStartError::ActiveTurnExists)
        }
        CloudAgentTurnCreateOutcome::CapacityExceeded => {
            Err(CloudAgentTurnStartError::CapacityExceeded)
        }
    }
}

fn validate_request(
    request: &CloudAgentTurnStartRequest<'_>,
) -> Result<(), CloudAgentTurnStartError> {
    if request.workspace.scope != WorkspaceScope::Conversation
        || request.workspace.scope_id != request.thread_id
        || request.client_user_message_id.trim().is_empty()
        || request.prompt.trim().is_empty()
        || request.now < 0
    {
        return Err(CloudAgentTurnStartError::InvalidRequest);
    }
    Ok(())
}

fn binding_matches_context(
    binding: &ProviderResourceBindingRecord,
    revision: u64,
    context: &crewon_state::ThreadExecutionContextRecord,
) -> bool {
    binding.validate().is_ok()
        && binding.status == ProviderResourceBindingStatus::Active
        && binding.revision == revision
        && binding.local_actor_id == context.local_actor_id
        && binding.local_tenant_id == context.local_tenant_id
        && binding.local_space_id == context.local_space_id
        && binding.workspace_key == context.workspace_key
        && binding.workspace_scope == ProviderResourceWorkspaceScope::Conversation
        && binding.workspace_scope_id == context.thread_id
        && binding.resource_kind == ProviderResourceKind::Agent
        && binding.binding_mode == ProviderResourceBindingMode::ProviderManaged
        && binding.execution_location == ProviderResourceExecutionLocation::Provider
}

fn restore_cloud_agent_binding(
    record: &ProviderResourceBindingRecord,
) -> Result<ResolvedResourceBinding, CloudAgentTurnStartError> {
    let provider = ProviderRef {
        provider_id: ProviderId::new(&record.provider_id)
            .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
        protocol_version: ProviderProtocolVersion::new(&record.protocol_version)
            .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new(&record.resource_id)
            .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
        revision: ResourceRevision::new(&record.resource_revision)
            .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
    };
    let capability = Capability {
        resource_kind: ResourceKind::Agent,
        binding_mode: BindingMode::ProviderManaged,
        execution_location: ExecutionLocation::Provider,
    };
    resolve_binding(
        &BindingRequest {
            binding_id: BindingId::new(&record.binding_id)
                .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
            workspace_key: WorkspaceKey::new(&record.workspace_key)
                .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
            resource: resource.clone(),
            mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
            materialization: None,
        },
        &ResourceManifest {
            resource,
            schema_version: ManifestSchemaVersion::new(&record.manifest_schema_version)
                .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
            content_digest: record
                .content_digest
                .as_deref()
                .map(crewon_resource_federation::ContentDigest::new)
                .transpose()
                .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
        },
        &ProviderCapabilities::new(provider, [capability])
            .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)?,
    )
    .map_err(|_| CloudAgentTurnStartError::AuthorityChanged)
}

fn task_records(
    ids: &TurnIds,
    spec: &CloudExecutionSpecRecord,
    binding: ResolvedResourceBinding,
    now: i64,
) -> Result<(crewon_state::TaskRecord, crewon_state::TaskCommitRecord), CloudAgentTurnStartError> {
    let task_id =
        TaskId::new(&ids.task_id).map_err(|_| CloudAgentTurnStartError::InvalidRequest)?;
    let contract = TaskContract::new(TaskContractSpec {
        task_id: task_id.clone(),
        authority: TaskAuthority::LocalAppServer,
        strategy: StrategyKind::Single,
        workspace_key: WorkspaceKey::new(&spec.workspace_key)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        schema_version: TaskContractSchemaVersion::new(TASK_CONTRACT_SCHEMA_VERSION)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        execution_spec: ExecutionSpecRef::new(
            ExecutionSpecId::new(&spec.execution_spec_id)
                .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
            ExecutionSpecRevision::new(spec.revision)
                .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
            ExecutionSpecDigest::new(&spec.digest)
                .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        ),
        bindings: vec![binding],
        created_at: UnixTimestamp::new(now)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
    })
    .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?;
    let genesis = TaskAggregate::new(contract);
    let envelope = TaskCommandEnvelope {
        command_id: CommandId::new(&ids.accept_command_id)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        event_id: EventId::new(&ids.accept_event_id)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        task_id,
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(now)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        received_at: UnixTimestamp::new(now)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        command: TaskCommand::AcceptTask {
            attempt_id: AttemptId::new(&ids.attempt_id)
                .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
            idempotency_key: IdempotencyKey::new(&ids.attempt_idempotency_key)
                .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        },
    };
    let decision = decide_command(&genesis, &envelope)
        .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?;
    let commit = TaskCommit::from_decision(
        &genesis,
        &envelope,
        OutboxId::new(&ids.accept_outbox_id)
            .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        decision,
    )
    .map_err(|_| CloudAgentTurnStartError::InvalidRequest)?;
    Ok((
        task_record(&genesis).map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
        task_commit_record(&commit).map_err(|_| CloudAgentTurnStartError::InvalidRequest)?,
    ))
}

struct TurnIds {
    task_id: String,
    turn_id: String,
    attempt_id: String,
    attempt_idempotency_key: String,
    execution_spec_id: String,
    accept_command_id: String,
    accept_event_id: String,
    accept_outbox_id: String,
}

impl TurnIds {
    fn new(thread_id: &str, client_user_message_id: &str) -> Self {
        let seed = stable_seed(thread_id, client_user_message_id);
        Self {
            task_id: stable_id("cloud-agent-task", &seed),
            turn_id: stable_id("cloud-agent-turn", &seed),
            attempt_id: stable_id("cloud-agent-attempt", &seed),
            attempt_idempotency_key: stable_id("cloud-agent-attempt-key", &seed),
            execution_spec_id: stable_id("cloud-agent-execution-spec", &seed),
            accept_command_id: stable_id("cloud-agent-accept-command", &seed),
            accept_event_id: stable_id("cloud-agent-accept-event", &seed),
            accept_outbox_id: stable_id("cloud-agent-accept-outbox", &seed),
        }
    }
}

fn stable_seed(thread_id: &str, client_user_message_id: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.cloud-agent-turn.v1\0");
    for part in [thread_id.as_bytes(), client_user_message_id.as_bytes()] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn stable_id(prefix: &str, seed: &[u8]) -> String {
    let digest = Sha256::digest(seed);
    format!("{prefix}:{digest:x}")
}

fn zero_digest() -> String {
    format!("sha256:{}", "0".repeat(64))
}

#[cfg(test)]
#[path = "cloud_agent_turn_coordinator_tests.rs"]
pub(crate) mod tests;
