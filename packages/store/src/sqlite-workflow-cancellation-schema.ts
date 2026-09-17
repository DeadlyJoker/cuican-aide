import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";
import { migrateSqliteWorkflowRunAdmission } from "./sqlite-workflow-run-admission-schema.ts";

const TABLE = `CREATE TABLE workflow_cancellation_wakes (
  tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,work_item_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE,request_sequence INTEGER NOT NULL CHECK(request_sequence>=1),created_at TEXT NOT NULL,
  children_signaled INTEGER NOT NULL DEFAULT 0 CHECK(children_signaled IN (0,1)),
  PRIMARY KEY(tenant_id,run_id),
  FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_run_inputs(tenant_id,run_id)
) STRICT;`;
const VERSION =
  "CREATE TABLE workflow_cancellation_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL) STRICT;";
// A durable one-shot wake, including writers opened before the experimental scheduler.
// Store random identities first so all JSON references use the same generated values.
const TRIGGER = `CREATE TRIGGER workflow_root_cancellation_wake AFTER UPDATE OF state_json ON run_snapshots
WHEN json_extract(NEW.state_json,'$.cancelRequested')=1
  AND json_extract(OLD.state_json,'$.cancelRequested')=0
  AND json_extract(NEW.state_json,'$.purpose')='workflow'
  AND EXISTS(SELECT 1 FROM workflow_run_admissions WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id)
BEGIN
  INSERT INTO workflow_cancellation_wakes(tenant_id,run_id,work_item_id,operation_id,request_sequence,created_at)
    VALUES(NEW.tenant_id,NEW.run_id,'workflow-cancel-'||lower(hex(randomblob(16))),lower(hex(randomblob(16))),json_extract(NEW.state_json,'$.lastSequence'),json_extract(NEW.state_json,'$.updatedAt'));
  INSERT INTO work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at_ms)
    SELECT w.work_item_id,w.tenant_id,w.run_id,'run.execute',
      json_object('workItemId',w.work_item_id,'tenantId',w.tenant_id,'runId',w.run_id,'kind','run.execute',
        'payload',json_object('schemaVersion','crewon.workflow-scheduler-work-item.v1','trigger','workflowScheduler',
          'binding',json_extract(NEW.state_json,'$.workflowVersionBinding'),'schedulerOperationId',w.operation_id,
          'workflowInput',json_object('valueId',v.value_id,'valueDigest',v.value_digest)),
        'createdAt',w.created_at),w.created_at,0
    FROM workflow_cancellation_wakes w JOIN workflow_run_inputs v USING(tenant_id,run_id)
    WHERE w.tenant_id=NEW.tenant_id AND w.run_id=NEW.run_id;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'workflow cancellation wake missing') END;
END;`;
const OBJECTS = {
  workflow_cancellation_wakes: TABLE,
  workflow_cancellation_schema: VERSION,
  workflow_root_cancellation_wake: TRIGGER,
};

export function migrateSqliteWorkflowCancellation(db: DatabaseSync): void {
  migrateSqliteWorkflowRunAdmission(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = schemaRows(db);
    if (rows.length === 0) {
      for (const sql of Object.values(OBJECTS)) db.exec(sql);
      db.exec("INSERT INTO workflow_cancellation_schema VALUES(1,1)");
    }
    assertSqliteWorkflowCancellationSchema(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
export function assertSqliteWorkflowCancellationSchema(db: DatabaseSync): void {
  const rows = schemaRows(db);
  if (rows.length !== 3)
    throw new RunStoreError("workflow_cancellation_schema_corrupt");
  for (const [name, sql] of Object.entries(OBJECTS)) {
    const row = rows.find((row) => row.name === name);
    if (!row || normalize(String(row.sql)) !== normalize(sql))
      throw new RunStoreError("workflow_cancellation_schema_corrupt");
  }
  const versions = db
    .prepare(
      "SELECT singleton,version FROM workflow_cancellation_schema LIMIT 2",
    )
    .all();
  if (
    versions.length !== 1 ||
    versions[0]!.singleton !== 1 ||
    versions[0]!.version !== 1
  )
    throw new RunStoreError("workflow_cancellation_schema_unsupported");
}
function schemaRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('workflow_cancellation_wakes','workflow_cancellation_schema','workflow_root_cancellation_wake')",
    )
    .all();
}
function normalize(sql: string) {
  return sql.trim().replace(/;$/u, "");
}
