CREATE TABLE artifact_payloads (
    payload_id TEXT PRIMARY KEY NOT NULL,
    sha256 TEXT NOT NULL,
    byte_len INTEGER NOT NULL CHECK(byte_len >= 0 AND byte_len <= 8388608),
    media_type TEXT NOT NULL,
    sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public', 'internal', 'workspace_sensitive')),
    retention_kind TEXT NOT NULL CHECK(retention_kind IN ('session', 'task', 'user_managed', 'compliance')),
    expires_at INTEGER CHECK(expires_at IS NULL OR expires_at >= 0),
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'deleted')),
    content BLOB,
    deletion_reason TEXT,
    deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    CHECK(
        (retention_kind = 'user_managed' AND expires_at IS NULL)
        OR
        (retention_kind != 'user_managed' AND expires_at IS NOT NULL AND expires_at > created_at)
    ),
    CHECK(
        (status = 'available' AND content IS NOT NULL AND deletion_reason IS NULL AND deleted_at IS NULL)
        OR
        (status = 'deleted' AND content IS NULL AND deletion_reason IS NOT NULL AND deleted_at IS NOT NULL)
    )
);

CREATE INDEX idx_artifact_payloads_expiry
    ON artifact_payloads(status, expires_at, created_at)
    WHERE status = 'available' AND expires_at IS NOT NULL;

CREATE TABLE artifact_manifests (
    artifact_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    commit_hash TEXT NOT NULL,
    payload_id TEXT NOT NULL UNIQUE REFERENCES artifact_payloads(payload_id),
    manifest_json TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(artifact_id, revision)
);

CREATE TABLE platform_audit_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    event_hash TEXT NOT NULL,
    event_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    payload_id TEXT REFERENCES artifact_payloads(payload_id),
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
);

CREATE INDEX idx_platform_audit_events_payload
    ON platform_audit_events(payload_id, occurred_at)
    WHERE payload_id IS NOT NULL;
