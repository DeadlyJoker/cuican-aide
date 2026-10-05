import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";

const tables = [
  "run_snapshots",
  "run_thread_bindings",
  "work_items",
  "run_steps",
  "run_attempts",
  "tool_execution_receipts",
  "plugin_task_admissions",
  "plugin_task_admission_schema_version",
  "installed_plugin_packages",
  "plugin_profile_selections",
  "plugin_installation_schema_version",
  "extension_run_bindings",
  "extension_configurations",
  "extension_mutation_receipts",
] as const;

/** Missing/partial storage is never created or substituted by this qualification boundary. */
export function assertSqliteProjectRunSchema(db: DatabaseSync): void {
  const placeholders = tables.map(() => "?").join(",");
  const shadow = db
    .prepare(
      `SELECT name FROM temp.sqlite_schema WHERE name IN (${placeholders}) LIMIT 1`,
    )
    .get(...tables);
  const rows = db
    .prepare(
      `SELECT name,type FROM main.sqlite_schema WHERE name IN (${placeholders})`,
    )
    .all(...tables);
  if (
    shadow !== undefined ||
    rows.length !== tables.length ||
    rows.some((row) => row.type !== "table")
  )
    invalid();
}
export async function assertPostgresProjectRunSchema(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const rows = await client.query<{ relname: string; relkind: string }>(
    `SELECT c.relname,c.relkind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
    [schema, tables],
  );
  if (
    rows.rows.length !== tables.length ||
    rows.rows.some((row) => row.relkind !== "r")
  )
    invalid();
}
function invalid(): never {
  throw new Error("creative_project_run_commit_schema_invalid");
}
