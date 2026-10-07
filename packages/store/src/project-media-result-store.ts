import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  parseProjectAssetMediaReferenceImageRequest,
  type ProjectAssetMediaReferenceImageRequest,
  type ProjectAssetMediaReferenceImageStore,
} from "@crewon/application";
import { loadAssetMediaReferenceImagePlan } from "./project-asset-media-reference-image-plan.ts";
import {
  parseProjectAssetMediaAdoptionWrite,
  captureProjectAssetMediaAdoptionAuthority,
  type ProjectAssetMediaAdoptionWrite,
  type ProjectAssetMediaAdoptionAuthority,
  type ProjectAssetMediaAdoptionStore,
} from "@crewon/application";
import { adoptAssetMediaReferencePlan } from "./project-asset-media-adoption-plan.ts";
import {
  assertSqliteAssetMediaAdoptionSchema,
  assertPostgresAssetMediaAdoptionSchema,
  migrateSqliteAssetMediaAdoptions,
  migratePostgresAssetMediaAdoptions,
} from "./project-asset-media-adoption-schema.ts";
import {
  parseProjectAssetMediaReferenceQualificationRequest,
  projectAssetMediaReferenceResultRequest,
  type ProjectAssetMediaReferenceQualificationRequest,
  type ProjectAssetMediaReferenceQualificationStore,
} from "@crewon/application";
import { qualifyAssetMediaReferencePlan } from "./project-asset-media-reference-plan.ts";
import {
  assertSqliteProjectAssetSchema,
  assertPostgresProjectAssetSchema,
} from "./project-asset-schema.ts";
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
export class SqliteProjectMediaResultStore
  implements
    ProjectMediaResultStore,
    ProjectAssetMediaReferenceQualificationStore,
    ProjectAssetMediaAdoptionStore,
    ProjectAssetMediaReferenceImageStore
{
  #enabled = false;
  #assetAdoptionsEnabled = false;
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
  async migrateAssetAdoptions() {
    this.#active();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteAssetMediaAdoptions(this.#db);
      this.#active();
      this.#db.exec("COMMIT");
      this.#assetAdoptionsEnabled = true;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }
  adoptAssetReference(
    input: ProjectAssetMediaAdoptionWrite,
    authority: ProjectAssetMediaAdoptionAuthority,
  ) {
    const write = parseProjectAssetMediaAdoptionWrite(input),
      captured = captureProjectAssetMediaAdoptionAuthority(
        authority,
        write.request,
      );
    return this.#transaction(
      adoptAssetMediaReferencePlan(this.#d, write),
      captured,
      "adoption",
    );
  }
  loadAdoptedAssetReference(
    input: ProjectAssetMediaReferenceImageRequest,
    authority: ProjectMediaResultAuthority,
  ) {
    const request = parseProjectAssetMediaReferenceImageRequest(input),
      captured = capture(authority.request, authority, "read");
    return this.#transaction(
      loadAssetMediaReferenceImagePlan(this.#d, request, captured.request),
      captured.authority,
      "read",
    );
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
    a: Pick<
      ProjectMediaResultAuthority,
      "assertCurrent" | "assertActive" | "uiInstallation"
    > &
      Readonly<{ assertTransactionCurrent?: () => Promise<void> }>,
    purpose: "candidate" | "catalog" | "read" | "adoption" = "candidate",
  ): Promise<T> {
    this.#active();
    if (
      purpose === "adoption"
        ? !this.#assetAdoptionsEnabled
        : !this.#enabled &&
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
      if (purpose === "adoption")
        assertSqliteAssetMediaAdoptionSchema(this.#db);
      assertSqliteProjectTextUiCommit(this.#db, a.uiInstallation);
      let next = plan.next();
      while (!next.done) {
        this.#active();
        a.assertActive();
        let rows: readonly Record<string, unknown>[];
        if ("mediaOperationSchema" in next.value) {
          assertSqliteProjectMediaOperationSchema(this.#db);
          rows = [];
        } else if ("assetSchema" in next.value) {
          assertSqliteProjectAssetSchema(this.#db);
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
      assertSqliteProjectTextUiCommit(this.#db, a.uiInstallation);
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
  qualifyAssetReference(
    input: ProjectAssetMediaReferenceQualificationRequest,
    a: ProjectMediaResultAuthority,
  ) {
    const request = parseProjectAssetMediaReferenceQualificationRequest(input),
      captured = capture(
        projectAssetMediaReferenceResultRequest(request),
        a,
        "read",
      );
    return this.#transaction(
      qualifyAssetMediaReferencePlan(this.#d, request),
      captured.authority,
      "read",
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
  implements
    ProjectMediaResultStore,
    ProjectAssetMediaReferenceQualificationStore,
    ProjectAssetMediaAdoptionStore,
    ProjectAssetMediaReferenceImageStore
{
  #enabled = false;
  #assetAdoptionsEnabled = false;
  loadAdoptedAssetReference(
    input: ProjectAssetMediaReferenceImageRequest,
    authority: ProjectMediaResultAuthority,
  ) {
    const request = parseProjectAssetMediaReferenceImageRequest(input),
      captured = capture(authority.request, authority, "read");
    return this.#transaction(
      loadAssetMediaReferenceImagePlan(this.#d, request, captured.request),
      captured.authority,
      "read",
    );
  }
  async migrateAssetAdoptions() {
    await this.#client(async (c) => {
      await c.query("BEGIN");
      try {
        await migratePostgresAssetMediaAdoptions(c, this.#d.schema);
        this.#open();
        await c.query("COMMIT");
        this.#assetAdoptionsEnabled = true;
      } catch (error) {
        await this.#rollback(c);
        throw error;
      }
    });
  }
  adoptAssetReference(
    input: ProjectAssetMediaAdoptionWrite,
    authority: ProjectAssetMediaAdoptionAuthority,
  ) {
    const write = parseProjectAssetMediaAdoptionWrite(input),
      captured = captureProjectAssetMediaAdoptionAuthority(
        authority,
        write.request,
      );
    return this.#transaction(
      adoptAssetMediaReferencePlan(this.#d, write),
      captured,
      "adoption",
    );
  }
  qualifyAssetReference(
    input: ProjectAssetMediaReferenceQualificationRequest,
    a: ProjectMediaResultAuthority,
  ) {
    const request = parseProjectAssetMediaReferenceQualificationRequest(input),
      captured = capture(
        projectAssetMediaReferenceResultRequest(request),
        a,
        "read",
      );
    return this.#transaction(
      qualifyAssetMediaReferencePlan(this.#d, request),
      captured.authority,
      "read",
    );
  }
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
  async #transaction<T>(
    plan: MediaResultPlan<T>,
    a: Pick<
      ProjectMediaResultAuthority,
      "assertCurrent" | "assertActive" | "uiInstallation"
    > &
      Readonly<{ assertTransactionCurrent?: () => Promise<void> }>,
    purpose: "candidate" | "catalog" | "read" | "adoption" = "candidate",
  ): Promise<T> {
    // Adoption preflight may read the original project through the same one-slot
    // pool. Finish it before borrowing the commit connection; only the dedicated
    // transaction callback is allowed to run while that connection is held.
    if (purpose === "adoption") {
      this.#open();
      if (!this.#assetAdoptionsEnabled) fail("unavailable");
      await a.assertCurrent();
      this.#open();
      a.assertActive();
    }
    return this.#client(async (c) => {
      if (
        purpose === "adoption"
          ? !this.#assetAdoptionsEnabled
          : !this.#enabled &&
            !(purpose === "catalog" && this.#catalogEnabled) &&
            !(purpose === "read" && this.#resultReadsEnabled)
      )
        fail("unavailable");
      if (purpose !== "adoption") await a.assertCurrent();
      this.#open();
      a.assertActive();
      await c.query("BEGIN");
      try {
        await assertPostgresProjectMediaResultSchema(c, this.#d.schema);
        if (purpose === "adoption")
          await assertPostgresAssetMediaAdoptionSchema(c, this.#d.schema);
        await assertPostgresProjectTextUiCommit(
          c,
          this.#d.schema,
          a.uiInstallation,
        );
        let next = plan.next();
        while (!next.done) {
          this.#open();
          a.assertActive();
          let rows: readonly Record<string, unknown>[];
          if ("mediaOperationSchema" in next.value) {
            await assertPostgresProjectMediaOperationSchema(c, this.#d.schema);
            rows = [];
          } else if ("assetSchema" in next.value) {
            await assertPostgresProjectAssetSchema(c, this.#d.schema);
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
        await assertPostgresProjectTextUiCommit(
          c,
          this.#d.schema,
          a.uiInstallation,
        );
        if (a.assertTransactionCurrent) await a.assertTransactionCurrent();
        else await a.assertCurrent();
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
