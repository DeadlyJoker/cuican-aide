CREATE TABLE cloud_agent_turns (
    turn_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES thread_execution_contexts(thread_id) ON DELETE CASCADE,
    client_user_message_id TEXT NOT NULL,
    origin_kind TEXT NOT NULL CHECK(origin_kind IN ('durableTask', 'legacyImport')),
    task_id TEXT UNIQUE REFERENCES task_runtime_tasks(task_id),
    import_id TEXT,
    local_actor_id TEXT NOT NULL,
    local_tenant_id TEXT NOT NULL,
    local_space_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL REFERENCES durable_workspace_roots(workspace_key),
    execution_binding_id TEXT NOT NULL,
    execution_binding_revision INTEGER NOT NULL CHECK(execution_binding_revision > 0),
    prompt_artifact_id TEXT NOT NULL,
    prompt_artifact_revision INTEGER NOT NULL CHECK(prompt_artifact_revision > 0),
    status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'suspended', 'finalizing',
        'completed', 'failed', 'cancelled', 'resultUnavailable'
    )),
    last_provider_sequence INTEGER NOT NULL CHECK(last_provider_sequence >= 0),
    primary_output_artifact_id TEXT,
    primary_output_artifact_revision INTEGER
        CHECK(primary_output_artifact_revision IS NULL OR primary_output_artifact_revision > 0),
    error_code TEXT,
    trace_id TEXT,
    revision INTEGER NOT NULL CHECK(revision > 0),
    creation_digest TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
    UNIQUE(thread_id, client_user_message_id),
    CHECK(
        (origin_kind = 'durableTask' AND task_id IS NOT NULL AND import_id IS NULL)
        OR
        (origin_kind = 'legacyImport' AND task_id IS NULL AND import_id IS NOT NULL)
    ),
    CHECK(
        (primary_output_artifact_id IS NULL AND primary_output_artifact_revision IS NULL)
        OR
        (primary_output_artifact_id IS NOT NULL AND primary_output_artifact_revision IS NOT NULL)
    ),
    FOREIGN KEY(thread_id, execution_binding_id, execution_binding_revision)
        REFERENCES thread_execution_context_bindings(
            thread_id, binding_id, binding_revision
        ),
    FOREIGN KEY(prompt_artifact_id, prompt_artifact_revision)
        REFERENCES artifact_manifests(artifact_id, revision),
    FOREIGN KEY(primary_output_artifact_id, primary_output_artifact_revision)
        REFERENCES artifact_manifests(artifact_id, revision)
);

CREATE UNIQUE INDEX idx_cloud_agent_turn_one_active_per_thread
    ON cloud_agent_turns(thread_id)
    WHERE status IN ('queued', 'running', 'suspended', 'finalizing');

CREATE UNIQUE INDEX idx_cloud_agent_turn_import_identity
    ON cloud_agent_turns(thread_id, import_id)
    WHERE import_id IS NOT NULL;

CREATE TABLE cloud_agent_turn_output_artifacts (
    turn_id TEXT NOT NULL REFERENCES cloud_agent_turns(turn_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 32),
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL CHECK(artifact_revision > 0),
    PRIMARY KEY(turn_id, ordinal),
    UNIQUE(turn_id, artifact_id, artifact_revision),
    FOREIGN KEY(artifact_id, artifact_revision)
        REFERENCES artifact_manifests(artifact_id, revision)
);

CREATE TABLE cloud_agent_thread_summaries (
    thread_id TEXT PRIMARY KEY NOT NULL
        REFERENCES thread_execution_contexts(thread_id) ON DELETE CASCADE,
    last_turn_id TEXT NOT NULL REFERENCES cloud_agent_turns(turn_id),
    preview TEXT CHECK(preview IS NULL OR length(CAST(preview AS BLOB)) <= 1024),
    projection_revision INTEGER NOT NULL CHECK(projection_revision > 0),
    metadata_sync_revision INTEGER NOT NULL CHECK(metadata_sync_revision >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
);
