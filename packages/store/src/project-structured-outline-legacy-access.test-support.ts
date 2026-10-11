import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  actor,
  time,
  type StructuredOutlineFixture,
} from "./project-structured-outline.test-support.ts";
import {
  parsePluginProjectMetadataOwnerRecord,
  pluginProjectMetadataOwnerColumns,
} from "./plugin-project-metadata-owner-records.ts";
import {
  migrateSqlitePluginProjectMetadataOwners,
  migratePostgresPluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";

/** SQL constraint fixture only; this is not a protected-project creation or adoption grant. */
export function structuredOwnerInsert(projectId: string) {
  const record = parsePluginProjectMetadataOwnerRecord({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner: {
      ...actor,
      profileId: "structured-fixture",
      pluginId: "structured.fixture",
      publisherId: "structured.fixture.publisher",
      projectId,
    },
    createdAt: time(),
  });
  return {
    columns: pluginProjectMetadataOwnerColumns,
    values: [
      record.owner.tenantId,
      record.owner.spaceId,
      record.owner.principalId,
      record.owner.actorId,
      record.owner.profileId,
      record.owner.pluginId,
      record.owner.publisherId,
      record.owner.projectId,
      record.createdAt,
      JSON.stringify(record),
    ],
  };
}
export async function protectStructuredFixture(
  _t: TestContext,
  f: StructuredOutlineFixture,
) {
  const raw = structuredOwnerInsert(f.created.project.projectId);
  if (f.prefix === "") {
    const db = new DatabaseSync(f.path);
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      migrateSqlitePluginProjectMetadataOwners(db);
      db.prepare(
        `INSERT INTO plugin_project_metadata_owners(${raw.columns.join(",")}) VALUES(${raw.values.map(() => "?").join(",")})`,
      ).run(...raw.values);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  } else {
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 1,
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await migratePostgresPluginProjectMetadataOwners(client, f.schema);
      await client.query(
        `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${raw.columns.join(",")}) VALUES(${raw.values.map((_, i) => `$${i + 1}`).join(",")})`,
        raw.values,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
}
export async function structuredLegacySnapshot(f: StructuredOutlineFixture) {
  const rows = [];
  for (const table of [
    "project_text_artifacts",
    "project_text_revisions",
    "project_text_mutation_receipts",
  ])
    rows.push(
      await f.sql(`SELECT * FROM ${f.prefix}${table} ORDER BY project_id`),
    );
  return rows;
}
