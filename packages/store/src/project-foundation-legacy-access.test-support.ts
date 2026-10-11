import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  migrateSqlitePluginProjectMetadataOwners,
  migratePostgresPluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import { pluginProjectMetadataOwnerColumns } from "./plugin-project-metadata-owner-records.ts";
import { metadataOwnerFixtureRecord } from "./plugin-project-metadata-owner-schema.test-support.ts";
import { parsePluginProjectMetadataOwnerRecord } from "./plugin-project-metadata-owner-records.ts";

/** Raw immutable owner rows are negative constraint fixtures, never Host qualifications. */
export async function foundationMetadataFixture(
  t: TestContext,
  f: Readonly<{
    backend: "sqlite" | "postgres";
    path: string;
    schema: string;
    prefix: string;
  }>,
) {
  const database = f.backend === "sqlite" ? new DatabaseSync(f.path) : null;
  database?.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const pool =
    f.backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        })
      : null;
  const client = await pool?.connect();
  t.after(async () => {
    database?.close();
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    await pool?.end();
  });
  async function execute(sql: string, values: readonly unknown[] = []) {
    if (database) {
      if (values.length === 0) database.exec(sql);
      else
        database
          .prepare(sql.replace(/\$[0-9]+/gu, "?"))
          .run(...(values as SQLInputValue[]));
    } else await client!.query(sql, [...values]);
  }
  async function transaction(operation: () => Promise<void>) {
    await execute(database ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      await operation();
      await execute("COMMIT");
    } catch (error) {
      await execute("ROLLBACK");
      throw error;
    }
  }
  async function migrateDirect() {
    if (database) migrateSqlitePluginProjectMetadataOwners(database);
    else await migratePostgresPluginProjectMetadataOwners(client!, f.schema);
  }
  async function mark(
    projectId: string,
    actor?: Readonly<{
      tenantId: string;
      spaceId: string;
      principalId: string;
      actorId: string;
    }>,
  ) {
    const base = metadataOwnerFixtureRecord(projectId);
    const record = parsePluginProjectMetadataOwnerRecord({
      ...base,
      owner: { ...base.owner, ...actor },
    });
    const o = record.owner;
    const values = [
      o.tenantId,
      o.spaceId,
      o.principalId,
      o.actorId,
      o.profileId,
      o.pluginId,
      o.publisherId,
      o.projectId,
      record.createdAt,
      JSON.stringify(record),
    ];
    await execute(
      `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${values.map((_, i) => `$${i + 1}`).join(",")})`,
      values,
    );
  }
  async function begin() {
    await execute(database ? "BEGIN IMMEDIATE" : "BEGIN");
  }
  async function hasBlockedReader() {
    assert.ok(client);
    return Boolean(
      (
        await client.query(
          `SELECT 1 FROM pg_catalog.pg_locks waiting WHERE waiting.locktype='advisory' AND NOT waiting.granted AND pg_backend_pid()=ANY(pg_blocking_pids(waiting.pid)) LIMIT 1`,
        )
      ).rowCount,
    );
  }
  return {
    database,
    client,
    execute,
    transaction,
    begin,
    migrateDirect,
    migrate: () => transaction(migrateDirect),
    mark,
    hasBlockedReader,
  };
}
