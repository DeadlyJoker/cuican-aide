CREATE TABLE cloud_agent_turn_finalizations (
    turn_id TEXT PRIMARY KEY NOT NULL
        REFERENCES cloud_agent_turns(turn_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL UNIQUE
        REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    worker_run_id TEXT NOT NULL,
    provider_run_id TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    provider_event_sequence INTEGER NOT NULL CHECK(provider_event_sequence > 0),
    provider_event_payload_digest TEXT NOT NULL CHECK(
        length(provider_event_payload_digest) = 71
        AND substr(provider_event_payload_digest, 1, 7) = 'sha256:'
    ),
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'completed', 'resultUnavailable'
    )),
    attempts INTEGER NOT NULL CHECK(attempts >= 0 AND attempts <= 16),
    available_at INTEGER NOT NULL CHECK(available_at >= 0),
    last_error_code TEXT,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
    UNIQUE(task_id, attempt_id, worker_run_id, provider_event_sequence),
    FOREIGN KEY(task_id, attempt_id, worker_run_id)
        REFERENCES provider_run_journal(task_id, attempt_id, worker_run_id),
    CHECK(
        (status = 'pending' AND completed_at IS NULL)
        OR
        (status != 'pending' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX idx_cloud_agent_turn_finalization_recovery
    ON cloud_agent_turn_finalizations(status, available_at, turn_id);
