#![allow(
    clippy::expect_used,
    reason = "Wave 1 integration Harness uses expect for precise contract failures"
)]

use super::ConnectionRequestIdentity;
use super::RequestIdentity;
use super::artifact_adapter::ResolvedArtifactCommitInput;
use super::artifact_adapter::ResolvedArtifactDeletionInput;
use super::artifact_adapter::ResolvedArtifactTraceInput;
use super::artifact_adapter::prepare_artifact_commit;
use super::artifact_adapter::prepare_artifact_deletion;
use super::context_adapter::ContextConsumer;
use super::context_adapter::ContextFragmentInput;
use super::context_adapter::build_context_fragment;
use super::credential_adapter::credential_owner;
use super::credential_adapter::policy_credential_binding;
use super::policy_adapter::ResolvedPolicyActionInput;
use super::policy_adapter::build_action_intent;
use crate::task_control::task_state_store_adapter::TaskStateStoreAdapter;
use crate::transport::ConnectionOrigin;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use crewon_app_server_protocol::WorkspaceBindParams;
use crewon_app_server_protocol::WorkspaceBindResponse;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
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
use crewon_artifact::CurrencyCode;
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
use crewon_artifact::UsageCost;
use crewon_artifact::VerificationStatus;
use crewon_core::context::ContextAudienceKind;
use crewon_core::context::ContextBudget;
use crewon_core::context::ContextFreshness;
use crewon_core::context::ContextPurpose;
use crewon_core::context::ContextSensitivity;
use crewon_core::context::ContextSourceKind;
use crewon_core::context::ContextTrust;
use crewon_core::context::GovernedContextBundle;
use crewon_core::context::GovernedContextError;
use crewon_policy::AccessDecisionId;
use crewon_policy::ActionNonce;
use crewon_policy::ActionPurpose;
use crewon_policy::ActionTarget;
use crewon_policy::ActionType;
use crewon_policy::ApprovalDecision;
use crewon_policy::ApprovalId;
use crewon_policy::ApprovalLedger;
use crewon_policy::AuthorizationError;
use crewon_policy::BaselinePolicy;
use crewon_policy::CredentialBinding;
use crewon_policy::PolicyDecision;
use crewon_policy::PolicyDenialReason;
use crewon_policy::SideEffect;
use crewon_provider_transport::EndpointResolver;
use crewon_provider_transport::ProviderEndpointPolicy;
use crewon_provider_transport::ProviderEndpointPolicyError;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::Capability;
use crewon_resource_federation::CatalogProvider;
use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::PageLimit;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderError;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceListQuery;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourcePage;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_secrets::CredentialAccessRequest;
use crewon_secrets::CredentialCreateRequest;
use crewon_secrets::CredentialScopeKind;
use crewon_secrets::CredentialSecret;
use crewon_secrets::CredentialStore;
use crewon_secrets::CredentialStoreError;
use crewon_secrets::FakeCredentialStore;
use crewon_secrets::GrantedCredentialScope;
use crewon_state::ArtifactCommitOutcome;
use crewon_state::ArtifactDeletionReason;
use crewon_state::ArtifactPayloadDeleteOutcome;
use crewon_state::StateRuntime;
use crewon_task_runtime::ExecutionSpecDigest;
use crewon_task_runtime::ExecutionSpecId;
use crewon_task_runtime::ExecutionSpecRef;
use crewon_task_runtime::ExecutionSpecRevision;
use crewon_task_runtime::StrategyKind;
use crewon_task_runtime::TASK_CONTRACT_SCHEMA_VERSION;
use crewon_task_runtime::TaskAggregate;
use crewon_task_runtime::TaskAuthority;
use crewon_task_runtime::TaskContract;
use crewon_task_runtime::TaskContractSchemaVersion;
use crewon_task_runtime::TaskContractSpec;
use crewon_task_runtime::TaskId;
use crewon_task_runtime::TaskStore;
use crewon_task_runtime::UnixTimestamp;
use pretty_assertions::assert_eq;
use serde_json::json;
use std::net::IpAddr;

