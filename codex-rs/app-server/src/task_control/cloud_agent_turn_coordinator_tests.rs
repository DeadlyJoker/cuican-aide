use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::DurableWorkspaceRootResolveOutcome;
use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderAccessGrantResolveOutcome;
use crewon_state::ProviderAccessGrantRevokeOutcome;
use crewon_state::ProviderAccessGrantRevokeRequest;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::ProviderConnectionRecord;
use crewon_state::ProviderConnectionResolveOutcome;
use crewon_state::ProviderIdentityBindingCreateOutcome;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::ProviderIdentityBindingStatus;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingResolveOutcome;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_state::StateRuntime;
use crewon_state::ThreadExecutionContextBindingRef;
use crewon_state::ThreadExecutionContextCreateOutcome;
use crewon_state::ThreadExecutionContextRecord;
use pretty_assertions::assert_eq;

use super::CloudAgentTurnArtifactRequest;
use super::CloudAgentTurnStartError;
use super::CloudAgentTurnStartRequest;
use super::TurnIds;
use super::expected_cloud_agent_turn_artifact_refs;
use super::restore_cloud_agent_binding;
use super::start_cloud_agent_turn;
use crate::platform_control::RequestIdentity;
use crate::platform_control::authenticated_identity_in_space;
use crate::platform_control::provider_access_grant_scope::agent_platform_scopes;

const THREAD_ID: &str = "019f550e-ba52-7490-a248-b0d3a84103c1";
const WORKSPACE_KEY: &str = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001";
const CONNECTION_ID: &str = "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101";
const GRANT_ID: &str = "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c102";
const BINDING_ID: &str = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301";
const SOURCE_BINDING_ID: &str = "019f6f00-0000-7000-8000-000000000001";

