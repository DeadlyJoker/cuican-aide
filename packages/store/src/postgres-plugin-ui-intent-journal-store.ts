import type { Pool, PoolClient } from "pg";
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
  assertPostgresPluginUiIntentSchema,
  migratePostgresPluginUiIntentJournal,
} from "./plugin-ui-intent-schema.ts";
import {
  admitPostgresPluginInstallationPin,
  assertPostgresPluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
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
/** All locks and pure payload checks run on one connection from the original host pool. */
export class PostgresPluginUiIntentJournalStore
  implements PluginUiIntentJournalStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  readonly #verifier: PluginUiIntentPayloadVerifier;
  #writes = false;
  #reads = false;
  #realm: string | undefined;
  constructor(input: {
    pool: Pool;
    schema: string;
    assertOpen(): void;
    verifier: PluginUiIntentPayloadVerifier;
  }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${creativeProjectSchemaName(input.schema)}.`;
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
    const realm = await this.#transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify(["plugin-ui-intent-migration", this.#schema])],
      );
      return migratePostgresPluginUiIntentJournal(client, this.#schema);
    });
    this.#realm = realm;
    this.#writes = true;
    this.#reads = true;
  }
  async enablePluginUiIntentJournalReads(): Promise<void> {
    const realm = await this.#read((client) =>
      assertPostgresPluginUiIntentSchema(client, this.#schema),
    );
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
  async refuseUiIntentUnadmittedQuery(
    input: Input<"refuseUiIntentUnadmittedQuery">,
  ): Promise<Output<"refuseUiIntentUnadmittedQuery">> {
    return this.#write("refuseQuery", input);
  }
  async listUiIntentHints(
    input: Input<"listUiIntentHints">,
  ): Promise<Output<"listUiIntentHints">> {
    const command = captureIntentCommand("list", input);
    this.#flag(false);
    return this.#read(async (client) => {
      await this.#require(client, command);
      return this.#execute(
        client,
        intentPlan(
          { postgres: true, prefix: this.#prefix },
          command,
          this.#verifier,
        ),
      ) as Promise<Output<"listUiIntentHints">>;
    });
  }
  async #write<T>(
    kind: IntentCommand["kind"],
    input: unknown,
    options?: PluginUiIntentJournalWriteOptions,
  ): Promise<T> {
    const command = captureIntentCommand(kind, input),
      authority =
        kind === "stage" || kind === "dispatch"
          ? captureIntentAuthority(options!, command.sourcePin!)
          : undefined;
    this.#flag(true);
    await assertCreativeProjectCommitCurrent(authority);
    return this.#transaction(async (client) => {
      await this.#require(client, command);
      if (command.sourcePin) {
        await assertPostgresPluginInstallationPinSchema(client, this.#schema);
        const current = await admitPostgresPluginInstallationPin(
          client,
          this.#schema,
          command.sourcePin,
        );
        if (authority?.transaction)
          assertCreativeProjectPluginCommitSelection(
            authority.transaction,
            current,
          );
      }
      const result = await this.#execute(
        client,
        intentPlan(
          { postgres: true, prefix: this.#prefix },
          command,
          this.#verifier,
        ),
        authority,
      );
      await assertCreativeProjectCommitTransactionCurrent(authority);
      return result as T;
    }, authority);
  }
  #flag(write: boolean) {
    this.#assertOpen();
    if (write ? !this.#writes : !this.#reads)
      throw new Error(
        write
          ? "plugin_ui_intent_not_enabled"
          : "plugin_ui_intent_reads_not_enabled",
      );
  }
  async #require(client: PoolClient, command: IntentCommand) {
    this.#assertOpen();
    const realm = await assertPostgresPluginUiIntentSchema(
      client,
      this.#schema,
    );
    if (realm !== this.#realm || command.account.controlRealmId !== realm)
      throw new Error("plugin_ui_intent_realm_mismatch");
  }
  async #execute<T>(
    client: PoolClient,
    plan: IntentPlan<T>,
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
  async #read<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      this.#assertOpen();
      const value = await body(client);
      this.#assertOpen();
      return value;
    } finally {
      client.release();
    }
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
      const value = await body(client);
      this.#assertOpen();
      assertCreativeProjectCommitActive(authority);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Preserve failure. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