const RESOURCE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn wave1_composition_gate_is_bounded_restart_safe_and_has_no_external_side_effect() {
    let app_home = tempfile::tempdir().expect("temporary app home");
    let mut app = TestAppServer::new(app_home.path())
        .await
        .expect("start TestAppServer");
    app.initialize().await.expect("initialize TestAppServer");
    assert_forged_authority_is_rejected(&mut app).await;
    let (single_workspace, office_workspace) = bind_consumer_workspaces(&mut app).await;

    let identity = server_identity();
    let provider = provider_ref();
    let resource = resource_ref(provider.clone());
    let endpoint = ProviderEndpointPolicy::production()
        .validate("https://provider.example/api", &StaticEndpointResolver)
        .await
        .expect("validated fake Provider endpoint");
    assert_eq!(endpoint.socket_addrs().len(), 1);

    let catalog = FakeCatalogProvider {
        manifest: resource_manifest(resource.clone()),
    };
    let page = catalog
        .list_resources(ResourceListQuery::new(
            provider.clone(),
            PageLimit::new(/*value*/ 10).expect("page limit"),
        ))
        .await
        .expect("list fake catalog");
    assert_eq!(page.resources(), std::slice::from_ref(&resource));
    let manifest = catalog
        .read_manifest(resource.clone())
        .await
        .expect("read exact manifest");
    let binding = resolve_resource_binding(&office_workspace, resource.clone(), manifest);

    let credential_store = FakeCredentialStore::default();
    let owner = credential_owner(&identity).expect("server credential owner");
    let credential = credential_store
        .create(CredentialCreateRequest {
            provider_id: provider.provider_id.as_str().to_string(),
            owner: owner.clone(),
            scope: CredentialScopeKind::User,
            granted_scopes: vec![
                GrantedCredentialScope::new("resource:read").expect("scope"),
                GrantedCredentialScope::new("resource:execute").expect("scope"),
            ],
            secret: CredentialSecret::new("test-secret-never-serialized").expect("secret"),
            expires_at: Some(200),
            now: 10,
        })
        .expect("create fake credential");
    let credential_binding =
        policy_credential_binding(&identity, &credential).expect("policy credential binding");

    assert_context_gate(&identity, &single_workspace, &office_workspace);

    let state_home = tempfile::tempdir().expect("temporary State home");
    let state = StateRuntime::init(state_home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State Runtime");
    let task_id = TaskId::new("task-wave1").expect("Task id");
    let task = TaskAggregate::new(task_contract(
        task_id.clone(),
        &single_workspace,
        binding.clone(),
    ));
    let task_store = TaskStateStoreAdapter::new(state.clone());
    task_store.create(task.clone()).await.expect("create Task");
    assert_eq!(
        task_store.read(task_id.clone()).await.expect("read Task"),
        Some(task)
    );

    let access_decision_id = AccessDecisionId::new("decision-wave1").expect("decision id");
    let action = build_action_intent(
        &identity,
        &office_workspace,
        policy_input(&binding, credential_binding, "nonce-wave1"),
    )
    .expect("build exact action");
    let requirement =
        match BaselinePolicy::evaluate(access_decision_id.clone(), &action, /*now*/ 11)
            .expect("policy evaluation")
        {
            PolicyDecision::ApprovalRequired(requirement) => requirement,
            PolicyDecision::Allow(_) | PolicyDecision::Deny(_) => {
                panic!("external write must require approval")
            }
        };
    let action_digest = requirement.action_digest().clone();
    let approval_id = ApprovalId::new("approval-wave1").expect("approval id");
    let mut approvals = ApprovalLedger::new();
    approvals
        .request(approval_id.clone(), requirement, /*now*/ 11)
        .expect("request approval");
    approvals
        .decide(
            &approval_id,
            action.actor(),
            action_digest.clone(),
            ApprovalDecision::Approve,
            /*now*/ 12,
        )
        .expect("approve exact action");
    let authorization = approvals
        .consume(&approval_id, action.actor(), &action, /*now*/ 12)
        .expect("consume approval once");

    let revoked = credential_store
        .revoke(CredentialAccessRequest {
            credential_id: credential.credential_id.clone(),
            owner,
            now: 13,
        })
        .expect("revoke credential");
    assert!(matches!(
        credential_store.read(CredentialAccessRequest {
            credential_id: revoked.credential_id.clone(),
            owner: revoked.owner.clone(),
            now: 13,
        }),
        Err(CredentialStoreError::Revoked)
    ));
    let revoked_action = build_action_intent(
        &identity,
        &office_workspace,
        policy_input(
            &binding,
            policy_credential_binding(&identity, &revoked).expect("revoked binding"),
            "nonce-wave1",
        ),
    )
    .expect("build revoked action");
    assert_eq!(
        authorization.verify(&revoked_action, /*now*/ 13),
        Err(AuthorizationError::CredentialUnavailable)
    );
    match BaselinePolicy::evaluate(
        AccessDecisionId::new("decision-revoked").expect("decision id"),
        &revoked_action,
        /*now*/ 13,
    )
    .expect("revoked evaluation")
    {
        PolicyDecision::Deny(denial) => {
            assert_eq!(denial.reason(), PolicyDenialReason::CredentialUnavailable);
        }
        PolicyDecision::Allow(_) | PolicyDecision::ApprovalRequired(_) => {
            panic!("revoked credential must deny")
        }
    }

    let prepared = prepare_artifact_commit(
        &identity,
        &office_workspace,
        artifact_input(
            resource.clone(),
            approval_id.clone(),
            access_decision_id.clone(),
            action_digest.clone(),
        ),
    )
    .expect("prepare Artifact");
    let artifact_ref = prepared.domain().manifest().artifact_ref().clone();
    let payload_ref = prepared.domain().manifest().payload().clone();
    assert_eq!(
        state
            .commit_artifact_record(&prepared.into_state_record().expect("Artifact State record"))
            .await
            .expect("commit Artifact"),
        ArtifactCommitOutcome::Created
    );
    state.close().await;

    let reopened = StateRuntime::init(state_home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("reopen State Runtime");
    let reopened_tasks = TaskStateStoreAdapter::new(reopened.clone());
    assert!(
        reopened_tasks
            .read(task_id)
            .await
            .expect("read reopened Task")
            .is_some()
    );
    assert_eq!(
        reopened
            .list_expired_artifact_payload_ids(/*now*/ 149, /*limit*/ 10)
            .await
            .expect("pre-expiry list"),
        Vec::<String>::new()
    );
    assert_eq!(
        reopened
            .list_expired_artifact_payload_ids(/*now*/ 150, /*limit*/ 10)
            .await
            .expect("expiry list"),
        vec!["payload-wave1".to_string()]
    );
    let deletion = prepare_artifact_deletion(
        &identity,
        &office_workspace,
        ResolvedArtifactDeletionInput {
            payload: payload_ref,
            artifacts: vec![artifact_ref],
            execution: conversation_execution(),
            resource: ResourceCorrelation::Resource { resource },
            approval: ApprovalCorrelation::Decision {
                approval_id,
                access_decision_id,
                action_digest,
            },
            trace: ResolvedArtifactTraceInput {
                span_id: SpanId::new("span-delete").expect("span id"),
                parent_span_id: Some(SpanId::new("span-create").expect("parent span id")),
            },
            cost: CostCorrelation::None,
            reason: ArtifactDeletionReason::RetentionExpired,
            event_id: AuditEventId::new("event-delete-wave1").expect("event id"),
            audit_idempotency_key: AuditIdempotencyKey::new("audit-delete-wave1")
                .expect("audit idempotency key"),
            deleted_at: UnixTimestamp::new(/*value*/ 150).expect("delete timestamp"),
        },
    )
    .expect("prepare Artifact deletion");
    assert_eq!(
        reopened
            .delete_artifact_payload(&deletion)
            .await
            .expect("delete expired payload"),
        ArtifactPayloadDeleteOutcome::Deleted
    );
    let stored = reopened
        .get_artifact_record("artifact-wave1", /*revision*/ 1)
        .await
        .expect("read deleted Artifact")
        .expect("stored Artifact");
    assert_eq!(stored.payload.content, None);
    assert!(stored.manifest.manifest_json.contains("office"));
    assert!(
        reopened
            .get_platform_audit_event("event-delete-wave1")
            .await
            .expect("read deletion audit")
            .is_some()
    );
    reopened.close().await;
}

fn assert_context_gate(
    identity: &RequestIdentity,
    single_workspace: &WorkspaceRef,
    office_workspace: &WorkspaceRef,
) {
    let single = build_context_fragment(
        identity,
        single_workspace,
        ContextConsumer::Single,
        context_input("single-context", "bounded ".repeat(4_000)),
        /*now*/ 20,
    )
    .expect("bounded Single context");
    assert!(single.was_truncated());
    assert!(single.rendered_tokens() <= 256);
    assert_eq!(single.audience().kind(), ContextAudienceKind::Single);
    let bundle = GovernedContextBundle::new(single.audience().clone(), vec![single.clone()])
        .expect("Single context bundle");
    assert_eq!(bundle.additional_context_entries().len(), 1);
    assert_eq!(
        GovernedContextBundle::new(single.audience().clone(), vec![single; 9]),
        Err(GovernedContextError::TooManyFragments)
    );

    let office = build_context_fragment(
        identity,
        office_workspace,
        ContextConsumer::OfficeShared,
        context_input("office-context", "office shared context".to_string()),
        /*now*/ 20,
    )
    .expect("Office context");
    assert_eq!(office.audience().kind(), ContextAudienceKind::OfficeShared);
}

async fn assert_forged_authority_is_rejected(app: &mut TestAppServer) {
    let request_id = app
        .send_identity_read_request(Some(json!({"actorId": "forged"})))
        .await
        .expect("send forged identity request");
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(request_id))
        .await
        .expect("forged identity rejection");
    assert_eq!(error.code, -32600);
}

async fn bind_consumer_workspaces(app: &mut TestAppServer) -> (WorkspaceRef, WorkspaceRef) {
    let listed = list_workspaces(app).await;
    let workspace_key = listed
        .data
        .first()
        .expect("server workspace")
        .workspace_key
        .clone();
    let forged_id = app
        .send_workspace_bind_request(Some(json!({
            "workspaceKey": workspace_key,
            "scope": "conversation",
            "scopeId": "single-wave1",
            "rootPath": "/tmp/forged"
        })))
        .await
        .expect("send forged workspace request");
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(forged_id))
        .await
        .expect("forged workspace rejection");
    assert_eq!(error.code, -32600);

    let single = bind_workspace(
        app,
        WorkspaceBindParams {
            workspace_key: workspace_key.clone(),
            scope: WorkspaceScope::Conversation,
            scope_id: "single-wave1".to_string(),
        },
    )
    .await;
    let office = bind_workspace(
        app,
        WorkspaceBindParams {
            workspace_key,
            scope: WorkspaceScope::Office,
            scope_id: "office-wave1".to_string(),
        },
    )
    .await;
    assert_ne!(single.workspace.binding_id, office.workspace.binding_id);
    (single.workspace, office.workspace)
}

