import { capturePostgresAssetLegacyExecution } from "./project-asset-legacy-instruction.ts";
import type { Pool, PoolClient } from "pg";
import {
  captureProjectGenerationImageResultVerifier,
  type ProjectAssetUiIntentJournalStore,
  type ProjectAssetCommitOptions,
  type ProjectAssetRecoveryCommitOptions,
  type ProjectAssetCommitAuthority,
  type ProjectAssetRecoveryCommitAuthority,
  type ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertPostgresAssetIntentSchema,
  migratePostgresAssetIntent,
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
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
type Fence = ProjectAssetCommitAuthority | ProjectAssetRecoveryCommitAuthority;
type Installation = Parameters<typeof assertPostgresProjectTextUiCommit>[2] & {
  assertCurrent(): Promise<void>;
};
export class PostgresProjectAssetUiIntentJournalStore
  implements ProjectAssetUiIntentJournalStore
{
  readonly #pool: Pool;
  readonly #open: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier | undefined;
  readonly #d: Readonly<{ postgres: true; schema: string; prefix: string }>;
  constructor(i: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    verifier?: ProjectGenerationImageResultVerifier;
  }) {
    this.#pool = i.pool;
    this.#open = i.assertOpen.bind(i);
    this.#verifier =
      i.verifier === undefined
        ? undefined
        : captureProjectGenerationImageResultVerifier(i.verifier);
    this.#d = {
      postgres: true,
      schema: i.schema,
      prefix: `${creativeProjectSchemaName(i.schema)}.`,
    };
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
        await migratePostgresAssetIntent(c, this.#d.schema);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
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
    a.assertActive();
    return this.#with(async (c) => {
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await assertPostgresAssetIntentSchema(c, this.#d.schema);
        await assertPostgresProjectTextUiCommit(c, this.#d.schema, q);
        const legacy = capturePostgresAssetLegacyExecution(c, this.#d.schema);
        let n = plan.next();
        while (!n.done) {
          this.#open();
          a.assertActive();
          n = plan.next(
            "assetLegacyAccess" in n.value
              ? await legacy.execute(n.value)
              : (await c.query(n.value.sql, [...n.value.values])).rows,
          );
        }
        await legacy.assertCurrent();
        await a.assertTransactionCurrent();
        await q.assertCurrent();
        await assertPostgresProjectTextUiCommit(c, this.#d.schema, q);
        a.assertActive();
        this.#open();
        await c.query("COMMIT");
        return n.value;
      } catch (e) {
        try {
          await c.query("ROLLBACK");
        } catch {
          /* Preserve original failure. */
        }
        throw e;
      }
    });
  }
}
