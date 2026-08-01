use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use pretty_assertions::assert_eq;

use super::dynamic_tool_router_tests::binding;
use super::provider_identity_adapter_tests::authenticated_identity;
use super::thread_execution_context_adapter::ThreadExecutionContextAdapterError;
use super::thread_execution_context_adapter::ThreadExecutionContextBindingSelection;
use super::thread_execution_context_adapter::project_thread_execution_context;
use super::thread_execution_context_adapter::thread_execution_context_binding_update;
use super::thread_execution_context_adapter::thread_execution_context_record;

#[test]
fn adapter_derives_stable_owner_workspace_and_sorted_binding_refs() {
    let identity = authenticated_identity("thread-context-trace");
    let workspace = workspace();
    let mut first = owned_binding(&identity, &workspace, "301");
    let second = owned_binding(&identity, &workspace, "302");
    first.binding_id = first.binding_id.replace("301", "303");
    first.record_hash = first.canonical_hash();

    let record = thread_execution_context_record(
        &identity,
        &workspace,
        "thread-1",
        &[first.clone(), second.clone()],
        /*created_at*/ 100,
    )
    .expect("derive Thread execution context");
    assert_eq!(record.local_actor_id, identity.reference().actor_id);
    assert_eq!(record.local_tenant_id, "tenant-local-1");
    assert_eq!(record.local_space_id, "space-local-1");
    assert_eq!(record.resource_bindings[0].binding_id, second.binding_id);
    assert_eq!(record.resource_bindings[1].binding_id, first.binding_id);
    assert!(!format!("{record:?}").contains("tenant-local-1"));
    let projection = project_thread_execution_context(&record, workspace.clone())
        .expect("project Thread execution context");
    assert_eq!(projection.workspace.binding_id, workspace.binding_id);

    let update = thread_execution_context_binding_update(
        &identity,
        &workspace,
        &record,
        ThreadExecutionContextBindingSelection {
            bindings: &[second],
            execution_binding_id: None,
        },
        /*updated_at*/ 110,
    )
    .expect("derive binding update");
    assert_eq!(update.expected_revision, 1);
    assert_eq!(update.resource_bindings.len(), 1);

    let mut other_workspace = workspace;
    other_workspace.workspace_key = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c099".to_string();
    assert_eq!(
        thread_execution_context_binding_update(
            &identity,
            &other_workspace,
            &record,
            ThreadExecutionContextBindingSelection {
                bindings: &[],
                execution_binding_id: None,
            },
            /*updated_at*/ 110,
        ),
        Err(ThreadExecutionContextAdapterError::Unauthorized)
    );
}

#[test]
fn adapter_accepts_only_exact_provider_managed_agent_execution_binding() {
    let identity = authenticated_identity("thread-context-agent");
    let workspace = workspace();
    let agent = owned_binding_of_kind(
        &identity,
        &workspace,
        "304",
        ProviderResourceKind::Agent,
        ProviderResourceBindingMode::ProviderManaged,
    );
    let skill = owned_binding_of_kind(
        &identity,
        &workspace,
        "305",
        ProviderResourceKind::Skill,
        ProviderResourceBindingMode::ProviderManaged,
    );
    let record = thread_execution_context_record(
        &identity,
        &workspace,
        "thread-1",
        &[],
        /*created_at*/ 100,
    )
    .expect("derive empty Thread execution context");

    let bindings = [agent.clone(), skill.clone()];
    let update = thread_execution_context_binding_update(
        &identity,
        &workspace,
        &record,
        ThreadExecutionContextBindingSelection {
            bindings: &bindings,
            execution_binding_id: Some(&agent.binding_id),
        },
        /*updated_at*/ 110,
    )
    .expect("select exact Agent execution binding");
    assert_eq!(
        update.execution_binding,
        Some(crewon_state::ThreadExecutionContextBindingRef {
            binding_id: agent.binding_id.clone(),
            revision: agent.revision,
        })
    );

    assert_eq!(
        thread_execution_context_binding_update(
            &identity,
            &workspace,
            &record,
            ThreadExecutionContextBindingSelection {
                bindings: &bindings,
                execution_binding_id: Some(&skill.binding_id),
            },
            /*updated_at*/ 110,
        ),
        Err(ThreadExecutionContextAdapterError::InvalidRequest)
    );
    assert_eq!(
        thread_execution_context_binding_update(
            &identity,
            &workspace,
            &record,
            ThreadExecutionContextBindingSelection {
                bindings: &bindings,
                execution_binding_id: Some("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c399",),
            },
            /*updated_at*/ 110,
        ),
        Err(ThreadExecutionContextAdapterError::InvalidRequest)
    );
}

