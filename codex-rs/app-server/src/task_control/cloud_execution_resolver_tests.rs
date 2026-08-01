use super::*;
use crate::platform_control::ConnectionRequestIdentity;
use crate::platform_control::artifact_adapter::ResolvedArtifactCommitInput;
use crate::platform_control::artifact_adapter::ResolvedArtifactTraceInput;
use crate::platform_control::artifact_adapter::prepare_artifact_commit;
use crate::task_control::provider_run_authority::tests::GRANT_ID;
use crate::task_control::provider_run_authority::tests::WORKSPACE_KEY;
use crate::task_control::provider_run_authority::tests::install_authority_records;
use crate::task_control::task_state_store_adapter::TaskStateStoreAdapter;
use crate::transport::ConnectionOrigin;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_artifact::ApprovalCorrelation;
use crewon_artifact::ArtifactId;
use crewon_artifact::ArtifactIdempotencyKey;
use crewon_artifact::ArtifactKind;
use crewon_artifact::ArtifactRevision;
use crewon_artifact::AuditEventId;
use crewon_artifact::AuditIdempotencyKey;
use crewon_artifact::CostCorrelation;
use crewon_artifact::ExecutionCorrelation;
use crewon_artifact::MediaType;
use crewon_artifact::PayloadBody;
use crewon_artifact::PayloadId;
use crewon_artifact::PayloadSensitivity;
use crewon_artifact::ResourceCorrelation;
use crewon_artifact::RetentionPolicy;
use crewon_artifact::SpanId;
use crewon_artifact::ThreadId;
use crewon_artifact::TurnId;
use crewon_artifact::VerificationStatus;
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
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_state::ArtifactCommitOutcome;
use crewon_state::CloudExecutionArtifactRefRecord;
use crewon_state::CloudExecutionSpecCreateOutcome;
use crewon_state::CloudExecutionSpecRecord;
use crewon_state::ProviderAccessGrantRevokeOutcome;
use crewon_state::ProviderAccessGrantRevokeRequest;
use crewon_state::StateRuntime;
use crewon_task_runtime::ExecutionSpecDigest;
use crewon_task_runtime::ExecutionSpecId;
use crewon_task_runtime::ExecutionSpecRef;
use crewon_task_runtime::ExecutionSpecRevision;
use crewon_task_runtime::FencingTokenHash;
use crewon_task_runtime::IdempotencyKey;
use crewon_task_runtime::LeaseEpoch;
use crewon_task_runtime::LeaseGrant;
use crewon_task_runtime::OutboxId;
use crewon_task_runtime::StrategyKind;
use crewon_task_runtime::TASK_CONTRACT_SCHEMA_VERSION;
use crewon_task_runtime::TaskAggregate;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskCommand;
use crewon_task_runtime::TaskCommandEnvelope;
use crewon_task_runtime::TaskCommit;
use crewon_task_runtime::TaskCommitOutcome;
use crewon_task_runtime::TaskContract;
use crewon_task_runtime::TaskContractSchemaVersion;
use crewon_task_runtime::TaskContractSpec;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use crewon_task_runtime::WorkerDispatch;
use crewon_task_runtime::WorkerRunId;
use crewon_task_runtime::decide_command;
use pretty_assertions::assert_eq;

pub(in crate::task_control) const CONTEXT_SECRET_MARKER: &str =
    "context-body-must-not-enter-resolved-input";

#[tokio::test]
async fn resolves_exact_cloud_input_without_secret_or_context_body_exposure() {
    let fixture = fixture(FixtureOptions::default()).await;

    let resolved = resolve_cloud_execution(CloudExecutionResolveRequest {
        state: fixture.state.as_ref(),
        contract: &fixture.contract,
        now: 150,
    })
    .await
    .expect("resolve cloud execution");

    assert_eq!(resolved.execution_spec(), &fixture.spec);
    assert_eq!(resolved.resource(), fixture.bindings[0].resource());
    assert_eq!(resolved.authority().credential_revision(), 1);
    assert_eq!(resolved.prompt(), "Run the exact task");
    assert_eq!(resolved.context_artifacts().len(), 1);
    assert_eq!(
        resolved.context_artifacts()[0].kind(),
        ArtifactKind::StructuredResult
    );
    let debug = format!("{resolved:?}");
    assert!(!debug.contains("credential-secret"));
    assert!(!debug.contains(CONTEXT_SECRET_MARKER));
    assert!(!debug.contains("Run the exact task"));

    fixture.state.close().await;
}

