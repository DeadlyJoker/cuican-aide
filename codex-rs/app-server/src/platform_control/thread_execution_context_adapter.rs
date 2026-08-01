use crewon_app_server_protocol::ThreadExecutionContext;
use crewon_app_server_protocol::ThreadExecutionContextBindingRef as ProtocolBindingRef;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_state::ThreadExecutionContextBindingRef;
use crewon_state::ThreadExecutionContextBindingUpdate;
use crewon_state::ThreadExecutionContextRecord;

use super::RequestIdentity;

pub(crate) fn validate_thread_execution_context_identity(
    identity: &RequestIdentity,
) -> Result<(), ThreadExecutionContextAdapterError> {
    stable_owner(identity).map(|_| ())
}

pub(crate) fn authorize_thread_execution_context_record(
    identity: &RequestIdentity,
    record: &ThreadExecutionContextRecord,
) -> Result<(), ThreadExecutionContextAdapterError> {
    let (actor_id, tenant_id, space_id) = stable_owner(identity)?;
    if record.local_actor_id != actor_id
        || record.local_tenant_id != tenant_id
        || record.local_space_id != space_id
    {
        return Err(ThreadExecutionContextAdapterError::Unauthorized);
    }
    Ok(())
}

pub(crate) fn project_thread_execution_context(
    record: &ThreadExecutionContextRecord,
    workspace: WorkspaceRef,
) -> Result<ThreadExecutionContext, ThreadExecutionContextAdapterError> {
    let workspace_scope = state_workspace_scope(workspace.scope)?;
    if record.workspace_scope != workspace_scope
        || record.workspace_key != workspace.workspace_key
        || record.workspace_scope_id != workspace.scope_id
        || !thread_matches_workspace_scope(&record.thread_id, workspace.scope, &workspace.scope_id)
    {
        return Err(ThreadExecutionContextAdapterError::InvalidRequest);
    }
    Ok(ThreadExecutionContext {
        thread_id: record.thread_id.clone(),
        workspace,
        resource_bindings: record
            .resource_bindings
            .iter()
            .map(|binding| ProtocolBindingRef {
                binding_id: binding.binding_id.clone(),
                revision: binding.revision,
            })
            .collect(),
        execution_binding: record
            .execution_binding
            .as_ref()
            .map(|binding| ProtocolBindingRef {
                binding_id: binding.binding_id.clone(),
                revision: binding.revision,
            }),
        revision: record.revision,
        created_at: record.created_at,
        updated_at: record.updated_at,
    })
}

pub(crate) fn thread_execution_context_record(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    thread_id: &str,
    bindings: &[ProviderResourceBindingRecord],
    created_at: i64,
) -> Result<ThreadExecutionContextRecord, ThreadExecutionContextAdapterError> {
    let (actor_id, tenant_id, space_id) = stable_owner(identity)?;
    let workspace_scope = state_workspace_scope(workspace.scope)?;
    if !thread_matches_workspace_scope(thread_id, workspace.scope, &workspace.scope_id)
        || created_at < 0
    {
        return Err(ThreadExecutionContextAdapterError::InvalidRequest);
    }
    let resource_bindings = binding_refs(
        bindings,
        actor_id,
        tenant_id,
        space_id,
        &workspace.workspace_key,
        workspace_scope,
        &workspace.scope_id,
    )?;
    let mut record = ThreadExecutionContextRecord {
        thread_id: thread_id.to_string(),
        local_actor_id: actor_id.to_string(),
        local_tenant_id: tenant_id.to_string(),
        local_space_id: space_id.to_string(),
        workspace_key: workspace.workspace_key.clone(),
        workspace_scope,
        workspace_scope_id: workspace.scope_id.clone(),
        resource_bindings,
        execution_binding: None,
        revision: 1,
        record_hash: String::new(),
        created_at,
        updated_at: created_at,
    };
    record.record_hash = record.canonical_hash();
    record
        .validate()
        .map_err(|_| ThreadExecutionContextAdapterError::InvalidRequest)?;
    Ok(record)
}

pub(crate) fn thread_execution_context_binding_update(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    current: &ThreadExecutionContextRecord,
    selection: ThreadExecutionContextBindingSelection<'_>,
    updated_at: i64,
) -> Result<ThreadExecutionContextBindingUpdate, ThreadExecutionContextAdapterError> {
    let (actor_id, tenant_id, space_id) = stable_owner(identity)?;
    let workspace_scope = state_workspace_scope(workspace.scope)?;
    if current.local_actor_id != actor_id
        || current.local_tenant_id != tenant_id
        || current.local_space_id != space_id
        || current.workspace_key != workspace.workspace_key
        || current.workspace_scope != workspace_scope
        || current.workspace_scope_id != workspace.scope_id
        || !thread_matches_workspace_scope(&current.thread_id, workspace.scope, &workspace.scope_id)
        || updated_at < current.updated_at
    {
        return Err(ThreadExecutionContextAdapterError::Unauthorized);
    }
    let resource_bindings = binding_refs(
        selection.bindings,
        actor_id,
        tenant_id,
        space_id,
        &current.workspace_key,
        current.workspace_scope,
        &current.workspace_scope_id,
    )?;
    let execution_binding = execution_binding_ref(selection, &resource_bindings)?;
    Ok(ThreadExecutionContextBindingUpdate {
        thread_id: current.thread_id.clone(),
        local_actor_id: actor_id.to_string(),
        local_tenant_id: tenant_id.to_string(),
        local_space_id: space_id.to_string(),
        expected_revision: current.revision,
        resource_bindings,
        execution_binding,
        updated_at,
    })
}

