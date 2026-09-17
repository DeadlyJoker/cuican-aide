import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";

const TABLE = `CREATE TABLE workflow_node_children (
  tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,node_id TEXT NOT NULL,claim_id TEXT NOT NULL UNIQUE,
  child_thread_id TEXT NOT NULL UNIQUE,child_run_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,
  wake_work_item_id TEXT NOT NULL UNIQUE,wake_json TEXT NOT NULL CHECK(json_valid(wake_json)),
  PRIMARY KEY(tenant_id,run_id,node_id),
  FOREIGN KEY(tenant_id,run_id,node_id) REFERENCES workflow_node_admissions(tenant_id,run_id,node_id),
  FOREIGN KEY(tenant_id,child_thread_id) REFERENCES threads(tenant_id,thread_id),
  FOREIGN KEY(tenant_id,child_run_id) REFERENCES run_snapshots(tenant_id,run_id)
) STRICT;`;
const VERSION =
  "CREATE TABLE workflow_child_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL) STRICT;";
// Installed once in SQLite so every connection, including an already-open Worker,
// commits the wake with the child's canonical terminal snapshot.
const TRIGGER = `CREATE TRIGGER workflow_child_terminal_wake AFTER UPDATE OF state_json ON run_snapshots
WHEN json_extract(NEW.state_json,'$.status') IN ('completed','failed','canceled')
  AND json_extract(OLD.state_json,'$.status') NOT IN ('completed','failed','canceled')
BEGIN
  INSERT INTO work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at_ms)
    SELECT c.wake_work_item_id,c.tenant_id,c.run_id,'run.execute',c.wake_json,json_extract(c.wake_json,'$.createdAt'),0
    FROM workflow_node_children c WHERE c.tenant_id=NEW.tenant_id AND c.child_run_id=NEW.run_id;
END;`;

export function migrateSqliteWorkflowChildren(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const present = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('workflow_node_children','workflow_child_schema','workflow_child_terminal_wake')",
      )
      .all();
    if (present.length === 0) {
      db.exec(TABLE);
      db.exec(VERSION);
      db.exec(TRIGGER);
      db.exec("INSERT INTO workflow_child_schema VALUES(1,1)");
    } else if (present.length !== 3)
      throw new RunStoreError("workflow_child_schema_corrupt");
    assertSqliteWorkflowChildSchema(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function assertSqliteWorkflowChildSchema(db: DatabaseSync): boolean {
  const rows = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('workflow_node_children','workflow_child_schema','workflow_child_terminal_wake')",
    )
    .all();
  if (rows.length === 0) return false;
  if (rows.length !== 3)
    throw new RunStoreError("workflow_child_schema_corrupt");
  for (const [name, sql] of [
    ["workflow_node_children", TABLE],
    ["workflow_child_schema", VERSION],
    ["workflow_child_terminal_wake", TRIGGER],
  ]) {
    const row = rows.find((value) => value.name === name);
    if (!row || normalize(String(row.sql)) !== normalize(sql!))
      throw new RunStoreError("workflow_child_schema_corrupt");
  }
  const versions = db
    .prepare("SELECT singleton,version FROM workflow_child_schema LIMIT 2")
    .all();
  if (
    versions.length !== 1 ||
    versions[0]!.singleton !== 1 ||
    versions[0]!.version !== 1
  )
    throw new RunStoreError("workflow_child_schema_unsupported");
  return true;
}
function normalize(sql: string) {
  return sql.trim().replace(/;$/u, "");
}
