use std::sync::Arc;

use crewon_app_server_protocol::ThreadExecutionContextCreateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateParams;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_state::StateRuntime;
use crewon_state::ThreadExecutionContextBindingRef;
use crewon_state::ThreadExecutionContextRecord;
use pretty_assertions::assert_eq;

use super::WorkspaceRegistry;
use super::WorkspaceRootCatalog;
use super::provider_identity_adapter_tests::authenticated_identity;
use super::provider_identity_adapter_tests::authenticated_identity_in_space;
use super::thread_execution_context_runtime::CloudAgentThreadOperation;
use super::thread_execution_context_runtime::ThreadExecutionContextRequestRuntime;
use super::thread_execution_context_runtime::ThreadExecutionContextWorkspaceScope;
use super::thread_execution_context_runtime::binding_matches_thread_execution_context;

#[tokio::test]
async fn runtime_creates_owner_scoped_context_and_refreshes_session_binding() {
    let state_home = tempfile::TempDir::new().expect("state home");
    let workspace_root = tempfile::TempDir::new().expect("workspace root");
    let state = StateRuntime::init(
        state_home.path().to_path_buf(),
        "thread-context-runtime-test".to_string(),
    )
    .await
    .expect("initialize State");
    let catalog = WorkspaceRootCatalog::new(
        "node-1".to_string(),
        workspace_root.path().to_path_buf(),
        vec![workspace_root.path().to_path_buf()],
    );
    let identity = authenticated_identity("thread-context-runtime-1");
    let registry = Arc::new(WorkspaceRegistry::new(
        identity.reference().session_id.clone(),
    ));
    let workspace_key =
        registered_workspace_key(registry.as_ref(), &identity, &catalog, state.as_ref()).await;
    let runtime = ThreadExecutionContextRequestRuntime::new(
        identity,
        Arc::clone(&registry),
        catalog.clone(),
        Arc::clone(&state),
    );
    let prepared = runtime
        .prepare_create(ThreadExecutionContextCreateParams {
            workspace_key: workspace_key.clone(),
        })
        .await
        .expect("prepare Thread execution context");
    let thread_id = "019f550e-ba52-7490-a248-b0d3a84103c1";
    let created = runtime
        .create(
            prepared,
            thread_id,
            ThreadExecutionContextWorkspaceScope::Conversation,
            /*now*/ 100,
        )
        .await
        .expect("create Thread execution context");
    assert_eq!(created.thread_id, thread_id);
    assert_eq!(created.workspace.workspace_key, workspace_key);
    assert_eq!(created.workspace.scope, WorkspaceScope::Conversation);
    assert_eq!(created.workspace.scope_id, thread_id);
    assert_eq!(created.resource_bindings, Vec::new());
    assert_eq!(created.revision, 1);
    runtime
        .ensure_operation_supported(thread_id, CloudAgentThreadOperation::Steer)
        .await
        .expect("Core Thread operation remains supported");

    for (thread_id, expected_role) in [
        ("019f550e-ba52-7490-a248-b0d3a84103c2", "manager"),
        ("019f550e-ba52-7490-a248-b0d3a84103c3", "member"),
    ] {
        let prepared = runtime
            .prepare_create(ThreadExecutionContextCreateParams {
                workspace_key: workspace_key.clone(),
            })
            .await
            .expect("prepare Office Thread execution context");
        let office = runtime
            .create(
                prepared,
                thread_id,
                ThreadExecutionContextWorkspaceScope::Office {
                    office_id: "office-1".to_string(),
                },
                /*now*/ 100,
            )
            .await
            .unwrap_or_else(|_| panic!("create Office {expected_role} execution context"));
        assert_eq!(office.workspace.scope, WorkspaceScope::Office);
        assert_eq!(office.workspace.scope_id, "office-1");
        assert_eq!(office.thread_id, thread_id);

        let read = runtime
            .read_owned(thread_id)
            .await
            .unwrap_or_else(|_| panic!("read Office {expected_role} execution context"))
            .unwrap_or_else(|| panic!("Office {expected_role} context exists"));
        assert_eq!(read.workspace.scope, WorkspaceScope::Office);
        assert_eq!(read.workspace.scope_id, "office-1");

        let unchanged = runtime
            .update(
                ThreadExecutionContextUpdateParams {
                    thread_id: thread_id.to_string(),
                    workspace_binding_id: read.workspace.binding_id,
                    resource_binding_ids: Vec::new(),
                    execution_binding_id: None,
                    expected_revision: 1,
                },
                /*now*/ 110,
            )
            .await
            .unwrap_or_else(|_| panic!("update Office {expected_role} execution context"));
        assert_eq!(unchanged.workspace.scope, WorkspaceScope::Office);
    }

    let unchanged = runtime
        .update(
            ThreadExecutionContextUpdateParams {
                thread_id: thread_id.to_string(),
                workspace_binding_id: created.workspace.binding_id.clone(),
                resource_binding_ids: Vec::new(),
                execution_binding_id: None,
                expected_revision: 1,
            },
            /*now*/ 110,
        )
        .await
        .expect("idempotent empty update");
    assert_eq!(unchanged, created);

    let stale = runtime
        .update(
            ThreadExecutionContextUpdateParams {
                thread_id: thread_id.to_string(),
                workspace_binding_id: created.workspace.binding_id.clone(),
                resource_binding_ids: Vec::new(),
                execution_binding_id: None,
                expected_revision: 2,
            },
            /*now*/ 110,
        )
        .await
        .expect_err("stale revision rejected");
    assert_eq!(
        stale.message,
        "Thread execution context revision conflicts with current state"
    );

    let reconnect_identity = authenticated_identity("thread-context-runtime-2");
    let reconnect_registry = Arc::new(WorkspaceRegistry::new(
        reconnect_identity.reference().session_id.clone(),
    ));
    assert_eq!(
        registered_workspace_key(
            reconnect_registry.as_ref(),
            &reconnect_identity,
            &catalog,
            state.as_ref(),
        )
        .await,
        workspace_key
    );
    let reconnect_runtime = ThreadExecutionContextRequestRuntime::new(
        reconnect_identity,
        reconnect_registry,
        catalog.clone(),
        Arc::clone(&state),
    );
    let resumed = reconnect_runtime
        .read_owned(thread_id)
        .await
        .expect("read owner context")
        .expect("context exists");
    assert_eq!(resumed.workspace.workspace_key, workspace_key);
    assert_ne!(resumed.workspace.binding_id, created.workspace.binding_id);

    let other_identity =
        authenticated_identity_in_space("thread-context-runtime-other", "space-local-other");
    let other_runtime = ThreadExecutionContextRequestRuntime::new(
        other_identity.clone(),
        Arc::new(WorkspaceRegistry::new(
            other_identity.reference().session_id.clone(),
        )),
        catalog,
        Arc::clone(&state),
    );
    assert_eq!(
        other_runtime
            .read_owned(thread_id)
            .await
            .expect_err("cross-owner context rejected")
            .message,
        "Thread execution context request is not authorized"
    );

    state.close().await;
}

