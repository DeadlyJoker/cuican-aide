import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import {
  captureAssetV2RecoveryAuthority,
  assetV2RecoveryInvalid,
  type ProjectAssetV2RecoveryStore,
  type ProjectAssetV2RecoveryAuthority,
} from "@crewon/application";
import { PROJECT_ASSET_RECOVERY_V2_ACTIONS as actions } from "@crewon/contracts/project-asset-recovery-v2";
import { projectAssetTimestamp } from "@crewon/domain";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";
import {
  assertSqliteAssetVtwoRecoverySchema,
  assertPostgresAssetVtwoRecoverySchema,
  migrateSqliteAssetVtwoRecovery,
  migratePostgresAssetVtwoRecovery,
} from "./project-asset-vtwo-recovery-schema.ts";
import {
  stageAssetVtwoRecovery,
  pendingAssetVtwoRecovery,
  assetVtwoById,
  settleAssetVtwoRecovery,
} from "./project-asset-vtwo-recovery-plan.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import type { AssetPlan, AssetDialect } from "./project-asset-store-support.ts";

abstract class RecoveryOperations implements ProjectAssetV2RecoveryStore {
  abstract migrate(): Promise<void>;
  protected abstract dialect: AssetDialect;
  protected abstract transaction<T>(
    plan: AssetPlan<T>,
    authority: ProjectAssetV2RecoveryAuthority,
  ): Promise<T>;
  stage(
    input: Readonly<{ at: string }>,
    authority: ProjectAssetV2RecoveryAuthority,
  ) {
    const a = captureAssetV2RecoveryAuthority(authority);
    return this.transaction(
      stageAssetVtwoRecovery(this.dialect, a, projectAssetTimestamp(input.at)),
      a,
    );
  }
  getPending(authority: ProjectAssetV2RecoveryAuthority) {
    const a = captureAssetV2RecoveryAuthority(authority);
    if (a.request.action !== actions.getPending) assetV2RecoveryInvalid();
    return this.transaction(pendingAssetVtwoRecovery(this.dialect, a.scope), a);
  }
  loadIntent(authority: ProjectAssetV2RecoveryAuthority) {
    const a = captureAssetV2RecoveryAuthority(authority);
    if (
      a.request.action !== actions.acknowledge &&
      a.request.action !== actions.cancelPending
    )
      assetV2RecoveryInvalid();
    return this.transaction(
      assetVtwoById(this.dialect, a.scope, a.request.input.intentId),
      a,
    );
  }
  async cancelPending(
    input: Readonly<{ at: string }>,
    authority: ProjectAssetV2RecoveryAuthority,
  ) {
    const a = captureAssetV2RecoveryAuthority(authority);
    return (
      await this.transaction(
        settleAssetVtwoRecovery(
          this.dialect,
          a,
          projectAssetTimestamp(input.at),
          "cancel",
        ),
        a,
      )
    ).record;
  }
  acknowledge(
    input: Readonly<{ at: string }>,
    authority: ProjectAssetV2RecoveryAuthority,
  ) {
    const a = captureAssetV2RecoveryAuthority(authority);
    return this.transaction(
      settleAssetVtwoRecovery(
        this.dialect,
        a,
        projectAssetTimestamp(input.at),
        "acknowledge",
      ),
      a,
    );
  }
}
/** Shares the parent connection: no separate journal database or asynchronous callback under SQLite's write lock. */
export class SqliteProjectAssetV2RecoveryStore extends RecoveryOperations {
  protected readonly dialect = { postgres: false, schema: "main", prefix: "" };
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  constructor(i: { database: DatabaseSync; assertOpen(): void }) {
    super();
    this.#db = i.database;
    this.#open = i.assertOpen.bind(i);
  }
  async migrate() {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteAssetVtwoRecovery(this.#db);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#rollback();
      throw e;
    }
  }
  protected async transaction<T>(
    plan: AssetPlan<T>,
    a: ProjectAssetV2RecoveryAuthority,
  ) {
    this.#open();
    await a.assertCurrent();
    await a.assertTransactionCurrent();
    a.assertActive();
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteAssetVtwoRecoverySchema(this.#db);
      const installation = {
        ...a.scope,
        selection: a.selection,
        package: a.package,
      };
      assertSqliteProjectTextUiCommit(this.#db, installation);
      let n = plan.next();
      while (!n.done) {
        this.#open();
        a.assertActive();
        n = plan.next(this.#db.prepare(n.value.sql).all(...n.value.values));
      }
      assertSqliteProjectTextUiCommit(this.#db, installation);
      a.assertActive();
      this.#open();
      this.#db.exec("COMMIT");
      return n.value;
    } catch (e) {
      this.#rollback();
      throw e;
    }
  }
  #rollback() {
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      /* Preserve original failure. */
    }
  }
}
/** Uses one parent pool borrow; transaction callbacks must never acquire another connection. */
export class PostgresProjectAssetV2RecoveryStore extends RecoveryOperations {
  protected readonly dialect: AssetDialect;
  readonly #pool: Pool;
  readonly #open: () => void;
  constructor(i: { pool: Pool; schema: string; assertOpen(): void }) {
    super();
    this.#pool = i.pool;
    this.#open = i.assertOpen.bind(i);
    this.dialect = {
      postgres: true,
      schema: i.schema,
      prefix: `${creativeProjectSchemaName(i.schema)}.`,
    };
  }
  async #with<T>(work: (c: PoolClient) => Promise<T>) {
    this.#open();
    const c = await this.#pool.connect();
    try {
      this.#open();
      return await work(c);
    } finally {
      c.release();
    }
  }
  async migrate() {
    await this.#with(async (c) => {
      await c.query("BEGIN");
      try {
        await migratePostgresAssetVtwoRecovery(c, this.dialect.schema);
        await c.query("COMMIT");
      } catch (e) {
        await this.#rollback(c);
        throw e;
      }
    });
  }
  protected async transaction<T>(
    plan: AssetPlan<T>,
    a: ProjectAssetV2RecoveryAuthority,
  ) {
    this.#open();
    await a.assertCurrent();
    a.assertActive();
    return this.#with(async (c) => {
      await c.query("BEGIN");
      try {
        await assertPostgresAssetVtwoRecoverySchema(c, this.dialect.schema);
        const installation = {
          ...a.scope,
          selection: a.selection,
          package: a.package,
        };
        await assertPostgresProjectTextUiCommit(
          c,
          this.dialect.schema,
          installation,
        );
        let n = plan.next();
        while (!n.done) {
          this.#open();
          a.assertActive();
          n = plan.next((await c.query(n.value.sql, [...n.value.values])).rows);
        }
        await a.assertTransactionCurrent();
        await assertPostgresProjectTextUiCommit(
          c,
          this.dialect.schema,
          installation,
        );
        a.assertActive();
        this.#open();
        await c.query("COMMIT");
        return n.value;
      } catch (e) {
        await this.#rollback(c);
        throw e;
      }
    });
  }
  async #rollback(c: PoolClient) {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* Preserve original failure. */
    }
  }
}
