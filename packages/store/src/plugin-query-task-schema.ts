import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
export function assertPluginQuerySchema(
  rows: readonly { id: unknown; version: unknown }[],
): void {
  if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.version !== 1)
    throw new Error("plugin_query_schema_version_unsupported");
}
function table(prefix: string, pg: boolean): string {
  const json = pg ? "JSONB" : "TEXT";
  return `CREATE TABLE IF NOT EXISTS ${prefix}plugin_query_task_admissions (tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,source_run_id TEXT NOT NULL,admission_json ${json} NOT NULL CHECK(${pg ? "jsonb_typeof(admission_json)='object' AND octet_length(admission_json::text)<=16384" : "json_valid(admission_json) AND json_type(admission_json)='object' AND length(CAST(admission_json AS BLOB))<=16384"}),PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES ${prefix}extension_run_bindings(tenant_id,run_id) ON DELETE RESTRICT,FOREIGN KEY(tenant_id,source_run_id) REFERENCES ${prefix}plugin_task_admissions(tenant_id,run_id) ON DELETE RESTRICT)${pg ? "" : " STRICT"};`;
}
export function migrateSqlitePluginQueryTasks(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS plugin_query_task_admission_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT; INSERT INTO plugin_query_task_admission_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;",
  );
  assertPluginQuerySchema(
    db
      .prepare(
        "SELECT id,version FROM plugin_query_task_admission_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  db.exec(table("", false));
  for (const operation of ["UPDATE", "DELETE"])
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS plugin_query_task_no_${operation.toLowerCase()} BEFORE ${operation} ON plugin_query_task_admissions BEGIN SELECT RAISE(ABORT,'plugin_query_admission_immutable'); END;`,
    );
}
export async function migratePostgresPluginQueryTasks(input: {
  pool: Pool;
  schema: string;
  assertOpen(): void;
}): Promise<void> {
  input.assertOpen();
  const client = await input.pool.connect();
  const prefix = `${pluginInstallationSchemaName(input.schema)}.`;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      JSON.stringify(["plugin-query-schema", input.schema]),
    ]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${prefix}plugin_query_task_admission_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO ${prefix}plugin_query_task_admission_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;`,
    );
    assertPluginQuerySchema(
      (
        await client.query<{ id: unknown; version: unknown }>(
          `SELECT id,version FROM ${prefix}plugin_query_task_admission_schema_version LIMIT 2`,
        )
      ).rows,
    );
    await client.query(table(prefix, true));
    await client.query(
      `CREATE OR REPLACE FUNCTION ${prefix}plugin_query_task_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plugin_query_admission_immutable'; END $$; DROP TRIGGER IF EXISTS plugin_query_task_no_change ON ${prefix}plugin_query_task_admissions; CREATE TRIGGER plugin_query_task_no_change BEFORE UPDATE OR DELETE ON ${prefix}plugin_query_task_admissions FOR EACH ROW EXECUTE FUNCTION ${prefix}plugin_query_task_immutable();`,
    );
    input.assertOpen();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function postgresPluginQueryVersion(
  client: Pool | PoolClient,
  schema: string,
): Promise<void> {
  assertPluginQuerySchema(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${pluginInstallationSchemaName(schema)}.plugin_query_task_admission_schema_version LIMIT 2`,
      )
    ).rows,
  );
}
