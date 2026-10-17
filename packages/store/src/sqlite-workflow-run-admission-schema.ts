import type { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";

/** Explicit authority migration; ordinary Store construction and query reads never call it. */
export function migrateSqliteWorkflowRunAdmission(
  database: DatabaseSync,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflow_run_admission_schema','workflow_run_inputs','workflow_run_admissions') ORDER BY name",
      )
      .all();
    if (tables.length !== 0 && tables.length !== 3)
      throw new RunStoreError("workflow_run_admission_schema_corrupt");
    if (tables.length === 0) {
      for (const sql of Object.values(TABLES)) database.exec(sql);
      database.exec("INSERT INTO workflow_run_admission_schema VALUES (1,1)");
    }
    assertSqliteWorkflowRunAdmissionSchema(database);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function assertSqliteWorkflowRunAdmissionSchema(
  database: DatabaseSync,
): void {
  const version = database
    .prepare(
      "SELECT singleton,version FROM workflow_run_admission_schema LIMIT 2",
    )
    .all() as { singleton: number; version: number }[];
  if (version.length !== 1 || version[0]!.singleton !== 1)
    throw new RunStoreError("workflow_run_admission_schema_corrupt");
  if (version[0]!.version !== 1)
    throw new RunStoreError("workflow_run_admission_schema_unsupported");
  for (const [table, columns] of Object.entries({
    workflow_run_inputs: "tenant_id,run_id,value_id,value_digest,value_json",
    workflow_run_admissions:
      "scope,idempotency_key,tenant_id,run_id,authority_json",
  })) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (actual.map((column) => column.name).join(",") !== columns)
      throw new RunStoreError("workflow_run_admission_schema_corrupt");
  }
  // This is the first version of this authority: validate the complete constraints,
  // including uniqueness/FKs/STRICT, rather than trusting matching column names.
  for (const [table, expected] of Object.entries(TABLES)) {
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql: string } | undefined;
    if (!row || normalizeDdl(row.sql) !== normalizeDdl(expected))
      throw new RunStoreError("workflow_run_admission_schema_corrupt");
  }
}

const TABLES = {
  workflow_run_admission_schema: `CREATE TABLE workflow_run_admission_schema (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL
        ) STRICT;`,
  workflow_run_inputs: `CREATE TABLE workflow_run_inputs (
          tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, value_id TEXT NOT NULL,
          value_digest TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
          PRIMARY KEY(tenant_id,run_id), UNIQUE(tenant_id,value_id),
          FOREIGN KEY(tenant_id,run_id) REFERENCES run_snapshots(tenant_id,run_id)
        ) STRICT;`,
  workflow_run_admissions: `CREATE TABLE workflow_run_admissions (
          scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
          authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
          PRIMARY KEY(scope,idempotency_key), UNIQUE(tenant_id,run_id),
          FOREIGN KEY(scope,idempotency_key) REFERENCES idempotency_receipts(scope,idempotency_key),
          FOREIGN KEY(tenant_id,run_id) REFERENCES run_snapshots(tenant_id,run_id)
        ) STRICT;`,
} as const;

function normalizeDdl(sql: string): string {
  return sql.replaceAll(/\s+/gu, "").replaceAll(";", "").toLowerCase();
}
