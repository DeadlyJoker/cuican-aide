import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { validatePostgresSchemaName as validatePostgresSchemaIdentifier } from "./postgres-queue-schema.ts";

const names = [
  "workflow_run_admission_schema",
  "workflow_run_inputs",
  "workflow_run_admissions",
] as const;
export async function migratePostgresWorkflowRunAdmission(
  client: PoolClient,
  schema: string,
): Promise<void> {
  validatePostgresSchemaIdentifier(schema);
  await client.query("BEGIN");
  try {
    await advisoryLock(client, `${schema}:workflow-run-admission:migration`);
    const present = await client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
      [schema, names],
    );
    if (present.rows.length !== 0 && present.rows.length !== names.length)
      throw new RunStoreError("workflow_run_admission_schema_corrupt");
    const sql = `"${schema}"`;
    if (present.rows.length === 0) {
      await client.query(`CREATE TABLE ${sql}.workflow_run_admission_schema (
        singleton boolean PRIMARY KEY CHECK(singleton), version integer NOT NULL);
        INSERT INTO ${sql}.workflow_run_admission_schema VALUES(true,1);
        CREATE TABLE ${sql}.workflow_run_inputs (
          tenant_id text NOT NULL, run_id text NOT NULL, value_id text NOT NULL,
          value_digest text NOT NULL, value_json text NOT NULL,
          PRIMARY KEY(tenant_id,run_id), UNIQUE(tenant_id,value_id),
          CHECK(octet_length(value_json)<=32768), CHECK(jsonb_typeof(value_json::jsonb) IS NOT NULL),
          FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.run_snapshots(tenant_id,run_id));
        CREATE TABLE ${sql}.workflow_run_admissions (
          scope text NOT NULL, idempotency_key text NOT NULL, tenant_id text NOT NULL,
          run_id text NOT NULL, authority_json text NOT NULL,
          PRIMARY KEY(scope,idempotency_key), UNIQUE(tenant_id,run_id),
          CHECK(jsonb_typeof(authority_json::jsonb)='object'),
          FOREIGN KEY(scope,idempotency_key) REFERENCES ${sql}.idempotency_receipts(scope,idempotency_key),
          FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.run_snapshots(tenant_id,run_id));`);
    }
    await assertPostgresWorkflowRunAdmissionSchema(client, schema);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function assertPostgresWorkflowRunAdmissionSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  validatePostgresSchemaIdentifier(schema);
  const version = await client.query<{ singleton: boolean; version: number }>(
    `SELECT singleton,version FROM "${schema}".workflow_run_admission_schema LIMIT 2`,
  );
  if (version.rows.length !== 1 || version.rows[0]?.singleton !== true)
    throw new RunStoreError("workflow_run_admission_schema_corrupt");
  if (version.rows[0]?.version !== 1)
    throw new RunStoreError("workflow_run_admission_schema_unsupported");
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
     WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position`,
    [schema, names],
  );
  const expected = {
    workflow_run_admission_schema: "singleton:boolean,version:integer",
    workflow_run_admissions:
      "scope:text,idempotency_key:text,tenant_id:text,run_id:text,authority_json:text",
    workflow_run_inputs:
      "tenant_id:text,run_id:text,value_id:text,value_digest:text,value_json:text",
  };
  for (const [name, fields] of Object.entries(expected)) {
    const actual = columns.rows.filter((c) => c.table_name === name);
    if (
      actual.some((c) => c.is_nullable !== "NO") ||
      actual.map((c) => `${c.column_name}:${c.data_type}`).join(",") !== fields
    )
      throw new RunStoreError("workflow_run_admission_schema_corrupt");
  }
  const constraints = await client.query<{
    name: string;
    definition: string;
    valid: boolean;
    deferred: boolean;
    kind: string;
  }>(
    `SELECT t.relname AS name,pg_get_constraintdef(c.oid) AS definition,c.convalidated AS valid,c.condeferrable AS deferred,c.contype AS kind
     FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND c.contype IN ('p','u','f','c','n')`,
    [schema, names],
  );
  const checks = {
    workflow_run_admission_schema: [
      "PRIMARY KEY (singleton)",
      "CHECK (singleton)",
    ],
    workflow_run_inputs: [
      "PRIMARY KEY (tenant_id,run_id)",
      "UNIQUE (tenant_id,value_id)",
      "CHECK (octet_length(value_json)<=32768)",
      "CHECK (jsonb_typeof((value_json)::jsonb) IS NOT NULL)",
      `FOREIGN KEY (tenant_id,run_id) REFERENCES "${schema}".run_snapshots(tenant_id,run_id)`,
    ],
    workflow_run_admissions: [
      "PRIMARY KEY (scope,idempotency_key)",
      "UNIQUE (tenant_id,run_id)",
      "CHECK (jsonb_typeof((authority_json)::jsonb)='object'::text)",
      `FOREIGN KEY (scope,idempotency_key) REFERENCES "${schema}".idempotency_receipts(scope,idempotency_key)`,
      `FOREIGN KEY (tenant_id,run_id) REFERENCES "${schema}".run_snapshots(tenant_id,run_id)`,
    ],
  };
  const normalize = (value: string) =>
    value.replaceAll(/[\s()"']/gu, "").toLowerCase();
  for (const [name, definitions] of Object.entries(checks)) {
    const all = constraints.rows.filter((c) => c.name === name);
    // PostgreSQL 18 exposes NOT NULL as its own constraint; earlier releases use column metadata.
    if (all.some((c) => !c.valid || c.deferred))
      throw new RunStoreError("workflow_run_admission_schema_corrupt");
    const actual = all.filter((c) => c.kind !== "n");
    if (
      JSON.stringify(actual.map((c) => normalize(c.definition)).sort()) !==
      JSON.stringify(definitions.map(normalize).sort())
    )
      throw new RunStoreError("workflow_run_admission_schema_corrupt");
  }
}
