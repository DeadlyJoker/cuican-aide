export function compactionCheckpointSchemaSql(
  postgres: boolean,
  prefix = "",
): string {
  const size = postgres
    ? "octet_length(payload)"
    : "length(CAST(payload AS BLOB))";
  return (
    `CREATE TABLE IF NOT EXISTS ${prefix}context_compaction_checkpoints (
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    context_digest TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 32),
    payload TEXT NOT NULL CHECK (${size} BETWEEN 1 AND 262144),
    payload_digest TEXT NOT NULL,
    PRIMARY KEY (tenant_id, run_id, step_id),
    UNIQUE (tenant_id, run_id),
    FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES ${prefix}run_steps(tenant_id, run_id, step_id) ON DELETE CASCADE
  );` +
    (postgres
      ? `
  CREATE OR REPLACE FUNCTION ${prefix}retire_terminal_compaction_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $checkpoint$
  BEGIN
    IF NEW.state_json->>'status' IN ('completed','failed','canceled') THEN
      DELETE FROM ${prefix}context_compaction_checkpoints WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id;
    END IF;
    RETURN NEW;
  END $checkpoint$;
  DO $checkpoint_trigger$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${prefix}run_snapshots'::regclass AND tgname='retire_terminal_compaction_checkpoint') THEN
    CREATE TRIGGER retire_terminal_compaction_checkpoint AFTER UPDATE OF state_json ON ${prefix}run_snapshots
      FOR EACH ROW WHEN (NEW.state_json->>'status' IN ('completed','failed','canceled')) EXECUTE FUNCTION ${prefix}retire_terminal_compaction_checkpoint();
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $checkpoint_trigger$;`
      : `
  CREATE TRIGGER IF NOT EXISTS retire_terminal_compaction_checkpoint AFTER UPDATE OF state_json ON run_snapshots
  WHEN json_extract(NEW.state_json, '$.status') IN ('completed','failed','canceled')
  BEGIN DELETE FROM context_compaction_checkpoints WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id; END;`)
  );
}
