CREATE TABLE thread_execution_contexts (
    thread_id TEXT PRIMARY KEY NOT NULL,
    local_actor_id TEXT NOT NULL,
    local_tenant_id TEXT NOT NULL,
    local_space_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL REFERENCES durable_workspace_roots(workspace_key),
    workspace_scope TEXT NOT NULL CHECK(workspace_scope IN (
        'conversation', 'office', 'workflow', 'automation'
    )),
    workspace_scope_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    record_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
);

CREATE TABLE thread_execution_context_bindings (
    thread_id TEXT NOT NULL REFERENCES thread_execution_contexts(thread_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 32),
    binding_id TEXT NOT NULL REFERENCES provider_resource_bindings(binding_id),
    binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
    PRIMARY KEY(thread_id, ordinal),
    UNIQUE(thread_id, binding_id)
);

CREATE INDEX idx_thread_execution_context_owner
    ON thread_execution_contexts(local_actor_id, local_tenant_id, local_space_id, updated_at);
