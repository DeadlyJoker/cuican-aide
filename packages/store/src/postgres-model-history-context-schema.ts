/** Rebuildable metadata. Migrations do not read or copy canonical history bodies. */
export function postgresModelHistoryContextSchemaSql(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.model_history_context_state (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      algorithm_version integer NOT NULL CHECK (algorithm_version=1),
      through_sequence bigint NOT NULL CHECK (through_sequence BETWEEN 0 AND 9007199254740991),
      fingerprint text NOT NULL,
      last_item_digest text,
      latest_rollback_sequence bigint,
      latest_rollback_digest text,
      PRIMARY KEY (tenant_id, thread_id),
      FOREIGN KEY (tenant_id, thread_id) REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ${schema}.model_history_context_refs (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      sequence bigint NOT NULL,
      item_id text NOT NULL,
      item_type text NOT NULL,
      boundary_kind text NOT NULL CHECK (boundary_kind IN ('instruction', 'contextual', 'other')),
      item_digest text NOT NULL,
      PRIMARY KEY (tenant_id, thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id) REFERENCES ${schema}.model_history_context_state(tenant_id, thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS model_history_context_compactions
      ON ${schema}.model_history_context_refs(tenant_id, thread_id, sequence) WHERE item_type='compaction';
    CREATE INDEX IF NOT EXISTS model_history_context_content
      ON ${schema}.model_history_context_refs(tenant_id, thread_id, sequence) WHERE item_type<>'compaction';
    CREATE INDEX IF NOT EXISTS model_history_context_instructions
      ON ${schema}.model_history_context_refs(tenant_id, thread_id, sequence) WHERE boundary_kind='instruction';

    CREATE OR REPLACE FUNCTION ${schema}.invalidate_model_history_context() RETURNS trigger
    LANGUAGE plpgsql AS $context_invalidation$
    BEGIN
      DELETE FROM ${schema}.model_history_context_state WHERE tenant_id=OLD.tenant_id AND thread_id=OLD.thread_id;
      IF TG_OP='UPDATE' AND (NEW.tenant_id, NEW.thread_id) IS DISTINCT FROM (OLD.tenant_id, OLD.thread_id) THEN
        DELETE FROM ${schema}.model_history_context_state WHERE tenant_id=NEW.tenant_id AND thread_id=NEW.thread_id;
      END IF;
      RETURN NULL;
    END
    $context_invalidation$;
    DO $context_trigger$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid='${schema}.model_history_items'::regclass AND tgname='model_history_context_invalidate') THEN
        CREATE TRIGGER model_history_context_invalidate AFTER UPDATE OR DELETE ON ${schema}.model_history_items
          FOR EACH ROW EXECUTE FUNCTION ${schema}.invalidate_model_history_context();
      END IF;
    END
    $context_trigger$;
    UPDATE ${schema}.schema_migrations SET version=6 WHERE component='thread_authority' AND version=5;
  `;
}
