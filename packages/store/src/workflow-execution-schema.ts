import { DatabaseSync } from "node:sqlite";
import { RunStoreError } from "@crewon/application";
import type { PoolClient } from "pg";

const SCHEMA_VERSION = 5;

export function migrateSqliteWorkflowExecutions(database: DatabaseSync): void {
  try {
  database.exec(`CREATE TABLE IF NOT EXISTS workflow_execution_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  ) STRICT`);
  const stored = database
    .prepare("SELECT version FROM workflow_execution_schema WHERE singleton=1")
    .get() as { version: number } | undefined;
  if (stored && stored.version > SCHEMA_VERSION)
    throw new RunStoreError("workflow_execution_schema_too_new");
  let version = stored?.version;
  if (version === undefined) {
    database.exec(sqliteTables);
    database.exec(sqliteCompositionTables);
    database
      .prepare("INSERT INTO workflow_execution_schema VALUES (1, ?)")
      .run(SCHEMA_VERSION);
    version = SCHEMA_VERSION;
  }
  if (version === 1) {
    database.exec(
      "ALTER TABLE workflow_execution_receipts ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))",
    );
    database
      .prepare(
        "UPDATE workflow_execution_schema SET version=? WHERE singleton=1",
      )
      .run(2);
    version = 2;
  }
  if (version === 2) {
    database.exec(sqliteCompositionTables);
    database
      .prepare(
        "UPDATE workflow_execution_schema SET version=5 WHERE singleton=1",
      )
      .run();
    version = 5;
  }
  if (version === 3) {
    database.exec(sqliteValueTable);
    database
      .prepare("UPDATE workflow_execution_schema SET version=5 WHERE singleton=1")
      .run();
    version = 5;
  }
  if (version === 4) {
    database.exec("ALTER TABLE workflow_execution_values RENAME TO workflow_execution_values_v4");
    database.exec(sqliteValueTable);
    database.exec(`INSERT INTO workflow_execution_values
      SELECT * FROM workflow_execution_values_v4;
      DROP TABLE workflow_execution_values_v4`);
    database
      .prepare("UPDATE workflow_execution_schema SET version=5 WHERE singleton=1")
      .run();
    version = 5;
  }
  assertSqliteShape(database);
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw new RunStoreError("workflow_execution_schema_corrupt", {
      cause: error instanceof Error ? error : undefined,
    });
  }
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
  let version = stored.rows[0]?.version;
  if (version !== undefined && version > SCHEMA_VERSION)
    throw new RunStoreError("workflow_execution_schema_too_new");
  if (version === undefined) {
    await client.query(postgresTables(schema));
    await client.query(
      `INSERT INTO ${schema}.workflow_execution_schema(singleton, version) VALUES (true,$1)`,
      [SCHEMA_VERSION],
    );
    version = SCHEMA_VERSION;
  }
  if (version === 1) {
    await client.query(
      `ALTER TABLE ${schema}.workflow_execution_receipts ADD COLUMN result_json jsonb`,
    );
    await client.query(
      `UPDATE ${schema}.workflow_execution_schema SET version=$1 WHERE singleton=true`,
      [2],
    );
    version = 2;
  }
  if (version === 2) {
    await client.query(postgresCompositionTables(schema));
    await client.query(
      `UPDATE ${schema}.workflow_execution_schema SET version=5 WHERE singleton=true`,
    );
    version = 5;
  }
  if (version === 3) {
    await client.query(postgresValueTable(schema));
    await client.query(
      `UPDATE ${schema}.workflow_execution_schema SET version=5 WHERE singleton=true`,
    );
    version = 5;
  }
  if (version === 4) {
    await client.query(
      `ALTER TABLE ${schema}.workflow_execution_values RENAME TO workflow_execution_values_v4`,
    );
    await client.query(postgresValueTable(schema));
    await client.query(`INSERT INTO ${schema}.workflow_execution_values
      SELECT * FROM ${schema}.workflow_execution_values_v4`);
    await client.query(`DROP TABLE ${schema}.workflow_execution_values_v4`);
    await client.query(
      `UPDATE ${schema}.workflow_execution_schema SET version=5 WHERE singleton=true`,
    );
    version = 5;
  }
  const columns = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema=$1 AND table_name IN
       ('workflow_executions','workflow_execution_receipts','workflow_execution_values','workflow_composition_receipts','workflow_gate_requests')`,
    [schema],
  );
  const actual = columns.rows
    .map((row) => `${row.table_name}.${row.column_name}`)
    .sort();
  if (actual.join("\n") !== postgresColumns.join("\n"))
    throw new RunStoreError("workflow_execution_schema_corrupt");
  const indexes = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1
     AND tablename='workflow_execution_values'
     AND indexname IN ('workflow_execution_values_global_role_uq','workflow_execution_values_node_role_uq')
     ORDER BY indexname`,
    [schema],
  );
  if (indexes.rows.map((row) => row.indexname).join("\n") !== [
    "workflow_execution_values_global_role_uq",
    "workflow_execution_values_node_role_uq",
  ].join("\n")) throw new RunStoreError("workflow_execution_schema_corrupt");
}

