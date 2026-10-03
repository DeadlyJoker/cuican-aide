import type { Pool, PoolClient } from "pg";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  captureProjectGenerationImageResultVerifier,
  type ProjectConceptSelectionStore,
  type ProjectGenerationImageResultVerifier,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertPostgresConceptSelectionSchema,
  migratePostgresConceptSelections,
} from "./concept-selection-schema.ts";
import {
  captureConceptSelection,
  captureConceptSelectionRead,
  captureConceptSelectionReceipt,
  commitConceptSelectionPlan,
  loadConceptSelectionReceiptPlan,
  loadCurrentConceptSelectionPlan,
  type SelectionPlan,
  type SelectionDialect,
} from "./concept-selection-store-support.ts";
import { admitPostgresConceptSelectionSource } from "./concept-selection-publication-admission.ts";

type Input<K extends keyof ProjectConceptSelectionStore> = Parameters<
  Extract<ProjectConceptSelectionStore[K], (...args: never[]) => unknown>
>[0];
/** Independent opt-in sidecar; every transaction owns exactly one connection from its host pool. */
export class PostgresProjectConceptSelectionStore
  implements ProjectConceptSelectionStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #dialect: SelectionDialect;
  readonly #assertOpen: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier;
  #writes = false;
  #reads = false;
  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    verifier: ProjectGenerationImageResultVerifier;
  }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#assertOpen = input.assertOpen;
    this.#verifier = captureProjectGenerationImageResultVerifier(
      input.verifier,
    );
    this.#dialect = Object.freeze({
      postgres: true,
      schema: input.schema,
      prefix: `${creativeProjectSchemaName(input.schema)}.`,
    });
  }
  get projectConceptSelectionVersion() {
    return this.#writes
      ? ("crewon.project-concept-selection.v1" as const)
      : undefined;
  }
  get projectConceptSelectionReadVersion() {
    return this.#reads
      ? ("crewon.project-concept-selection-read.v1" as const)
      : undefined;
  }
  async migrateConceptSelections(): Promise<void> {
    await this.#transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["concept-selection-migration", this.#schema])],
      );
      await migratePostgresConceptSelections(client, this.#schema);
    });
    this.#writes = true;
    this.#reads = true;
  }
  async enableConceptSelectionReads(): Promise<void> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      this.#assertOpen();
      await assertPostgresConceptSelectionSchema(client, this.#schema);
      this.#assertOpen();
      this.#reads = true;
    } finally {
      client.release();
    }
  }
  async loadConceptSelectionReceipt(
    input: Input<"loadConceptSelectionReceipt">,
  ) {
    const query = captureConceptSelectionReceipt(input);
    this.#requireReads();
    return this.#read((client) =>
      this.#execute(
        client,
        loadConceptSelectionReceiptPlan(this.#dialect, query),
      ),
    );
  }
  async loadCurrentConceptSelection(
    input: Input<"loadCurrentConceptSelection">,
  ) {
    const query = captureConceptSelectionRead(input);
    this.#requireReads();
    return this.#read((client) =>
      this.#execute(
        client,
        loadCurrentConceptSelectionPlan(this.#dialect, query),
      ),
    );
  }
  async commitConceptImageSelection(
    input: Input<"commitConceptImageSelection">,
    options: Parameters<
      ProjectConceptSelectionStore["commitConceptImageSelection"]
    >[1],
  ) {
    const prepared = captureConceptSelection(input, options);
    this.#assertOpen();
    if (!this.#writes) throw new Error("concept_selection_not_enabled");
    await assertCreativeProjectCommitCurrent(prepared.authority);
    return this.#transaction(async (client) => {
      await assertPostgresConceptSelectionSchema(client, this.#schema);
      await admitPostgresConceptSelectionSource(
        client,
        this.#schema,
        prepared.source,
      );
      const result = await this.#execute(
        client,
        commitConceptSelectionPlan(this.#dialect, prepared, this.#verifier),
        prepared.authority,
      );
      await assertCreativeProjectCommitCurrent(prepared.authority);
      return result;
    }, prepared.authority);
  }
  #requireReads() {
    this.#assertOpen();
    if (!this.#reads) throw new Error("concept_selection_reads_not_enabled");
  }
  async #read<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      this.#assertOpen();
      await assertPostgresConceptSelectionSchema(client, this.#schema);
      const result = await body(client);
      this.#assertOpen();
      return result;
    } finally {
      client.release();
    }
  }
  async #execute<T>(
    client: PoolClient,
    plan: SelectionPlan<T>,
    authority?: CreativeProjectCommitAuthority,
  ): Promise<T> {
    let next = plan.next();
    while (!next.done) {
      this.#assertOpen();
      assertCreativeProjectCommitActive(authority);
      const rows = await client.query(next.value.sql, [...next.value.values]);
      next = plan.next(rows.rows);
    }
    return next.value;
  }
  async #transaction<T>(
    body: (client: PoolClient) => Promise<T>,
    authority?: CreativeProjectCommitAuthority,
  ): Promise<T> {
    this.#assertOpen();
    assertCreativeProjectCommitActive(authority);
    const client = await this.#pool.connect();
    try {
      this.#assertOpen();
      await client.query("BEGIN");
      const result = await body(client);
      this.#assertOpen();
      assertCreativeProjectCommitActive(authority);
      // An acknowledged COMMIT is final even if the owner's lifetime closes while it is in flight.
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
