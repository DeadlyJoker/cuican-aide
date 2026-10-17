import {
  POSTGRES_WORKFLOW_CHILD_COLUMNS,
  postgresWorkflowChildConstraints,
  normalizePostgresWorkflowConstraint as normalize,
} from "./postgres-workflow-child-membership-schema.ts";
import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import { migratePostgresWorkflowExecutions } from "./workflow-execution-schema.ts";
import { validatePostgresSchemaName } from "./postgres-queue-schema.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";

const tables = [
  "workflow_composition_schema",
  "workflow_node_admissions",
  "workflow_node_passes",
  "workflow_node_children",
];
function wakeBody(sql: string): string {
  return `BEGIN
    IF NEW.state_json->>'status' IN ('completed','failed','canceled')
       AND OLD.state_json->>'status' NOT IN ('completed','failed','canceled') THEN
      INSERT INTO ${sql}.work_items(work_item_id,tenant_id,run_id,kind,work_item_json,created_at,available_at)
      SELECT c.wake_work_item_id,c.tenant_id,c.run_id,'run.execute',c.wake_json,(c.wake_json->>'createdAt')::timestamptz,clock_timestamp()
      FROM ${sql}.workflow_node_children c WHERE c.tenant_id=NEW.tenant_id AND c.child_run_id=NEW.run_id;
    END IF;
    RETURN NEW;
  END;`;
}
export async function migratePostgresWorkflowComposition(
  client: PoolClient,
  schema: string,
): Promise<void> {
  validatePostgresSchemaName(schema);
  const sql = `"${schema}"`;
  await advisoryLock(client, `${schema}:workflow-composition-migration`);
  await migratePostgresWorkflowExecutions(client, schema);
  const present = await client.query(
    "SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])",
    [schema, tables],
  );
  if (present.rows.length !== 0 && present.rows.length !== tables.length)
    throw new RunStoreError("workflow_composition_schema_corrupt");
  if (present.rows.length === 0) {
    await client.query(`CREATE TABLE ${sql}.workflow_composition_schema(singleton boolean PRIMARY KEY CHECK(singleton),version integer NOT NULL);
      INSERT INTO ${sql}.workflow_composition_schema VALUES(true,1);
      CREATE TABLE ${sql}.workflow_node_admissions (
        tenant_id text NOT NULL,run_id text NOT NULL,node_id text NOT NULL,claim_id text NOT NULL UNIQUE,
        step_id text NOT NULL,attempt_id text,work_item_id text NOT NULL,lease_epoch bigint NOT NULL CHECK(lease_epoch>=1),
        operation_id text NOT NULL,input_digest text NOT NULL,input_json text NOT NULL CHECK(octet_length(input_json)<=32768),
        output_digest text,output_json text CHECK(octet_length(output_json)<=32768),settlement_fingerprint text,
        PRIMARY KEY(tenant_id,run_id,node_id),
        FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.workflow_executions(tenant_id,run_id),
        FOREIGN KEY(tenant_id,run_id,step_id) REFERENCES ${sql}.run_steps(tenant_id,run_id,step_id),
        FOREIGN KEY(tenant_id,run_id,step_id,attempt_id) REFERENCES ${sql}.run_attempts(tenant_id,run_id,step_id,attempt_id),
        FOREIGN KEY(work_item_id) REFERENCES ${sql}.work_items(work_item_id));
      CREATE TABLE ${sql}.workflow_node_passes (
        tenant_id text NOT NULL,run_id text NOT NULL,operation_id text NOT NULL,work_item_id text NOT NULL,
        fingerprint text NOT NULL,node_ids_json jsonb NOT NULL,
        PRIMARY KEY(tenant_id,run_id,operation_id),
        FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.workflow_executions(tenant_id,run_id),
        FOREIGN KEY(work_item_id) REFERENCES ${sql}.work_items(work_item_id));
      CREATE TABLE ${sql}.workflow_node_children (
        tenant_id text NOT NULL,run_id text NOT NULL,node_id text NOT NULL,claim_id text NOT NULL UNIQUE,
        child_thread_id text NOT NULL UNIQUE,child_run_id text NOT NULL UNIQUE,input_digest text NOT NULL,
        wake_work_item_id text NOT NULL UNIQUE,wake_json jsonb NOT NULL,
        PRIMARY KEY(tenant_id,run_id,node_id),
        FOREIGN KEY(tenant_id,run_id,node_id) REFERENCES ${sql}.workflow_node_admissions(tenant_id,run_id,node_id),
        FOREIGN KEY(tenant_id,child_thread_id) REFERENCES ${sql}.threads(tenant_id,thread_id),
        FOREIGN KEY(tenant_id,child_run_id) REFERENCES ${sql}.run_snapshots(tenant_id,run_id));
      CREATE FUNCTION ${sql}.workflow_child_terminal_wake() RETURNS trigger LANGUAGE plpgsql AS $wake$${wakeBody(sql)}$wake$;
      CREATE TRIGGER workflow_child_terminal_wake AFTER UPDATE OF state_json ON ${sql}.run_snapshots
        FOR EACH ROW EXECUTE FUNCTION ${sql}.workflow_child_terminal_wake();`);
  }
  await assertPostgresWorkflowCompositionSchema(client, schema);
}
export async function assertPostgresWorkflowCompositionSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  validatePostgresSchemaName(schema);
  const sql = `"${schema}"`;
  const version = await client.query<{ singleton: boolean; version: number }>(
    `SELECT singleton,version FROM ${sql}.workflow_composition_schema LIMIT 2`,
  );
  if (
    version.rows.length !== 1 ||
    version.rows[0]?.singleton !== true ||
    version.rows[0].version !== 1
  )
    throw new RunStoreError("workflow_composition_schema_unsupported");
  const expected: Record<string, string> = {
    workflow_composition_schema: "singleton:boolean!,version:integer!",
    workflow_node_admissions:
      "tenant_id:text!,run_id:text!,node_id:text!,claim_id:text!,step_id:text!,attempt_id:text,work_item_id:text!,lease_epoch:bigint!,operation_id:text!,input_digest:text!,input_json:text!,output_digest:text,output_json:text,settlement_fingerprint:text",
    workflow_node_passes:
      "tenant_id:text!,run_id:text!,operation_id:text!,work_item_id:text!,fingerprint:text!,node_ids_json:jsonb!",
    workflow_node_children: POSTGRES_WORKFLOW_CHILD_COLUMNS,
  };
  const cols = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    "SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position",
    [schema, tables],
  );
  for (const [name, columns] of Object.entries(expected)) {
    if (
      cols.rows
        .filter((c) => c.table_name === name)
        .map(
          (c) =>
            `${c.column_name}:${c.data_type}${c.is_nullable === "NO" ? "!" : ""}`,
        )
        .join(",") !== columns
    )
      throw new RunStoreError("workflow_composition_schema_corrupt");
  }
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
  const required: Record<string, string[]> = {
    workflow_composition_schema: ["PRIMARY KEY(singleton)", "CHECK(singleton)"],
    workflow_node_admissions: [
      "PRIMARY KEY(tenant_id,run_id,node_id)",
      "UNIQUE(claim_id)",
      "CHECK(lease_epoch>=1)",
      "CHECK(octet_length(input_json)<=32768)",
      "CHECK(octet_length(output_json)<=32768)",
      `FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.workflow_executions(tenant_id,run_id)`,
      `FOREIGN KEY(tenant_id,run_id,step_id) REFERENCES ${sql}.run_steps(tenant_id,run_id,step_id)`,
      `FOREIGN KEY(tenant_id,run_id,step_id,attempt_id) REFERENCES ${sql}.run_attempts(tenant_id,run_id,step_id,attempt_id)`,
      `FOREIGN KEY(work_item_id) REFERENCES ${sql}.work_items(work_item_id)`,
    ],
    workflow_node_passes: [
      "PRIMARY KEY(tenant_id,run_id,operation_id)",
      `FOREIGN KEY(tenant_id,run_id) REFERENCES ${sql}.workflow_executions(tenant_id,run_id)`,
      `FOREIGN KEY(work_item_id) REFERENCES ${sql}.work_items(work_item_id)`,
    ],
    workflow_node_children: [...postgresWorkflowChildConstraints(schema)],
  };
  for (const [table, definitions] of Object.entries(required)) {
    const rows = constraints.rows.filter((c) => c.name === table);
    if (
      rows.some((c) => !c.valid || c.deferred) ||
      JSON.stringify(
        rows
          .filter((c) => c.kind !== "n")
          .map((c) => normalize(c.definition))
          .sort(),
      ) !== JSON.stringify(definitions.map(normalize).sort())
    )
      throw new RunStoreError("workflow_composition_schema_corrupt");
  }
  const trigger = await client.query<{
    enabled: string;
    internal: boolean;
    definition: string;
    body: string;
    language: string;
    definer: boolean;
  }>(
    `SELECT t.tgenabled AS enabled,t.tgisinternal AS internal,pg_get_triggerdef(t.oid) AS definition,p.prosrc AS body,l.lanname AS language,p.prosecdef AS definer
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname=$1 AND c.relname='run_snapshots' AND t.tgname='workflow_child_terminal_wake'`,
    [schema],
  );
  const row = trigger.rows[0];
  const expectedTrigger = `CREATE TRIGGER workflow_child_terminal_wake AFTER UPDATE OF state_json ON ${sql}.run_snapshots FOR EACH ROW EXECUTE FUNCTION ${sql}.workflow_child_terminal_wake()`;
  if (
    !row ||
    trigger.rows.length !== 1 ||
    row.enabled !== "O" ||
    row.internal ||
    row.definer ||
    row.language !== "plpgsql" ||
    normalize(row.definition) !== normalize(expectedTrigger) ||
    row.body.trim() !== wakeBody(sql).trim()
  )
    throw new RunStoreError("workflow_child_schema_corrupt");
}
