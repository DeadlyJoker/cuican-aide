CREATE TABLE task_runtime_tasks (
    task_id TEXT PRIMARY KEY NOT NULL,
    authority TEXT NOT NULL,
    strategy TEXT NOT NULL,
    status TEXT NOT NULL,
    contract_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 0),
    stream_offset INTEGER NOT NULL CHECK(stream_offset >= 0),
    active_attempt_id TEXT,
    worker_run_id TEXT,
    lease_epoch INTEGER CHECK(lease_epoch IS NULL OR lease_epoch > 0),
    fencing_token_hash TEXT,
    lease_expires_at INTEGER CHECK(lease_expires_at IS NULL OR lease_expires_at >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    CHECK(
        (worker_run_id IS NULL AND lease_epoch IS NULL AND fencing_token_hash IS NULL AND lease_expires_at IS NULL)
        OR
        (active_attempt_id IS NOT NULL AND worker_run_id IS NOT NULL AND lease_epoch IS NOT NULL AND fencing_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE TABLE task_runtime_attempts (
    task_id TEXT NOT NULL REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    worker_run_id TEXT,
    lease_epoch INTEGER CHECK(lease_epoch IS NULL OR lease_epoch > 0),
    fencing_token_hash TEXT,
    lease_expires_at INTEGER CHECK(lease_expires_at IS NULL OR lease_expires_at >= 0),
    last_producer_sequence INTEGER CHECK(last_producer_sequence IS NULL OR last_producer_sequence > 0),
    attempt_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(task_id, attempt_id),
    UNIQUE(task_id, ordinal),
    CHECK(
        (worker_run_id IS NULL AND lease_epoch IS NULL AND fencing_token_hash IS NULL AND lease_expires_at IS NULL)
        OR
        (worker_run_id IS NOT NULL AND lease_epoch IS NOT NULL AND fencing_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE TABLE task_runtime_events (
    task_id TEXT NOT NULL REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    stream_offset INTEGER NOT NULL CHECK(stream_offset > 0),
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_json TEXT NOT NULL,
    attempt_id TEXT,
    worker_run_id TEXT,
    producer_sequence INTEGER CHECK(producer_sequence IS NULL OR producer_sequence > 0),
    lease_epoch INTEGER CHECK(lease_epoch IS NULL OR lease_epoch > 0),
    fencing_token_hash TEXT,
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
    received_at INTEGER NOT NULL CHECK(received_at >= 0),
    PRIMARY KEY(task_id, stream_offset),
    UNIQUE(task_id, event_id)
);

CREATE UNIQUE INDEX idx_task_runtime_events_worker_sequence
    ON task_runtime_events(task_id, attempt_id, worker_run_id, producer_sequence)
    WHERE attempt_id IS NOT NULL
        AND worker_run_id IS NOT NULL
        AND producer_sequence IS NOT NULL;

CREATE TABLE task_runtime_inbox (
    task_id TEXT NOT NULL REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    receipt_kind TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    result_aggregate_version INTEGER NOT NULL CHECK(result_aggregate_version > 0),
    result_stream_offset INTEGER NOT NULL CHECK(result_stream_offset > 0),
    result_snapshot_json TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(task_id, receipt_kind, receipt_id)
);

CREATE TABLE task_runtime_outbox (
    outbox_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
    decision_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered')),
    delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts >= 0),
    available_at INTEGER NOT NULL CHECK(available_at >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    delivered_at INTEGER CHECK(delivered_at IS NULL OR delivered_at >= 0)
);

CREATE INDEX idx_task_runtime_outbox_pending
    ON task_runtime_outbox(status, available_at, created_at)
    WHERE status = 'pending';

CREATE TABLE task_runtime_cursors (
    consumer_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    stream_offset INTEGER NOT NULL CHECK(stream_offset >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(consumer_id, task_id)
);

CREATE TABLE task_runtime_migration_journal (
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    migration_hash TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(source_kind, source_id, source_revision)
);
