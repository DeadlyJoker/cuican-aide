use crewon_app_server_protocol::ExecutionLocation as ProtocolExecutionLocation;
use crewon_app_server_protocol::ResourceBindingMode as ProtocolResourceBindingMode;
use crewon_app_server_protocol::ResourceBindingProjection;
use crewon_app_server_protocol::ResourceBindingRef;
use crewon_app_server_protocol::ResourceBindingStatus;
use crewon_app_server_protocol::ResourceRef as ProtocolResourceRef;
use crewon_app_server_protocol::ResourceType;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResourceKind;
use crewon_state::ProviderConnectionRecord;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::ProviderResourceWorkspaceScope;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderResourceBindingAdapterError {
    #[error("Provider resource binding input is invalid")]
    InvalidInput,
    #[error("Provider resource binding is incompatible")]
    Incompatible,
    #[error("Provider resource binding record is invalid")]
    InvalidRecord,
}

pub(crate) fn resource_binding_record(
    connection: &ProviderConnectionRecord,
    workspace: &WorkspaceRef,
    binding: &ResolvedResourceBinding,
    now: i64,
) -> Result<ProviderResourceBindingRecord, ProviderResourceBindingAdapterError> {
    connection
        .validate()
        .map_err(|_| ProviderResourceBindingAdapterError::InvalidRecord)?;
    if now < connection.created_at || now < 0 {
        return Err(ProviderResourceBindingAdapterError::InvalidInput);
    }
    let resource = binding.resource();
    if binding.workspace_key().as_str() != workspace.workspace_key
        || resource.provider.provider_id.as_str() != connection.provider_id
        || resource.provider.protocol_version.as_str() != connection.protocol_version
    {
        return Err(ProviderResourceBindingAdapterError::Incompatible);
    }
    let materialization = binding.materialization();
    let mut record = ProviderResourceBindingRecord {
        binding_id: binding.binding_id().as_str().to_string(),
        local_actor_id: connection.local_actor_id.clone(),
        local_tenant_id: connection.local_tenant_id.clone(),
        local_space_id: connection.local_space_id.clone(),
        connection_id: connection.connection_id.clone(),
        workspace_key: workspace.workspace_key.clone(),
        workspace_scope: map_workspace_scope(workspace.scope),
        workspace_scope_id: workspace.scope_id.clone(),
        provider_id: connection.provider_id.clone(),
        protocol_version: connection.protocol_version.clone(),
        resource_kind: map_resource_kind(resource.kind),
        resource_id: resource.resource_id.as_str().to_string(),
        resource_revision: resource.revision.as_str().to_string(),
        binding_mode: map_binding_mode(binding.mode()),
        execution_location: map_execution_location(binding.execution_location()),
        manifest_schema_version: binding.manifest_schema_version().as_str().to_string(),
        content_digest: binding
            .content_digest()
            .map(|digest| digest.as_str().to_string()),
        source_revision: materialization
            .map(|materialization| materialization.source_revision.as_str().to_string()),
        source_digest: materialization
            .map(|materialization| materialization.source_digest.as_str().to_string()),
        local_revision: materialization
            .map(|materialization| materialization.local_revision.as_str().to_string()),
        local_content_digest: materialization
            .map(|materialization| materialization.content_digest.as_str().to_string()),
        status: ProviderResourceBindingStatus::Active,
        revision: 1,
        record_hash: String::new(),
        created_at: now,
        updated_at: now,
        unbound_at: None,
    };
    record.record_hash = record.canonical_hash();
    record
        .validate()
        .map_err(|_| ProviderResourceBindingAdapterError::InvalidRecord)?;
    Ok(record)
}

pub(crate) fn project_resource_binding(
    record: &ProviderResourceBindingRecord,
) -> Result<ResourceBindingProjection, ProviderResourceBindingAdapterError> {
    record
        .validate()
        .map_err(|_| ProviderResourceBindingAdapterError::InvalidRecord)?;
    Ok(ResourceBindingProjection {
        connection_id: record.connection_id.clone(),
        binding: ResourceBindingRef {
            binding_id: record.binding_id.clone(),
            workspace_key: record.workspace_key.clone(),
            resource: ProtocolResourceRef {
                provider_id: record.provider_id.clone(),
                resource_id: record.resource_id.clone(),
                revision: record.resource_revision.clone(),
                resource_type: project_resource_kind(record.resource_kind),
            },
            mode: project_binding_mode(record.binding_mode),
            execution_location: project_execution_location(record.execution_location),
        },
        workspace_scope: project_workspace_scope(record.workspace_scope),
        workspace_scope_id: record.workspace_scope_id.clone(),
        status: match record.status {
            ProviderResourceBindingStatus::Active => ResourceBindingStatus::Active,
            ProviderResourceBindingStatus::Unbound => ResourceBindingStatus::Unbound,
        },
        revision: record.revision,
        updated_at: record.updated_at,
    })
}

