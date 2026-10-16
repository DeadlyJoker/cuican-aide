import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";

const tables = ["workflow_human_gate_schema", "workflow_human_gates"];
export async function migratePostgresWorkflowHumanGates(
  client: PoolClient,
  schema: string,
) {
  validatePostgresSchemaName(schema);
  const sql = `"${schema}"`;
  await advisoryLock(client, `${schema}:workflow-human-gate-migration`);
  const present = await presentTables(client, schema);
  if (present !== 0 && present !== tables.length) corrupt();
  if (present === 0) {
    await client.query(`CREATE TABLE ${sql}.workflow_human_gate_schema (
      singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL);
      INSERT INTO ${sql}.workflow_human_gate_schema VALUES(true,1);
      CREATE TABLE ${sql}.workflow_human_gates (
        tenant_id text NOT NULL,run_id text NOT NULL,node_id text NOT NULL,request_id text NOT NULL UNIQUE,
        authority_json text NOT NULL CHECK(octet_length(authority_json)<=8192),
        decision_json text CHECK(octet_length(decision_json)<=16384),
        wake_work_item_id text UNIQUE,wake_json text CHECK(octet_length(wake_json)<=65536),
        PRIMARY KEY(tenant_id,run_id,node_id),
        FOREIGN KEY(tenant_id,run_id,node_id) REFERENCES ${sql}.workflow_node_admissions(tenant_id,run_id,node_id),
        FOREIGN KEY(wake_work_item_id) REFERENCES ${sql}.work_items(work_item_id));`);
  }
  await assertPostgresWorkflowHumanGateSchema(client, schema);
}

export async function postgresWorkflowHumanGateSchemaPresent(
  client: PoolClient,
  schema: string,
) {
  const count = await presentTables(client, schema);
  if (count !== 0 && count !== tables.length) corrupt();
  return count !== 0;
}
async function presentTables(client: PoolClient, schema: string) {
  validatePostgresSchemaName(schema);
  return (
    await client.query(
      "SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
      [schema, tables],
    )
  ).rows.length;
}
export async function assertPostgresWorkflowHumanGateSchema(
  client: PoolClient,
  schema: string,
) {
  validatePostgresSchemaName(schema);
  if (!(await postgresWorkflowHumanGateSchemaPresent(client, schema)))
    corrupt();
  const sql = `"${schema}"`;
  const version = await client.query<{ singleton: boolean; version: number }>(
    `SELECT singleton,version FROM ${sql}.workflow_human_gate_schema LIMIT 2`,
  );
  if (
    version.rows.length !== 1 ||
    version.rows[0]?.singleton !== true ||
    version.rows[0].version !== 1
  )
    throw new RunStoreError("workflow_gate_schema_unsupported");
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    "SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position",
    [schema, tables],
  );
  const expected = {
    workflow_human_gate_schema: "singleton:boolean!,version:integer!",
    workflow_human_gates:
      "tenant_id:text!,run_id:text!,node_id:text!,request_id:text!,authority_json:text!,decision_json:text,wake_work_item_id:text,wake_json:text",
  };
  for (const [table, value] of Object.entries(expected))
    if (
      columns.rows
        .filter((row) => row.table_name === table)
        .map(
          (row) =>
            `${row.column_name}:${row.data_type}${row.is_nullable === "NO" ? "!" : ""}`,
        )
        .join() !== value
    )
      corrupt();
  const constraints = await client.query<{
    name: string;
    kind: string;
    definition: string;
    valid: boolean;
    deferred: boolean;
  }>(
    `SELECT t.relname AS name,c.contype AS kind,pg_get_constraintdef(c.oid) AS definition,c.convalidated AS valid,c.condeferrable AS deferred
     FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname=$1 AND t.relname=ANY($2::text[])`,
    [schema, tables],
  );
  const required = {
    workflow_human_gate_schema: ["PRIMARY KEY(singleton)", "CHECK(singleton)"],
    workflow_human_gates: [
      "PRIMARY KEY(tenant_id,run_id,node_id)",
      "UNIQUE(request_id)",
      "UNIQUE(wake_work_item_id)",
      "CHECK(octet_length(authority_json)<=8192)",
      "CHECK(octet_length(decision_json)<=16384)",
      "CHECK(octet_length(wake_json)<=65536)",
      `FOREIGN KEY(tenant_id,run_id,node_id) REFERENCES ${sql}.workflow_node_admissions(tenant_id,run_id,node_id)`,
      `FOREIGN KEY(wake_work_item_id) REFERENCES ${sql}.work_items(work_item_id)`,
    ],
  };
  const normalize = (text: string) =>
    text.replaceAll(/[\s()"']/gu, "").toLowerCase();
  for (const [table, values] of Object.entries(required)) {
    const rows = constraints.rows.filter((row) => row.name === table);
    if (
      rows.some((row) => !row.valid || row.deferred) ||
      JSON.stringify(
        rows
          .filter((row) => row.kind !== "n")
          .map((row) => normalize(row.definition))
          .sort(),
      ) !== JSON.stringify(values.map(normalize).sort())
    )
      corrupt();
  }
}
function corrupt(): never {
  throw new RunStoreError("workflow_gate_schema_corrupt");
}
