import type { DatabaseSync } from "node:sqlite";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
  type CreativeProjectCommitAuthority,
  type PluginUiIntentJournalStore,
  type PluginUiIntentJournalWriteOptions,
  type PluginUiIntentPayloadVerifier,
} from "@crewon/application";
import {
  assertSqlitePluginUiIntentSchema,
  migrateSqlitePluginUiIntentJournal,
} from "./plugin-ui-intent-schema.ts";
import {
  admitSqlitePluginInstallationPin,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
import {
  captureIntentAuthority,
  captureIntentCommand,
  captureIntentVerifier,
  intentPlan,
  type IntentCommand,
  type IntentPlan,
} from "./plugin-ui-intent-store-support.ts";

type Input<K extends keyof PluginUiIntentJournalStore> = Parameters<
  Extract<PluginUiIntentJournalStore[K], (...args: never[]) => unknown>
>[0];
type Output<K extends keyof PluginUiIntentJournalStore> = Awaited<
  ReturnType<
    Extract<PluginUiIntentJournalStore[K], (...args: never[]) => unknown>
  >
>;
/** Separate, opt-in server journal using the host connection and lifetime. */
export class SqlitePluginUiIntentJournalStore
  implements PluginUiIntentJournalStore
{
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  readonly #verifier: PluginUiIntentPayloadVerifier;
  #writes = false;
  #reads = false;
  #realm: string | undefined;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    verifier: PluginUiIntentPayloadVerifier;
  }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
    this.#verifier = captureIntentVerifier(input.verifier);
  }
  get uiIntentJournalVersion() {
    return this.#writes
      ? ("crewon.plugin-ui-intent-journal.v1" as const)
      : undefined;
  }
  get uiIntentJournalReadVersion() {
    return this.#reads
      ? ("crewon.plugin-ui-intent-journal-read.v1" as const)
      : undefined;
  }
  get uiIntentJournalRealmId() {
    return this.#realm;
  }
  async migratePluginUiIntentJournal(): Promise<void> {
    const realm = this.#transaction(() =>
      migrateSqlitePluginUiIntentJournal(this.#database),
    );
    this.#realm = realm;
    this.#writes = true;
    this.#reads = true;
  }
  async enablePluginUiIntentJournalReads(): Promise<void> {
    this.#assertOpen();
    const realm = assertSqlitePluginUiIntentSchema(this.#database);
    this.#realm = realm;
    this.#reads = true;
  }
  async stageUiIntent(
    input: Input<"stageUiIntent">,
    options: PluginUiIntentJournalWriteOptions,
  ): Promise<Output<"stageUiIntent">> {
    return this.#write("stage", input, options);
  }
  async markUiIntentDispatched(
    input: Input<"markUiIntentDispatched">,
    options: PluginUiIntentJournalWriteOptions,
  ): Promise<Output<"markUiIntentDispatched">> {
    return this.#write("dispatch", input, options);
  }
  async confirmUiIntentAccepted(
    input: Input<"confirmUiIntentAccepted">,
  ): Promise<Output<"confirmUiIntentAccepted">> {
    return this.#write("accept", input);
  }
  async refuseUiIntentFirstDispatch(
    input: Input<"refuseUiIntentFirstDispatch">,
  ): Promise<Output<"refuseUiIntentFirstDispatch">> {
    return this.#write("refuse", input);
  }
  async listUiIntentHints(
    input: Input<"listUiIntentHints">,
  ): Promise<Output<"listUiIntentHints">> {
    const command = captureIntentCommand("list", input);
    this.#require(command, false);
    return this.#execute(
      intentPlan({ postgres: false, prefix: "" }, command, this.#verifier),
    ) as Output<"listUiIntentHints">;
  }
  async #write<T>(
    kind: IntentCommand["kind"],
    input: unknown,
    options?: PluginUiIntentJournalWriteOptions,
  ): Promise<T> {
    const command = captureIntentCommand(kind, input);
    const authority =
      kind === "stage" || kind === "dispatch"
        ? captureIntentAuthority(options!, command.sourcePin!)
        : undefined;
    this.#require(command, true);
    // SQLite cannot await external work while holding its synchronous writer. Actual installation rows remain locked until COMMIT.
    await assertCreativeProjectCommitCurrent(authority);
    await assertCreativeProjectCommitTransactionCurrent(authority);
    return this.#transaction(() => {
      this.#require(command, true);
      if (command.sourcePin) {
        assertSqlitePluginInstallationPinSchema(this.#database);
        const current = admitSqlitePluginInstallationPin(
          this.#database,
          command.sourcePin,
        );
        if (authority?.transaction)
          assertCreativeProjectPluginCommitSelection(
            authority.transaction,
            current,
          );
      }
      return this.#execute(
        intentPlan({ postgres: false, prefix: "" }, command, this.#verifier),
        authority,
      ) as T;
    }, authority);
  }
  #require(command: IntentCommand, write: boolean) {
    this.#assertOpen();
    if (write ? !this.#writes : !this.#reads)
      throw new Error(
        write
          ? "plugin_ui_intent_not_enabled"
          : "plugin_ui_intent_reads_not_enabled",
      );
    const realm = assertSqlitePluginUiIntentSchema(this.#database);
    if (realm !== this.#realm || command.account.controlRealmId !== realm)
      throw new Error("plugin_ui_intent_realm_mismatch");
  }
  #execute<T>(
    plan: IntentPlan<T>,
    authority?: CreativeProjectCommitAuthority,
  ): T {
    let next = plan.next();
    while (!next.done) {
      this.#assertOpen();
      assertCreativeProjectCommitActive(authority);
      next = plan.next(
        this.#database.prepare(next.value.sql).all(...next.value.values),
      );
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
      const value = body();
      this.#assertOpen();
      assertCreativeProjectCommitActive(authority);
      this.#database.exec("COMMIT");
      return value;
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