#[tokio::test]
async fn creates_real_single_task_and_replays_same_turn_across_restart() {
    let fixture = fixture().await;
    let first = start(
        &fixture.state,
        &fixture.identity,
        "client-message-1",
        "Ship it",
        /*now*/ 150,
    )
    .await
    .expect("create Cloud Agent Turn");
    let repeated = start(
        &fixture.state,
        &fixture.identity,
        "client-message-1",
        "Ship it",
        /*now*/ 175,
    )
    .await
    .expect("idempotent retry");
    assert!(first.created);
    assert!(!repeated.created);
    assert_eq!(repeated.turn, first.turn);

    let task_id = first.turn.origin.task_id().expect("durable Task");
    let task = fixture
        .state
        .get_task_record(task_id)
        .await
        .expect("read Task")
        .expect("Task exists");
    assert_eq!(task.authority, "localAppServer");
    assert_eq!(task.strategy, "single");
    assert_eq!(task.status, "queued");
    assert_eq!(task.aggregate_version, 1);
    assert_eq!(task.stream_offset, 1);
    let prompt = fixture
        .state
        .get_artifact_record(
            &first.turn.prompt_artifact.artifact_id,
            first.turn.prompt_artifact.revision,
        )
        .await
        .expect("read prompt")
        .expect("prompt exists");
    assert_eq!(prompt.payload.content, Some(b"Ship it".to_vec()));
    assert!(!format!("{first:?}").contains("Ship it"));

    fixture.state.close().await;
    let restarted = StateRuntime::init(
        fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let durable = restarted
        .get_cloud_agent_turn_record(&first.turn.turn_id)
        .await
        .expect("read durable Turn")
        .expect("Turn exists after restart");
    assert_eq!(durable, first.turn);
    restarted.close().await;
}

#[tokio::test]
async fn conflicts_on_changed_replay_and_serializes_active_turns() {
    let fixture = fixture().await;
    start(
        &fixture.state,
        &fixture.identity,
        "client-message-1",
        "Ship it",
        /*now*/ 150,
    )
    .await
    .expect("create first Turn");
    let binding_record = fixture
        .state
        .get_provider_resource_binding_record(BINDING_ID)
        .await
        .expect("read binding")
        .expect("binding exists");
    let resolved_binding = restore_cloud_agent_binding(&binding_record).expect("restore binding");
    let ids = TurnIds::new(THREAD_ID, "client-message-1");
    let workspace = workspace();
    let changed_refs = expected_cloud_agent_turn_artifact_refs(&CloudAgentTurnArtifactRequest {
        state: &fixture.state,
        identity: &fixture.identity,
        workspace: &workspace,
        execution_binding: &resolved_binding,
        thread_id: THREAD_ID,
        turn_id: &ids.turn_id,
        client_user_message_id: "client-message-1",
        prompt: "Change the request",
        context_fragments: Vec::new(),
        now: 160,
    })
    .expect("derive changed replay Artifact refs");
    assert_eq!(
        changed_refs.prompt,
        fixture
            .state
            .get_cloud_agent_turn_record_by_client_message(THREAD_ID, "client-message-1")
            .await
            .expect("read first Turn")
            .expect("first Turn exists")
            .prompt_artifact
    );

    assert_eq!(
        start(
            &fixture.state,
            &fixture.identity,
            "client-message-1",
            "Change the request",
            /*now*/ 160,
        )
        .await,
        Err(CloudAgentTurnStartError::Conflict)
    );
    let prompt = fixture
        .state
        .get_artifact_record(
            &changed_refs.prompt.artifact_id,
            changed_refs.prompt.revision,
        )
        .await
        .expect("read prompt after changed replay")
        .expect("original prompt remains");
    assert_eq!(prompt.payload.content, Some(b"Ship it".to_vec()));
    assert_eq!(
        start(
            &fixture.state,
            &fixture.identity,
            "client-message-2",
            "Second active request",
            /*now*/ 160,
        )
        .await,
        Err(CloudAgentTurnStartError::ActiveTurnExists)
    );
    fixture.state.close().await;
}

#[tokio::test]
async fn revalidates_grant_and_owner_before_duplicate_response() {
    let fixture = fixture().await;
    start(
        &fixture.state,
        &fixture.identity,
        "client-message-1",
        "Ship it",
        /*now*/ 150,
    )
    .await
    .expect("create first Turn");
    assert_eq!(
        fixture
            .state
            .revoke_provider_access_grant_record(&ProviderAccessGrantRevokeRequest {
                grant_id: GRANT_ID.to_string(),
                expected_revision: 1,
                revoked_at: 160,
            })
            .await
            .expect("revoke grant"),
        ProviderAccessGrantRevokeOutcome::Revoked
    );
    assert_eq!(
        start(
            &fixture.state,
            &fixture.identity,
            "client-message-1",
            "Ship it",
            /*now*/ 170,
        )
        .await,
        Err(CloudAgentTurnStartError::AuthorityChanged)
    );

    let cross_space = authenticated_identity_in_space("trace-cross-space", "space-other");
    assert_eq!(
        start(
            &fixture.state,
            &cross_space,
            "client-message-1",
            "Ship it",
            /*now*/ 170,
        )
        .await,
        Err(CloudAgentTurnStartError::Unauthorized)
    );
    fixture.state.close().await;
}

pub(crate) struct Fixture {
    pub(crate) home: tempfile::TempDir,
    pub(crate) state: std::sync::Arc<StateRuntime>,
    pub(crate) identity: RequestIdentity,
}

pub(crate) async fn fixture() -> Fixture {
    let home = tempfile::tempdir().expect("temporary State home");
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State");
    let identity = authenticated_identity_in_space("trace-cloud-agent", "space-local-1");
    install_authority(&state, &identity).await;
    Fixture {
        home,
        state,
        identity,
    }
}

pub(crate) async fn start(
    state: &StateRuntime,
    identity: &RequestIdentity,
    client_user_message_id: &str,
    prompt: &str,
    now: i64,
) -> Result<super::CloudAgentTurnStartResult, CloudAgentTurnStartError> {
    start_cloud_agent_turn(CloudAgentTurnStartRequest {
        state,
        identity,
        workspace: &workspace(),
        thread_id: THREAD_ID,
        client_user_message_id,
        prompt,
        context_fragments: Vec::new(),
        now,
    })
    .await
}

async fn install_authority(state: &StateRuntime, identity: &RequestIdentity) {
    let reference = identity.reference();
    let tenant_id = reference.tenant_id.as_deref().expect("tenant");
    let space_id = reference.space_id.as_deref().expect("space");
    let mut root = DurableWorkspaceRootRecord {
        workspace_key: WORKSPACE_KEY.to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
        root_fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        record_hash: String::new(),
        created_at: 100,
    };
    root.record_hash = root.canonical_hash();
    assert_eq!(
        state
            .resolve_durable_workspace_root_record(&root)
            .await
            .expect("create workspace root"),
        DurableWorkspaceRootResolveOutcome::Created(root)
    );

    let mut identity_binding = ProviderIdentityBindingRecord {
        binding_id: "identity-binding-cloud-agent".to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: tenant_id.to_string(),
        local_space_id: space_id.to_string(),
        provider_id: "agent-platform".to_string(),
        provider_subject: "user:42".to_string(),
        provider_tenant_id: "7".to_string(),
        provider_space_id: "11".to_string(),
        authority_id: "authority-1".to_string(),
        source_binding_id: SOURCE_BINDING_ID.to_string(),
        source_revision: 1,
        source_fresh_until: 1_000,
        revision: 1,
        status: ProviderIdentityBindingStatus::Active,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    identity_binding.record_hash = identity_binding.canonical_hash();
    assert_eq!(
        state
            .create_provider_identity_binding_record(&identity_binding)
            .await
            .expect("create identity binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );

    let mut grant = ProviderAccessGrantRecord {
        grant_id: GRANT_ID.to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: tenant_id.to_string(),
        local_space_id: space_id.to_string(),
        provider_id: "agent-platform".to_string(),
        source_binding_id: SOURCE_BINDING_ID.to_string(),
        source_revision: 1,
        granted_scopes: agent_platform_scopes(),
        status: ProviderAccessGrantStatus::Active,
        expires_at: 1_000,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        revoked_at: None,
    };
    grant.record_hash = grant.canonical_hash();
    assert_eq!(
        state
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create access grant"),
        ProviderAccessGrantResolveOutcome::Created(grant)
    );

    let mut connection = ProviderConnectionRecord {
        connection_id: CONNECTION_ID.to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: tenant_id.to_string(),
        local_space_id: space_id.to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        credential_id: GRANT_ID.to_string(),
        credential_revision: 1,
        record_hash: String::new(),
        created_at: 100,
    };
    connection.record_hash = connection.canonical_hash();
    assert_eq!(
        state
            .resolve_provider_connection_record(&connection)
            .await
            .expect("create connection"),
        ProviderConnectionResolveOutcome::Created(connection)
    );

    let mut binding = ProviderResourceBindingRecord {
        binding_id: BINDING_ID.to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: tenant_id.to_string(),
        local_space_id: space_id.to_string(),
        connection_id: CONNECTION_ID.to_string(),
        workspace_key: WORKSPACE_KEY.to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Conversation,
        workspace_scope_id: THREAD_ID.to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: ProviderResourceKind::Agent,
        resource_id: "agent-1".to_string(),
        resource_revision: "agent-revision-1".to_string(),
        binding_mode: ProviderResourceBindingMode::ProviderManaged,
        execution_location: ProviderResourceExecutionLocation::Provider,
        manifest_schema_version: "1".to_string(),
        content_digest: None,
        source_revision: None,
        source_digest: None,
        local_revision: None,
        local_content_digest: None,
        status: ProviderResourceBindingStatus::Active,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
        unbound_at: None,
    };
    binding.record_hash = binding.canonical_hash();
    assert_eq!(
        state
            .resolve_provider_resource_binding_record(&binding)
            .await
            .expect("create resource binding"),
        ProviderResourceBindingResolveOutcome::Created(binding)
    );

    let binding_ref = ThreadExecutionContextBindingRef {
        binding_id: BINDING_ID.to_string(),
        revision: 1,
    };
    let mut context = ThreadExecutionContextRecord {
        thread_id: THREAD_ID.to_string(),
        local_actor_id: reference.actor_id.clone(),
        local_tenant_id: tenant_id.to_string(),
        local_space_id: space_id.to_string(),
        workspace_key: WORKSPACE_KEY.to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Conversation,
        workspace_scope_id: THREAD_ID.to_string(),
        resource_bindings: vec![binding_ref.clone()],
        execution_binding: Some(binding_ref),
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    context.record_hash = context.canonical_hash();
    assert_eq!(
        state
            .create_thread_execution_context_record(&context)
            .await
            .expect("create Thread execution context"),
        ThreadExecutionContextCreateOutcome::Created
    );
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: WORKSPACE_KEY.to_string(),
        binding_id: "workspace-binding-1".to_string(),
        scope: WorkspaceScope::Conversation,
        scope_id: THREAD_ID.to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}
