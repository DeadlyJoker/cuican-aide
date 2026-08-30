CREATE TABLE provider_identity_bindings (
    binding_id TEXT PRIMARY KEY,
    local_actor_id TEXT NOT NULL,
    local_tenant_id TEXT NOT NULL,
    local_space_id TEXT NOT NULL,
    provider_id TEXT NOT NULL CHECK(provider_id = 'agent-platform'),
    provider_subject TEXT NOT NULL,
    provider_tenant_id TEXT NOT NULL,
    provider_space_id TEXT NOT NULL,
    authority_id TEXT NOT NULL,
    source_binding_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision > 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    record_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    UNIQUE(authority_id, source_binding_id)
);

CREATE UNIQUE INDEX provider_identity_bindings_active_owner
ON provider_identity_bindings (
    local_actor_id, local_tenant_id, local_space_id, provider_id
)
WHERE status = 'active';

CREATE UNIQUE INDEX provider_identity_bindings_active_target
ON provider_identity_bindings (
    provider_id, provider_tenant_id, provider_space_id, provider_subject
)
WHERE status = 'active';
