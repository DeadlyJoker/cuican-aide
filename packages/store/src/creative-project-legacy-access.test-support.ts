import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  appendConceptAssetRevision,
  appendProjectBriefRevision,
  renameCreativeProject,
  setCreativeProjectState,
  type CreativeProject,
  type ConceptAsset,
  type ProjectBriefRevision,
} from "@crewon/domain";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import {
  metadataOwnerSchemaFixture,
  metadataOwnerFixtureRecord,
} from "./plugin-project-metadata-owner-schema.test-support.ts";
import { pluginProjectMetadataOwnerColumns } from "./plugin-project-metadata-owner-records.ts";
import { parsePluginProjectMetadataOwnerRecord } from "./plugin-project-metadata-owner-records.ts";
import {
  migratePostgresPluginProjectMetadataOwners,
  migrateSqlitePluginProjectMetadataOwners,
} from "./plugin-project-metadata-owner-schema.ts";
import type { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";
import {
  actor,
  conceptRecipe,
  creationRecipe,
  digester,
  projectTables,
  receipt,
  timestamp,
  type Backend,
} from "./creative-project-store.test-support.ts";

/** Raw owner INSERT is a SQL isolation fixture, never an adoption or Host creation qualification. */
export function constraintOwnerInsert(projectId: string) {
  const record = metadataOwnerFixtureRecord(projectId);
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
  return { columns: pluginProjectMetadataOwnerColumns, values };
}

export async function legacyAccessFixture(
  context: TestContext,
  backend: Backend,
) {
  const f = await metadataOwnerSchemaFixture(context, backend);
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 2,
        })
      : null;
  context.after(async () => {
    await pool?.end();
  });
  const store = pool
    ? new PostgresCreativeProjectStore({
        pool,
        schema: f.schema,
        assertOpen: () => {},
      })
    : f.projects;
  async function create(projectId: string, who = actor) {
    const recipe = creationRecipe(projectId, `create-${projectId}`, who);
    return { recipe, result: await store.commitProjectCreation(recipe) };
  }
  async function snapshot() {
    const result = [];
    for (const table of projectTables)
      result.push(await f.query(`SELECT * FROM $schema.${table}`));
    return result;
  }
  return { ...f, pool, store, create, snapshot };
}

/** Constraint-only fixture on the genuine Run's original database, never a Host project writer. */
export async function protectRunProjectFixture(
  f: Awaited<ReturnType<typeof projectRunCommitFixture>>,
  projectId: string,
) {
  const record = parsePluginProjectMetadataOwnerRecord({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner: {
      ...f.actor,
      profileId: f.admission.profileId,
      pluginId: f.admission.pluginId,
      publisherId: f.admission.publisherId,
      projectId,
    },
    createdAt: timestamp,
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
  if (f.db) {
    f.db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqlitePluginProjectMetadataOwners(f.db);
      f.db
        .prepare(
          `INSERT INTO plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${values.map(() => "?").join(",")})`,
        )
        .run(...values);
      f.db.exec("COMMIT");
    } catch (error) {
      f.db.exec("ROLLBACK");
      throw error;
    }
  } else {
    const client = await f.pool!.connect();
    try {
      await client.query("BEGIN");
      await migratePostgresPluginProjectMetadataOwners(client, f.schema!);
      await client.query(
        `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${values.map((_, i) => `$${i + 1}`).join(",")})`,
        values,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function preparedLegacyMutations(
  project: CreativeProject,
  brief: ProjectBriefRevision,
  asset: ConceptAsset,
) {
  const common = {
    project,
    actor,
    expectedProjectRevision: project.revision,
    at: timestamp,
  };
  const briefChange = appendProjectBriefRevision(
    { ...common, text: "后续需求" },
    digester,
  );
  const conceptChange = appendConceptAssetRevision(
    {
      ...common,
      brief,
      asset,
      expectedAssetMetadataRevision: asset.revision,
      prompt: "后续概念图",
    },
    digester,
  );
  return {
    rename: {
      actor,
      receipt: receipt("rename-protected"),
      kind: "rename-project" as const,
      expectedProjectRevision: project.revision,
      project: renameCreativeProject({ ...common, title: "新名称" }),
    },
    archive: {
      actor,
      receipt: receipt("archive-protected"),
      kind: "set-project-state" as const,
      expectedProjectRevision: project.revision,
      project: setCreativeProjectState({ ...common, state: "archived" }),
    },
    brief: {
      actor,
      receipt: receipt("brief-protected"),
      expectedProjectRevision: project.revision,
      ...briefChange,
    },
    createConcept: conceptRecipe(
      project,
      brief,
      "create-concept-protected",
      "second-asset",
    ),
    appendConcept: {
      actor,
      receipt: receipt("append-concept-protected"),
      kind: "append-concept" as const,
      expectedProjectRevision: project.revision,
      expectedAssetMetadataRevision: asset.revision,
      ...conceptChange,
    },
  };
}