async fn list_workspaces(app: &mut TestAppServer) -> WorkspaceListResponse {
    let request_id = app
        .send_workspace_list_request(WorkspaceListParams {
            cursor: None,
            limit: Some(20),
        })
        .await
        .expect("send workspace list");
    let response: JSONRPCResponse = app
        .read_stream_until_response_message(RequestId::Integer(request_id))
        .await
        .expect("workspace list response");
    to_response(response).expect("decode workspace list")
}

async fn bind_workspace(
    app: &mut TestAppServer,
    params: WorkspaceBindParams,
) -> WorkspaceBindResponse {
    let request_id = app
        .send_workspace_bind_request(Some(
            serde_json::to_value(params).expect("workspace bind params"),
        ))
        .await
        .expect("send workspace bind");
    let response: JSONRPCResponse = app
        .read_stream_until_response_message(RequestId::Integer(request_id))
        .await
        .expect("workspace bind response");
    to_response(response).expect("decode workspace bind")
}

fn server_identity() -> RequestIdentity {
    ConnectionRequestIdentity::new(ConnectionOrigin::Stdio).derive(
        RequestIdentityClientRef {
            name: "untrusted-wave1-client".to_string(),
            version: "999".to_string(),
            capabilities: RequestIdentityClientCapabilitiesRef {
                experimental_api: true,
                request_attestation: false,
            },
        },
        "trace-wave1".to_string(),
    )
}