#[test]
fn adapter_rejects_connection_identity_workspace_drift_and_cross_owner_binding() {
    let identity = authenticated_identity("thread-context-trace");
    let workspace = workspace();
    let binding = owned_binding(&identity, &workspace, "301");
    let connection_identity =
        super::ConnectionRequestIdentity::new(crate::transport::ConnectionOrigin::Stdio).derive(
            super::provider_identity_adapter_tests::declared_client(),
            "connection-trace".to_string(),
        );
    assert_eq!(
        thread_execution_context_record(
            &connection_identity,
            &workspace,
            "thread-1",
            &[],
            /*created_at*/ 100,
        ),
        Err(ThreadExecutionContextAdapterError::Unauthorized)
    );

    let mut wrong_scope = workspace.clone();
    wrong_scope.scope = WorkspaceScope::Workflow;
    assert_eq!(
        thread_execution_context_record(
            &identity,
            &wrong_scope,
            "thread-1",
            &[],
            /*created_at*/ 100
        ),
        Err(ThreadExecutionContextAdapterError::InvalidRequest)
    );
    let mut cross_owner = binding;
    cross_owner.local_space_id = "space-other".to_string();
    cross_owner.record_hash = cross_owner.canonical_hash();
    assert_eq!(
        thread_execution_context_record(
            &identity,
            &workspace,
            "thread-1",
            &[cross_owner],
            /*created_at*/ 100,
        ),
        Err(ThreadExecutionContextAdapterError::Unauthorized)
    );
}

#[test]
fn adapter_allows_office_manager_and_member_threads_with_exact_office_bindings() {
    let identity = authenticated_identity("office-thread-context");
    let workspace = office_workspace();
    let binding = owned_binding(&identity, &workspace, "306");

    for thread_id in ["office-manager-thread", "office-member-thread"] {
        let record = thread_execution_context_record(
            &identity,
            &workspace,
            thread_id,
            std::slice::from_ref(&binding),
            /*created_at*/ 100,
        )
        .expect("derive Office Thread execution context");
        assert_eq!(
            record.workspace_scope,
            ProviderResourceWorkspaceScope::Office
        );
        assert_eq!(record.workspace_scope_id, "office-1");
        assert_eq!(record.thread_id, thread_id);

        let projection = project_thread_execution_context(&record, workspace.clone())
            .expect("project Office Thread execution context");
        assert_eq!(projection.workspace.scope, WorkspaceScope::Office);
        assert_eq!(projection.workspace.scope_id, "office-1");

        let update = thread_execution_context_binding_update(
            &identity,
            &workspace,
            &record,
            ThreadExecutionContextBindingSelection {
                bindings: std::slice::from_ref(&binding),
                execution_binding_id: None,
            },
            /*updated_at*/ 110,
        )
        .expect("update Office Thread binding selection");
        assert_eq!(update.resource_bindings.len(), 1);
    }
}

#[test]
fn adapter_rejects_conversation_binding_in_office_execution_context() {
    let identity = authenticated_identity("office-binding-scope-drift");
    let office_workspace = office_workspace();
    let conversation_binding = owned_binding(&identity, &workspace(), "307");

    assert_eq!(
        thread_execution_context_record(
            &identity,
            &office_workspace,
            "office-manager-thread",
            &[conversation_binding],
            /*created_at*/ 100,
        ),
        Err(ThreadExecutionContextAdapterError::Unauthorized)
    );
}

fn owned_binding(
    identity: &super::RequestIdentity,
    workspace: &WorkspaceRef,
    suffix: &str,
) -> crewon_state::ProviderResourceBindingRecord {
    owned_binding_of_kind(
        identity,
        workspace,
        suffix,
        ProviderResourceKind::McpTool,
        ProviderResourceBindingMode::RemoteReference,
    )
}

fn owned_binding_of_kind(
    identity: &super::RequestIdentity,
    workspace: &WorkspaceRef,
    suffix: &str,
    kind: ProviderResourceKind,
    mode: ProviderResourceBindingMode,
) -> crewon_state::ProviderResourceBindingRecord {
    let mut record = binding(kind, mode);
    record.binding_id = format!("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c{suffix}");
    record.local_actor_id = identity.reference().actor_id.clone();
    record.local_tenant_id = identity.reference().tenant_id.clone().expect("tenant id");
    record.local_space_id = identity.reference().space_id.clone().expect("space id");
    record.workspace_key = workspace.workspace_key.clone();
    record.workspace_scope = match workspace.scope {
        WorkspaceScope::Conversation => ProviderResourceWorkspaceScope::Conversation,
        WorkspaceScope::Office => ProviderResourceWorkspaceScope::Office,
        WorkspaceScope::Workflow => ProviderResourceWorkspaceScope::Workflow,
        WorkspaceScope::Automation => ProviderResourceWorkspaceScope::Automation,
    };
    record.workspace_scope_id = workspace.scope_id.clone();
    record.record_hash = record.canonical_hash();
    record
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        binding_id: "workspace-binding-current".to_string(),
        scope: WorkspaceScope::Conversation,
        scope_id: "thread-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}

fn office_workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        binding_id: "workspace-binding-office".to_string(),
        scope: WorkspaceScope::Office,
        scope_id: "office-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}
