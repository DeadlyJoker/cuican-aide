UPDATE device_journal_schema SET version = 4 WHERE singleton = 1 AND version = 3;

CREATE TABLE tool_executions (
    execution_id TEXT PRIMARY KEY NOT NULL,
    command_json TEXT NOT NULL CHECK (json_valid(command_json)),
    command_fingerprint TEXT NOT NULL CHECK (
        length(command_fingerprint) = 71
        AND substr(command_fingerprint, 1, 7) = 'sha256:'
        AND substr(command_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    device_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
    action_digest TEXT NOT NULL,
    acknowledged_through INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_through BETWEEN 0 AND 2),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tool_events (
    execution_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence IN (1, 2)),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    event_fingerprint TEXT NOT NULL CHECK (
        length(event_fingerprint) = 71
        AND substr(event_fingerprint, 1, 7) = 'sha256:'
        AND substr(event_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    event_type TEXT NOT NULL CHECK (
        (sequence = 1 AND event_type = 'execution.accepted') OR
        (sequence = 2 AND event_type IN (
            'execution.completed', 'execution.failed', 'execution.canceled',
            'execution.unknown_outcome'
        ))
    ),
    receipt_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, sequence),
    FOREIGN KEY (execution_id) REFERENCES tool_executions(execution_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE tool_acks (
    execution_id TEXT NOT NULL,
    through_sequence INTEGER NOT NULL CHECK (through_sequence IN (1, 2)),
    ack_json TEXT NOT NULL CHECK (json_valid(ack_json)),
    ack_fingerprint TEXT NOT NULL CHECK (
        length(ack_fingerprint) = 71
        AND substr(ack_fingerprint, 1, 7) = 'sha256:'
        AND substr(ack_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    acknowledged_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, through_sequence),
    FOREIGN KEY (execution_id, through_sequence)
        REFERENCES tool_events(execution_id, sequence) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX tool_events_accepted_receipt_idx
    ON tool_events (receipt_id) WHERE sequence = 1;
CREATE INDEX tool_executions_unacknowledged_idx
    ON tool_executions (execution_id, acknowledged_through);
