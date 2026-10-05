import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  ProjectAssetStageStore,
  ProjectAssetStageRunLocator,
} from "@crewon/application";
import { projectAssetRecord, projectAssetId } from "@crewon/domain";
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
export class SqliteProjectAssetStageStore implements ProjectAssetStageStore {
  readonly version = "crewon.project-asset-stage-run-admission.v1";
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
      migrateSqliteAssetStage(this.#db);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  async loadAssetStageAdmission(i: ProjectAssetStageRunLocator) {
    this.#open();
    return loadSqliteAssetStage(this.#db, locator(i));
  }
  async readRequiredAssetStageDigest(i: ProjectAssetStageRunLocator) {
    this.#open();
    const l = locator(i);
    loadSqliteAssetStage(this.#db, l);
    return sqliteRequiredAssetStageDigest(this.#db, l);
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
  async loadAssetStageAdmission(i: ProjectAssetStageRunLocator) {
    const l = locator(i);
    return this.#with((c) => loadPostgresAssetStage(c, this.#schema, l));
  }
  async readRequiredAssetStageDigest(i: ProjectAssetStageRunLocator) {
    const l = locator(i);
    return this.#with(async (c) => {
      await loadPostgresAssetStage(c, this.#schema, l);
      return postgresRequiredAssetStageDigest(c, this.#schema, l);
    });
  }
}