#[tokio::test]
async fn rejects_credential_revision_drift_before_prompt_loading() {
    let fixture = fixture(FixtureOptions::default()).await;
    assert_eq!(
        fixture
            .state
            .revoke_provider_access_grant_record(&ProviderAccessGrantRevokeRequest {
                grant_id: GRANT_ID.to_string(),
                expected_revision: 1,
                revoked_at: 140,
            })
            .await
            .expect("revoke Provider grant"),
        ProviderAccessGrantRevokeOutcome::Revoked
    );

    assert_eq!(
        resolve_cloud_execution(Fixture::request(&fixture, /*now*/ 150)).await,
        Err(CloudExecutionResolveError::CredentialMismatch)
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn rejects_multiple_cloud_agents_and_cross_workspace_context() {
    let multiple = fixture(FixtureOptions {
        extra_agent: true,
        ..FixtureOptions::default()
    })
    .await;
    assert_eq!(
        resolve_cloud_execution(Fixture::request(&multiple, /*now*/ 150)).await,
        Err(CloudExecutionResolveError::BindingCardinality)
    );
    multiple.state.close().await;

    let wrong_workspace = fixture(FixtureOptions {
        context_workspace_key: "workspace-other",
        ..FixtureOptions::default()
    })
    .await;
    assert_eq!(
        resolve_cloud_execution(Fixture::request(&wrong_workspace, /*now*/ 150)).await,
        Err(CloudExecutionResolveError::ArtifactMismatch)
    );
    wrong_workspace.state.close().await;
}

#[tokio::test]
async fn rejects_context_correlated_to_another_task() {
    let fixture = fixture(FixtureOptions {
        context_task_id: Some("task-other"),
        ..FixtureOptions::default()
    })
    .await;

    assert_eq!(
        resolve_cloud_execution(Fixture::request(&fixture, /*now*/ 150)).await,
        Err(CloudExecutionResolveError::ArtifactMismatch)
    );

    fixture.state.close().await;
}

#[derive(Clone, Copy)]
pub(in crate::task_control) struct FixtureOptions {
    extra_agent: bool,
    context_workspace_key: &'static str,
    context_task_id: Option<&'static str>,
}

impl Default for FixtureOptions {
    fn default() -> Self {
        Self {
            extra_agent: false,
            context_workspace_key: WORKSPACE_KEY,
            context_task_id: None,
        }
    }
}

pub(in crate::task_control) struct Fixture {
    _home: tempfile::TempDir,
    pub(in crate::task_control) state: std::sync::Arc<StateRuntime>,
    pub(in crate::task_control) contract: TaskContract,
    pub(in crate::task_control) dispatch: WorkerDispatch,
    pub(in crate::task_control) bindings: Vec<crewon_resource_federation::ResolvedResourceBinding>,
    pub(in crate::task_control) spec: CloudExecutionSpecRecord,
}

impl Fixture {
    fn request(&self, now: i64) -> CloudExecutionResolveRequest<'_> {
        CloudExecutionResolveRequest {
            state: self.state.as_ref(),
            contract: &self.contract,
            now,
        }
    }
}

pub(in crate::task_control) async fn fixture(options: FixtureOptions) -> Fixture {
    let home = tempfile::tempdir().expect("temporary state directory");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state");
    let mut bindings = vec![install_authority_records(state.as_ref()).await];
    if options.extra_agent {
        bindings.push(cloud_agent_binding(
            "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c302",
            "agent-2",
        ));
    }
    let mut spec = CloudExecutionSpecRecord {
        execution_spec_id: "execution-spec-1".to_string(),
        revision: 1,
        digest: String::new(),
        task_id: "task-1".to_string(),
        workspace_key: WORKSPACE_KEY.to_string(),
        binding_id: bindings[0].binding_id().as_str().to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: "agent".to_string(),
        resource_id: "agent-1".to_string(),
        resource_revision: "agent-revision-1".to_string(),
        credential_id: GRANT_ID.to_string(),
        credential_revision: 1,
        prompt_artifact: artifact_ref("prompt-artifact"),
        context_artifacts: vec![artifact_ref("context-artifact")],
        created_at: 100,
    };
    spec.digest = spec.canonical_digest();
    let contract = TaskContract::new(TaskContractSpec {
        task_id: TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        strategy: StrategyKind::Office,
        workspace_key: WorkspaceKey::new(WORKSPACE_KEY).expect("workspace key"),
        schema_version: TaskContractSchemaVersion::new(TASK_CONTRACT_SCHEMA_VERSION)
            .expect("schema version"),
        execution_spec: ExecutionSpecRef::new(
            ExecutionSpecId::new(&spec.execution_spec_id).expect("execution spec id"),
            ExecutionSpecRevision::new(spec.revision).expect("execution spec revision"),
            ExecutionSpecDigest::new(&spec.digest).expect("execution spec digest"),
        ),
        bindings: bindings.clone(),
        created_at: UnixTimestamp::new(/*value*/ 100).expect("created at"),
    })
    .expect("task contract");
    let adapter = TaskStateStoreAdapter::new(state.clone());
    let genesis = TaskAggregate::new(contract.clone());
    adapter.create(genesis.clone()).await.expect("create task");
    let queued = commit_task(
        &adapter,
        &genesis,
        command(
            "accept-command",
            "accept-event",
            TaskCommand::AcceptTask {
                attempt_id: crewon_task_runtime::AttemptId::new("attempt-1").expect("attempt id"),
                idempotency_key: IdempotencyKey::new("task-1:attempt-1").expect("idempotency key"),
            },
        ),
        "accept-outbox",
    )
    .await;
    let running = commit_task(
        &adapter,
        &queued,
        command(
            "claim-command",
            "claim-event",
            TaskCommand::ClaimAttempt {
                attempt_id: crewon_task_runtime::AttemptId::new("attempt-1").expect("attempt id"),
                worker_run_id: WorkerRunId::new("worker-1").expect("worker run id"),
                lease: LeaseGrant::new(
                    LeaseEpoch::new(/*value*/ 1).expect("lease epoch"),
                    FencingTokenHash::new(
                        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    )
                    .expect("fencing token hash"),
                    UnixTimestamp::new(/*value*/ 1_000).expect("lease expiry"),
                ),
            },
        ),
        "claim-outbox",
    )
    .await;
    let dispatch = WorkerDispatch::from_aggregate(
        &running,
        UnixTimestamp::new(/*value*/ 150).expect("dispatch time"),
    )
    .expect("worker dispatch");
    commit_artifact(
        &state,
        ArtifactFixtureInput {
            artifact_id: "prompt-artifact",
            payload_id: "prompt-payload",
            body: "Run the exact task".as_bytes(),
            kind: ArtifactKind::Document,
            media_type: "text/plain",
            workspace_key: WORKSPACE_KEY,
            task_id: None,
        },
    )
    .await;
    commit_artifact(
        &state,
        ArtifactFixtureInput {
            artifact_id: "context-artifact",
            payload_id: "context-payload",
            body: CONTEXT_SECRET_MARKER.as_bytes(),
            kind: ArtifactKind::StructuredResult,
            media_type: "application/json",
            workspace_key: options.context_workspace_key,
            task_id: options.context_task_id,
        },
    )
    .await;
    assert_eq!(
        state
            .create_cloud_execution_spec_record(&spec)
            .await
            .expect("create execution spec"),
        CloudExecutionSpecCreateOutcome::Created
    );
    Fixture {
        _home: home,
        state,
        contract,
        dispatch,
        bindings,
        spec,
    }
}

async fn commit_task(
    adapter: &TaskStateStoreAdapter,
    aggregate: &TaskAggregate,
    envelope: TaskCommandEnvelope,
    outbox_id: &str,
) -> TaskAggregate {
    let decision = decide_command(aggregate, &envelope).expect("task decision");
    let commit = TaskCommit::from_decision(
        aggregate,
        &envelope,
        OutboxId::new(outbox_id).expect("outbox id"),
        decision,
    )
    .expect("task commit");
    match adapter
        .commit(commit)
        .await
        .expect("persist task transition")
    {
        TaskCommitOutcome::Committed(aggregate) => aggregate,
        TaskCommitOutcome::Duplicate(_) => panic!("new fixture transition cannot be duplicate"),
    }
}

fn command(command_id: &str, event_id: &str, command: TaskCommand) -> TaskCommandEnvelope {
    TaskCommandEnvelope {
        command_id: crewon_task_runtime::CommandId::new(command_id).expect("command id"),
        event_id: crewon_task_runtime::EventId::new(event_id).expect("event id"),
        task_id: TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        occurred_at: UnixTimestamp::new(/*value*/ 110).expect("occurred at"),
        received_at: UnixTimestamp::new(/*value*/ 110).expect("received at"),
        command,
    }
}

struct ArtifactFixtureInput<'a> {
    artifact_id: &'a str,
    payload_id: &'a str,
    body: &'a [u8],
    kind: ArtifactKind,
    media_type: &'a str,
    workspace_key: &'a str,
    task_id: Option<&'a str>,
}

