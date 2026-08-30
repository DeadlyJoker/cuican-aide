use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::DurableWorkspaceRootResolveOutcome;
use crewon_state::DynamicToolExecutionTerminalRecord as StateTerminalRecord;
use crewon_state::DynamicToolExecutionUnknownCode as StateUnknownCode;
use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderAccessGrantResolveOutcome;
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
use pretty_assertions::assert_eq;

use super::dynamic_tool_router::ports::DynamicToolExecutionClaim;
use super::dynamic_tool_router::ports::DynamicToolExecutionClaimOutcome;
use super::dynamic_tool_router::ports::DynamicToolExecutionClaimRequest;
use super::dynamic_tool_router::ports::DynamicToolExecutionCompletion;
use super::dynamic_tool_router::ports::DynamicToolExecutionCompletionOutcome;
use super::dynamic_tool_router::ports::DynamicToolExecutionJournal;
use super::dynamic_tool_router::ports::DynamicToolExecutionResultMetadata;
use super::dynamic_tool_router::ports::DynamicToolExecutionUnknown;
use super::dynamic_tool_router::ports::DynamicToolPortError;
use super::dynamic_tool_router::registration::DynamicToolOperation;
use super::dynamic_tool_router::state_journal::StateDynamicToolExecutionJournal;
use super::provider_connection_descriptor::ProviderConnectionClock;

const PRINCIPAL: &str =
    "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f";
const WORKSPACE_KEY: &str = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001";
const CONNECTION_ID: &str = "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101";
const GRANT_ID: &str = "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301";
const BINDING_ID: &str = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401";

#[tokio::test]
async fn state_dynamic_tool_journal_round_trips_atomic_audit_and_idempotent_completion() {
    let home = tempfile::tempdir().expect("temp state home");
    let state = initialized_with_authority(&home).await;
    let journal = StateDynamicToolExecutionJournal::new(state.clone(), FixedClock(120));
    let request = claim_request("call-state-journal");

    let DynamicToolExecutionClaimOutcome::Acquired(claim) = journal
        .claim(request.clone())
        .await
        .expect("claim through State journal")
    else {
        panic!("expected acquired claim");
    };
    let completion = DynamicToolExecutionCompletion::succeeded(
        *claim,
        DynamicToolExecutionResultMetadata::Inline {
            item_count: 1,
            byte_len: 64,
            sha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                .to_string(),
        },
    );
    assert_eq!(
        journal
            .complete(completion)
            .await
            .expect("complete through State journal"),
        DynamicToolExecutionCompletionOutcome::Completed
    );

    let persisted = state
        .get_dynamic_tool_execution_record(&request.call_id)
        .await
        .expect("read persisted execution")
        .expect("execution exists");
    assert!(matches!(
        persisted.terminal,
        StateTerminalRecord::Succeeded(_)
    ));
    let event_id = persisted.audit_event_id.as_deref().expect("Audit event id");
    let event = state
        .get_platform_audit_event(event_id)
        .await
        .expect("read Audit event")
        .expect("Audit event exists");
    let metadata: serde_json::Value =
        serde_json::from_str(&event.metadata_json).expect("Audit JSON");
    assert_eq!(metadata["action"], "externalAction");
    assert_eq!(
        metadata["outcome"],
        serde_json::json!({"type": "succeeded"})
    );
    assert_eq!(metadata["resource"]["resource"]["resourceId"], "resource-9");
    assert_eq!(metadata["approval"]["approvalId"], "approval-1");
    assert_eq!(metadata["payload"], serde_json::json!({"type": "none"}));

    let replay = DynamicToolExecutionCompletion::succeeded(
        DynamicToolExecutionClaim::new(request.clone()),
        DynamicToolExecutionResultMetadata::Inline {
            item_count: 1,
            byte_len: 64,
            sha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                .to_string(),
        },
    );
    assert_eq!(
        journal
            .complete(replay)
            .await
            .expect("idempotent completion replay"),
        DynamicToolExecutionCompletionOutcome::Completed
    );
    assert!(matches!(
        journal
            .claim(request)
            .await
            .expect("claim replay after terminal"),
        DynamicToolExecutionClaimOutcome::ExistingSame
    ));

    state.close().await;
}

