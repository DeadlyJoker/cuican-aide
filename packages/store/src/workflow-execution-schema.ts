import { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";
import type { PoolClient } from "pg";

const SCHEMA_VERSION = 2;

export function migrateSqliteWorkflowExecutions(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS workflow_execution_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  ) STRICT`);
  const stored = database
    .prepare("SELECT version FROM workflow_execution_schema WHERE singleton=1")
    .get() as { version: number } | undefined;
  if (stored && stored.version > SCHEMA_VERSION)
    throw new RunStoreError(
      "workflow_execution_schema_too_new",
    );
  if (!stored) {
    database.exec(sqliteTables);
    database
      .prepare("INSERT INTO workflow_execution_schema VALUES (1, ?)")
      .run(SCHEMA_VERSION);
  } else if (stored.version === 1) {
    database.exec(
      "ALTER TABLE workflow_execution_receipts ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))",
    );
    database
      .prepare("UPDATE workflow_execution_schema SET version=? WHERE singleton=1")
      .run(SCHEMA_VERSION);
  }
  assertSqliteShape(database);
}

export async function migratePostgresWorkflowExecutions(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.workflow_execution_schema (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version integer NOT NULL
  )`);
  const stored = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.workflow_execution_schema WHERE singleton=true`,
  );
  const version = stored.rows[0]?.version;
  if (version !== undefined && version > SCHEMA_VERSION)
    throw new RunStoreError(
      "workflow_execution_schema_too_new",
    );
  if (version === undefined) {
    await client.query(postgresTables(schema));
    await client.query(
      `INSERT INTO ${schema}.workflow_execution_schema(singleton, version) VALUES (true,$1)`,
      [SCHEMA_VERSION],
    );
  } else if (version === 1) {
    await client.query(
      `ALTER TABLE ${schema}.workflow_execution_receipts ADD COLUMN result_json jsonb`,
    );
    await client.query(
      `UPDATE ${schema}.workflow_execution_schema SET version=$1 WHERE singleton=true`,
      [SCHEMA_VERSION],
    );
  }
  const columns = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema=$1 AND table_name IN ('workflow_executions','workflow_execution_receipts')`,
    [schema],
  );
  const actual = columns.rows
    .map((row) => `${row.table_name}.${row.column_name}`)
    .sort();
  if (actual.join("\n") !== postgresColumns.join("\n"))
    throw new RunStoreError("workflow_execution_schema_corrupt");
}

const sqliteTables = `CREATE TABLE workflow_executions (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
) STRICT;
CREATE TABLE workflow_execution_receipts (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  PRIMARY KEY (tenant_id, run_id, operation_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_executions(tenant_id, run_id)
) STRICT;`;

function assertSqliteShape(database: DatabaseSync): void {
  for (const [table, expected] of Object.entries(sqliteColumns)) {
    const actual = database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as { name: string }).name);
    if (actual.join("\n") !== expected.join("\n"))
      throw new RunStoreError("workflow_execution_schema_corrupt");
  }
}

const sqliteColumns = {
  workflow_executions: [
    "tenant_id",
    "run_id",
    "revision",
    "state_json",
    "result_json",
    "updated_at",
  ],
  workflow_execution_receipts: [
    "tenant_id",
    "run_id",
    "operation_id",
    "fingerprint",
    "state_json",
  ],
} as const;

function postgresTables(schema: string): string {
  return `CREATE TABLE ${schema}.workflow_executions (
    tenant_id text NOT NULL, run_id text NOT NULL, revision bigint NOT NULL,
    state_json jsonb NOT NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, run_id));
  CREATE TABLE ${schema}.workflow_execution_receipts (
    tenant_id text NOT NULL, run_id text NOT NULL, operation_id text NOT NULL,
    fingerprint text NOT NULL, state_json jsonb NOT NULL, result_json jsonb,
    PRIMARY KEY (tenant_id, run_id, operation_id),
    FOREIGN KEY (tenant_id, run_id) REFERENCES ${schema}.workflow_executions(tenant_id,run_id));`;
}

const postgresColumns = [
  "workflow_execution_receipts.fingerprint",
  "workflow_execution_receipts.operation_id",
  "workflow_execution_receipts.result_json",
  "workflow_execution_receipts.run_id",
  "workflow_execution_receipts.state_json",
  "workflow_execution_receipts.tenant_id",
  "workflow_executions.revision",
  "workflow_executions.run_id",
  "workflow_executions.state_json",
  "workflow_executions.tenant_id",
  "workflow_executions.updated_at",
] as const;