fn provider_ref() -> ProviderRef {
    ProviderRef {
        provider_id: ProviderId::new("provider-wave1").expect("Provider id"),
        protocol_version: ProviderProtocolVersion::new("1").expect("protocol version"),
    }
}

fn resource_ref(provider: ProviderRef) -> ResourceRef {
    ResourceRef {
        provider,
        kind: ResourceKind::Agent,
        resource_id: crewon_resource_federation::ResourceId::new("agent-wave1")
            .expect("resource id"),
        revision: ResourceRevision::new("rev-1").expect("resource revision"),
    }
}

fn resource_manifest(resource: ResourceRef) -> ResourceManifest {
    ResourceManifest {
        resource,
        schema_version: ManifestSchemaVersion::new("1").expect("manifest schema"),
        content_digest: Some(ContentDigest::new(RESOURCE_DIGEST).expect("resource digest")),
    }
}

fn resolve_resource_binding(
    workspace: &WorkspaceRef,
    resource: ResourceRef,
    manifest: ResourceManifest,
) -> ResolvedResourceBinding {
    let capability = Capability {
        resource_kind: ResourceKind::Agent,
        binding_mode: BindingMode::RemoteReference,
        execution_location: ExecutionLocation::Provider,
    };
    resolve_binding(
        &BindingRequest {
            binding_id: BindingId::new(&workspace.binding_id).expect("binding id"),
            workspace_key: WorkspaceKey::new(&workspace.workspace_key).expect("workspace key"),
            resource: resource.clone(),
            mode: BindingMode::RemoteReference,
            execution_location: ExecutionLocation::Provider,
            materialization: None,
        },
        &manifest,
        &ProviderCapabilities::new(resource.provider, [capability]).expect("Provider capabilities"),
    )
    .expect("resolve exact resource binding")
}

