import {
  readSqliteAssetRuntimeMetadata,
  readPostgresAssetRuntimeMetadata,
  type ProjectAssetRuntimeReadOptions,
} from "./project-asset-runtime-read.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  ProjectAssetStageStore,
  ProjectAssetStageRunLocator,
} from "@crewon/application";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "@crewon/application";
import { readSqliteOwnedCreativeProject } from "./plugin-project-owned-read-sqlite.ts";
import { readPostgresOwnedCreativeProject } from "./plugin-project-owned-read-postgres.ts";
import { projectAssetRecord, projectAssetId } from "@crewon/domain";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import { readPostgresLegacyCreativeProject } from "./creative-project-postgres-legacy-read.ts";
import {
  loadSqliteAssetStage,
  loadPostgresAssetStage,
  sqliteRequiredAssetStageDigest,
  postgresRequiredAssetStageDigest,
} from "./project-asset-stage-markers.ts";
import {
  migrateSqliteAssetStage,
  migratePostgresAssetStage,
} from "./project-asset-stage-schema.ts";
function locator(input: ProjectAssetStageRunLocator) {
  const v = projectAssetRecord(input, ["tenantId", "spaceId", "runId"]);
  return {
    tenantId: projectAssetId(v.tenantId),
    spaceId: projectAssetId(v.spaceId),
    runId: projectAssetId(v.runId),
  };
}
function stageReadView(
  store: ProjectAssetStageStore & {
    loadAssetStageAdmission(
      i: ProjectAssetStageRunLocator,
      scope?: PluginProjectReadScope | ProjectAssetRuntimeReadOptions,
    ): ReturnType<ProjectAssetStageStore["loadAssetStageAdmission"]>;
    readRequiredAssetStageDigest(
      i: ProjectAssetStageRunLocator,
      scope?: PluginProjectReadScope | ProjectAssetRuntimeReadOptions,
    ): ReturnType<ProjectAssetStageStore["readRequiredAssetStageDigest"]>;
  },
  scope: PluginProjectReadScope,
): ProjectAssetStageStore {
  const source = qualifyPluginProjectReadScope(scope);
  if (
    source.assetStageRead === undefined ||
    source.request.action !== "crewon.project-asset-stage-read.v1" ||
    source.request.input.purpose !== "start-stage"
  )
    throw new Error("project_asset_stage_read_scope_mismatch");
  return Object.freeze({
    version: store.version,
    migrate: async () => {
      throw new Error("project_asset_stage_read_view_cannot_migrate");
    },
    loadAssetStageAdmission: (i: ProjectAssetStageRunLocator) =>
      store.loadAssetStageAdmission(i, scope),
    readRequiredAssetStageDigest: (i: ProjectAssetStageRunLocator) =>
      store.readRequiredAssetStageDigest(i, scope),
  });
}
function stageReadCall(
  i: ProjectAssetStageRunLocator,
  scope: PluginProjectReadScope,
  method: "loadAssetStageAdmission" | "readRequiredAssetStageDigest",
) {
  const source = qualifyPluginProjectReadScope(scope),
    b = source.assetStageRead?.binding;
  if (!b || i.tenantId !== b.owner.tenantId || i.spaceId !== b.owner.spaceId)
    throw new Error("project_asset_stage_read_scope_mismatch");
  return {
    scope,
    method,
    query: {
      owner: {
        tenantId: b.owner.tenantId,
        spaceId: b.owner.spaceId,
        principalId: b.owner.principalId,
      },
      projectId: b.projectId,
    },
  } as const;
}
function assertReadAdmission(
  scope: PluginProjectReadScope,
  a: Awaited<ReturnType<ProjectAssetStageStore["loadAssetStageAdmission"]>>,
) {
  const b = qualifyPluginProjectReadScope(scope).assetStageRead!.binding;
  if (
    a !== null &&
    (a.projectId !== b.projectId ||
      a.threadId !== b.threadId ||
      a.bindingId !== b.bindingId ||
      a.bindingRevision !== b.revision)
  )
    throw new Error("project_asset_stage_read_target_mismatch");
}
export class SqliteProjectAssetStageStore implements ProjectAssetStageStore {
  readonly version = "crewon.project-asset-stage-run-admission.v1";
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  constructor(i: { database: DatabaseSync; assertOpen(): void }) {
    this.#db = i.database;
    this.#open = i.assertOpen.bind(i);
  }
  bindProjectReads(scope: PluginProjectReadScope) {
    return stageReadView(this, scope);
  }
  async migrate() {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteAssetStage(this.#db);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  async loadAssetStageAdmission(
    i: ProjectAssetStageRunLocator,
    scope?: PluginProjectReadScope | ProjectAssetRuntimeReadOptions,
  ) {
    this.#open();
    const l = locator(i);
    if (
      scope !== undefined &&
      Object.hasOwn(scope, "projectAssetRuntimeReadObservation")
    )
      return readSqliteAssetRuntimeMetadata(
        {
          database: this.#db,
          assertOpen: this.#open,
          request: l,
          options: scope as ProjectAssetRuntimeReadOptions,
        },
        (projectAccess) => loadSqliteAssetStage(this.#db, l, { projectAccess }),
      );
    if (scope !== undefined) {
      const call = stageReadCall(
        l,
        scope as PluginProjectReadScope,
        "loadAssetStageAdmission",
      );
      const result = await readSqliteOwnedCreativeProject(
        this.#db,
        call,
        (projectAccess) => {
          const value = loadSqliteAssetStage(this.#db, l, { projectAccess });
          assertReadAdmission(scope as PluginProjectReadScope, value);
          return { projectId: call.query.projectId, value };
        },
        this.#open,
      );
      return result.value;
    }
    return readSqliteLegacyCreativeProject(this.#db, () =>
      loadSqliteAssetStage(this.#db, l),
    );
  }
  async readRequiredAssetStageDigest(
    i: ProjectAssetStageRunLocator,
    scope?: PluginProjectReadScope | ProjectAssetRuntimeReadOptions,
  ) {
    this.#open();
    const l = locator(i);
    if (
      scope !== undefined &&
      Object.hasOwn(scope, "projectAssetRuntimeReadObservation")
    )
      return readSqliteAssetRuntimeMetadata(
        {
          database: this.#db,
          assertOpen: this.#open,
          request: l,
          options: scope as ProjectAssetRuntimeReadOptions,
        },
        (projectAccess) => {
          loadSqliteAssetStage(this.#db, l, { projectAccess });
          return sqliteRequiredAssetStageDigest(this.#db, l);
        },
      );
    if (scope !== undefined) {
      const call = stageReadCall(
        l,
        scope as PluginProjectReadScope,
        "readRequiredAssetStageDigest",
      );
      const result = await readSqliteOwnedCreativeProject(
        this.#db,
        call,
        (projectAccess) => {
          assertReadAdmission(
            scope as PluginProjectReadScope,
            loadSqliteAssetStage(this.#db, l, { projectAccess }),
          );
          return {
            projectId: call.query.projectId,
            value: sqliteRequiredAssetStageDigest(this.#db, l),
          };
        },
        this.#open,
      );
      return result.value;
    }
    return readSqliteLegacyCreativeProject(this.#db, () => {
      loadSqliteAssetStage(this.#db, l);
      return sqliteRequiredAssetStageDigest(this.#db, l);
    });
  }
}
export class PostgresProjectAssetStageStore implements ProjectAssetStageStore {
  readonly version = "crewon.project-asset-stage-run-admission.v1";
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #open: () => void;
  constructor(i: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = i.pool;
    this.#schema = i.schema;
    this.#open = i.assertOpen.bind(i);
  }
  bindProjectReads(scope: PluginProjectReadScope) {
    return stageReadView(this, scope);
  }
  async #with<T>(f: (c: PoolClient) => Promise<T>) {
    this.#open();
    const c = await this.#pool.connect();
    try {
      this.#open();
      return await f(c);
    } finally {
      c.release();
    }
  }
  async migrate() {
    await this.#with(async (c) => {
      await c.query("BEGIN");
      try {
        await migratePostgresAssetStage(c, this.#schema);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
  }
  async loadAssetStageAdmission(
    i: ProjectAssetStageRunLocator,
    scope?: PluginProjectReadScope | ProjectAssetRuntimeReadOptions,
  ) {
    const l = locator(i);
    if (
      scope !== undefined &&
      Object.hasOwn(scope, "projectAssetRuntimeReadObservation")
    )
      return readPostgresAssetRuntimeMetadata(
        {
          pool: this.#pool,
          schema: this.#schema,
          assertOpen: this.#open,
          request: l,
          options: scope as ProjectAssetRuntimeReadOptions,
        },
        (c, projectAccess) =>
          loadPostgresAssetStage(c, this.#schema, l, { projectAccess }),
      );
    if (scope !== undefined) {
      const call = stageReadCall(
        l,
        scope as PluginProjectReadScope,
        "loadAssetStageAdmission",
      );
      const result = await readPostgresOwnedCreativeProject(
        { pool: this.#pool, schema: this.#schema, assertOpen: this.#open },
        call,
        async (c, projectAccess) => {
          const value = await loadPostgresAssetStage(c, this.#schema, l, {
            projectAccess,
          });
          assertReadAdmission(scope as PluginProjectReadScope, value);
          return { projectId: call.query.projectId, value };
        },
      );
      return result.value;
    }
    return readPostgresLegacyCreativeProject(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#open },
      (c) => loadPostgresAssetStage(c, this.#schema, l),
    );
  }
  async readRequiredAssetStageDigest(
    i: ProjectAssetStageRunLocator,
    scope?: PluginProjectReadScope | ProjectAssetRuntimeReadOptions,
  ) {
    const l = locator(i);
    if (
      scope !== undefined &&
      Object.hasOwn(scope, "projectAssetRuntimeReadObservation")
    )
      return readPostgresAssetRuntimeMetadata(
        {
          pool: this.#pool,
          schema: this.#schema,
          assertOpen: this.#open,
          request: l,
          options: scope as ProjectAssetRuntimeReadOptions,
        },
        async (c, projectAccess) => {
          await loadPostgresAssetStage(c, this.#schema, l, { projectAccess });
          return postgresRequiredAssetStageDigest(c, this.#schema, l);
        },
      );
    if (scope !== undefined) {
      const call = stageReadCall(
        l,
        scope as PluginProjectReadScope,
        "readRequiredAssetStageDigest",
      );
      const result = await readPostgresOwnedCreativeProject(
        { pool: this.#pool, schema: this.#schema, assertOpen: this.#open },
        call,
        async (c, projectAccess) => {
          assertReadAdmission(
            scope as PluginProjectReadScope,
            await loadPostgresAssetStage(c, this.#schema, l, { projectAccess }),
          );
          return {
            projectId: call.query.projectId,
            value: await postgresRequiredAssetStageDigest(c, this.#schema, l),
          };
        },
      );
      return result.value;
    }
    return readPostgresLegacyCreativeProject(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#open },
      async (c) => {
        await loadPostgresAssetStage(c, this.#schema, l);
        return postgresRequiredAssetStageDigest(c, this.#schema, l);
      },
    );
  }
}