const sqliteTables = `CREATE TABLE workflow_executions (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
) STRICT;
CREATE TABLE workflow_execution_receipts (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  PRIMARY KEY (tenant_id, run_id, operation_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_executions(tenant_id, run_id)
) STRICT;`;

const sqliteValueTable = `CREATE TABLE workflow_execution_values (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, value_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('rootInput','nodeInput','nodeOutput','workflowOutput')),
  node_id TEXT, value_digest TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)), created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,run_id,value_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES run_snapshots(tenant_id,run_id)
) STRICT;
CREATE UNIQUE INDEX workflow_execution_values_global_role_uq
  ON workflow_execution_values(tenant_id,run_id,role) WHERE node_id IS NULL;
CREATE UNIQUE INDEX workflow_execution_values_node_role_uq
  ON workflow_execution_values(tenant_id,run_id,role,node_id) WHERE node_id IS NOT NULL;`;

const sqliteCompositionTables = `${sqliteValueTable}
CREATE TABLE workflow_composition_receipts (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('admit','scheduleNodes','admitNode','settleNode','recordGateDecision','settleGate','scheduleReconciliation','cancelExecution')),
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  PRIMARY KEY (tenant_id, run_id, operation_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_executions(tenant_id, run_id)
) STRICT;
CREATE TABLE workflow_gate_requests (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  gate_request_id TEXT NOT NULL UNIQUE,
  claim_id TEXT NOT NULL,
  claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
  step_id TEXT NOT NULL,
  approval_policy_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  publication_outbox_message_id TEXT NOT NULL UNIQUE,
  approval_resume_work_item_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('published','completed','failed','canceled')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id, node_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_executions(tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES run_steps(tenant_id, run_id, step_id)
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
  const indexes = database.prepare(
    `SELECT name,sql FROM sqlite_master WHERE type='index'
     AND tbl_name='workflow_execution_values' AND sql IS NOT NULL ORDER BY name`,
  ).all() as { name: string; sql: string }[];
  if (indexes.map((row) => row.name).join("\n") !== [
    "workflow_execution_values_global_role_uq",
    "workflow_execution_values_node_role_uq",
  ].join("\n")) throw new RunStoreError("workflow_execution_schema_corrupt");
}

const sqliteColumns = {
  workflow_executions: [
    "tenant_id",
    "run_id",
    "revision",
    "state_json",
    "updated_at",
  ],
  workflow_execution_receipts: [
    "tenant_id",
    "run_id",
    "operation_id",
    "fingerprint",
    "state_json",
    "result_json",
  ],
  workflow_execution_values: [
    "tenant_id",
    "run_id",
    "value_id",
    "role",
    "node_id",
    "value_digest",
    "value_json",
    "created_at",
  ],
  workflow_composition_receipts: [
    "tenant_id",
    "run_id",
    "operation_id",
    "kind",
    "fingerprint",
    "result_json",
  ],
  workflow_gate_requests: [
    "tenant_id",
    "run_id",
    "node_id",
    "gate_request_id",
    "claim_id",
    "claim_epoch",
    "step_id",
    "approval_policy_id",
    "input_digest",
    "publication_outbox_message_id",
    "approval_resume_work_item_id",
    "status",
    "state_json",
    "created_at",
    "updated_at",
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
    FOREIGN KEY (tenant_id, run_id) REFERENCES ${schema}.workflow_executions(tenant_id,run_id));
  ${postgresCompositionTables(schema)}`;
}

