import type { DatabaseSync } from "node:sqlite";
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
import { assertSqliteProjectAssetSchema } from "./project-asset-schema.ts";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertSqliteMaterialPreparationSchema,
  migrateSqliteMaterialPreparations,
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
/** Parent-owned connection, explicit independent migration, mandatory preparation-purpose fence. */
export class SqliteProjectMaterialPreparationStore
  implements ProjectMaterialPreparationStore
{
  readonly #db: DatabaseSync;
  readonly #open: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier | undefined;
  readonly #d = Object.freeze({ postgres: false, schema: "main", prefix: "" });
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    verifier?: ProjectGenerationImageResultVerifier;
  }) {
    this.#db = input.database;
    this.#open = input.assertOpen.bind(input);
    this.#verifier =
      input.verifier === undefined
        ? undefined
        : captureProjectGenerationImageResultVerifier(input.verifier);
  }
  async migrate(): Promise<void> {
    this.#active();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteMaterialPreparations(this.#db);
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
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
      (result) => result,
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
      (result) => result.state,
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
      (result) => result.state,
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
      (result) => result,
    );
  }
  #active() {
    this.#open();
    if (this.#db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
      throw new Error("project_material_preparation_foreign_keys_required");
  }
  #execute<T>(
    plan: MaterialPreparationPlan<T>,
    a: ProjectMaterialPreparationCommitAuthority,
  ): T {
    let next = plan.next();
    while (!next.done) {
      this.#active();
      assertProjectMaterialPreparationActive(a);
      let rows: readonly Record<string, unknown>[];
      if ("installation" in next.value) {
        assertSqliteProjectTextUiCommit(this.#db, next.value.installation);
        rows = [];
      } else rows = this.#db.prepare(next.value.sql).all(...next.value.values);
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
    this.#active();
    await assertProjectMaterialPreparationCurrent(a, "before");
    await assertProjectMaterialPreparationCurrent(a, "transaction");
    this.#active();
    // Every operation after BEGIN is synchronous. No filesystem/HTTP or asynchronous grant holds this lock.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectAssetSchema(this.#db);
      assertSqliteMaterialPreparationSchema(this.#db);
      const result = this.#execute(plan, a),
        current = state(result);
      if (current)
        this.#execute(
          qualifyMaterialPreparation(this.#d, current.initial, this.#verifier),
          a,
        );
      assertProjectMaterialPreparationActive(a);
      this.#open();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* Preserve failure. */
      }
      throw error;
    }
  }
}