fn task_contract(
    task_id: TaskId,
    workspace: &WorkspaceRef,
    binding: ResolvedResourceBinding,
) -> TaskContract {
    TaskContract::new(TaskContractSpec {
        task_id,
        authority: TaskAuthority::LocalAppServer,
        strategy: StrategyKind::Single,
        workspace_key: WorkspaceKey::new(&workspace.workspace_key).expect("workspace key"),
        schema_version: TaskContractSchemaVersion::new(TASK_CONTRACT_SCHEMA_VERSION)
            .expect("Task schema"),
        execution_spec: ExecutionSpecRef::new(
            ExecutionSpecId::new("execution-spec-wave1").expect("execution spec id"),
            ExecutionSpecRevision::new(/*value*/ 1).expect("execution spec revision"),
            ExecutionSpecDigest::new(RESOURCE_DIGEST).expect("execution spec digest"),
        ),
        bindings: vec![binding],
        created_at: UnixTimestamp::new(/*value*/ 20).expect("Task timestamp"),
    })
    .expect("Task Contract")
}

fn policy_input(
    binding: &ResolvedResourceBinding,
    credential: CredentialBinding,
    nonce: &str,
) -> ResolvedPolicyActionInput {
    ResolvedPolicyActionInput {
        action_type: ActionType::ResourceOperation,
        purpose: ActionPurpose::new("resource.execute").expect("action purpose"),
        target: ActionTarget::resource(binding.binding_id().clone(), binding.resource().clone()),
        arguments: json!({"operation": "dryRun"}),
        credential,
        execution_location: ExecutionLocation::Provider,
        side_effect: SideEffect::ExternalWrite,
        expires_at: 100,
        nonce: ActionNonce::new(nonce).expect("action nonce"),
    }
}

