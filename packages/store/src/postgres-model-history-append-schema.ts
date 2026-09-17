/** Rebuildable pairing metadata; canonical history remains append-only. */
export function postgresModelHistoryAppendSchemaSql(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.model_history_append_state (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
      pending_tool_call_count bigint NOT NULL CHECK (pending_tool_call_count BETWEEN 0 AND 9007199254740991),
      PRIMARY KEY (tenant_id, thread_id),
      FOREIGN KEY (tenant_id, thread_id) REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS model_history_non_tool_sequence_idx
      ON ${schema}.model_history_items(tenant_id, thread_id, sequence)
      WHERE item_type NOT IN ('tool_call', 'tool_result');

    CREATE OR REPLACE FUNCTION ${schema}.advance_model_history_append_state() RETURNS trigger
    LANGUAGE plpgsql AS $history_append$
    BEGIN
      UPDATE ${schema}.model_history_append_state AS state SET
        last_sequence = inserted.last_sequence,
        pending_tool_call_count = state.pending_tool_call_count + inserted.pending_delta
      FROM (
        SELECT tenant_id, thread_id, min(sequence) AS first_sequence, max(sequence) AS last_sequence,
          count(*) AS item_count, sum(CASE item_type WHEN 'tool_call' THEN 1 WHEN 'tool_result' THEN -1 ELSE 0 END) AS pending_delta
        FROM inserted_history GROUP BY tenant_id, thread_id
      ) AS inserted
      WHERE state.tenant_id=inserted.tenant_id AND state.thread_id=inserted.thread_id
        AND state.last_sequence=inserted.first_sequence-1
        AND inserted.last_sequence-inserted.first_sequence+1=inserted.item_count;
      RETURN NULL;
    END
    $history_append$;
    CREATE OR REPLACE FUNCTION ${schema}.invalidate_model_history_append_state() RETURNS trigger
    LANGUAGE plpgsql AS $history_invalidate$
    BEGIN
      DELETE FROM ${schema}.model_history_append_state AS state USING changed_history AS previous_history
        WHERE state.tenant_id=previous_history.tenant_id AND state.thread_id=previous_history.thread_id;
      IF TG_OP='UPDATE' THEN
        DELETE FROM ${schema}.model_history_append_state AS state USING replacement_history AS updated
          WHERE state.tenant_id=updated.tenant_id AND state.thread_id=updated.thread_id;
      END IF;
      RETURN NULL;
    END
    $history_invalidate$;
    DO $history_triggers$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${schema}.model_history_items'::regclass AND tgname='model_history_append_state_insert') THEN
        CREATE TRIGGER model_history_append_state_insert AFTER INSERT ON ${schema}.model_history_items
          REFERENCING NEW TABLE AS inserted_history FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.advance_model_history_append_state();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${schema}.model_history_items'::regclass AND tgname='model_history_append_state_delete') THEN
        CREATE TRIGGER model_history_append_state_delete AFTER DELETE ON ${schema}.model_history_items
          REFERENCING OLD TABLE AS changed_history FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.invalidate_model_history_append_state();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${schema}.model_history_items'::regclass AND tgname='model_history_append_state_update') THEN
        CREATE TRIGGER model_history_append_state_update AFTER UPDATE ON ${schema}.model_history_items
          REFERENCING OLD TABLE AS changed_history NEW TABLE AS replacement_history FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.invalidate_model_history_append_state();
      END IF;
    END $history_triggers$;
  `;
}
