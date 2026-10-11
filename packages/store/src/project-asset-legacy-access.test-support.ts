import type { TestContext } from "node:test";
import {
  parsePluginProjectMetadataOwnerRecord,
  pluginProjectMetadataOwnerColumns,
} from "./plugin-project-metadata-owner-records.ts";
import {
  migratePostgresPluginProjectMetadataOwners,
  migrateSqlitePluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import { projectAssetFixture, assetAt } from "./project-asset.test-support.ts";

export async function assetLegacyAccessFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await projectAssetFixture(t, backend);
  async function protectProject(projectId: string, pluginId: string) {
    const record = parsePluginProjectMetadataOwnerRecord({
      schemaVersion: "crewon.plugin-project-metadata-owner.v1",
      owner: {
        ...f.actor,
        profileId: "metadata-test-profile",
        pluginId,
        publisherId: "metadata-test-publisher",
        projectId,
      },
      createdAt: assetAt,
    });
    // The field order is explicit: a fixture record is persisted data, never a Host grant.
    const ordered = [
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
    ];
    const insert = `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${ordered.map((_, i) => (backend === "sqlite" ? "?" : `$${i + 1}`)).join(",")})`;
    if (f.database) {
      f.database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      try {
        migrateSqlitePluginProjectMetadataOwners(f.database);
        f.database.prepare(insert).run(...ordered);
        f.database.exec("COMMIT");
      } catch (error) {
        f.database.exec("ROLLBACK");
        throw error;
      }
    } else {
      const client = await f.observerPool!.connect();
      try {
        await client.query("BEGIN");
        await migratePostgresPluginProjectMetadataOwners(client, f.schema);
        await client.query(insert, ordered);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }
  async function snapshot() {
    const result: Record<string, readonly Record<string, unknown>[]> = {};
    for (const table of [
      "project_assets",
      "project_asset_revisions",
      "project_asset_reference_revisions",
      "project_asset_mutation_receipts",
      "project_asset_ui_intents",
    ])
      result[table] = await f.query(`SELECT * FROM ${f.prefix}${table}`);
    return result;
  }
  return { ...f, protectProject, snapshot };
}