#[tokio::test]
async fn state_dynamic_tool_journal_preserves_unknown_and_rejects_invalid_authority_or_clock() {
    let home = tempfile::tempdir().expect("temp state home");
    let state = initialized_with_authority(&home).await;
    let journal = StateDynamicToolExecutionJournal::new(state.clone(), FixedClock(125));
    let request = claim_request("call-state-unknown");
    let DynamicToolExecutionClaimOutcome::Acquired(claim) = journal
        .claim(request.clone())
        .await
        .expect("claim unknown execution")
    else {
        panic!("expected acquired claim");
    };
    assert_eq!(
        journal
            .complete(DynamicToolExecutionCompletion::unknown(
                *claim,
                DynamicToolExecutionUnknown::Timeout,
            ))
            .await
            .expect("complete unknown execution"),
        DynamicToolExecutionCompletionOutcome::Completed
    );
    let persisted = state
        .get_dynamic_tool_execution_record(&request.call_id)
        .await
        .expect("read unknown execution")
        .expect("unknown execution exists");
    assert_eq!(
        persisted.terminal,
        StateTerminalRecord::Unknown(StateUnknownCode::Timeout)
    );
    let event = state
        .get_platform_audit_event(persisted.audit_event_id.as_deref().expect("Audit event id"))
        .await
        .expect("read unknown Audit")
        .expect("unknown Audit exists");
    let metadata: serde_json::Value =
        serde_json::from_str(&event.metadata_json).expect("unknown Audit JSON");
    assert_eq!(
        metadata["outcome"],
        serde_json::json!({
            "type": "unknown",
            "errorCode": "dynamicTool.timeout"
        })
    );
    assert!(!event.metadata_json.contains("provider timeout body"));

    let mut missing_scope = claim_request("call-missing-scope");
    missing_scope.space_id = None;
    assert!(matches!(
        journal.claim(missing_scope).await,
        Err(DynamicToolPortError::Unauthorized)
    ));

    let rollback_request = claim_request("call-clock-rollback");
    let rollback_journal = StateDynamicToolExecutionJournal::new(
        state.clone(),
        FixedClock(rollback_request.claimed_at - 1),
    );
    let DynamicToolExecutionClaimOutcome::Acquired(claim) = rollback_journal
        .claim(rollback_request.clone())
        .await
        .expect("claim before clock rollback")
    else {
        panic!("expected rollback claim");
    };
    assert_eq!(
        rollback_journal
            .complete(DynamicToolExecutionCompletion::unknown(
                *claim,
                DynamicToolExecutionUnknown::AdapterUnavailable,
            ))
            .await,
        Err(DynamicToolPortError::Unavailable)
    );
    let persisted = state
        .get_dynamic_tool_execution_record(&rollback_request.call_id)
        .await
        .expect("read rollback claim")
        .expect("rollback claim exists");
    assert_eq!(persisted.terminal, StateTerminalRecord::Claimed);
    assert_eq!(persisted.audit_event_id, None);

    state.close().await;
}

#[derive(Clone, Copy)]
struct FixedClock(i64);

impl ProviderConnectionClock for FixedClock {
    fn now(&self) -> i64 {
        self.0
    }
}

