CREATE TABLE provider_connections (
    connection_id TEXT PRIMARY KEY,
    local_actor_id TEXT NOT NULL,
    local_tenant_id TEXT NOT NULL,
    local_space_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    credential_revision INTEGER NOT NULL CHECK(credential_revision > 0),
    record_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE(
        local_actor_id,
        local_tenant_id,
        local_space_id,
        provider_id,
        protocol_version,
        credential_id,
        credential_revision
    )
);

