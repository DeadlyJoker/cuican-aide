CREATE TABLE durable_workspace_roots (
    workspace_key TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    root_fingerprint TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE(node_id, environment_id, root_fingerprint)
);