fn map_workspace_scope(scope: WorkspaceScope) -> ProviderResourceWorkspaceScope {
    match scope {
        WorkspaceScope::Conversation => ProviderResourceWorkspaceScope::Conversation,
        WorkspaceScope::Office => ProviderResourceWorkspaceScope::Office,
        WorkspaceScope::Workflow => ProviderResourceWorkspaceScope::Workflow,
        WorkspaceScope::Automation => ProviderResourceWorkspaceScope::Automation,
    }
}

fn project_workspace_scope(scope: ProviderResourceWorkspaceScope) -> WorkspaceScope {
    match scope {
        ProviderResourceWorkspaceScope::Conversation => WorkspaceScope::Conversation,
        ProviderResourceWorkspaceScope::Office => WorkspaceScope::Office,
        ProviderResourceWorkspaceScope::Workflow => WorkspaceScope::Workflow,
        ProviderResourceWorkspaceScope::Automation => WorkspaceScope::Automation,
    }
}

fn map_resource_kind(kind: ResourceKind) -> ProviderResourceKind {
    match kind {
        ResourceKind::Agent => ProviderResourceKind::Agent,
        ResourceKind::Skill => ProviderResourceKind::Skill,
        ResourceKind::McpServer => ProviderResourceKind::McpServer,
        ResourceKind::McpTool => ProviderResourceKind::McpTool,
        ResourceKind::KnowledgeBase => ProviderResourceKind::KnowledgeBase,
        ResourceKind::Workflow => ProviderResourceKind::Workflow,
    }
}

fn project_resource_kind(kind: ProviderResourceKind) -> ResourceType {
    match kind {
        ProviderResourceKind::Agent => ResourceType::Agent,
        ProviderResourceKind::Skill => ResourceType::Skill,
        ProviderResourceKind::McpServer => ResourceType::McpServer,
        ProviderResourceKind::McpTool => ResourceType::McpTool,
        ProviderResourceKind::KnowledgeBase => ResourceType::KnowledgeBase,
        ProviderResourceKind::Workflow => ResourceType::Workflow,
    }
}

fn map_binding_mode(mode: BindingMode) -> ProviderResourceBindingMode {
    match mode {
        BindingMode::RemoteReference => ProviderResourceBindingMode::RemoteReference,
        BindingMode::LocalSnapshot => ProviderResourceBindingMode::LocalSnapshot,
        BindingMode::LocalFork => ProviderResourceBindingMode::LocalFork,
        BindingMode::ProviderManaged => ProviderResourceBindingMode::ProviderManaged,
    }
}

fn project_binding_mode(mode: ProviderResourceBindingMode) -> ProtocolResourceBindingMode {
    match mode {
        ProviderResourceBindingMode::RemoteReference => {
            ProtocolResourceBindingMode::RemoteReference
        }
        ProviderResourceBindingMode::LocalSnapshot => ProtocolResourceBindingMode::LocalSnapshot,
        ProviderResourceBindingMode::LocalFork => ProtocolResourceBindingMode::LocalFork,
        ProviderResourceBindingMode::ProviderManaged => {
            ProtocolResourceBindingMode::ProviderManaged
        }
    }
}

fn map_execution_location(location: ExecutionLocation) -> ProviderResourceExecutionLocation {
    match location {
        ExecutionLocation::LocalNode => ProviderResourceExecutionLocation::LocalNode,
        ExecutionLocation::Provider => ProviderResourceExecutionLocation::Provider,
    }
}

fn project_execution_location(
    location: ProviderResourceExecutionLocation,
) -> ProtocolExecutionLocation {
    match location {
        ProviderResourceExecutionLocation::LocalNode => ProtocolExecutionLocation::LocalNode,
        ProviderResourceExecutionLocation::Provider => ProtocolExecutionLocation::Provider,
    }
}