#[tokio::test]
async fn office_authorization_requires_exact_owner_scope_and_workspace_root() {
    let state_home = tempfile::TempDir::new().expect("state home");
    let workspace_root = tempfile::TempDir::new().expect("workspace root");
    let other_workspace_root = tempfile::TempDir::new().expect("other workspace root");
    let unregistered_workspace_root = tempfile::TempDir::new().expect("unregistered root");
    let state = StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-context-authorization-test".to_string(),
    )
    .await
    .expect("initialize State");
    let catalog = WorkspaceRootCatalog::new(
        "node-1".to_string(),
        workspace_root.path().to_path_buf(),
        vec![
            workspace_root.path().to_path_buf(),
            other_workspace_root.path().to_path_buf(),
        ],
    );
    let identity = authenticated_identity("office-context-owner");
    let runtime = ThreadExecutionContextRequestRuntime::new(
        identity.clone(),
        Arc::new(WorkspaceRegistry::new(
            identity.reference().session_id.clone(),
        )),
        catalog.clone(),
        Arc::clone(&state),
    );
    let thread_id = "019f550e-ba52-7490-a248-b0d3a84103d1";
    let prepared = runtime
        .prepare_create_for_registered_root(workspace_root.path())
        .await
        .expect("prepare Office context");
    runtime
        .create(
            prepared,
            thread_id,
            ThreadExecutionContextWorkspaceScope::Office {
                office_id: "office-1".to_string(),
            },
            /*now*/ 100,
        )
        .await
        .expect("create Office context");

    runtime
        .authorize_registered_workspace_root(workspace_root.path())
        .await
        .expect("registered workspace root");
    assert_eq!(
        runtime
            .authorize_registered_workspace_root(unregistered_workspace_root.path())
            .await
            .expect_err("unregistered workspace root rejected")
            .message,
        "Office workspace root is not registered"
    );
    runtime
        .authorize_office_thread(thread_id, "office-1", workspace_root.path())
        .await
        .expect("exact Office authority");
    assert_eq!(
        runtime
            .authorize_office_thread(thread_id, "office-2", workspace_root.path())
            .await
            .expect_err("cross-Office authority rejected")
            .message,
        "Office execution context does not belong to this Office"
    );
    assert_eq!(
        runtime
            .authorize_office_thread(thread_id, "office-1", other_workspace_root.path())
            .await
            .expect_err("cross-workspace authority rejected")
            .message,
        "Office execution context does not belong to this workspace"
    );

    let other_identity =
        authenticated_identity_in_space("office-context-other", "space-local-other");
    let other_runtime = ThreadExecutionContextRequestRuntime::new(
        other_identity.clone(),
        Arc::new(WorkspaceRegistry::new(
            other_identity.reference().session_id.clone(),
        )),
        catalog,
        Arc::clone(&state),
    );
    assert_eq!(
        other_runtime
            .authorize_office_thread(thread_id, "office-1", workspace_root.path())
            .await
            .expect_err("cross-owner authority rejected")
            .message,
        "Thread execution context request is not authorized"
    );

    state.close().await;
}

