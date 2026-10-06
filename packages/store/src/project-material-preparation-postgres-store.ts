import type { Pool, PoolClient } from "pg";
import {
  parseProjectMaterialPreparationRequest,
  captureProjectMaterialPreparationAuthority,
  assertProjectMaterialPreparationActive,
  assertProjectMaterialPreparationCurrent,
  captureProjectGenerationImageResultVerifier,
  type ProjectMaterialPreparationStore,
  type ProjectMaterialPreparationCommitAuthority,
  type ProjectGenerationImageResultVerifier,
  type ProjectMaterialPreparationState,
} from "@crewon/application";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { assertPostgresProjectAssetSchema } from "./project-asset-schema.ts";
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertPostgresMaterialPreparationSchema,
  migratePostgresMaterialPreparations,
} from "./project-material-preparation-schema.ts";
import {
  loadMaterialPreparation,
  reserveMaterialPreparation,
  claimMaterialPreparation,
  advanceMaterialPreparation,
  qualifyMaterialPreparation,
  captureMaterialPreparationReservation,
  captureMaterialPreparationClaim,
  captureMaterialPreparationAdvance,
  type MaterialPreparationPlan,
} from "./project-material-preparation-plan.ts";
type Input<K extends keyof ProjectMaterialPreparationStore> = Parameters<
  ProjectMaterialPreparationStore[K]
>[0];
/** Exactly one parent-pool borrow for schema, sources, target pins, CAS and final qualification. */
export class PostgresProjectMaterialPreparationStore
  implements ProjectMaterialPreparationStore
{
  readonly #pool: Pool;
  readonly #open: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier | undefined;
  readonly #d: Readonly<{ postgres: true; schema: string; prefix: string }>;
  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    verifier?: ProjectGenerationImageResultVerifier;
  }) {
    this.#pool = input.pool;
    this.#open = input.assertOpen.bind(input);
    this.#d = Object.freeze({
      postgres: true,
      schema: input.schema,
      prefix: `${creativeProjectSchemaName(input.schema)}.`,
    });
    this.#verifier =
      input.verifier === undefined
        ? undefined
        : captureProjectGenerationImageResultVerifier(input.verifier);
  }
  async migrate(): Promise<void> {
    await this.#withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await migratePostgresMaterialPreparations(c, this.#d.schema);
        await c.query("COMMIT");
      } catch (error) {
        try {
          await c.query("ROLLBACK");
        } catch {
          /* Preserve failure. */
        }
        throw error;
      }
    });
  }
  async load(
    input: Input<"load">,
    authority: ProjectMaterialPreparationCommitAuthority,
  ) {
    const request = parseProjectMaterialPreparationRequest(input),
      a = captureProjectMaterialPreparationAuthority(authority, request);
    return this.#transaction(
      loadMaterialPreparation(this.#d, request, this.#verifier),
      a,
      (r) => r,
    );
  }
  async reserve(
    input: Input<"reserve">,
    authority: ProjectMaterialPreparationCommitAuthority,
  ) {
    const q = captureMaterialPreparationReservation(input),
      a = captureProjectMaterialPreparationAuthority(authority, q.request);
    return this.#transaction(
      reserveMaterialPreparation(this.#d, q, this.#verifier),
      a,
      (r) => r.state,
    );
  }
  async claimDispatch(
    input: Input<"claimDispatch">,
    authority: ProjectMaterialPreparationCommitAuthority,
  ) {
    const q = captureMaterialPreparationClaim(input),
      a = captureProjectMaterialPreparationAuthority(authority, q.request);
    return this.#transaction(
      claimMaterialPreparation(this.#d, q, this.#verifier),
      a,
      (r) => r.state,
    );
  }
  async advance(
    input: Input<"advance">,
    authority: ProjectMaterialPreparationCommitAuthority,
  ) {
    const q = captureMaterialPreparationAdvance(input),
      a = captureProjectMaterialPreparationAuthority(authority, q.request);
    return this.#transaction(
      advanceMaterialPreparation(this.#d, q, this.#verifier),
      a,
      (r) => r,
    );
  }
  async #withClient<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    this.#open();
    const c = await this.#pool.connect();
    try {
      this.#open();
      return await work(c);
    } finally {
      c.release();
    }
  }
  async #execute<T>(
    c: PoolClient,
    plan: MaterialPreparationPlan<T>,
    a: ProjectMaterialPreparationCommitAuthority,
  ): Promise<T> {
    let next = plan.next();
    while (!next.done) {
      this.#open();
      assertProjectMaterialPreparationActive(a);
      let rows: readonly Record<string, unknown>[];
      if ("installation" in next.value) {
        await assertPostgresProjectTextUiCommit(
          c,
          this.#d.schema,
          next.value.installation,
        );
        rows = [];
      } else
        rows = (
          await c.query<Record<string, unknown>>(next.value.sql, [
            ...next.value.values,
          ])
        ).rows;
      this.#open();
      assertProjectMaterialPreparationActive(a);
      next = plan.next(rows);
    }
    return next.value;
  }
  async #transaction<T>(
    plan: MaterialPreparationPlan<T>,
    a: ProjectMaterialPreparationCommitAuthority,
    state: (result: T) => ProjectMaterialPreparationState | null,
  ): Promise<T> {
    this.#open();
    await assertProjectMaterialPreparationCurrent(a, "before");
    return this.#withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await assertPostgresProjectAssetSchema(c, this.#d.schema);
        await assertPostgresMaterialPreparationSchema(c, this.#d.schema);
        const result = await this.#execute(c, plan, a);
        await assertProjectMaterialPreparationCurrent(a, "transaction");
        const current = state(result);
        if (current)
          await this.#execute(
            c,
            qualifyMaterialPreparation(
              this.#d,
              current.initial,
              this.#verifier,
            ),
            a,
          );
        assertProjectMaterialPreparationActive(a);
        this.#open();
        await c.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await c.query("ROLLBACK");
        } catch {
          /* Preserve failure. */
        }
        throw error;
      }
    });
  }
}