fn claim_request(call_id: &str) -> DynamicToolExecutionClaimRequest {
    DynamicToolExecutionClaimRequest {
        call_id: call_id.to_string(),
        action_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        access_decision_id: "decision-1".to_string(),
        approval_id: Some("approval-1".to_string()),
        actor_id: PRINCIPAL.to_string(),
        tenant_id: Some("7".to_string()),
        space_id: Some("11".to_string()),
        session_id: "session-1".to_string(),
        trace_id: "trace-1".to_string(),
        span_id: format!("span-{call_id}"),
        parent_span_id: Some("span-parent-1".to_string()),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        workspace_key: WORKSPACE_KEY.to_string(),
        workspace_binding_id: "workspace-binding-1".to_string(),
        workspace_scope: WorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        binding_id: BINDING_ID.to_string(),
        binding_revision: 1,
        connection_id: CONNECTION_ID.to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: ProviderResourceKind::McpTool,
        resource_id: "resource-9".to_string(),
        resource_revision: "resource-version:7".to_string(),
        execution_location: ProviderResourceExecutionLocation::Provider,
        credential_id: Some(GRANT_ID.to_string()),
        credential_revision: Some(1),
        provider_identity_binding_id: Some("identity-binding-dynamic-tool-1".to_string()),
        provider_identity_binding_revision: Some(1),
        provider_subject: Some("user:42".to_string()),
        provider_tenant_id: Some("7".to_string()),
        provider_space_id: Some("11".to_string()),
        operation: DynamicToolOperation::Call,
        claimed_at: 110,
    }
}

async fn initialized_with_authority(home: &tempfile::TempDir) -> std::sync::Arc<StateRuntime> {
    let state = StateRuntime::init(home.path().to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State Runtime");
    let mut workspace = DurableWorkspaceRootRecord {
        workspace_key: WORKSPACE_KEY.to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
        root_fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            .to_string(),
        record_hash: String::new(),
        created_at: 100,
    };
    workspace.record_hash = workspace.canonical_hash();
    assert_eq!(
        state
            .resolve_durable_workspace_root_record(&workspace)
            .await
            .expect("create workspace"),
        DurableWorkspaceRootResolveOutcome::Created(workspace)
    );

    let mut grant = ProviderAccessGrantRecord {
        grant_id: GRANT_ID.to_string(),
        local_actor_id: PRINCIPAL.to_string(),
        local_tenant_id: "7".to_string(),
        local_space_id: "11".to_string(),
        provider_id: "agent-platform".to_string(),
        source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
        source_revision: 1,
        granted_scopes: vec![
            "provider.discovery".to_string(),
            "providerRun:start".to_string(),
        ],
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

    let mut identity_binding = ProviderIdentityBindingRecord {
        binding_id: "identity-binding-dynamic-tool-1".to_string(),
        local_actor_id: PRINCIPAL.to_string(),
        local_tenant_id: "7".to_string(),
        local_space_id: "11".to_string(),
        provider_id: "agent-platform".to_string(),
        provider_subject: "user:42".to_string(),
        provider_tenant_id: "7".to_string(),
        provider_space_id: "11".to_string(),
        authority_id: "crewon-identity-session".to_string(),
        source_binding_id: "identity-source-binding-1".to_string(),
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
            .expect("create Provider identity binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );

    let mut connection = ProviderConnectionRecord {
        connection_id: CONNECTION_ID.to_string(),
        local_actor_id: PRINCIPAL.to_string(),
        local_tenant_id: "7".to_string(),
        local_space_id: "11".to_string(),
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
        local_actor_id: PRINCIPAL.to_string(),
        local_tenant_id: "7".to_string(),
        local_space_id: "11".to_string(),
        connection_id: CONNECTION_ID.to_string(),
        workspace_key: WORKSPACE_KEY.to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: ProviderResourceKind::McpTool,
        resource_id: "resource-9".to_string(),
        resource_revision: "resource-version:7".to_string(),
        binding_mode: ProviderResourceBindingMode::ProviderManaged,
        execution_location: ProviderResourceExecutionLocation::Provider,
        manifest_schema_version: "1.0.0".to_string(),
        content_digest: Some(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        ),
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
            .expect("create binding"),
        ProviderResourceBindingResolveOutcome::Created(binding)
    );
    state
}