function postgresCompositionTables(schema: string): string {
  return `${postgresValueTable(schema)}
  CREATE TABLE ${schema}.workflow_composition_receipts (
    tenant_id text NOT NULL, run_id text NOT NULL, operation_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('admit','scheduleNodes','admitNode','settleNode','recordGateDecision','settleGate','scheduleReconciliation','cancelExecution')),
    fingerprint text NOT NULL, result_json jsonb NOT NULL,
    PRIMARY KEY (tenant_id,run_id,operation_id),
    FOREIGN KEY (tenant_id,run_id) REFERENCES ${schema}.workflow_executions(tenant_id,run_id));
  CREATE TABLE ${schema}.workflow_gate_requests (
    tenant_id text NOT NULL, run_id text NOT NULL, node_id text NOT NULL,
    gate_request_id text NOT NULL UNIQUE, claim_id text NOT NULL, claim_epoch bigint NOT NULL,
    step_id text NOT NULL, approval_policy_id text NOT NULL, input_digest text NOT NULL,
    publication_outbox_message_id text NOT NULL UNIQUE,
    approval_resume_work_item_id text NOT NULL UNIQUE,
    status text NOT NULL CHECK (status IN ('published','completed','failed','canceled')),
    state_json jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,run_id,node_id),
    FOREIGN KEY (tenant_id,run_id) REFERENCES ${schema}.workflow_executions(tenant_id,run_id),
    FOREIGN KEY (tenant_id,run_id,step_id) REFERENCES ${schema}.run_steps(tenant_id,run_id,step_id));`;
}

function postgresValueTable(schema: string): string {
  return `CREATE TABLE ${schema}.workflow_execution_values (
    tenant_id text NOT NULL, run_id text NOT NULL, value_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('rootInput','nodeInput','nodeOutput','workflowOutput')),
    node_id text, value_digest text NOT NULL, value_json jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,run_id,value_id),
    FOREIGN KEY (tenant_id,run_id) REFERENCES ${schema}.run_snapshots(tenant_id,run_id));
  CREATE UNIQUE INDEX workflow_execution_values_global_role_uq
    ON ${schema}.workflow_execution_values(tenant_id,run_id,role) WHERE node_id IS NULL;
  CREATE UNIQUE INDEX workflow_execution_values_node_role_uq
    ON ${schema}.workflow_execution_values(tenant_id,run_id,role,node_id) WHERE node_id IS NOT NULL;`;
}

const postgresColumns = [
  "workflow_composition_receipts.fingerprint",
  "workflow_composition_receipts.kind",
  "workflow_composition_receipts.operation_id",
  "workflow_composition_receipts.result_json",
  "workflow_composition_receipts.run_id",
  "workflow_composition_receipts.tenant_id",
  "workflow_execution_receipts.fingerprint",
  "workflow_execution_receipts.operation_id",
  "workflow_execution_receipts.result_json",
  "workflow_execution_receipts.run_id",
  "workflow_execution_receipts.state_json",
  "workflow_execution_receipts.tenant_id",
  "workflow_execution_values.created_at",
  "workflow_execution_values.node_id",
  "workflow_execution_values.role",
  "workflow_execution_values.run_id",
  "workflow_execution_values.tenant_id",
  "workflow_execution_values.value_digest",
  "workflow_execution_values.value_id",
  "workflow_execution_values.value_json",
  "workflow_executions.revision",
  "workflow_executions.run_id",
  "workflow_executions.state_json",
  "workflow_executions.tenant_id",
  "workflow_executions.updated_at",
  "workflow_gate_requests.approval_policy_id",
  "workflow_gate_requests.approval_resume_work_item_id",
  "workflow_gate_requests.claim_epoch",
  "workflow_gate_requests.claim_id",
  "workflow_gate_requests.created_at",
  "workflow_gate_requests.gate_request_id",
  "workflow_gate_requests.input_digest",
  "workflow_gate_requests.node_id",
  "workflow_gate_requests.publication_outbox_message_id",
  "workflow_gate_requests.run_id",
  "workflow_gate_requests.state_json",
  "workflow_gate_requests.status",
  "workflow_gate_requests.step_id",
  "workflow_gate_requests.tenant_id",
  "workflow_gate_requests.updated_at",
] as const;
