CREATE TABLE provider_resource_bindings (
    binding_id TEXT PRIMARY KEY CHECK(length(binding_id) BETWEEN 1 AND 255),
    local_actor_id TEXT NOT NULL CHECK(length(local_actor_id) BETWEEN 1 AND 255),
    local_tenant_id TEXT NOT NULL CHECK(length(local_tenant_id) BETWEEN 1 AND 255),
    local_space_id TEXT NOT NULL CHECK(length(local_space_id) BETWEEN 1 AND 255),
    connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 255),
    workspace_key TEXT NOT NULL CHECK(length(workspace_key) BETWEEN 1 AND 255),
    workspace_scope TEXT NOT NULL CHECK(workspace_scope IN ('conversation', 'office', 'workflow', 'automation')),
    workspace_scope_id TEXT NOT NULL CHECK(length(workspace_scope_id) BETWEEN 1 AND 255),
    provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 255),
    protocol_version TEXT NOT NULL CHECK(length(protocol_version) BETWEEN 1 AND 64),
    resource_kind TEXT NOT NULL CHECK(resource_kind IN ('agent', 'skill', 'mcpServer', 'mcpTool', 'knowledgeBase', 'workflow')),
    resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 512),
    resource_revision TEXT NOT NULL CHECK(length(resource_revision) BETWEEN 1 AND 256),
    binding_mode TEXT NOT NULL CHECK(binding_mode IN ('remoteReference', 'localSnapshot', 'localFork', 'providerManaged')),
    execution_location TEXT NOT NULL CHECK(execution_location IN ('localNode', 'provider')),
    manifest_schema_version TEXT NOT NULL CHECK(length(manifest_schema_version) BETWEEN 1 AND 64),
    content_digest TEXT CHECK(content_digest IS NULL OR length(content_digest) = 71),
    source_revision TEXT CHECK(source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 256),
    source_digest TEXT CHECK(source_digest IS NULL OR length(source_digest) = 71),
    local_revision TEXT CHECK(local_revision IS NULL OR length(local_revision) BETWEEN 1 AND 256),
    local_content_digest TEXT CHECK(local_content_digest IS NULL OR length(local_content_digest) = 71),
    status TEXT NOT NULL CHECK(status IN ('active', 'unbound')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    record_hash TEXT NOT NULL CHECK(length(record_hash) = 71),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    unbound_at INTEGER,
    FOREIGN KEY(connection_id) REFERENCES provider_connections(connection_id),
    FOREIGN KEY(workspace_key) REFERENCES durable_workspace_roots(workspace_key),
    CHECK(
        (
            binding_mode IN ('remoteReference', 'providerManaged')
            AND execution_location = 'provider'
            AND source_revision IS NULL
            AND source_digest IS NULL
            AND local_revision IS NULL
            AND local_content_digest IS NULL
        )
        OR
        (
            binding_mode IN ('localSnapshot', 'localFork')
            AND execution_location = 'localNode'
            AND content_digest IS NOT NULL
            AND source_revision IS NOT NULL
            AND source_digest IS NOT NULL
            AND local_revision IS NOT NULL
            AND local_content_digest IS NOT NULL
        )
    ),
    CHECK(
        (status = 'active' AND revision % 2 = 1 AND unbound_at IS NULL)
        OR
        (status = 'unbound' AND revision >= 2 AND revision % 2 = 0 AND unbound_at = updated_at)
    ),
    UNIQUE(
        local_actor_id,
        local_tenant_id,
        local_space_id,
        connection_id,
        workspace_key,
        workspace_scope,
        workspace_scope_id,
        provider_id,
        protocol_version,
        resource_kind,
        resource_id,
        resource_revision,
        binding_mode,
        execution_location
    )
);
