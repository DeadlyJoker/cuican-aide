export function sqliteModelHistoryAppendSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS model_history_append_state (
      tenant_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      pending_tool_call_count INTEGER NOT NULL CHECK (pending_tool_call_count >= 0),
      PRIMARY KEY (tenant_id, thread_id),
      FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, thread_id) ON DELETE CASCADE
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS model_history_tool_call_identity_idx
      ON model_history_items(tenant_id, thread_id, run_id, json_extract(item_json, '$.callId'))
      WHERE item_type='tool_call';
    CREATE UNIQUE INDEX IF NOT EXISTS model_history_tool_result_identity_idx
      ON model_history_items(tenant_id, thread_id, run_id, json_extract(item_json, '$.callId'))
      WHERE item_type='tool_result';
    CREATE INDEX IF NOT EXISTS model_history_non_tool_sequence_idx
      ON model_history_items(tenant_id, thread_id, sequence)
      WHERE item_type NOT IN ('tool_call', 'tool_result');
    CREATE TRIGGER IF NOT EXISTS model_history_append_state_insert
    AFTER INSERT ON model_history_items
    BEGIN
      UPDATE model_history_append_state SET
        last_sequence=NEW.sequence,
        pending_tool_call_count=pending_tool_call_count +
          CASE NEW.item_type WHEN 'tool_call' THEN 1 WHEN 'tool_result' THEN -1 ELSE 0 END
      WHERE tenant_id=NEW.tenant_id AND thread_id=NEW.thread_id AND last_sequence=NEW.sequence-1;
    END;
    CREATE TRIGGER IF NOT EXISTS model_history_append_state_delete
    AFTER DELETE ON model_history_items
    BEGIN
      DELETE FROM model_history_append_state WHERE tenant_id=OLD.tenant_id AND thread_id=OLD.thread_id;
    END;
    CREATE TRIGGER IF NOT EXISTS model_history_append_state_update
    AFTER UPDATE ON model_history_items
    BEGIN
      DELETE FROM model_history_append_state WHERE
        (tenant_id=OLD.tenant_id AND thread_id=OLD.thread_id) OR
        (tenant_id=NEW.tenant_id AND thread_id=NEW.thread_id);
    END;
  `;
}
