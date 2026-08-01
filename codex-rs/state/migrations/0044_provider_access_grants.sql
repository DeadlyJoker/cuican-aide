CREATE TABLE provider_access_grants (
    grant_id TEXT PRIMARY KEY CHECK(length(grant_id) BETWEEN 1 AND 255),
    local_actor_id TEXT NOT NULL CHECK(length(local_actor_id) BETWEEN 1 AND 255),
    local_tenant_id TEXT NOT NULL CHECK(length(local_tenant_id) BETWEEN 1 AND 255),
    local_space_id TEXT NOT NULL CHECK(length(local_space_id) BETWEEN 1 AND 255),
    provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 255),
    source_binding_id TEXT NOT NULL CHECK(length(source_binding_id) BETWEEN 1 AND 255),
    source_revision INTEGER NOT NULL CHECK(source_revision > 0),
    granted_scopes_json TEXT NOT NULL CHECK(length(granted_scopes_json) BETWEEN 1 AND 8192),
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
    expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    record_hash TEXT NOT NULL CHECK(length(record_hash) = 71),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    revoked_at INTEGER,
    CHECK(
        (status = 'active' AND revision = 1 AND revoked_at IS NULL AND updated_at = created_at)
        OR
        (status = 'revoked' AND revision >= 2 AND revoked_at = updated_at)
    )
);

CREATE UNIQUE INDEX provider_access_grants_active_owner_provider
ON provider_access_grants (
    local_actor_id,
    local_tenant_id,
    local_space_id,
    provider_id
)
WHERE status = 'active';

CREATE UNIQUE INDEX provider_access_grants_active_source_binding
ON provider_access_grants (provider_id, source_binding_id, source_revision)
WHERE status = 'active';
