import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  saveProjectOutlineCandidate,
  saveProjectScriptCandidate,
  selectProjectTextRevision,
  setProjectTextArtifactLocked,
  type ProjectTextArtifact,
  type ProjectTextArtifactRevision,
} from "@crewon/domain";
import {
  projectTextFixture,
  textActor,
  textAt,
  textDigester,
} from "./project-text-store.test-support.ts";
import {
  migratePostgresPluginProjectMetadataOwners,
  migrateSqlitePluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import {
  parsePluginProjectMetadataOwnerRecord,
  pluginProjectMetadataOwnerColumns,
} from "./plugin-project-metadata-owner-records.ts";

export type TextLegacyFixture = Awaited<ReturnType<typeof projectTextFixture>>;
export const legacyTextReceipt = (key: string) => ({
  idempotencyKey: key,
  requestDigest: textDigester.sha256(key),
});
export function legacyOutlineRecipe(
  f: TextLegacyFixture,
  key: string,
  artifact: ProjectTextArtifact | null = null,
) {
  const next = saveProjectOutlineCandidate(
    {
      project: f.created.project,
      actor: textActor,
      artifact,
      artifactId: artifact?.artifactId ?? "legacy-outline",
      expectedArtifactRevision: artifact?.revision ?? 0,
      brief: f.created.brief,
      content: {
        title: "雨夜",
        logline: "找到旧信",
        synopsis: "一封旧信揭开谜题",
        episodes: [
          { episodeId: "episode-1", title: "来信", summary: "收到信" },
        ],
      },
      at: textAt,
    },
    textDigester,
  );
  return {
    ...next,
    project: f.created.project,
    actor: textActor,
    expectedArtifactRevision: artifact?.revision ?? 0,
    receipt: legacyTextReceipt(key),
    kind: "save-outline" as const,
  };
}
export function legacyScriptRecipe(f: TextLegacyFixture, key: string) {
  const next = saveProjectScriptCandidate(
    {
      project: f.created.project,
      actor: textActor,
      artifact: null,
      artifactId: "legacy-script",
      expectedArtifactRevision: 0,
      brief: f.created.brief,
      outline: null,
      episodeId: "episode-1",
      content: {
        title: "来信",
        scenes: [
          {
            sceneId: "scene-1",
            location: "工作室",
            timeOfDay: "夜",
            action: "读信",
            dialogue: [{ speaker: "修复师", text: "这是谁的信" }],
          },
        ],
      },
      at: textAt,
    },
    textDigester,
  );
  return {
    ...next,
    project: f.created.project,
    actor: textActor,
    expectedArtifactRevision: 0,
    receipt: legacyTextReceipt(key),
    kind: "save-script" as const,
  };
}
export function legacyTextMetadataRecipes(
  f: TextLegacyFixture,
  artifact: ProjectTextArtifact,
  revision: ProjectTextArtifactRevision,
) {
  return {
    selection: {
      project: f.created.project,
      actor: textActor,
      ...selectProjectTextRevision(
        {
          project: f.created.project,
          actor: textActor,
          artifact,
          expectedArtifactRevision: artifact.revision,
          contentRevision: revision,
          latestBrief: f.created.brief,
          selectedOutline: null,
          at: textAt,
        },
        textDigester,
      ),
      expectedArtifactRevision: artifact.revision,
      receipt: legacyTextReceipt("legacy-select"),
    },
    lock: {
      project: f.created.project,
      actor: textActor,
      ...setProjectTextArtifactLocked({
        project: f.created.project,
        actor: textActor,
        artifact,
        expectedArtifactRevision: artifact.revision,
        locked: false,
        at: textAt,
      }),
      expectedArtifactRevision: artifact.revision,
      receipt: legacyTextReceipt("legacy-lock"),
    },
  };
}
/** Raw SQL ownership is solely an isolation fixture, never a project-creation qualification. */
export function textOwnerInsert(projectId: string) {
  const record = parsePluginProjectMetadataOwnerRecord({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner: {
      ...textActor,
      profileId: "text-legacy-fixture-profile",
      pluginId: "text.fixture",
      publisherId: "text.fixture.publisher",
      projectId,
    },
    createdAt: textAt,
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
export async function protectTextFixture(
  _t: TestContext,
  f: TextLegacyFixture,
  projectId = f.created.project.projectId,
) {
  const raw = textOwnerInsert(projectId);
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

export async function textLegacySqlSnapshot(f: TextLegacyFixture) {
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
