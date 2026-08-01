CREATE TABLE cloud_agent_legacy_imports (
    journal_id TEXT PRIMARY KEY NOT NULL,
    source_key TEXT NOT NULL UNIQUE,
    source_digest TEXT NOT NULL CHECK(
        length(source_digest) = 71
        AND substr(source_digest, 1, 7) = 'sha256:'
    ),
    source_bytes INTEGER NOT NULL CHECK(source_bytes > 0 AND source_bytes <= 1000000),
    thread_id TEXT NOT NULL
        REFERENCES thread_execution_contexts(thread_id) ON DELETE CASCADE,
    execution_binding_id TEXT NOT NULL,
    execution_binding_revision INTEGER NOT NULL CHECK(execution_binding_revision > 0),
    expected_turn_count INTEGER NOT NULL CHECK(
        expected_turn_count > 0 AND expected_turn_count <= 10
    ),
    status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
    imported_at INTEGER NOT NULL CHECK(imported_at >= 0),
    completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= imported_at),
    FOREIGN KEY(thread_id, execution_binding_id, execution_binding_revision)
        REFERENCES thread_execution_context_bindings(
            thread_id, binding_id, binding_revision
        ),
    CHECK(
        (status = 'pending' AND completed_at IS NULL)
        OR
        (status = 'completed' AND completed_at IS NOT NULL)
    )
);

CREATE TABLE cloud_agent_legacy_import_turns (
    journal_id TEXT NOT NULL
        REFERENCES cloud_agent_legacy_imports(journal_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 10),
    turn_id TEXT NOT NULL UNIQUE
        REFERENCES cloud_agent_turns(turn_id) ON DELETE CASCADE,
    import_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(journal_id, ordinal),
    UNIQUE(journal_id, import_id)
);

CREATE INDEX idx_cloud_agent_legacy_import_recovery
    ON cloud_agent_legacy_imports(status, imported_at, journal_id);
