import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  assertPluginInstallationSchemaVersion,
  pluginInstallationSchemaName,
} from "./plugin-installation-schema.ts";

export function pluginTaskAdmissionSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const pg = input.dialect === "postgres";
  const prefix = pg ? `${pluginInstallationSchemaName(input.schema)}.` : "";
  const json = pg ? "JSONB" : "TEXT";
  const integer = pg ? "BIGINT" : "INTEGER";
  const field = (key: string) =>
    pg
      ? `(admission_json->>'${key}')`
      : `json_extract(admission_json, '$.${key}')`;
  const matches = Object.entries({
    tenantId: "tenant_id",
    spaceId: "space_id",
    profileId: "profile_id",
    pluginId: "plugin_id",
    principalId: "principal_id",
    actorId: "actor_id",
    runId: "run_id",
    packageDigest: "package_digest",
    selectionRevision: "selection_revision",
    extensionBindingDigest: "extension_binding_digest",
  })
    .map(
      ([key, column]) =>
        `${field(key)} IS NOT NULL AND CAST(${field(key)} AS TEXT)=CAST(${column} AS TEXT)`,
    )
    .join(" AND ");
  return `CREATE TABLE IF NOT EXISTS ${prefix}plugin_task_admissions (
    tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,profile_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,principal_id TEXT NOT NULL,actor_id TEXT NOT NULL,run_id TEXT NOT NULL,
    package_digest TEXT NOT NULL,selection_revision ${integer} NOT NULL CHECK(selection_revision>=1 AND selection_revision<=9007199254740991),
    extension_binding_digest TEXT NOT NULL,
    admission_json ${json} NOT NULL CHECK (${pg ? "jsonb_typeof(admission_json)='object' AND octet_length(admission_json::text)<=16384" : "json_valid(admission_json) AND json_type(admission_json)='object' AND length(CAST(admission_json AS BLOB))<=16384"} AND ${matches}),
    PRIMARY KEY(tenant_id,run_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES ${prefix}extension_run_bindings(tenant_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,space_id,profile_id,package_digest) REFERENCES ${prefix}installed_plugin_packages(tenant_id,space_id,profile_id,package_digest) ON DELETE RESTRICT
  )${pg ? "" : " STRICT"};`;
}

export function assertPluginTaskAdmissionSchemaVersion(
  rows: readonly { id: unknown; version: unknown }[],
): void {
  if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.version !== 1)
    throw new Error("plugin_task_admission_schema_version_unsupported");
}

/** Separate, explicit opt-in; never rewrites the v0 extension schema or historical bindings. */
export function migrateSqlitePluginTaskAdmissions(
  database: DatabaseSync,
): void {
  assertPluginInstallationSchemaVersion(
    database
      .prepare(
        "SELECT id,version FROM plugin_installation_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  database
    .prepare("SELECT binding_json FROM extension_run_bindings LIMIT 0")
    .all();
  database.exec(`CREATE TABLE IF NOT EXISTS plugin_task_admission_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT;
    INSERT INTO plugin_task_admission_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;`);
  assertPluginTaskAdmissionSchemaVersion(
    database
      .prepare(
        "SELECT id,version FROM plugin_task_admission_schema_version LIMIT 2",
      )
      .all() as { id: unknown; version: unknown }[],
  );
  database.exec(pluginTaskAdmissionSchemaSql({ dialect: "sqlite" }));
  for (const operation of ["UPDATE", "DELETE"] as const)
    database.exec(`CREATE TRIGGER IF NOT EXISTS plugin_task_admissions_no_${operation.toLowerCase()} BEFORE ${operation} ON plugin_task_admissions
      BEGIN SELECT RAISE(ABORT,'plugin_task_admission_immutable'); END;`);
}

export async function migratePostgresPluginTaskAdmissions(
  client: PoolClient,
  schema: string,
): Promise<void> {
  const prefix = `${pluginInstallationSchemaName(schema)}.`;
  assertPluginInstallationSchemaVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix}plugin_installation_schema_version LIMIT 2`,
      )
    ).rows,
  );
  await client.query(`CREATE TABLE IF NOT EXISTS ${prefix}plugin_task_admission_schema_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT INTO ${prefix}plugin_task_admission_schema_version VALUES(1,1) ON CONFLICT(id) DO NOTHING;`);
  assertPluginTaskAdmissionSchemaVersion(
    (
      await client.query<{ id: unknown; version: unknown }>(
        `SELECT id,version FROM ${prefix}plugin_task_admission_schema_version LIMIT 2`,
      )
    ).rows,
  );
  await client.query(
    pluginTaskAdmissionSchemaSql({ dialect: "postgres", schema }),
  );
  await client.query(`CREATE OR REPLACE FUNCTION ${prefix}plugin_task_admission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'plugin_task_admission_immutable'; END $$;
    DROP TRIGGER IF EXISTS plugin_task_admissions_no_update ON ${prefix}plugin_task_admissions;
    CREATE TRIGGER plugin_task_admissions_no_update BEFORE UPDATE OR DELETE ON ${prefix}plugin_task_admissions
      FOR EACH ROW EXECUTE FUNCTION ${prefix}plugin_task_admission_immutable();`);
}

export async function migratePostgresPluginTaskAdmissionsWithPool(input: {
  pool: Pool;
  schema: string;
  assertOpen(): void;
}): Promise<void> {
  input.assertOpen();
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      JSON.stringify(["plugin-task-admission-migration", input.schema]),
    ]);
    await migratePostgresPluginTaskAdmissions(client, input.schema);
    input.assertOpen();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
