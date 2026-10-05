import type { DatabaseSync } from "node:sqlite";
import {
  assertProjectAssetCommitCurrent,
  assertProjectAssetCommitTransactionCurrent,
  assertProjectAssetCommitActive,
  captureProjectGenerationImageResultVerifier,
  type ProjectAssetUiIntentJournalStore,
  type ProjectAssetCommitOptions,
  type ProjectAssetRecoveryCommitOptions,
  type ProjectAssetCommitAuthority,
  type ProjectAssetRecoveryCommitAuthority,
  type ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertSqliteAssetIntentSchema,
  migrateSqliteAssetIntent,
} from "./project-asset-ui-intent-schema.ts";
import {
  captureAssetIntentStage,
  captureAssetIntentRejected,
  captureAssetIntentRecovery,
  type IntentInput,
} from "./project-asset-ui-intent-support.ts";
import {
  stageAssetIntent,
  rejectAssetIntent,
  pendingAssetIntent,
  readAssetIntent,
  acknowledgeAssetIntent,
} from "./project-asset-ui-intent-plan.ts";
import type { AssetPlan } from "./project-asset-store-support.ts";
type Fence = ProjectAssetCommitAuthority | ProjectAssetRecoveryCommitAuthority;
type Installation = Parameters<typeof assertSqliteProjectTextUiCommit>[1] & {
  assertCurrent(): Promise<void>;
};
export class SqliteProjectAssetUiIntentJournalStore
  implements ProjectAssetUiIntentJournalStore
{
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier | undefined;
  readonly #d = { postgres: false, schema: "main", prefix: "" };
  constructor(i: {
    database: DatabaseSync;
    assertOpen(): void;
    verifier?: ProjectGenerationImageResultVerifier;
  }) {
    this.#db = i.database;
    this.#open = i.assertOpen.bind(i);
    this.#verifier =
      i.verifier === undefined
        ? undefined
        : captureProjectGenerationImageResultVerifier(i.verifier);
  }
  async migrate() {
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteAssetIntent(this.#db);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  async stage(i: IntentInput<"stage">, o: ProjectAssetCommitOptions) {
    const p = captureAssetIntentStage(i, o);
    return this.#transaction(stageAssetIntent(this.#d, p), p.authority!, p.q);
  }
  async observeRejected(
    i: IntentInput<"observeRejected">,
    o: ProjectAssetCommitOptions,
  ) {
    const p = captureAssetIntentRejected(i, o);
    return this.#transaction(
      rejectAssetIntent(this.#d, p, this.#verifier),
      p.authority!,
      p.q,
    );
  }
  async getPending(
    i: IntentInput<"getPending">,
    o: ProjectAssetRecoveryCommitOptions,
  ) {
    const p = captureAssetIntentRecovery("getPending", i, o);
    return this.#transaction(
      pendingAssetIntent(this.#d, p.scope),
      p.authority,
      p.q,
    );
  }
  async loadIntent(
    i: IntentInput<"loadIntent">,
    o: ProjectAssetRecoveryCommitOptions,
  ) {
    const p = captureAssetIntentRecovery("loadIntent", i, o);
    return this.#transaction(
      readAssetIntent(this.#d, p.intentId!, p.scope),
      p.authority,
      p.q,
    );
  }
  async acknowledge(
    i: IntentInput<"acknowledge">,
    o: ProjectAssetRecoveryCommitOptions,
  ) {
    const p = captureAssetIntentRecovery("acknowledge", i, o);
    return this.#transaction(
      acknowledgeAssetIntent(this.#d, {
        scope: p.scope,
        intentId: p.intentId!,
        expectedRevision: p.expectedRevision!,
        at: p.at!,
      }),
      p.authority,
      p.q,
    );
  }
  async #transaction<T>(
    plan: AssetPlan<T>,
    a: Fence,
    q: Installation,
  ): Promise<T> {
    this.#open();
    await a.assertCurrent();
    await a.assertTransactionCurrent();
    await q.assertCurrent();
    a.assertActive();
    this.#open();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteAssetIntentSchema(this.#db);
      assertSqliteProjectTextUiCommit(this.#db, q);
      let n = plan.next();
      while (!n.done) {
        this.#open();
        a.assertActive();
        n = plan.next(this.#db.prepare(n.value.sql).all(...n.value.values));
      }
      assertSqliteProjectTextUiCommit(this.#db, q);
      a.assertActive();
      this.#open();
      this.#db.exec("COMMIT");
      return n.value;
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw e;
    }
  }
}
