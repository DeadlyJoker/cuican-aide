import type { Pool, PoolClient } from "pg";
import type {
  PluginCreditEntry,
  PluginCreditStore,
  PluginCreditReadStore,
  PluginCreditAccountListInput,
  PluginCreditEntriesReadInput,
} from "@crewon/application";
import {
  CreditLedgerError,
  createCreditAccount,
  grantCreditAccount,
  settleCreditReservation,
  releaseCreditReservation,
  validateCreditScope,
  validateCreditReservationInput,
  type CreditAccount,
  type CreditReservation,
  type CreditReservationInput,
  type CreditScope,
} from "@crewon/domain";
import {
  migratePostgresPluginCredits,
  pluginCreditSchemaName,
} from "./plugin-credit-schema.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import { PostgresPluginCreditRead } from "./postgres-plugin-credit-read.ts";
import {
  lockPostgresPluginCreditAccount,
  reservePostgresPluginCreditsWithinTransaction,
} from "./postgres-plugin-credit-reservation.ts";
import {
  creditAmount,
  creditEntriesQuery,
  creditEntry,
  creditIdentifier,
  creditScopeValues,
  decodeCreditAccount,
  decodeCreditEntry,
  decodeCreditReservation,
} from "./plugin-credit-support.ts";

/** Host-owned Pool. All plugins sharing a personal pool serialize on the same account lock. */
export class PostgresPluginCreditStore
  implements PluginCreditStore, PluginCreditReadStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;

  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#prefix = `${pluginCreditSchemaName(input.schema)}.`;
    this.#schema = input.schema;
    this.#pool = input.pool;
    this.#assertOpen = input.assertOpen;
  }

  async listAccounts(input: PluginCreditAccountListInput) {
    return new PostgresPluginCreditRead({
      pool: this.#pool,
      schema: this.#schema,
      assertOpen: this.#assertOpen,
    }).listAccounts(input);
  }

  async readEntries(input: PluginCreditEntriesReadInput) {
    return new PostgresPluginCreditRead({
      pool: this.#pool,
      schema: this.#schema,
      assertOpen: this.#assertOpen,
    }).readEntries(input);
  }

  async migrate(): Promise<void> {
    await this.#transaction(null, async (client) => {
      await migratePostgresPluginCredits(client, this.#schema);
      this.#assertOpen();
    });
  }

  async getAccount(scope: CreditScope): Promise<CreditAccount | null> {
    this.#assertOpen();
    return this.#account(this.#pool, validateCreditScope(scope));
  }

  async getReservation(input: { scope: CreditScope; reservationId: string }) {
    this.#assertOpen();
    return this.#reservation(
      this.#pool,
      validateCreditScope(input.scope),
      "reservation_id",
      creditIdentifier(input.reservationId),
    );
  }

  async grant(input: { scope: CreditScope; grantId: string; credits: string }) {
    const scope = validateCreditScope(input.scope);
    const grantId = creditIdentifier(input.grantId);
    const credits = creditAmount(input.credits, "positive");
    return this.#transaction(scope, async (client) => {
      const before = await this.#account(client, scope);
      const receipt = await this.#query(
        client,
        `SELECT credits FROM ${this.#prefix}plugin_credit_grant_receipts WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND grant_id=$4`,
        [...creditScopeValues(scope), grantId],
      );
      const replay = receipt.rows[0];
      if (replay !== undefined) {
        if (creditAmount(replay.credits, "positive") !== credits)
          throw new CreditLedgerError("plugin_credit_grant_conflict");
        if (before === null)
          throw new CreditLedgerError("plugin_credit_account_not_found");
        return before;
      }
      const account = grantCreditAccount(
        before ?? createCreditAccount(scope),
        credits,
      );
      await this.#writeAccount(client, account);
      await this.#query(
        client,
        `INSERT INTO ${this.#prefix}plugin_credit_grant_receipts VALUES($1,$2,$3,$4,$5)`,
        [...creditScopeValues(scope), grantId, credits],
      );
      await this.#appendEntry(
        client,
        creditEntry({ account, kind: "grant", credits, grantId }),
      );
      return account;
    });
  }

  async reserve(input: CreditReservationInput): Promise<CreditReservation> {
    const checked = validateCreditReservationInput(input);
    return this.#transaction(checked.scope, (client) =>
      reservePostgresPluginCreditsWithinTransaction({
        client,
        schema: this.#schema,
        input: checked,
        assertOpen: this.#assertOpen,
      }),
    );
  }

  async settle(input: {
    scope: CreditScope;
    reservationId: string;
    actualCredits: string;
  }) {
    const scope = validateCreditScope(input.scope);
    const reservationId = creditIdentifier(input.reservationId);
    const actualCredits = creditAmount(input.actualCredits);
    return this.#transaction(scope, async (client) => {
      const before = await this.#requiredAccount(client, scope);
      const hold = await this.#requiredReservation(
        client,
        scope,
        reservationId,
      );
      const next = settleCreditReservation(before, hold, actualCredits);
      if (next.account.revision !== before.revision) {
        await this.#writeAccount(client, next.account);
        await this.#writeReservation(client, next.reservation);
        await this.#appendEntry(
          client,
          creditEntry({
            account: next.account,
            kind: "settle",
            credits: actualCredits,
            reservationId,
          }),
        );
      }
      return next.reservation;
    });
  }

  async release(input: { scope: CreditScope; reservationId: string }) {
    const scope = validateCreditScope(input.scope);
    const reservationId = creditIdentifier(input.reservationId);
    return this.#transaction(scope, async (client) => {
      const before = await this.#requiredAccount(client, scope);
      const hold = await this.#requiredReservation(
        client,
        scope,
        reservationId,
      );
      const next = releaseCreditReservation(before, hold);
      if (next.account.revision !== before.revision) {
        await this.#writeAccount(client, next.account);
        await this.#writeReservation(client, next.reservation);
        await this.#appendEntry(
          client,
          creditEntry({
            account: next.account,
            kind: "release",
            credits: hold.quotedCredits,
            reservationId,
          }),
        );
      }
      return next.reservation;
    });
  }

  async listEntries(input: {
    scope: CreditScope;
    afterRevision: number;
    limit: number;
  }): Promise<readonly PluginCreditEntry[]> {
    this.#assertOpen();
    const query = creditEntriesQuery(input);
    const rows = await this.#query(
      this.#pool,
      `SELECT revision,entry_json FROM ${this.#prefix}plugin_credit_entries WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND revision>$4 ORDER BY revision LIMIT $5`,
      [...creditScopeValues(query.scope), query.afterRevision, query.limit],
    );
    return Object.freeze(
      rows.rows.map((row) =>
        decodeCreditEntry(
          row as { revision: unknown; entry_json: unknown },
          query.scope,
        ),
      ),
    );
  }

  async #account(
    client: Pool | PoolClient,
    scope: CreditScope,
  ): Promise<CreditAccount | null> {
    const rows = await this.#query(
      client,
      `SELECT revision,account_json FROM ${this.#prefix}plugin_credit_accounts WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3`,
      [...creditScopeValues(scope)],
    );
    return decodeCreditAccount(
      rows.rows[0] as { revision: unknown; account_json: unknown } | undefined,
      scope,
    );
  }

  async #requiredAccount(
    client: PoolClient,
    scope: CreditScope,
  ): Promise<CreditAccount> {
    const account = await this.#account(client, scope);
    if (account === null)
      throw new CreditLedgerError("plugin_credit_account_not_found");
    return account;
  }

  async #reservation(
    client: Pool | PoolClient,
    scope: CreditScope,
    column: "reservation_id" | "idempotency_key",
    value: string,
  ): Promise<CreditReservation | null> {
    const rows = await this.#query(
      client,
      `SELECT reservation_id,idempotency_key,record_json FROM ${this.#prefix}plugin_credit_reservations WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND ${column}=$4`,
      [...creditScopeValues(scope), value],
    );
    return decodeCreditReservation(
      rows.rows[0] as
        | {
            reservation_id: unknown;
            idempotency_key: unknown;
            record_json: unknown;
          }
        | undefined,
      scope,
    );
  }

  async #requiredReservation(
    client: PoolClient,
    scope: CreditScope,
    reservationId: string,
  ): Promise<CreditReservation> {
    const reservation = await this.#reservation(
      client,
      scope,
      "reservation_id",
      reservationId,
    );
    if (reservation === null)
      throw new CreditLedgerError("plugin_credit_reservation_not_found");
    return reservation;
  }

  async #writeAccount(
    client: PoolClient,
    account: CreditAccount,
  ): Promise<void> {
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}plugin_credit_accounts VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,principal_id,pool_id) DO UPDATE SET revision=excluded.revision,account_json=excluded.account_json`,
      [
        ...creditScopeValues(account.scope),
        account.revision,
        JSON.stringify(account),
      ],
    );
  }

  async #writeReservation(
    client: PoolClient,
    reservation: CreditReservation,
  ): Promise<void> {
    await this.#query(
      client,
      `UPDATE ${this.#prefix}plugin_credit_reservations SET record_json=$1 WHERE tenant_id=$2 AND principal_id=$3 AND pool_id=$4 AND reservation_id=$5`,
      [
        JSON.stringify(reservation),
        ...creditScopeValues(reservation.scope),
        reservation.reservationId,
      ],
    );
  }

  async #appendEntry(
    client: PoolClient,
    entry: PluginCreditEntry,
  ): Promise<void> {
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}plugin_credit_entries VALUES($1,$2,$3,$4,$5)`,
      [
        ...creditScopeValues(entry.scope),
        entry.revision,
        JSON.stringify(entry),
      ],
    );
  }

  async #query(client: Pool | PoolClient, sql: string, values: unknown[] = []) {
    this.#assertOpen();
    const result = await client.query(sql, values);
    this.#assertOpen();
    return result;
  }

  async #transaction<T>(
    scope: CreditScope | null,
    body: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      this.#assertOpen();
      await this.#query(client, "BEGIN");
      if (scope === null)
        await this.#query(
          client,
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [JSON.stringify(["plugin-credit-migration", this.#schema])],
        );
      else
        await lockPostgresPluginCreditAccount({
          client,
          schema: this.#schema,
          scope,
          assertOpen: this.#assertOpen,
        });
      const result = await body(client);
      // After PostgreSQL confirms COMMIT, a later host close cannot undo the write.
      // Preserve that successful result instead of converting it into a false failure.
      this.#assertOpen();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
