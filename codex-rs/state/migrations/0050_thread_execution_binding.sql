CREATE UNIQUE INDEX idx_thread_execution_context_binding_exact
    ON thread_execution_context_bindings(thread_id, binding_id, binding_revision);

CREATE TABLE thread_execution_context_execution_binding (
    thread_id TEXT PRIMARY KEY NOT NULL,
    binding_id TEXT NOT NULL,
    binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
    FOREIGN KEY(thread_id, binding_id, binding_revision)
        REFERENCES thread_execution_context_bindings(
            thread_id, binding_id, binding_revision
        ) ON DELETE CASCADE
);
