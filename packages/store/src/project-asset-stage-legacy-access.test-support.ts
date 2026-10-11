import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import type { ProjectAssetStageCommitAuthority } from "@crewon/application";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import { mediaInputStageFixture } from "./project-media-input-stage.test-support.ts";
import { assetAt } from "./project-asset.test-support.ts";
import {
  migrateSqlitePluginProjectMetadataOwners,
  migratePostgresPluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import {
  parsePluginProjectMetadataOwnerRecord,
  pluginProjectMetadataOwnerColumns,
} from "./plugin-project-metadata-owner-records.ts";

/** Real original Host preparation and cold SQL readers; the persisted owner is a fixture, never a Native grant. */
export async function assetStageLegacyFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "asset" | "media-input",
) {
  async function asset() {
    const f = await conversationFixture(t, backend),
      prepared = await f.prepare();
    await f.store.commitBinding(prepared, { authority: f.authority });
    await f.parent.projectTextStore().migrate();
    await f.parent.projectAssetStore().migrate();
    const stages = f.parent.projectAssetStageStore();
    await stages.migrate();
    const brief = await f.metadata.loadBrief({
      owner: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      },
      projectId: f.reference.projectId,
      briefRevision: 1,
    });
    assert.ok(brief);
    const authority: ProjectAssetStageCommitAuthority = {
        ...f.authority,
        version: "crewon.project-asset-stage-commit.v1",
      },
      command = {
        pluginId: f.pin.pluginId,
        threadId: prepared.binding.threadId,
        expectedThreadRevision: 1,
        idempotencyKey: "asset-stage-legacy-original",
        intent: {
          kind: "generate" as const,
          input: { prompt: "Create one character archive candidate" },
        },
      },
      first = await f.tasks.createProjectAssetStageTurnFromHost(
        f.actor,
        command,
        {
          binding: prepared.binding,
          stage: {
            kind: "assets",
            assetKind: "character",
            briefRevision: 1,
            script: null,
          },
          sources: {
            brief: { briefRevision: 1, contentDigest: brief.contentDigest },
            script: null,
          },
          content: command.intent.input.prompt,
          authority,
          conversations: f.store,
          stages,
        },
      );
    return { f, first, admission: first.assetStageAdmission };
  }
  async function mediaInput() {
    const f = await mediaInputStageFixture(t, backend),
      first = await f.startStage();
    return { f, first, admission: first.mediaInputStageAdmission };
  }
  const { f, first, admission } = await (kind === "asset"
      ? asset()
      : mediaInput()),
    schema = backend === "postgres" ? f.prefix.slice(1, -2) : "main",
    database = backend === "sqlite" ? new DatabaseSync(f.databasePath) : null,
    pool =
      backend === "postgres"
        ? new Pool({
            connectionString: process.env.CREWON_TEST_POSTGRES_URL,
            max: 1,
          })
        : null;
  t.after(async () => {
    database?.close();
    await pool?.end();
  });
  const locator = {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      runId: first.result.binding.runId,
    },
    receipt = {
      ...first.result.binding,
      receipt: {
        actorId: f.actor.actorId,
        idempotencyKey: admission.idempotencyKey,
        requestDigest: admission.requestDigest,
      },
    };
  async function protect() {
    const record = parsePluginProjectMetadataOwnerRecord({
        schemaVersion: "crewon.plugin-project-metadata-owner.v1",
        owner: {
          ...f.actor,
          profileId: "stage-negative-profile",
          pluginId: "fixture.stage-negative",
          publisherId: "stage-negative-publisher",
          projectId: admission.projectId,
        },
        createdAt: assetAt,
      }),
      values = [
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
      sql = `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${values.map((_, i) => (backend === "sqlite" ? "?" : `$${i + 1}`)).join(",")})`;
    if (database) {
      database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      try {
        migrateSqlitePluginProjectMetadataOwners(database);
        database.prepare(sql).run(...values);
        database.exec("COMMIT");
      } catch (e) {
        database.exec("ROLLBACK");
        throw e;
      }
    } else {
      const c = await pool!.connect();
      try {
        await c.query("BEGIN");
        await migratePostgresPluginProjectMetadataOwners(c, schema);
        await c.query(sql, values);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
  }
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of [
      "run_snapshots",
      "extension_run_bindings",
      "plugin_task_admissions",
      kind === "asset"
        ? "project_asset_stage_run_admissions"
        : "project_media_input_stage_run_admissions",
    ])
      result[table] = await f.rows(`SELECT * FROM ${f.prefix}${table}`);
    return result;
  }
  return {
    ...f,
    first,
    admission,
    locator,
    receipt,
    database,
    pool,
    schema,
    protect,
    snapshot,
  };
}