async fn commit_artifact(state: &StateRuntime, fixture: ArtifactFixtureInput<'_>) {
    let execution = fixture.task_id.map_or_else(
        || ExecutionCorrelation::Conversation {
            thread_id: ThreadId::new("thread-1").expect("thread id"),
            turn_id: TurnId::new("turn-1").expect("turn id"),
        },
        |task_id| ExecutionCorrelation::Task {
            task_id: TaskId::new(task_id).expect("artifact task id"),
            run_id: crewon_artifact::RunId::new("run-1").expect("run id"),
            attempt_id: crewon_task_runtime::AttemptId::new("attempt-1").expect("attempt id"),
        },
    );
    let input = ResolvedArtifactCommitInput {
        artifact_id: ArtifactId::new(fixture.artifact_id).expect("artifact id"),
        revision: ArtifactRevision::new(/*value*/ 1).expect("artifact revision"),
        artifact_idempotency_key: ArtifactIdempotencyKey::new(format!(
            "create-{}",
            fixture.artifact_id
        ))
        .expect("artifact idempotency key"),
        kind: fixture.kind,
        payload_id: PayloadId::new(fixture.payload_id).expect("payload id"),
        body: PayloadBody::new(
            fixture.body.to_vec(),
            PayloadSensitivity::WorkspaceSensitive,
        )
        .expect("payload body"),
        media_type: MediaType::new(fixture.media_type).expect("media type"),
        execution,
        resource: ResourceCorrelation::None,
        approval: ApprovalCorrelation::None,
        trace: ResolvedArtifactTraceInput {
            span_id: SpanId::new(format!("span-{}", fixture.artifact_id)).expect("span id"),
            parent_span_id: None,
        },
        cost: CostCorrelation::None,
        verification: VerificationStatus::Verified,
        retention: RetentionPolicy::UserManaged,
        event_id: AuditEventId::new(format!("event-{}", fixture.artifact_id)).expect("event id"),
        audit_idempotency_key: AuditIdempotencyKey::new(format!("audit-{}", fixture.artifact_id))
            .expect("audit idempotency key"),
        created_at: UnixTimestamp::new(/*value*/ 100).expect("created at"),
    };
    let record = prepare_artifact_commit(&identity(), &workspace(fixture.workspace_key), input)
        .expect("prepare Artifact")
        .into_state_record()
        .expect("Artifact state record");
    assert_eq!(
        state
            .commit_artifact_record(&record)
            .await
            .expect("commit Artifact"),
        ArtifactCommitOutcome::Created
    );
}

