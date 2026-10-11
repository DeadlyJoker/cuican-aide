import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import {
  hasPostgresPluginProjectMetadataOwnerSchema,
  hasSqlitePluginProjectMetadataOwnerSchema,
  migratePostgresPluginProjectMetadataOwners,
  migrateSqlitePluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import {
  pluginProjectMetadataOwnerColumns,
  parsePluginProjectMetadataOwnerRecord,
} from "./plugin-project-metadata-owner-records.ts";
import {
  actor,
  creationRecipe,
  timestamp,
} from "./creative-project-store.test-support.ts";

export type MetadataOwnerBackend = "sqlite" | "postgres";
export const metadataOwnerFixtureScope = (projectId: string) =>
  parsePluginProjectWorkspaceOwner({
    ...actor,
    profileId: "fixture-profile",
    pluginId: "fixture.plugin-a",
    publisherId: "fixture.publisher-a",
    projectId,
  });
export function metadataOwnerFixtureRecord(projectId: string) {
  return parsePluginProjectMetadataOwnerRecord({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner: metadataOwnerFixtureScope(projectId),
    createdAt: timestamp,
  });
}

/** Genuine original project stores; raw SQL sidecar rows are constraint fixtures, not Host grants. */
export async function metadataOwnerSchemaFixture(
  context: TestContext,
  backend: MetadataOwnerBackend,
  options: Readonly<{ migrateParent?: boolean }> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-metadata-owner-"));
  const schema = `metadata_owner_${randomUUID().replaceAll("-", "")}`;
  const database =
    backend === "sqlite"
      ? new DatabaseSync(join(directory, "original.sqlite"))
      : null;
  database?.exec("PRAGMA foreign_keys=ON");
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const pool =
    backend === "postgres" ? new Pool({ connectionString, max: 2 }) : null;
  const client = await pool?.connect();
  if (client) await client.query(`CREATE SCHEMA "${schema}"`);
  let open = true;
  const assertOpen = () => assert.equal(open, true);
  const projects = database
    ? new SqliteCreativeProjectStore({ database, assertOpen })
    : new PostgresCreativeProjectStore({ pool: pool!, schema, assertOpen });
  context.after(async () => {
    open = false;
    try {
      if (client) {
        await client.query("ROLLBACK");
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      database?.close();
      client?.release();
      await pool?.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
  if (options.migrateParent !== false) await projects.migrate();
  const prefix = backend === "sqlite" ? "" : `"${schema}".`;
  const statement = (sql: string) =>
    sql
      .replaceAll("$schema.", prefix)
      .replace(/\$([0-9]+)/gu, (match) => (database ? "?" : match));
  async function query(sql: string, parameters: readonly unknown[] = []) {
    return database
      ? database
          .prepare(statement(sql))
          .all(...(parameters as SQLInputValue[]))
          .map((row) => ({ ...row }))
      : (await client!.query(statement(sql), [...parameters])).rows;
  }
  async function execute(sql: string, parameters: readonly unknown[] = []) {
    if (!database) await client!.query(statement(sql), [...parameters]);
    else if (parameters.length === 0) database.exec(statement(sql));
    else
      database.prepare(statement(sql)).run(...(parameters as SQLInputValue[]));
  }
  async function transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    await execute(database ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const value = await operation();
      await execute("COMMIT");
      return value;
    } catch (error) {
      await execute("ROLLBACK");
      throw error;
    }
  }
  async function migrateDirect() {
    if (database) migrateSqlitePluginProjectMetadataOwners(database);
    else await migratePostgresPluginProjectMetadataOwners(client!, schema);
  }
  async function hasSchema() {
    return database
      ? hasSqlitePluginProjectMetadataOwnerSchema(database)
      : hasPostgresPluginProjectMetadataOwnerSchema(client!, schema);
  }
  async function catalog() {
    return database
      ? query("SELECT name,type,sql FROM main.sqlite_schema ORDER BY name")
      : query(
          "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname",
          [schema],
        );
  }
  async function rawFixtureInsert(
    projectId: string,
    changes: Readonly<{
      owner?: Partial<ReturnType<typeof metadataOwnerFixtureScope>>;
      record?: unknown;
    }> = {},
  ) {
    const base = metadataOwnerFixtureRecord(projectId);
    const owner = { ...base.owner, ...changes.owner };
    const record = changes.record ?? { ...base, owner };
    const values = [
      owner.tenantId,
      owner.spaceId,
      owner.principalId,
      owner.actorId,
      owner.profileId,
      owner.pluginId,
      owner.publisherId,
      owner.projectId,
      base.createdAt,
      JSON.stringify(record),
    ];
    await execute(
      `INSERT INTO $schema.plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${values.map((_, index) => `$${index + 1}`).join(",")})`,
      values,
    );
  }
  async function createOriginalProject(projectId: string) {
    return projects.commitProjectCreation(
      creationRecipe(projectId, `fixture-create-${projectId}`),
    );
  }
  return {
    backend,
    database,
    client,
    schema,
    projects,
    query,
    execute,
    transaction,
    migrateDirect,
    migrate: () => transaction(migrateDirect),
    hasSchema,
    catalog,
    rawFixtureInsert,
    createOriginalProject,
  };
}