#[tokio::test]
async fn office_authorization_backfills_a_missing_legacy_context_idempotently() {
    let state_home = tempfile::TempDir::new().expect("state home");
    let workspace_root = tempfile::TempDir::new().expect("workspace root");
    let state = StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-context-backfill-test".to_string(),
    )
    .await
    .expect("initialize State");
    let catalog = WorkspaceRootCatalog::new(
        "node-1".to_string(),
        workspace_root.path().to_path_buf(),
        vec![workspace_root.path().to_path_buf()],
    );
    let identity = authenticated_identity("office-context-backfill-owner");
    let registry = Arc::new(WorkspaceRegistry::new(
        identity.reference().session_id.clone(),
    ));
    registered_workspace_key(registry.as_ref(), &identity, &catalog, state.as_ref()).await;
    let runtime =
        ThreadExecutionContextRequestRuntime::new(identity, registry, catalog, Arc::clone(&state));
    let thread_id = "019f550e-ba52-7490-a248-b0d3a84103e1";

    for now in [100, 110] {
        runtime
            .authorize_or_create_office_thread(
                thread_id,
                "legacy-office-1",
                workspace_root.path(),
                now,
            )
            .await
            .expect("legacy Office context should be authorized and backfilled");
    }

    let context = runtime
        .read_owned(thread_id)
        .await
        .expect("read backfilled Office context")
        .expect("backfilled Office context exists");
    assert_eq!(context.workspace.scope, WorkspaceScope::Office);
    assert_eq!(context.workspace.scope_id, "legacy-office-1");
    assert_eq!(context.thread_id, thread_id);
    assert_eq!(context.revision, 1);

    state.close().await;
}

async fn registered_workspace_key(
    registry: &WorkspaceRegistry,
    identity: &super::RequestIdentity,
    catalog: &WorkspaceRootCatalog,
    state: &StateRuntime,
) -> String {
    registry
        .list_with_state(
            identity,
            catalog,
            Some(state),
            WorkspaceListParams {
                cursor: None,
                limit: None,
            },
        )
        .await
        .expect("list durable workspace")
        .data
        .into_iter()
        .next()
        .expect("workspace")
        .workspace_key
}

#[test]
fn runtime_revalidates_exact_binding_authority_before_projection() {
    let mut binding = super::dynamic_tool_router_tests::binding(
        ProviderResourceKind::McpTool,
        ProviderResourceBindingMode::RemoteReference,
    );
    binding.workspace_scope = ProviderResourceWorkspaceScope::Conversation;
    binding.workspace_scope_id = "thread-1".to_string();
    let reference = ThreadExecutionContextBindingRef {
        binding_id: binding.binding_id.clone(),
        revision: binding.revision,
    };
    let context = ThreadExecutionContextRecord {
        thread_id: "thread-1".to_string(),
        local_actor_id: binding.local_actor_id.clone(),
        local_tenant_id: binding.local_tenant_id.clone(),
        local_space_id: binding.local_space_id.clone(),
        workspace_key: binding.workspace_key.clone(),
        workspace_scope: ProviderResourceWorkspaceScope::Conversation,
        workspace_scope_id: "thread-1".to_string(),
        resource_bindings: vec![reference.clone()],
        execution_binding: None,
        revision: 1,
        record_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        created_at: 100,
        updated_at: 100,
    };

    assert!(binding_matches_thread_execution_context(
        &binding, &reference, &context
    ));

    binding.local_space_id = "space-other".to_string();
    assert!(!binding_matches_thread_execution_context(
        &binding, &reference, &context
    ));
}

#[tokio::test]
async fn cloud_agent_context_rejects_unsupported_thread_mutations() {
    let fixture = crate::task_control::cloud_agent_turn_coordinator::tests::fixture().await;
    let workspace_root = tempfile::TempDir::new().expect("workspace root");
    let catalog = WorkspaceRootCatalog::new(
        "node-1".to_string(),
        workspace_root.path().to_path_buf(),
        vec![workspace_root.path().to_path_buf()],
    );
    let runtime = ThreadExecutionContextRequestRuntime::new(
        fixture.identity.clone(),
        Arc::new(WorkspaceRegistry::new(
            fixture.identity.reference().session_id.clone(),
        )),
        catalog,
        fixture.state.clone(),
    );

    for (operation, method) in [
        (CloudAgentThreadOperation::Fork, "thread/fork"),
        (CloudAgentThreadOperation::Compact, "thread/compact/start"),
        (CloudAgentThreadOperation::InjectItems, "thread/injectItems"),
        (CloudAgentThreadOperation::Steer, "turn/steer"),
    ] {
        assert_eq!(
            runtime
                .ensure_operation_supported("019f550e-ba52-7490-a248-b0d3a84103c1", operation,)
                .await
                .expect_err("Cloud Agent operation rejected")
                .message,
            format!("Cloud Agent Thread does not support {method}")
        );
    }
    fixture.state.close().await;
}
