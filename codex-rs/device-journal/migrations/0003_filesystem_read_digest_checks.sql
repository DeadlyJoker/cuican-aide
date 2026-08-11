UPDATE device_journal_schema SET version = 3 WHERE singleton = 1 AND version = 2;

DROP INDEX filesystem_read_events_accepted_receipt_idx;
DROP INDEX filesystem_read_executions_unacknowledged_idx;

ALTER TABLE filesystem_read_acks RENAME TO filesystem_read_acks_old;
ALTER TABLE filesystem_read_events RENAME TO filesystem_read_events_old;
ALTER TABLE filesystem_read_executions RENAME TO filesystem_read_executions_old;

CREATE TABLE filesystem_read_executions (
    execution_id TEXT PRIMARY KEY NOT NULL,
    command_fingerprint TEXT NOT NULL CHECK (length(command_fingerprint) = 71 AND substr(command_fingerprint, 1, 7) = 'sha256:' AND substr(command_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
    command_json TEXT NOT NULL CHECK (json_valid(command_json)), device_id TEXT NOT NULL,
    lease_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
    workspace_binding_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
    command_digest TEXT NOT NULL CHECK (length(command_digest) = 71 AND substr(command_digest, 1, 7) = 'sha256:' AND substr(command_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    acknowledged_through INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_through BETWEEN 0 AND 2),
    created_at TEXT NOT NULL
) STRICT;
INSERT INTO filesystem_read_executions SELECT * FROM filesystem_read_executions_old;

CREATE TABLE filesystem_read_events (
    execution_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence IN (1, 2)),
    event_type TEXT NOT NULL CHECK ((sequence = 1 AND event_type = 'workspace_read.accepted') OR (sequence = 2 AND event_type IN ('workspace_read.completed', 'workspace_read.failed', 'workspace_read.canceled', 'workspace_read.unknown_outcome'))),
    event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 71 AND substr(event_fingerprint, 1, 7) = 'sha256:' AND substr(event_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)), receipt_id TEXT NOT NULL,
    connection_epoch INTEGER NOT NULL CHECK (connection_epoch >= 1), observed_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, sequence),
    FOREIGN KEY (execution_id) REFERENCES filesystem_read_executions(execution_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO filesystem_read_events SELECT * FROM filesystem_read_events_old;

CREATE TABLE filesystem_read_acks (
    execution_id TEXT NOT NULL, through_sequence INTEGER NOT NULL CHECK (through_sequence IN (1, 2)),
    ack_fingerprint TEXT NOT NULL CHECK (length(ack_fingerprint) = 71 AND substr(ack_fingerprint, 1, 7) = 'sha256:' AND substr(ack_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'),
    ack_json TEXT NOT NULL CHECK (json_valid(ack_json)), acknowledged_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, through_sequence),
    FOREIGN KEY (execution_id, through_sequence) REFERENCES filesystem_read_events(execution_id, sequence) ON DELETE RESTRICT
) STRICT;
INSERT INTO filesystem_read_acks SELECT * FROM filesystem_read_acks_old;

DROP TABLE filesystem_read_acks_old;
DROP TABLE filesystem_read_events_old;
DROP TABLE filesystem_read_executions_old;

CREATE UNIQUE INDEX filesystem_read_events_accepted_receipt_idx ON filesystem_read_events (receipt_id) WHERE sequence = 1;
CREATE INDEX filesystem_read_executions_unacknowledged_idx ON filesystem_read_executions (execution_id, acknowledged_through);