pub(crate) struct ThreadExecutionContextBindingSelection<'a> {
    pub(crate) bindings: &'a [ProviderResourceBindingRecord],
    pub(crate) execution_binding_id: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ThreadExecutionContextAdapterError {
    #[error("Thread execution context request is invalid")]
    InvalidRequest,
    #[error("Thread execution context is not authorized")]
    Unauthorized,
}

fn stable_owner(
    identity: &RequestIdentity,
) -> Result<(&str, &str, &str), ThreadExecutionContextAdapterError> {
    if identity.authenticated_principal().is_none() {
        return Err(ThreadExecutionContextAdapterError::Unauthorized);
    }
    let reference = identity.reference();
    let (Some(tenant_id), Some(space_id)) = (&reference.tenant_id, &reference.space_id) else {
        return Err(ThreadExecutionContextAdapterError::Unauthorized);
    };
    Ok((&reference.actor_id, tenant_id, space_id))
}

fn binding_refs(
    bindings: &[ProviderResourceBindingRecord],
    actor_id: &str,
    tenant_id: &str,
    space_id: &str,
    workspace_key: &str,
    workspace_scope: ProviderResourceWorkspaceScope,
    workspace_scope_id: &str,
) -> Result<Vec<ThreadExecutionContextBindingRef>, ThreadExecutionContextAdapterError> {
    let mut refs = Vec::with_capacity(bindings.len());
    for binding in bindings {
        binding
            .validate()
            .map_err(|_| ThreadExecutionContextAdapterError::InvalidRequest)?;
        if binding.status != ProviderResourceBindingStatus::Active
            || binding.local_actor_id != actor_id
            || binding.local_tenant_id != tenant_id
            || binding.local_space_id != space_id
            || binding.workspace_key != workspace_key
            || binding.workspace_scope != workspace_scope
            || binding.workspace_scope_id != workspace_scope_id
        {
            return Err(ThreadExecutionContextAdapterError::Unauthorized);
        }
        refs.push(ThreadExecutionContextBindingRef {
            binding_id: binding.binding_id.clone(),
            revision: binding.revision,
        });
    }
    refs.sort();
    if refs.windows(2).any(|window| window[0] == window[1]) {
        return Err(ThreadExecutionContextAdapterError::InvalidRequest);
    }
    Ok(refs)
}

const fn state_workspace_scope(
    scope: WorkspaceScope,
) -> Result<ProviderResourceWorkspaceScope, ThreadExecutionContextAdapterError> {
    match scope {
        WorkspaceScope::Conversation => Ok(ProviderResourceWorkspaceScope::Conversation),
        WorkspaceScope::Office => Ok(ProviderResourceWorkspaceScope::Office),
        WorkspaceScope::Workflow | WorkspaceScope::Automation => {
            Err(ThreadExecutionContextAdapterError::InvalidRequest)
        }
    }
}

fn thread_matches_workspace_scope(thread_id: &str, scope: WorkspaceScope, scope_id: &str) -> bool {
    match scope {
        WorkspaceScope::Conversation => thread_id == scope_id,
        WorkspaceScope::Office => true,
        WorkspaceScope::Workflow | WorkspaceScope::Automation => false,
    }
}

pub(crate) const fn protocol_workspace_scope(
    scope: ProviderResourceWorkspaceScope,
) -> Result<WorkspaceScope, ThreadExecutionContextAdapterError> {
    match scope {
        ProviderResourceWorkspaceScope::Conversation => Ok(WorkspaceScope::Conversation),
        ProviderResourceWorkspaceScope::Office => Ok(WorkspaceScope::Office),
        ProviderResourceWorkspaceScope::Workflow | ProviderResourceWorkspaceScope::Automation => {
            Err(ThreadExecutionContextAdapterError::InvalidRequest)
        }
    }
}

fn execution_binding_ref(
    selection: ThreadExecutionContextBindingSelection<'_>,
    resource_bindings: &[ThreadExecutionContextBindingRef],
) -> Result<Option<ThreadExecutionContextBindingRef>, ThreadExecutionContextAdapterError> {
    let Some(binding_id) = selection.execution_binding_id else {
        return Ok(None);
    };
    let binding = selection
        .bindings
        .iter()
        .find(|binding| binding.binding_id == binding_id)
        .ok_or(ThreadExecutionContextAdapterError::InvalidRequest)?;
    if binding.resource_kind != ProviderResourceKind::Agent
        || binding.binding_mode != ProviderResourceBindingMode::ProviderManaged
        || binding.execution_location != ProviderResourceExecutionLocation::Provider
    {
        return Err(ThreadExecutionContextAdapterError::InvalidRequest);
    }
    let reference = ThreadExecutionContextBindingRef {
        binding_id: binding.binding_id.clone(),
        revision: binding.revision,
    };
    if resource_bindings.binary_search(&reference).is_err() {
        return Err(ThreadExecutionContextAdapterError::InvalidRequest);
    }
    Ok(Some(reference))
}
