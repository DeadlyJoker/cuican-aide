CREATE TABLE provider_run_supervision (
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    worker_run_id TEXT NOT NULL,
    poll_attempts INTEGER NOT NULL DEFAULT 0 CHECK(poll_attempts >= 0),
    available_at INTEGER NOT NULL CHECK(available_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(task_id, attempt_id, worker_run_id),
    FOREIGN KEY(task_id, attempt_id, worker_run_id)
        REFERENCES provider_run_journal(task_id, attempt_id, worker_run_id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_run_supervision_due
    ON provider_run_supervision(available_at, task_id, attempt_id, worker_run_id);

INSERT INTO provider_run_supervision (
    task_id, attempt_id, worker_run_id, poll_attempts, available_at, updated_at
)
SELECT task_id, attempt_id, worker_run_id, 0, updated_at, updated_at
FROM provider_run_journal;
