import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";
import { migrateSqliteWorkflowExecutions } from "./workflow-execution-schema.ts";

export function migrateSqliteWorkflowComposition(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    migrateSqliteWorkflowExecutions(database);
    const present = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflow_composition_schema','workflow_node_admissions','workflow_node_passes')",
      )
      .all();
    if (present.length !== 0 && present.length !== 3)
      throw new RunStoreError("workflow_composition_schema_corrupt");
    if (present.length === 0) {
      for (const sql of Object.values(TABLES)) database.exec(sql);
      database.exec("INSERT INTO workflow_composition_schema VALUES(1,1)");
    }
    assertSqliteWorkflowCompositionSchema(database);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function assertSqliteWorkflowCompositionSchema(
  database: DatabaseSync,
): void {
  const versions = database
    .prepare(
      "SELECT singleton,version FROM workflow_composition_schema LIMIT 2",
    )
    .all();
  if (
    versions.length !== 1 ||
    versions[0]!.singleton !== 1 ||
    versions[0]!.version !== 1
  )
    throw new RunStoreError("workflow_composition_schema_unsupported");
  for (const [name, sql] of Object.entries(TABLES)) {
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'")
      .get(name);
    if (!row || normalize(String(row.sql)) !== normalize(sql))
      throw new RunStoreError("workflow_composition_schema_corrupt");
  }
}

const TABLES = {
  workflow_composition_schema: `CREATE TABLE workflow_composition_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL) STRICT;`,
  workflow_node_admissions: `CREATE TABLE workflow_node_admissions (
    tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,node_id TEXT NOT NULL,claim_id TEXT NOT NULL UNIQUE,
    step_id TEXT NOT NULL,attempt_id TEXT,work_item_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL CHECK(lease_epoch>=1),
    operation_id TEXT NOT NULL,input_digest TEXT NOT NULL,input_json TEXT NOT NULL CHECK(json_valid(input_json)),
    output_digest TEXT,output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),settlement_fingerprint TEXT,
    PRIMARY KEY(tenant_id,run_id,node_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_executions(tenant_id,run_id),
    FOREIGN KEY(tenant_id,run_id,step_id) REFERENCES run_steps(tenant_id,run_id,step_id),
    FOREIGN KEY(tenant_id,run_id,step_id,attempt_id) REFERENCES run_attempts(tenant_id,run_id,step_id,attempt_id),
    FOREIGN KEY(work_item_id) REFERENCES work_items(work_item_id)
  ) STRICT;`,
  workflow_node_passes: `CREATE TABLE workflow_node_passes (
    tenant_id TEXT NOT NULL,run_id TEXT NOT NULL,operation_id TEXT NOT NULL,work_item_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,node_ids_json TEXT NOT NULL CHECK(json_valid(node_ids_json)),
    PRIMARY KEY(tenant_id,run_id,operation_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES workflow_executions(tenant_id,run_id),
    FOREIGN KEY(work_item_id) REFERENCES work_items(work_item_id)
  ) STRICT;`,
} as const;

function normalize(sql: string) {
  return sql.replaceAll(/\s+/gu, "").replaceAll(";", "").toLowerCase();
}
