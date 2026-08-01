CREATE TABLE office_migration_journals (
    record_id TEXT PRIMARY KEY NOT NULL CHECK(
        length(record_id) > 0 AND length(record_id) <= 128
    ),
    workspace_key TEXT NOT NULL
        REFERENCES durable_workspace_roots(workspace_key) ON DELETE RESTRICT,
    source_revision TEXT NOT NULL CHECK(
        length(source_revision) > 0 AND length(source_revision) <= 512
    ),
    source_digest TEXT NOT NULL CHECK(
        length(source_digest) = 71 AND substr(source_digest, 1, 7) = 'sha256:'
    ),
    source_bytes INTEGER NOT NULL CHECK(source_bytes > 0 AND source_bytes <= 4194304),
    phase TEXT NOT NULL CHECK(
        phase IN ('quiescing', 'importing', 'imported', 'active')
    ),
    journal_revision INTEGER NOT NULL CHECK(journal_revision > 0),
    snapshot_digest TEXT CHECK(
        snapshot_digest IS NULL OR (
            length(snapshot_digest) = 71
            AND substr(snapshot_digest, 1, 7) = 'sha256:'
        )
    ),
    snapshot_json TEXT CHECK(
        snapshot_json IS NULL OR (
            length(snapshot_json) > 0 AND length(snapshot_json) <= 4194304
        )
    ),
    record_hash TEXT NOT NULL CHECK(
        length(record_hash) = 71 AND substr(record_hash, 1, 7) = 'sha256:'
    ),
    started_at INTEGER NOT NULL CHECK(started_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= started_at),
    imported_at INTEGER CHECK(imported_at IS NULL OR imported_at >= started_at),
    CHECK(
        (phase IN ('quiescing', 'importing')
            AND snapshot_digest IS NULL
            AND snapshot_json IS NULL
            AND imported_at IS NULL)
        OR
        (phase IN ('imported', 'active')
            AND snapshot_digest IS NOT NULL
            AND snapshot_json IS NOT NULL
            AND imported_at IS NOT NULL)
    )
);

CREATE INDEX idx_office_migration_recovery
    ON office_migration_journals(phase, updated_at, record_id);
