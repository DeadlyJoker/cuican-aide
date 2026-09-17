export function runExecutionProgressSchemaSql(
  postgres: boolean,
  prefix = "",
): string {
  const length = postgres
    ? "octet_length(payload)"
    : "length(CAST(payload AS BLOB))";
  const table = `CREATE TABLE IF NOT EXISTS ${prefix}run_execution_progress (
    tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, through_sequence ${postgres ? "bigint" : "INTEGER"} NOT NULL CHECK (through_sequence BETWEEN 1 AND 9007199254740991),
    source_event_id TEXT NOT NULL, payload TEXT NOT NULL CHECK (${length} BETWEEN 1 AND 262144), payload_digest TEXT NOT NULL,
    PRIMARY KEY (tenant_id,run_id), FOREIGN KEY (tenant_id,run_id) REFERENCES ${prefix}run_snapshots(tenant_id,run_id) ON DELETE CASCADE
  )${postgres ? "" : " STRICT"};`;
  if (postgres)
    return (
      table +
      `
    CREATE OR REPLACE FUNCTION ${prefix}retire_terminal_run_execution_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state_json->>'status' IN ('completed','failed','canceled') THEN
        DELETE FROM ${prefix}run_execution_progress WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id;
      END IF; RETURN NEW; END $$;
    DROP TRIGGER IF EXISTS retire_terminal_run_execution_progress ON ${prefix}run_snapshots;
    CREATE TRIGGER retire_terminal_run_execution_progress AFTER UPDATE OF state_json ON ${prefix}run_snapshots FOR EACH ROW EXECUTE FUNCTION ${prefix}retire_terminal_run_execution_progress();`
    );
  return (
    table +
    `CREATE TRIGGER IF NOT EXISTS retire_terminal_run_execution_progress AFTER UPDATE OF state_json ON run_snapshots
    WHEN json_extract(NEW.state_json,'$.status') IN ('completed','failed','canceled')
    BEGIN DELETE FROM run_execution_progress WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id; END;`
  );
}
