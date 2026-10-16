import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import { advisoryLock } from "./postgres-thread-lock.ts";
import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";

const tables = ["workflow_cancellation_schema", "workflow_cancellation_wakes"];
function body(sql: string) {
  return `BEGIN
    IF NEW.state_json->>'cancelRequested'='true' AND OLD.state_json->>'cancelRequested'='false'
      AND NEW.state_json->>'purpose'='workflow'
      AND EXISTS(SELECT 1 FROM ${sql}.workflow_run_admissions WHERE tenant_id=NEW.tenant_id AND run_id=NEW.run_id) THEN
      INSERT INTO ${sql}.workflow_cancellation_wakes(tenant_id,run_id,work_item_id,operation_id,request_sequence,created_at)
        VALUES(NEW.tenant_id,NEW.run_id,'workflow-cancel-'||gen_random_uuid()::text,gen_random_uuid()::text,(NEW.state_json->>'lastSequence')::bigint,(NEW.state_json->>'updatedAt')::timestamptz);
      INSERT INTO ${sql}.work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at)
        SELECT w.work_item_id,w.tenant_id,w.run_id,'run.execute',
          jsonb_build_object('workItemId',w.work_item_id,'tenantId',w.tenant_id,'runId',w.run_id,'kind','run.execute',
            'payload',jsonb_build_object('schemaVersion','crewon.workflow-scheduler-work-item.v1','trigger','workflowScheduler',
              'binding',NEW.state_json->'workflowVersionBinding','schedulerOperationId',w.operation_id,
              'workflowInput',jsonb_build_object('valueId',v.value_id,'valueDigest',v.value_digest)),
            'createdAt',NEW.state_json->>'updatedAt'),w.created_at,clock_timestamp()
        FROM ${sql}.workflow_cancellation_wakes w JOIN ${sql}.workflow_run_inputs v USING(tenant_id,run_id)
        WHERE w.tenant_id=NEW.tenant_id AND w.run_id=NEW.run_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'workflow cancellation wake missing'; END IF;
    END IF;
    RETURN NEW;
  END;`;
}
export async function migratePostgresWorkflowCancellation(
  client: PoolClient,
  schema: string,
) {
  validatePostgresSchemaName(schema);
  const sql = `"${schema}"`;
  await advisoryLock(client, `${schema}:workflow-cancellation-migration`);
  const objects = await client.query<{ n: string }>(
    `SELECT (
    (SELECT count(*) FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])) +
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='workflow_root_cancellation_wake') +
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='run_snapshots' AND t.tgname='workflow_root_cancellation_wake')) AS n`,
    [schema, tables],
  );
  const count = Number(objects.rows[0]!.n);
  if (count !== 0 && count !== 4) corrupt();
  if (count === 0) {
    await client.query(`CREATE TABLE ${sql}.workflow_cancellation_schema(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL);
      INSERT INTO ${sql}.workflow_cancellation_schema VALUES(true,1);
      CREATE TABLE ${sql}.workflow_cancellation_wakes (
        tenant_id text NOT NULL,run_id text NOT NULL,work_item_id text NOT NULL UNIQUE,operation_id text NOT NULL UNIQUE,
        request_sequence bigint NOT NULL CHECK(request_sequence>=1),created_at timestamptz NOT NULL,children_signaled boolean NOT NULL DEFAULT false,
        PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.workflow_run_inputs(tenant_id,run_id));
      CREATE FUNCTION ${sql}.workflow_root_cancellation_wake() RETURNS trigger LANGUAGE plpgsql AS $wake$${body(sql)}$wake$;
      CREATE TRIGGER workflow_root_cancellation_wake AFTER UPDATE OF state_json ON ${sql}.run_snapshots FOR EACH ROW EXECUTE FUNCTION ${sql}.workflow_root_cancellation_wake();`);
  }
  await assertPostgresWorkflowCancellationSchema(client, schema);
}
export async function assertPostgresWorkflowCancellationSchema(
  client: PoolClient,
  schema: string,
) {
  validatePostgresSchemaName(schema);
  const sql = `"${schema}"`;
  const present = await client.query(
    "SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
    [schema, tables],
  );
  if (present.rows.length !== 2) corrupt();
  const version = (
    await client.query<{ singleton: boolean; version: number }>(
      `SELECT singleton,version FROM ${sql}.workflow_cancellation_schema LIMIT 2`,
    )
  ).rows;
  if (
    version.length !== 1 ||
    version[0]?.singleton !== true ||
    version[0].version !== 1
  )
    throw new RunStoreError("workflow_cancellation_schema_unsupported");
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position",
    [schema, tables],
  );
  if (
    columns.rows.some(
      (row) =>
        row.column_default !==
        (row.table_name === "workflow_cancellation_wakes" &&
        row.column_name === "children_signaled"
          ? "false"
          : null),
    )
  )
    corrupt();
  const expected = {
    workflow_cancellation_schema: "singleton:boolean!,version:integer!",
    workflow_cancellation_wakes:
      "tenant_id:text!,run_id:text!,work_item_id:text!,operation_id:text!,request_sequence:bigint!,created_at:timestamp with time zone!,children_signaled:boolean!",
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
     FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=ANY($2::text[])`,
    [schema, tables],
  );
  const required = {
    workflow_cancellation_schema: [
      "PRIMARY KEY(singleton)",
      "CHECK(singleton)",
    ],
    workflow_cancellation_wakes: [
      "PRIMARY KEY(tenant_id,run_id)",
      "UNIQUE(work_item_id)",
      "UNIQUE(operation_id)",
      "CHECK(request_sequence>=1)",
      `FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.workflow_run_inputs(tenant_id,run_id)`,
    ],
  };
  const normalize = (value: string) =>
    value.replaceAll(/[\s()"']/gu, "").toLowerCase();
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
  const triggers = await client.query<{
    enabled: string;
    internal: boolean;
    definition: string;
    body: string;
    language: string;
    definer: boolean;
  }>(
    `SELECT t.tgenabled AS enabled,t.tgisinternal AS internal,pg_get_triggerdef(t.oid) AS definition,p.prosrc AS body,l.lanname AS language,p.prosecdef AS definer
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname=$1 AND c.relname='run_snapshots' AND t.tgname='workflow_root_cancellation_wake'`,
    [schema],
  );
  const row = triggers.rows[0];
  if (
    !row ||
    triggers.rows.length !== 1 ||
    row.enabled !== "O" ||
    row.internal ||
    row.definer ||
    row.language !== "plpgsql" ||
    row.body.trim() !== body(sql).trim() ||
    normalize(row.definition) !==
      normalize(
        `CREATE TRIGGER workflow_root_cancellation_wake AFTER UPDATE OF state_json ON ${sql}.run_snapshots FOR EACH ROW EXECUTE FUNCTION ${sql}.workflow_root_cancellation_wake()`,
      )
  )
    corrupt();
}
function corrupt(): never {
  throw new RunStoreError("workflow_cancellation_schema_corrupt");
}
