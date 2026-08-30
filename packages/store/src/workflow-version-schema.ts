import { DatabaseSync } from "node:sqlite";

import { RunStoreError } from "@crewon/application";
import type { PoolClient } from "pg";

export const WORKFLOW_VERSION_SCHEMA_VERSION = 1;

export function migrateSqliteWorkflowVersions(database: DatabaseSync) {
  const tables = sqliteAuthorityTables(database);
  if (
    tables.length !== 0 &&
    !sameStrings(tables, ["workflow_version_schema", "workflow_versions"])
  )
    throw new RunStoreError("workflow_version_schema_corrupt");
  if (tables.length === 2) {
    const version = validateSqliteWorkflowVersionShape(database);
    if (version !== WORKFLOW_VERSION_SCHEMA_VERSION)
      throw new RunStoreError("workflow_version_schema_unsupported");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS workflow_version_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
      INSERT INTO workflow_version_schema VALUES(1,1) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS workflow_versions (tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
        workflow_version_id TEXT NOT NULL, content_digest TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
        created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, workflow_version_id)) STRICT;`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export async function migratePostgresWorkflowVersions(
  client: PoolClient,
  schema: string,
) {
  validatePostgresSchemaIdentifier(schema);
  const present = await client.query<{
    registry: string | null;
    assets: string | null;
  }>(
    "SELECT to_regclass($1)::text AS registry, to_regclass($2)::text AS assets",
    [`${schema}.workflow_version_schema`, `${schema}.workflow_versions`],
  );
  const registryPresent = present.rows[0]?.registry != null;
  const assetsPresent = present.rows[0]?.assets != null;
  if (registryPresent !== assetsPresent)
    throw new RunStoreError("workflow_version_schema_corrupt");
  if (registryPresent) {
    const version = await validatePostgresWorkflowVersionShape(client, schema);
    if (version !== WORKFLOW_VERSION_SCHEMA_VERSION)
      throw new RunStoreError("workflow_version_schema_unsupported");
  }
  await client.query("BEGIN");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.workflow_version_schema
      (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL);
      INSERT INTO ${schema}.workflow_version_schema(singleton,version) VALUES(true,1) ON CONFLICT DO NOTHING`);
    const result = await client.query<{ version: number }>(
      `SELECT version FROM ${schema}.workflow_version_schema WHERE singleton=true FOR UPDATE`,
    );
    if (result.rows[0]?.version !== WORKFLOW_VERSION_SCHEMA_VERSION)
      throw new RunStoreError("workflow_version_schema_unsupported");
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.workflow_versions (tenant_id text NOT NULL, workflow_id text NOT NULL,
      workflow_version_id text NOT NULL, content_digest text NOT NULL, definition_json text NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY(tenant_id, workflow_version_id))`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

type SqliteColumn = { name: string; type: string; notnull: number; pk: number };
function sqliteAuthorityTables(database: DatabaseSync) {
  return (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflow_version_schema','workflow_versions') ORDER BY name",
      )
      .all() as unknown as { name: string }[]
  ).map((row) => row.name);
}
function validateSqliteWorkflowVersionShape(database: DatabaseSync): number {
  const version = database
    .prepare("PRAGMA table_info(workflow_version_schema)")
    .all() as unknown as SqliteColumn[];
  const assets = database
    .prepare("PRAGMA table_info(workflow_versions)")
    .all() as unknown as SqliteColumn[];
  const assetSql = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_versions'",
    )
    .get() as { sql: string } | undefined;
  const registrySql = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='workflow_version_schema'",
    )
    .get() as { sql: string } | undefined;
  const authorityRows = database
    .prepare("SELECT singleton,version FROM workflow_version_schema LIMIT 2")
    .all() as unknown as { singleton: number; version: number }[];
  if (
    !sameSqliteColumns(version, [
      ["singleton", "INTEGER", 0, 1],
      ["version", "INTEGER", 1, 0],
    ]) ||
    !sameSqliteColumns(assets, [
      ["tenant_id", "TEXT", 1, 1],
      ["workflow_id", "TEXT", 1, 0],
      ["workflow_version_id", "TEXT", 1, 2],
      ["content_digest", "TEXT", 1, 0],
      ["definition_json", "TEXT", 1, 0],
      ["created_at", "TEXT", 1, 0],
    ]) ||
    registrySql === undefined ||
    !registrySql.sql.replaceAll(/\s+/gu, "").includes("CHECK(singleton=1)") ||
    authorityRows.length !== 1 ||
    authorityRows[0]?.singleton !== 1 ||
    !Number.isSafeInteger(authorityRows[0]?.version) ||
    assetSql === undefined ||
    !/\bSTRICT\s*$/iu.test(assetSql.sql) ||
    !assetSql.sql.includes("json_valid(definition_json)")
  )
    throw new RunStoreError("workflow_version_schema_corrupt");
  return authorityRows[0]!.version;
}
function sameSqliteColumns(
  actual: readonly SqliteColumn[],
  expected: readonly (readonly [string, string, number, number])[],
) {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => {
      const value = expected[index]!;
      return (
        column.name === value[0] &&
        column.type.toUpperCase() === value[1] &&
        column.notnull === value[2] &&
        column.pk === value[3]
      );
    })
  );
}

type PostgresColumn = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};
async function validatePostgresWorkflowVersionShape(
  client: PoolClient,
  schema: string,
): Promise<number> {
  const versionColumns = await client.query<PostgresColumn>(
    `SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema=$1 AND table_name='workflow_version_schema' ORDER BY ordinal_position`,
    [schema],
  );
  const columns = await client.query<PostgresColumn>(
    `SELECT column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema=$1 AND table_name='workflow_versions' ORDER BY ordinal_position`,
    [schema],
  );
  const primaryKey = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='workflow_versions' AND c.contype='p'`,
    [schema],
  );
  const versionPrimaryKey = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='workflow_version_schema' AND c.contype='p'`,
    [schema],
  );
  const singletonChecks = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='workflow_version_schema' AND c.contype='c'`,
    [schema],
  );
  const authorityRows = await client.query<{
    singleton: boolean;
    version: number;
  }>(`SELECT singleton,version FROM ${schema}.workflow_version_schema LIMIT 2`);
  const expected: readonly (readonly [string, string, "NO"])[] = [
    ["tenant_id", "text", "NO"],
    ["workflow_id", "text", "NO"],
    ["workflow_version_id", "text", "NO"],
    ["content_digest", "text", "NO"],
    ["definition_json", "text", "NO"],
    ["created_at", "timestamp with time zone", "NO"],
  ];
  if (
    versionColumns.rows.length !== 2 ||
    versionColumns.rows[0]?.column_name !== "singleton" ||
    versionColumns.rows[0]?.data_type !== "boolean" ||
    versionColumns.rows[0]?.is_nullable !== "NO" ||
    versionColumns.rows[0]?.column_default !== "true" ||
    versionColumns.rows[1]?.column_name !== "version" ||
    versionColumns.rows[1]?.data_type !== "integer" ||
    versionColumns.rows[1]?.is_nullable !== "NO" ||
    versionPrimaryKey.rows[0]?.definition !== "PRIMARY KEY (singleton)" ||
    singletonChecks.rows.length !== 1 ||
    singletonChecks.rows[0]?.definition !== "CHECK (singleton)" ||
    authorityRows.rows.length !== 1 ||
    authorityRows.rows[0]?.singleton !== true ||
    !Number.isSafeInteger(authorityRows.rows[0]?.version) ||
    columns.rows.length !== expected.length ||
    columns.rows.some((column, index) => {
      const value = expected[index]!;
      return (
        column.column_name !== value[0] ||
        column.data_type !== value[1] ||
        column.is_nullable !== value[2]
      );
    }) ||
    primaryKey.rows.length !== 1 ||
    primaryKey.rows[0]?.definition !==
      "PRIMARY KEY (tenant_id, workflow_version_id)"
  )
    throw new RunStoreError("workflow_version_schema_corrupt");
  return authorityRows.rows[0]!.version;
}
function validatePostgresSchemaIdentifier(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(schema))
    throw new RunStoreError("postgres_schema_invalid");
}
function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