fn cloud_agent_binding(
    binding_id: &str,
    resource_id: &str,
) -> crewon_resource_federation::ResolvedResourceBinding {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol version"),
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new(resource_id).expect("resource id"),
        revision: ResourceRevision::new("agent-revision-1").expect("resource revision"),
    };
    let capability = Capability {
        resource_kind: ResourceKind::Agent,
        binding_mode: BindingMode::ProviderManaged,
        execution_location: ExecutionLocation::Provider,
    };
    resolve_binding(
        &BindingRequest {
            binding_id: BindingId::new(binding_id).expect("binding id"),
            workspace_key: WorkspaceKey::new(WORKSPACE_KEY).expect("workspace key"),
            resource: resource.clone(),
            mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
            materialization: None,
        },
        &ResourceManifest {
            resource,
            schema_version: ManifestSchemaVersion::new("1").expect("manifest schema"),
            content_digest: None,
        },
        &ProviderCapabilities::new(provider, [capability]).expect("provider capabilities"),
    )
    .expect("resolve binding")
}

fn artifact_ref(artifact_id: &str) -> CloudExecutionArtifactRefRecord {
    CloudExecutionArtifactRefRecord {
        artifact_id: artifact_id.to_string(),
        revision: 1,
    }
}

fn identity() -> crate::platform_control::RequestIdentity {
    ConnectionRequestIdentity::new(ConnectionOrigin::Stdio).derive(
        RequestIdentityClientRef {
            name: "test-client".to_string(),
            version: "1".to_string(),
            capabilities: RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "trace-1".to_string(),
    )
}

fn workspace(workspace_key: &str) -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: workspace_key.to_string(),
        binding_id: "input-binding".to_string(),
        scope: WorkspaceScope::Office,
        scope_id: "office-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "environment-1".to_string(),
    }
}
