import type { DatabaseSync } from "node:sqlite";
import {
  captureProjectMediaInputAuthority,
  assertProjectMediaInputCurrent,
  assertProjectMediaInputActive,
  captureProjectMediaInputWrite,
  parseProjectMediaInputQuery,
  parseProjectMediaInputListQuery,
  parseSaveProjectMediaInputCommand,
  mediaInputActor,
  materialPreparationFields,
  captureProjectGenerationImageResultVerifier,
  type ProjectMediaInputStore,
  type ProjectMediaInputAuthority,
  type ProjectMediaInputRevision,
  type ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import { projectAssetRevision } from "@crewon/domain";
import { assertSqliteProjectAssetSchema } from "./project-asset-schema.ts";
import { assertSqliteProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertSqliteProjectMediaInputSchema,
  migrateSqliteProjectMediaInputs,
} from "./project-media-input-schema.ts";
import {
  loadProjectMediaInputPlan,
  listProjectMediaInputPlan,
  loadProjectMediaInputReceipt,
  saveProjectMediaInputPlan,
  qualifySavedProjectMediaInput,
  qualifyProjectMediaInputPlan,
  type ProjectMediaInputPlan,
} from "./project-media-input-plan.ts";
type Input<K extends keyof ProjectMediaInputStore> = Parameters<
  ProjectMediaInputStore[K]
>[0];
export class SqliteProjectMediaInputStore implements ProjectMediaInputStore {
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
  async migrate() {
    this.#active();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      migrateSqliteProjectMediaInputs(this.#db);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#rollback();
      throw e;
    }
  }
  list(input: Input<"list">, authority: ProjectMediaInputAuthority) {
    const q = parseProjectMediaInputListQuery(input),
      a = captureProjectMediaInputAuthority(
        authority,
        q.actor,
        q.projectId,
        "read",
      );
    return this.#transaction(
      listProjectMediaInputPlan(this.#d, q),
      a,
      () => null,
    );
  }
  load(input: Input<"load">, authority: ProjectMediaInputAuthority) {
    const q = parseProjectMediaInputQuery(input),
      a = captureProjectMediaInputAuthority(
        authority,
        q.actor,
        q.projectId,
        "read",
      );
    return this.#transaction(
      loadProjectMediaInputPlan(this.#d, q),
      a,
      () => null,
    );
  }
  loadReceipt(
    input: Input<"loadReceipt">,
    authority: ProjectMediaInputAuthority,
  ) {
    const fields = materialPreparationFields(input, ["actor", "command"]),
      q = {
        actor: mediaInputActor(fields.actor),
        command: parseSaveProjectMediaInputCommand(fields.command),
      },
      a = captureProjectMediaInputAuthority(
        authority,
        q.actor,
        q.command.projectId,
        "read",
      );
    return this.#transaction(
      loadProjectMediaInputReceipt(this.#d, q),
      a,
      () => null,
    );
  }
  save(input: Input<"save">, authority: ProjectMediaInputAuthority) {
    const q = captureProjectMediaInputWrite(input),
      a = captureProjectMediaInputAuthority(
        authority,
        q.actor,
        q.command.projectId,
        "write",
      );
    return this.#transaction(
      saveProjectMediaInputPlan(this.#d, q, a, this.#verifier),
      a,
      (result) => (result.disposition === "committed" ? result.input : null),
    );
  }
  qualify(input: Input<"qualify">, authority: ProjectMediaInputAuthority) {
    const fields = materialPreparationFields(input, [
        "actor",
        "projectId",
        "mediaInputId",
        "inputRevision",
        "expectedInputRevision",
      ]),
      q = {
        ...parseProjectMediaInputQuery({
          actor: fields.actor,
          projectId: fields.projectId,
          mediaInputId: fields.mediaInputId,
          inputRevision: fields.inputRevision,
        }),
        expectedInputRevision: projectAssetRevision(
          fields.expectedInputRevision,
        ),
      },
      a = captureProjectMediaInputAuthority(
        authority,
        q.actor,
        q.projectId,
        "qualify",
      );
    return this.#transaction(
      qualifySavedProjectMediaInput(this.#d, q, a, this.#verifier),
      a,
      (result) => result,
    );
  }
  #active() {
    this.#open();
    if (this.#db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
      throw new Error("project_media_input_foreign_keys_required");
  }
  #execute<T>(
    plan: ProjectMediaInputPlan<T>,
    a: ProjectMediaInputAuthority,
  ): T {
    let next = plan.next();
    while (!next.done) {
      this.#active();
      assertProjectMediaInputActive(a);
      let rows: readonly Record<string, unknown>[];
      if ("installation" in next.value) {
        assertSqliteProjectTextUiCommit(this.#db, next.value.installation);
        rows = [];
      } else rows = this.#db.prepare(next.value.sql).all(...next.value.values);
      this.#active();
      assertProjectMediaInputActive(a);
      next = plan.next(rows);
    }
    return next.value;
  }
  async #transaction<T>(
    plan: ProjectMediaInputPlan<T>,
    a: ProjectMediaInputAuthority,
    qualify: (r: T) => ProjectMediaInputRevision | null,
  ): Promise<T> {
    this.#active();
    await assertProjectMediaInputCurrent(a, "before");
    await assertProjectMediaInputCurrent(a, "transaction");
    this.#active();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      assertSqliteProjectAssetSchema(this.#db);
      assertSqliteProjectMediaInputSchema(this.#db);
      const result = this.#execute(plan, a),
        record = qualify(result);
      if (record)
        this.#execute(
          qualifyProjectMediaInputPlan(this.#d, record, a, this.#verifier),
          a,
        );
      this.#active();
      assertProjectMediaInputActive(a);
      this.#db.exec("COMMIT");
      return result;
    } catch (e) {
      this.#rollback();
      throw e;
    }
  }
  #rollback() {
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      /* Preserve failure. */
    }
  }
}
