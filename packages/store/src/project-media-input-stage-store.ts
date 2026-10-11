import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  ProjectMediaInputStageStore,
  ProjectMediaInputStageRunLocator,
} from "@crewon/application";
import { projectAssetRecord, projectAssetId } from "@crewon/domain";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import { readPostgresLegacyCreativeProject } from "./creative-project-postgres-legacy-read.ts";
import {
  loadSqliteMediaInputStage,
  loadPostgresMediaInputStage,
  sqliteRequiredMediaInputStageDigest,
  postgresRequiredMediaInputStageDigest,
} from "./project-media-input-stage-markers.ts";
import {
  migrateSqliteMediaInputStage,
  migratePostgresMediaInputStage,
} from "./project-media-input-stage-schema.ts";
function locator(input: ProjectMediaInputStageRunLocator) {
  const v = projectAssetRecord(input, ["tenantId", "spaceId", "runId"]);
  return {
    tenantId: projectAssetId(v.tenantId),
    spaceId: projectAssetId(v.spaceId),
    runId: projectAssetId(v.runId),
  };
}
export class SqliteProjectMediaInputStageStore
  implements ProjectMediaInputStageStore
{
  readonly version = "crewon.project-media-input-stage-run-admission.v1";
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  constructor(i: { database: DatabaseSync; assertOpen(): void }) {
    this.#db = i.database;
    this.#open = i.assertOpen.bind(i);
  }
  async migrate() {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteMediaInputStage(this.#db);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  async loadMediaInputStageAdmission(i: ProjectMediaInputStageRunLocator) {
    this.#open();
    const l = locator(i);
    return readSqliteLegacyCreativeProject(this.#db, () =>
      loadSqliteMediaInputStage(this.#db, l),
    );
  }
  async readRequiredMediaInputStageDigest(i: ProjectMediaInputStageRunLocator) {
    this.#open();
    const l = locator(i);
    return readSqliteLegacyCreativeProject(this.#db, () => {
      loadSqliteMediaInputStage(this.#db, l);
      return sqliteRequiredMediaInputStageDigest(this.#db, l);
    });
  }
}
export class PostgresProjectMediaInputStageStore
  implements ProjectMediaInputStageStore
{
  readonly version = "crewon.project-media-input-stage-run-admission.v1";
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #open: () => void;
  constructor(i: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = i.pool;
    this.#schema = i.schema;
    this.#open = i.assertOpen.bind(i);
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
        await migratePostgresMediaInputStage(c, this.#schema);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
  }
  async loadMediaInputStageAdmission(i: ProjectMediaInputStageRunLocator) {
    const l = locator(i);
    return readPostgresLegacyCreativeProject(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#open },
      (c) => loadPostgresMediaInputStage(c, this.#schema, l),
    );
  }
  async readRequiredMediaInputStageDigest(i: ProjectMediaInputStageRunLocator) {
    const l = locator(i);
    return readPostgresLegacyCreativeProject(
      { pool: this.#pool, schema: this.#schema, assertOpen: this.#open },
      async (c) => {
        await loadPostgresMediaInputStage(c, this.#schema, l);
        return postgresRequiredMediaInputStageDigest(c, this.#schema, l);
      },
    );
  }
}
