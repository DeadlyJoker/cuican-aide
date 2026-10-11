import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { workspaceNamespaceFixture } from "./plugin-project-workspace.test-support.ts";
import {
  migrateSqlitePluginProjectMetadataOwners,
  migratePostgresPluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import { pluginProjectMetadataOwnerColumns as columns } from "./plugin-project-metadata-owner-records.ts";

/** Actual original SQL project/Thread/installation stores; persisted ownership is a named fixture, not a new adoption API. */
export async function ownedConversationSqlFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  mismatch:
    | "matching"
    | "actorId"
    | "profileId"
    | "pluginId"
    | "publisherId" = "matching",
) {
  const f = await workspaceNamespaceFixture(t, backend);
  const owner = { ...f.namespaceOwner() };
  if (mismatch !== "matching") owner[mismatch] = `foreign-${mismatch}`;
  const createdAt = f.namespaceRecipe().createdAt;
  const record = {
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner,
    createdAt,
  };
  const values = [
    owner.tenantId,
    owner.spaceId,
    owner.principalId,
    owner.actorId,
    owner.profileId,
    owner.pluginId,
    owner.publisherId,
    owner.projectId,
    createdAt,
    JSON.stringify(record),
  ];
  if (backend === "sqlite") {
    const db = new DatabaseSync(f.databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      migrateSqlitePluginProjectMetadataOwners(db);
      db.prepare(
        `INSERT INTO plugin_project_metadata_owners(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      ).run(...values);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  } else {
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await migratePostgresPluginProjectMetadataOwners(
        c,
        f.prefix.slice(1, -2),
      );
      await c.query(
        `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${columns.join(",")}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(",")})`,
        values,
      );
      await c.query("COMMIT");
    } finally {
      c.release();
      await pool.end();
    }
  }
  return f;
}
