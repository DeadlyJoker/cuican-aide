import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";

const OBJECTS = {
  workflow_human_gate_schema: `CREATE TABLE workflow_human_gate_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL) STRICT;`,
  workflow_human_gates: `CREATE TABLE workflow_human_gates (
    tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,node_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,
    authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
    decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
    wake_work_item_id TEXT UNIQUE,wake_json TEXT CHECK(wake_json IS NULL OR json_valid(wake_json)),
    PRIMARY KEY(tenant_id,run_id,node_id),
    FOREIGN KEY(tenant_id,run_id,node_id) REFERENCES workflow_node_admissions(tenant_id,run_id,node_id)
  ) STRICT;`,
} as const;

export function migrateSqliteWorkflowHumanGates(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const count = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('workflow_human_gate_schema','workflow_human_gates')",
      )
      .get()!.n;
    if (count === 0) {
      for (const sql of Object.values(OBJECTS)) db.exec(sql);
      db.exec("INSERT INTO workflow_human_gate_schema VALUES(1,1)");
    }
    assertSqliteWorkflowHumanGateSchema(db);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}
export function assertSqliteWorkflowHumanGateSchema(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('workflow_human_gate_schema','workflow_human_gates')",
    )
    .all();
  if (rows.length !== 2)
    throw new RunStoreError("workflow_gate_schema_corrupt");
  for (const [name, sql] of Object.entries(OBJECTS))
    if (
      normalize(String(rows.find((row) => row.name === name)?.sql)) !==
      normalize(sql)
    )
      throw new RunStoreError("workflow_gate_schema_corrupt");
  const versions = db
    .prepare("SELECT singleton,version FROM workflow_human_gate_schema LIMIT 2")
    .all();
  if (
    versions.length !== 1 ||
    versions[0]!.singleton !== 1 ||
    versions[0]!.version !== 1
  )
    throw new RunStoreError("workflow_gate_schema_unsupported");
}
function normalize(sql: string) {
  return sql.trim().replace(/;$/u, "");
}
