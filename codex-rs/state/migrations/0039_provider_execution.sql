CREATE TABLE cloud_execution_specs (
    execution_spec_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    digest TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    workspace_key TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK(resource_kind = 'agent'),
    resource_id TEXT NOT NULL,
    resource_revision TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    credential_revision INTEGER NOT NULL CHECK(credential_revision > 0),
    prompt_artifact_id TEXT NOT NULL,
    prompt_artifact_revision INTEGER NOT NULL CHECK(prompt_artifact_revision > 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(execution_spec_id, revision),
    FOREIGN KEY(prompt_artifact_id, prompt_artifact_revision)
        REFERENCES artifact_manifests(artifact_id, revision)
);

CREATE TABLE cloud_execution_spec_context_artifacts (
    execution_spec_id TEXT NOT NULL,
    execution_spec_revision INTEGER NOT NULL CHECK(execution_spec_revision > 0),
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 32),
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL CHECK(artifact_revision > 0),
    PRIMARY KEY(execution_spec_id, execution_spec_revision, ordinal),
    UNIQUE(execution_spec_id, execution_spec_revision, artifact_id, artifact_revision),
    FOREIGN KEY(execution_spec_id, execution_spec_revision)
        REFERENCES cloud_execution_specs(execution_spec_id, revision) ON DELETE CASCADE,
    FOREIGN KEY(artifact_id, artifact_revision)
        REFERENCES artifact_manifests(artifact_id, revision)
);

CREATE TABLE provider_run_journal (
    task_id TEXT NOT NULL REFERENCES task_runtime_tasks(task_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    worker_run_id TEXT NOT NULL,
    journal_version INTEGER NOT NULL CHECK(journal_version >= 0),
    execution_spec_id TEXT NOT NULL,
    execution_spec_revision INTEGER NOT NULL CHECK(execution_spec_revision > 0),
    execution_spec_digest TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    resource_revision TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    credential_revision INTEGER NOT NULL CHECK(credential_revision > 0),
    provider_run_id TEXT NOT NULL,
    provider_attempt_id TEXT NOT NULL,
    provider_revision INTEGER CHECK(provider_revision IS NULL OR provider_revision > 0),
    last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
    last_cursor TEXT,
    status TEXT NOT NULL CHECK(status IN (
        'starting', 'running', 'suspended', 'reconciling', 'completed', 'failed', 'cancelled'
    )),
    start_command_id TEXT NOT NULL,
    start_idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    PRIMARY KEY(task_id, attempt_id, worker_run_id),
    UNIQUE(task_id, attempt_id),
    UNIQUE(provider_id, provider_run_id),
    FOREIGN KEY(execution_spec_id, execution_spec_revision)
        REFERENCES cloud_execution_specs(execution_spec_id, revision),
    CHECK(
        (last_sequence = 0 AND last_cursor IS NULL AND status = 'starting')
        OR
        (last_sequence > 0 AND last_cursor IS NOT NULL AND status != 'starting')
    )
);

CREATE TABLE provider_run_journal_events (
    provider_id TEXT NOT NULL,
    provider_run_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    cursor TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(provider_id, provider_run_id, event_id),
    UNIQUE(provider_id, provider_run_id, sequence),
    UNIQUE(provider_id, provider_run_id, cursor),
    FOREIGN KEY(provider_id, provider_run_id)
        REFERENCES provider_run_journal(provider_id, provider_run_id) ON DELETE CASCADE
);
