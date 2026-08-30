CREATE TABLE device_journal_schema (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 1)
) STRICT;

INSERT INTO device_journal_schema (singleton, version) VALUES (1, 1);

CREATE TABLE workspace_executions (
    execution_id TEXT PRIMARY KEY NOT NULL,
    execution_kind TEXT NOT NULL CHECK (execution_kind = 'workspaceList'),
    command_fingerprint TEXT NOT NULL CHECK (
        length(command_fingerprint) = 71
        AND substr(command_fingerprint, 1, 7) = 'sha256:'
        AND substr(command_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    command_json TEXT NOT NULL CHECK (json_valid(command_json)),
    device_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
    expires_at TEXT NOT NULL,
    workspace_binding_id TEXT NOT NULL,
    incarnation_id TEXT NOT NULL,
    device_binding_id TEXT NOT NULL,
    runtime_binding_id TEXT NOT NULL,
    policy_snapshot_id TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    command_digest TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    acknowledged_through INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_through BETWEEN 0 AND 2),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_events (
    execution_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence IN (1, 2)),
    event_type TEXT NOT NULL CHECK (
        (sequence = 1 AND event_type = 'workspace_list.accepted')
        OR
        (sequence = 2 AND event_type IN (
            'workspace_list.completed',
            'workspace_list.failed',
            'workspace_list.canceled',
            'workspace_list.unknown_outcome'
        ))
    ),
    event_fingerprint TEXT NOT NULL CHECK (
        length(event_fingerprint) = 71
        AND substr(event_fingerprint, 1, 7) = 'sha256:'
        AND substr(event_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    device_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL CHECK (connection_epoch >= 1),
    workspace_binding_id TEXT NOT NULL,
    incarnation_id TEXT NOT NULL,
    device_binding_id TEXT NOT NULL,
    runtime_binding_id TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    command_digest TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, sequence),
    FOREIGN KEY (execution_id) REFERENCES workspace_executions(execution_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE workspace_acks (
    execution_id TEXT NOT NULL,
    through_sequence INTEGER NOT NULL CHECK (through_sequence IN (1, 2)),
    ack_fingerprint TEXT NOT NULL CHECK (
        length(ack_fingerprint) = 71
        AND substr(ack_fingerprint, 1, 7) = 'sha256:'
        AND substr(ack_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    ack_json TEXT NOT NULL CHECK (json_valid(ack_json)),
    device_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL CHECK (connection_epoch >= 1),
    workspace_binding_id TEXT NOT NULL,
    incarnation_id TEXT NOT NULL,
    device_binding_id TEXT NOT NULL,
    runtime_binding_id TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    command_digest TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, through_sequence),
    FOREIGN KEY (execution_id, through_sequence)
        REFERENCES workspace_events(execution_id, sequence) ON DELETE RESTRICT
) STRICT;

CREATE INDEX workspace_executions_unacknowledged_idx
    ON workspace_executions (execution_id, acknowledged_through);

CREATE UNIQUE INDEX workspace_events_accepted_receipt_idx
    ON workspace_events (receipt_id)
    WHERE sequence = 1;