fn artifact_input(
    resource: ResourceRef,
    approval_id: ApprovalId,
    access_decision_id: AccessDecisionId,
    action_digest: crewon_policy::ActionDigest,
) -> ResolvedArtifactCommitInput {
    ResolvedArtifactCommitInput {
        artifact_id: ArtifactId::new("artifact-wave1").expect("Artifact id"),
        revision: ArtifactRevision::new(/*value*/ 1).expect("Artifact revision"),
        artifact_idempotency_key: ArtifactIdempotencyKey::new("artifact-create-wave1")
            .expect("Artifact idempotency key"),
        kind: ArtifactKind::StructuredResult,
        payload_id: PayloadId::new("payload-wave1").expect("Payload id"),
        body: PayloadBody::new(
            b"bounded dry-run result".to_vec(),
            PayloadSensitivity::WorkspaceSensitive,
        )
        .expect("Payload body"),
        media_type: MediaType::new("application/json").expect("media type"),
        execution: conversation_execution(),
        resource: ResourceCorrelation::Resource { resource },
        approval: ApprovalCorrelation::Decision {
            approval_id,
            access_decision_id,
            action_digest,
        },
        trace: ResolvedArtifactTraceInput {
            span_id: SpanId::new("span-create").expect("span id"),
            parent_span_id: None,
        },
        cost: CostCorrelation::Usage {
            cost: UsageCost::new(
                /*input_tokens*/ 10,
                /*output_tokens*/ 5,
                /*tool_calls*/ 0,
                /*amount_micros*/ 0,
                CurrencyCode::new("USD").expect("currency"),
            ),
        },
        verification: VerificationStatus::Verified,
        retention: RetentionPolicy::Session {
            expires_at: UnixTimestamp::new(/*value*/ 150).expect("retention expiry"),
        },
        event_id: AuditEventId::new("event-create-wave1").expect("event id"),
        audit_idempotency_key: AuditIdempotencyKey::new("audit-create-wave1")
            .expect("audit idempotency key"),
        created_at: UnixTimestamp::new(/*value*/ 20).expect("Artifact timestamp"),
    }
}

fn conversation_execution() -> ExecutionCorrelation {
    ExecutionCorrelation::Conversation {
        thread_id: ThreadId::new("thread-wave1").expect("thread id"),
        turn_id: TurnId::new("turn-wave1").expect("turn id"),
    }
}

fn context_input(fragment_id: &str, content: String) -> ContextFragmentInput {
    ContextFragmentInput {
        fragment_id: fragment_id.to_string(),
        source_kind: ContextSourceKind::Provider,
        source_id: "provider-wave1".to_string(),
        trust: ContextTrust::UntrustedData,
        sensitivity: ContextSensitivity::WorkspaceSensitive,
        purpose: ContextPurpose::ResourceContext,
        budget: ContextBudget::new(/*token_cap*/ 256).expect("context budget"),
        freshness: ContextFreshness::current(/*observed_at*/ 20).expect("context freshness"),
        content,
    }
}

struct StaticEndpointResolver;

impl EndpointResolver for StaticEndpointResolver {
    async fn resolve(
        &self,
        _host: String,
        _port: u16,
    ) -> Result<Vec<IpAddr>, ProviderEndpointPolicyError> {
        Ok(vec!["93.184.216.34".parse().expect("public IP")])
    }
}

struct FakeCatalogProvider {
    manifest: ResourceManifest,
}

impl CatalogProvider for FakeCatalogProvider {
    async fn list_resources(
        &self,
        query: ResourceListQuery,
    ) -> Result<ResourcePage, ProviderError> {
        if query.provider != self.manifest.resource.provider {
            return Err(ProviderError::Unauthorized);
        }
        ResourcePage::complete(vec![self.manifest.resource.clone()])
            .map_err(|_| ProviderError::InvalidResponse)
    }

    async fn read_manifest(
        &self,
        resource: ResourceRef,
    ) -> Result<ResourceManifest, ProviderError> {
        if resource != self.manifest.resource {
            return Err(ProviderError::NotFound);
        }
        Ok(self.manifest.clone())
    }
}
