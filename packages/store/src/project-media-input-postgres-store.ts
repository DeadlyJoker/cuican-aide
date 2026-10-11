import { capturePostgresAssetLegacyExecution } from "./project-asset-legacy-instruction.ts";
import { assertPostgresProjectMediaResultSchema } from "./project-media-result-schema.ts";
import { assertPostgresProjectMediaOperationSchema } from "./project-media-operation-schema.ts";
import { assertPostgresProjectMediaInputRunQualification } from "./project-media-input-run-qualification.ts";
import type { Pool, PoolClient } from "pg";
import {
  captureProjectMediaInputAuthority,
  assertProjectMediaInputRunCommand,
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
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { assertPostgresProjectAssetSchema } from "./project-asset-schema.ts";
import { assertPostgresProjectTextUiCommit } from "./project-text-ui-commit-support.ts";
import {
  assertPostgresProjectMediaInputSchema,
  migratePostgresProjectMediaInputs,
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
export class PostgresProjectMediaInputStore implements ProjectMediaInputStore {
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
  async migrate() {
    await this.#client(async (c) => {
      await c.query("BEGIN");
      try {
        await migratePostgresProjectMediaInputs(c, this.#d.schema);
        await c.query("COMMIT");
      } catch (e) {
        await this.#rollback(c);
        throw e;
      }
    });
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
    assertProjectMediaInputRunCommand(a.runTransaction, q.actor, q.command);
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
    assertProjectMediaInputRunCommand(a.runTransaction, q.actor, q.command);
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
      (r) => r,
    );
  }
  async #client<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
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
    plan: ProjectMediaInputPlan<T>,
    a: ProjectMediaInputAuthority,
    legacy: ReturnType<typeof capturePostgresAssetLegacyExecution>,
  ): Promise<T> {
    let next = plan.next();
    while (!next.done) {
      this.#open();
      assertProjectMediaInputActive(a);
      let rows: readonly Record<string, unknown>[];
      if ("assetLegacyAccess" in next.value) {
        rows = await legacy.execute(next.value);
      } else if ("mediaResultSchema" in next.value) {
        await assertPostgresProjectMediaResultSchema(c, this.#d.schema);
        rows = [];
      } else if ("mediaOperationSchema" in next.value) {
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
    this.#open();
    await assertProjectMediaInputCurrent(a, "before");
    return this.#client(async (c) => {
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        await assertPostgresProjectAssetSchema(c, this.#d.schema);
        await assertPostgresProjectMediaInputSchema(c, this.#d.schema);
        await assertPostgresProjectMediaInputRunQualification(
          c,
          this.#d.schema,
          a,
        );
        const legacy = capturePostgresAssetLegacyExecution(c, this.#d.schema);
        const result = await this.#execute(c, plan, a, legacy);
        await assertProjectMediaInputCurrent(a, "transaction");
        const record = qualify(result);
        if (record)
          await this.#execute(
            c,
            qualifyProjectMediaInputPlan(this.#d, record, a, this.#verifier),
            a,
            legacy,
          );
        await legacy.assertCurrent();
        await assertProjectMediaInputCurrent(a, "transaction");
        this.#open();
        assertProjectMediaInputActive(a);
        await assertPostgresProjectMediaInputRunQualification(
          c,
          this.#d.schema,
          a,
        );
        assertProjectMediaInputActive(a);
        await c.query("COMMIT");
        return result;
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
      /* Preserve failure. */
    }
  }
}
