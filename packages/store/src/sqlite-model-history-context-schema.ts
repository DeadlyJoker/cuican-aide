/** Derived references only. Canonical history bodies are never copied or rewritten. */
export function sqliteModelHistoryContextSchemaSql(): string {
  return `
  CREATE TABLE IF NOT EXISTS model_history_context_state (
    tenant_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    algorithm_version INTEGER NOT NULL CHECK (algorithm_version=1),
    through_sequence INTEGER NOT NULL CHECK (through_sequence>=0),
    fingerprint TEXT NOT NULL,
    last_item_digest TEXT,
    latest_rollback_sequence INTEGER,
    latest_rollback_digest TEXT,
    PRIMARY KEY (tenant_id, thread_id),
    FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS model_history_context_refs (
    tenant_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('instruction', 'contextual', 'other')),
    item_digest TEXT NOT NULL,
    PRIMARY KEY (tenant_id, thread_id, sequence),
    FOREIGN KEY (tenant_id, thread_id) REFERENCES model_history_context_state(tenant_id, thread_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS model_history_context_compactions
    ON model_history_context_refs(tenant_id, thread_id, sequence) WHERE item_type='compaction';
  CREATE INDEX IF NOT EXISTS model_history_context_content
    ON model_history_context_refs(tenant_id, thread_id, sequence) WHERE item_type<>'compaction';
  CREATE INDEX IF NOT EXISTS model_history_context_instructions
    ON model_history_context_refs(tenant_id, thread_id, sequence) WHERE boundary_kind='instruction';
  CREATE TRIGGER IF NOT EXISTS model_history_context_invalidate_update
    AFTER UPDATE ON model_history_items BEGIN
      DELETE FROM model_history_context_state
      WHERE (tenant_id=OLD.tenant_id AND thread_id=OLD.thread_id)
         OR (tenant_id=NEW.tenant_id AND thread_id=NEW.thread_id);
    END;
  CREATE TRIGGER IF NOT EXISTS model_history_context_invalidate_delete
    AFTER DELETE ON model_history_items BEGIN
      DELETE FROM model_history_context_state WHERE tenant_id=OLD.tenant_id AND thread_id=OLD.thread_id;
    END;
  `;
}
