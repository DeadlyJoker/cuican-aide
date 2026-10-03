import type { DatabaseSync } from "node:sqlite";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  captureProjectGenerationImageResultVerifier,
  type ProjectConceptSelectionStore,
  type ProjectGenerationImageResultVerifier,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import {
  assertSqliteConceptSelectionSchema,
  migrateSqliteConceptSelections,
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
import { admitSqliteConceptSelectionSource } from "./concept-selection-publication-admission.ts";
type Input<K extends keyof ProjectConceptSelectionStore> = Parameters<
  Extract<ProjectConceptSelectionStore[K], (...args: never[]) => unknown>
>[0];
/** Uses its host's connection. Async external policy work finishes before the synchronous SQLite transaction. */
export class SqliteProjectConceptSelectionStore
  implements ProjectConceptSelectionStore
{
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  readonly #verifier: ProjectGenerationImageResultVerifier;
  readonly #dialect: SelectionDialect = Object.freeze({
    postgres: false,
    prefix: "",
    schema: "main",
  });
  #writes = false;
  #reads = false;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    verifier: ProjectGenerationImageResultVerifier;
  }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
    this.#verifier = captureProjectGenerationImageResultVerifier(
      input.verifier,
    );
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
    this.#transaction(() => migrateSqliteConceptSelections(this.#database));
    this.#writes = true;
    this.#reads = true;
  }
  async enableConceptSelectionReads(): Promise<void> {
    this.#assertOpen();
    assertSqliteConceptSelectionSchema(this.#database);
    this.#reads = true;
  }
  async loadConceptSelectionReceipt(
    input: Input<"loadConceptSelectionReceipt">,
  ) {
    const query = captureConceptSelectionReceipt(input);
    this.#requireReads();
    return this.#execute(loadConceptSelectionReceiptPlan(this.#dialect, query));
  }
  async loadCurrentConceptSelection(
    input: Input<"loadCurrentConceptSelection">,
  ) {
    const query = captureConceptSelectionRead(input);
    this.#requireReads();
    return this.#execute(loadCurrentConceptSelectionPlan(this.#dialect, query));
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
    return this.#transaction(() => {
      assertSqliteConceptSelectionSchema(this.#database);
      admitSqliteConceptSelectionSource(this.#database, prepared.source);
      return this.#execute(
        commitConceptSelectionPlan(this.#dialect, prepared, this.#verifier),
        prepared.authority,
      );
    }, prepared.authority);
  }
  #requireReads() {
    this.#assertOpen();
    if (!this.#reads) throw new Error("concept_selection_reads_not_enabled");
    assertSqliteConceptSelectionSchema(this.#database);
  }
  #execute<T>(
    plan: SelectionPlan<T>,
    authority?: CreativeProjectCommitAuthority,
  ): T {
    let next = plan.next();
    while (!next.done) {
      this.#assertOpen();
      assertCreativeProjectCommitActive(authority);
      const rows = this.#database
        .prepare(next.value.sql)
        .all(...next.value.values);
      next = plan.next(rows);
    }
    return next.value;
  }
  #transaction<T>(
    body: () => T,
    authority?: CreativeProjectCommitAuthority,
  ): T {
    this.#assertOpen();
    assertCreativeProjectCommitActive(authority);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#assertOpen();
      assertCreativeProjectCommitActive(authority);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Preserve failure. */
      }
      throw error;
    }
  }
}
