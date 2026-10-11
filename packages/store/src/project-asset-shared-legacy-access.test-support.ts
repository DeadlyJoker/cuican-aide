import type { TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type { ProjectAssetV2RecoveryAuthority } from "@crewon/application";
import { assetLegacyAccessFixture } from "./project-asset-legacy-access.test-support.ts";
import { assetAt } from "./project-asset.test-support.ts";
import {
  migrateSqliteProjectMediaInputs,
  migratePostgresProjectMediaInputs,
} from "./project-media-input-schema.ts";
import {
  migrateSqliteMaterialPreparations,
  migratePostgresMaterialPreparations,
} from "./project-material-preparation-schema.ts";
import {
  migrateSqliteProjectMediaGenerations,
  migratePostgresProjectMediaGenerations,
} from "./project-media-generation-schema.ts";
import {
  migrateSqliteProjectMediaOperations,
  migratePostgresProjectMediaOperations,
} from "./project-media-operation-schema.ts";
import {
  migrateSqliteProjectMediaResults,
  migratePostgresProjectMediaResults,
} from "./project-media-result-schema.ts";
import {
  migrateSqliteAssetMediaAdoptions,
  migratePostgresAssetMediaAdoptions,
} from "./project-asset-media-adoption-schema.ts";
import {
  parsePluginProjectMetadataOwnerRecord,
  pluginProjectMetadataOwnerColumns,
} from "./plugin-project-metadata-owner-records.ts";

/** Named Store-port authority and actual parent storage, never a Native grant. */
export async function sharedAssetFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await assetLegacyAccessFixture(t, backend);
  const recovery = f.parent.projectAssetV2RecoveryStore();
  async function migrateRecovery() {
    await f.parent.extensionStore().migrate();
    await f.parent.extensionStore().migratePluginAdmissions();
    await f.parent.externalOperationStore().migrate();
    if (f.database) {
      f.database.exec("BEGIN IMMEDIATE");
      try {
        migrateSqliteProjectMediaInputs(f.database);
        migrateSqliteMaterialPreparations(f.database);
        migrateSqliteProjectMediaGenerations(f.database);
        migrateSqliteProjectMediaOperations(f.database);
        migrateSqliteProjectMediaResults(f.database);
        migrateSqliteAssetMediaAdoptions(f.database);
        f.database.exec("COMMIT");
      } catch (error) {
        f.database.exec("ROLLBACK");
        throw error;
      }
    } else {
      const client = await f.observerPool!.connect();
      try {
        await client.query("BEGIN");
        await migratePostgresProjectMediaInputs(client, f.schema);
        await migratePostgresMaterialPreparations(client, f.schema);
        await migratePostgresProjectMediaGenerations(client, f.schema);
        await migratePostgresProjectMediaOperations(client, f.schema);
        await migratePostgresProjectMediaResults(client, f.schema);
        await migratePostgresAssetMediaAdoptions(client, f.schema);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await recovery.migrate();
  }
  function v2Authority(
    request: ProjectAssetV2RecoveryAuthority["request"],
  ): ProjectAssetV2RecoveryAuthority {
    const original = f.legacyGrant();
    return {
      version: "crewon.project-asset-v2-recovery-authority.v1",
      scope: f.scope,
      selection: f.source.selection,
      package: f.source.package,
      request,
      assertCurrent: original.authority.assertCurrent,
      assertTransactionCurrent: original.authority.transaction!.assertCurrent,
      assertActive: original.authority.assertActive,
    };
  }
  async function journalSnapshot() {
    const result = await f.snapshot();
    return {
      ...result,
      v2: await f.query(
        `SELECT * FROM ${f.prefix}project_asset_versioned_intents`,
      ),
    };
  }
  function insertOwnerAfterJournalSql(
    projectId: string,
    journal: "project_asset_ui_intents" | "project_asset_versioned_intents",
  ) {
    const record = parsePluginProjectMetadataOwnerRecord({
      schemaVersion: "crewon.plugin-project-metadata-owner.v1",
      owner: {
        ...f.actor,
        profileId: "metadata-test-profile",
        pluginId: "fixture.after-journal-sql",
        publisherId: "metadata-test-publisher",
        projectId,
      },
      createdAt: assetAt,
    });
    const values = [
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
    const statement = `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${values.map((_, i) => (backend === "sqlite" ? "?" : `$${i + 1}`)).join(",")})`;
    let inserted = false;
    const matches = (sql: string) =>
      !inserted && sql.startsWith(`INSERT INTO ${f.prefix}${journal}(`);
    const database =
      f.database &&
      (new Proxy(f.database, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              const prepared = target.prepare(sql);
              return new Proxy(prepared, {
                get(row, method) {
                  if (method === "all")
                    return (...input: (string | number | null)[]) => {
                      const result = row.all(...input);
                      if (matches(sql)) {
                        inserted = true;
                        target.prepare(statement).run(...values);
                      }
                      return result;
                    };
                  const value = Reflect.get(row, method, row);
                  return typeof value === "function" ? value.bind(row) : value;
                },
              });
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DatabaseSync | null);
    const pool =
      f.pool &&
      (new Proxy(f.pool, {
        get(target, key) {
          if (key === "connect")
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(connection, method) {
                  if (method === "query")
                    return async (sql: string, input?: unknown[]) => {
                      const result = await connection.query(sql, input);
                      if (matches(sql)) {
                        inserted = true;
                        await connection.query(statement, values);
                      }
                      return result;
                    };
                  const value = Reflect.get(connection, method, connection);
                  return typeof value === "function"
                    ? value.bind(connection)
                    : value;
                },
              }) as PoolClient;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Pool | null);
    return { database, pool, inserted: () => inserted };
  }
  return {
    ...f,
    v2Recovery: recovery,
    migrateRecovery,
    v2Authority,
    journalSnapshot,
    insertOwnerAfterJournalSql,
    at: assetAt,
  };
}
