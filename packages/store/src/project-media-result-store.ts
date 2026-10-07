import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  parseProjectMediaResultRequest,
  parseProjectMediaResultCatalogRequest,
  captureProjectMediaResultCatalogAuthority,
  type ProjectMediaResultCatalogRequest,
  type ProjectMediaResultCatalogAuthority,
  parseProjectMediaResultCandidate,
  captureProjectMediaResultAuthority,
  mediaResultFail as fail,
  type ProjectMediaResultStore,
  type ProjectMediaResultAuthority,
  type ProjectMediaResultRequest,
  type ProjectMediaResultCandidate,
} from "@crewon/application";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  mediaResultSourcePlan,
  mediaResultCatalogPlan,
  mediaResultLoadPlan,
  mediaResultSavePlan,
  mediaResultPublicationPlan,
  type MediaResultPlan,
} from "./project-media-result-plan.ts";
import {
  assertSqliteProjectMediaResultSchema,
  assertPostgresProjectMediaResultSchema,
  migrateSqliteProjectMediaResults,
  migratePostgresProjectMediaResults,
} from "./project-media-result-schema.ts";
import {
  assertSqliteProjectMediaOperationSchema,
  assertPostgresProjectMediaOperationSchema,
} from "./project-media-operation-schema.ts";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";
import type { AssetDialect } from "./project-asset-store-support.ts";
const version = "crewon.project-media-result-candidate.v1";
const capture = (
  q: ProjectMediaResultRequest,
  a: ProjectMediaResultAuthority,
  action: "read" | "publish",
) => {
  const request = parseProjectMediaResultRequest(q);
  return {
    request,
    authority: captureProjectMediaResultAuthority(a, request, action),
  };
};
/** Explicit opt-in child on the original native connection; constructors never migrate. */
export class SqliteProjectMediaResultStore implements ProjectMediaResultStore {
  #enabled = false;
  #catalogEnabled = false;
  #resultReadsEnabled = false;
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  readonly #d: AssetDialect = Object.freeze({
    postgres: false,
    schema: "main",
    prefix: "",
  });
  constructor(db: DatabaseSync, assertOpen: () => void) {
    this.#db = db;
    this.#open = assertOpen;
  }
  get version() {
    return this.#enabled ? version : undefined;
  }
  #active() {
    this.#open();
    if (this.#db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
      fail("foreign_keys_required");
  }
  async enableResultReads() {
    await this.enableCatalogReads();
    this.#resultReadsEnabled = true;
  }
  async enableCatalogReads() {
    this.#active();
    assertSqliteProjectMediaResultSchema(this.#db);
    this.#active();
    this.#catalogEnabled = true;
  }
  async migrate() {
    this.#active();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteProjectMediaResults(this.#db);
      this.#active();
      this.#db.exec("COMMIT");
      this.#enabled = true;
    } catch (e) {
      this.#rollback();
      throw e;
    }
  }
  #rollback() {
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      /* Original failure survives. */
    }
  }
  async #transaction<T>(
    plan: MediaResultPlan<T>,
    a: Pick<ProjectMediaResultAuthority, "assertCurrent" | "assertActive">,
    purpose: "candidate" | "catalog" | "read" = "candidate",
  ): Promise<T> {
    this.#active();
    if (
      !this.#enabled &&
      !(purpose === "catalog" && this.#catalogEnabled) &&
      !(purpose === "read" && this.#resultReadsEnabled)
    )
      fail("unavailable");
    await a.assertCurrent();
    this.#active();
    a.assertActive();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectMediaResultSchema(this.#db);
      let next = plan.next();
      while (!next.done) {
        this.#active();
        a.assertActive();
        let rows: readonly Record<string, unknown>[];
        if ("mediaOperationSchema" in next.value) {
          assertSqliteProjectMediaOperationSchema(this.#db);
          rows = [];
        } else if ("installation" in next.value) {
          assertSqliteProjectTextUiCommit(this.#db, next.value.installation);
          rows = [];
        } else
          rows = this.#db.prepare(next.value.sql).all(...next.value.values);
        this.#active();
        a.assertActive();
        next = plan.next(rows);
      }
      // SQLite callbacks must be synchronous while this borrowed native connection is in a transaction.
      this.#active();
      a.assertActive();
      this.#db.exec("COMMIT");
      return next.value;
    } catch (e) {
      this.#rollback();
      throw e;
    }
  }
  listCandidates(
    input: ProjectMediaResultCatalogRequest,
    authority: ProjectMediaResultCatalogAuthority,
  ) {
    const request = parseProjectMediaResultCatalogRequest(input);
    const captured = captureProjectMediaResultCatalogAuthority(
      authority,
      request,
    );
    return this.#transaction(
      mediaResultCatalogPlan(this.#d, request),
      captured,
      "catalog",
    );
  }
  qualifyPublication(
    input: ProjectMediaResultRequest,
    a: ProjectMediaResultAuthority,
  ) {
    const q = capture(input, a, "publish");
    return this.#transaction(
      mediaResultPublicationPlan(this.#d, q.request),
      q.authority,
    );
  }
  loadSource(input: ProjectMediaResultRequest, a: ProjectMediaResultAuthority) {
    const q = capture(input, a, "read");
    return this.#transaction(
      mediaResultSourcePlan(this.#d, q.request),
      q.authority,
      "read",
    );
  }
  loadCandidate(
    input: ProjectMediaResultRequest,
    a: ProjectMediaResultAuthority,
  ) {
    const q = capture(input, a, "read");
    return this.#transaction(
      mediaResultLoadPlan(this.#d, q.request),
      q.authority,
      "read",
    );
  }
  saveCandidate(
    input: ProjectMediaResultCandidate,
    a: ProjectMediaResultAuthority,
  ) {
    const candidate = parseProjectMediaResultCandidate(input),
      q = capture(a.request, a, "publish");
    return this.#transaction(
      mediaResultSavePlan(this.#d, q.request, candidate),
      q.authority,
    );
  }
}
export class PostgresProjectMediaResultStore
  implements ProjectMediaResultStore
{
  #enabled = false;
  #catalogEnabled = false;
  #resultReadsEnabled = false;
  readonly #pool: Pool;
  readonly #open: () => void;
  readonly #d: AssetDialect;
  constructor(pool: Pool, schema: string, assertOpen: () => void) {
    this.#pool = pool;
    this.#open = assertOpen;
    this.#d = Object.freeze({
      postgres: true,
      schema,
      prefix: creativeProjectSchemaName(schema) + ".",
    });
  }
  get version() {
    return this.#enabled ? version : undefined;
  }
  async #client<T>(work: (c: PoolClient) => Promise<T>) {
    this.#open();
    const c = await this.#pool.connect();
    try {
      this.#open();
      return await work(c);
    } finally {
      c.release();
    }
  }
  async #rollback(c: PoolClient) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* Original failure survives. */
    }
  }
  async enableResultReads() {
    await this.enableCatalogReads();
    this.#resultReadsEnabled = true;
  }
  async enableCatalogReads() {
    await this.#client(async (c) => {
      await assertPostgresProjectMediaResultSchema(c, this.#d.schema);
      this.#open();
      this.#catalogEnabled = true;
    });
  }
  async migrate() {
    await this.#client(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify(["project-media-result-migration", this.#d.schema]),
        ]);
        await migratePostgresProjectMediaResults(c, this.#d.schema);
        this.#open();
        await c.query("COMMIT");
        this.#enabled = true;
      } catch (e) {
        await this.#rollback(c);
        throw e;
      }
    });
  }
  #transaction<T>(
    plan: MediaResultPlan<T>,
    a: Pick<ProjectMediaResultAuthority, "assertCurrent" | "assertActive">,
    purpose: "candidate" | "catalog" | "read" = "candidate",
  ): Promise<T> {
    return this.#client(async (c) => {
      if (
        !this.#enabled &&
        !(purpose === "catalog" && this.#catalogEnabled) &&
        !(purpose === "read" && this.#resultReadsEnabled)
      )
        fail("unavailable");
      await a.assertCurrent();
      this.#open();
      a.assertActive();
      await c.query("BEGIN");
      try {
        await assertPostgresProjectMediaResultSchema(c, this.#d.schema);
        let next = plan.next();
        while (!next.done) {
          this.#open();
          a.assertActive();
          let rows: readonly Record<string, unknown>[];
          if ("mediaOperationSchema" in next.value) {
            await assertPostgresProjectMediaOperationSchema(c, this.#d.schema);
            rows = [];
          } else if ("installation" in next.value) {
            await assertPostgresProjectTextUiCommit(
              c,
              this.#d.schema,
              next.value.installation,
            );
            rows = [];
          } else
            rows = (await c.query(next.value.sql, [...next.value.values])).rows;
          this.#open();
          a.assertActive();
          next = plan.next(rows);
        }
        await a.assertCurrent();
        this.#open();
        a.assertActive();
        await c.query("COMMIT");
        return next.value;
      } catch (e) {
        await this.#rollback(c);
        throw e;
      }
    });
  }
  listCandidates(
    input: ProjectMediaResultCatalogRequest,
    authority: ProjectMediaResultCatalogAuthority,
  ) {
    const request = parseProjectMediaResultCatalogRequest(input);
    const captured = captureProjectMediaResultCatalogAuthority(
      authority,
      request,
    );
    return this.#transaction(
      mediaResultCatalogPlan(this.#d, request),
      captured,
      "catalog",
    );
  }
  qualifyPublication(
    input: ProjectMediaResultRequest,
    a: ProjectMediaResultAuthority,
  ) {
    const q = capture(input, a, "publish");
    return this.#transaction(
      mediaResultPublicationPlan(this.#d, q.request),
      q.authority,
    );
  }
  loadSource(input: ProjectMediaResultRequest, a: ProjectMediaResultAuthority) {
    const q = capture(input, a, "read");
    return this.#transaction(
      mediaResultSourcePlan(this.#d, q.request),
      q.authority,
      "read",
    );
  }
  loadCandidate(
    input: ProjectMediaResultRequest,
    a: ProjectMediaResultAuthority,
  ) {
    const q = capture(input, a, "read");
    return this.#transaction(
      mediaResultLoadPlan(this.#d, q.request),
      q.authority,
      "read",
    );
  }
  saveCandidate(
    input: ProjectMediaResultCandidate,
    a: ProjectMediaResultAuthority,
  ) {
    const candidate = parseProjectMediaResultCandidate(input),
      q = capture(a.request, a, "publish");
    return this.#transaction(
      mediaResultSavePlan(this.#d, q.request, candidate),
      q.authority,
    );
  }
}
