import type { DatabaseSync } from "node:sqlite";
import type { PluginCreditEntry, PluginCreditStore } from "@crewon/application";
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
import { migrateSqlitePluginCredits } from "./plugin-credit-schema.ts";
import { reserveSqlitePluginCreditsWithinTransaction } from "./sqlite-plugin-credit-reservation.ts";
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

/** Host-owned connection. Construction neither migrates nor creates funded accounts. */
export class SqlitePluginCreditStore implements PluginCreditStore {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;

  constructor(input: { database: DatabaseSync; assertOpen(): void }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
  }

  async migrate(): Promise<void> {
    this.#transaction(() => migrateSqlitePluginCredits(this.#database));
  }

  async getAccount(scope: CreditScope): Promise<CreditAccount | null> {
    this.#assertOpen();
    return this.#account(validateCreditScope(scope));
  }

  async getReservation(input: { scope: CreditScope; reservationId: string }) {
    this.#assertOpen();
    return this.#reservation(
      validateCreditScope(input.scope),
      "reservation_id",
      creditIdentifier(input.reservationId),
    );
  }

  async grant(input: { scope: CreditScope; grantId: string; credits: string }) {
    const scope = validateCreditScope(input.scope);
    const grantId = creditIdentifier(input.grantId);
    const credits = creditAmount(input.credits, "positive");
    return this.#transaction(() => {
      const before = this.#account(scope);
      const replay = this.#database
        .prepare(
          "SELECT credits FROM plugin_credit_grant_receipts WHERE tenant_id=? AND principal_id=? AND pool_id=? AND grant_id=?",
        )
        .get(...creditScopeValues(scope), grantId);
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
      this.#writeAccount(account);
      this.#database
        .prepare("INSERT INTO plugin_credit_grant_receipts VALUES(?,?,?,?,?)")
        .run(...creditScopeValues(scope), grantId, credits);
      this.#appendEntry(
        creditEntry({ account, kind: "grant", credits, grantId }),
      );
      return account;
    });
  }

  async reserve(input: CreditReservationInput): Promise<CreditReservation> {
    const checked = validateCreditReservationInput(input);
    return this.#transaction(
      () =>
        reserveSqlitePluginCreditsWithinTransaction(this.#database, checked)
          .reservation,
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
    return this.#transaction(() => {
      const before = this.#requiredAccount(scope);
      const hold = this.#requiredReservation(scope, reservationId);
      const next = settleCreditReservation(before, hold, actualCredits);
      if (next.account.revision !== before.revision) {
        this.#writeAccount(next.account);
        this.#writeReservation(next.reservation);
        this.#appendEntry(
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
    return this.#transaction(() => {
      const before = this.#requiredAccount(scope);
      const hold = this.#requiredReservation(scope, reservationId);
      const next = releaseCreditReservation(before, hold);
      if (next.account.revision !== before.revision) {
        this.#writeAccount(next.account);
        this.#writeReservation(next.reservation);
        this.#appendEntry(
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
    const rows = this.#database
      .prepare(
        "SELECT revision,entry_json FROM plugin_credit_entries WHERE tenant_id=? AND principal_id=? AND pool_id=? AND revision>? ORDER BY revision LIMIT ?",
      )
      .all(...creditScopeValues(query.scope), query.afterRevision, query.limit);
    return Object.freeze(
      rows.map((row) =>
        decodeCreditEntry(
          row as { revision: unknown; entry_json: unknown },
          query.scope,
        ),
      ),
    );
  }

  #account(scope: CreditScope): CreditAccount | null {
    const row = this.#database
      .prepare(
        "SELECT revision,account_json FROM plugin_credit_accounts WHERE tenant_id=? AND principal_id=? AND pool_id=?",
      )
      .get(...creditScopeValues(scope));
    return decodeCreditAccount(
      row as { revision: unknown; account_json: unknown } | undefined,
      scope,
    );
  }

  #requiredAccount(scope: CreditScope): CreditAccount {
    const account = this.#account(scope);
    if (account === null)
      throw new CreditLedgerError("plugin_credit_account_not_found");
    return account;
  }

  #reservation(
    scope: CreditScope,
    column: "reservation_id" | "idempotency_key",
    value: string,
  ): CreditReservation | null {
    const row = this.#database
      .prepare(
        `SELECT reservation_id,idempotency_key,record_json FROM plugin_credit_reservations WHERE tenant_id=? AND principal_id=? AND pool_id=? AND ${column}=?`,
      )
      .get(...creditScopeValues(scope), value);
    return decodeCreditReservation(
      row as
        | {
            reservation_id: unknown;
            idempotency_key: unknown;
            record_json: unknown;
          }
        | undefined,
      scope,
    );
  }

  #requiredReservation(
    scope: CreditScope,
    reservationId: string,
  ): CreditReservation {
    const reservation = this.#reservation(
      scope,
      "reservation_id",
      reservationId,
    );
    if (reservation === null)
      throw new CreditLedgerError("plugin_credit_reservation_not_found");
    return reservation;
  }

  #writeAccount(account: CreditAccount): void {
    this.#database
      .prepare(
        "INSERT INTO plugin_credit_accounts VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,principal_id,pool_id) DO UPDATE SET revision=excluded.revision,account_json=excluded.account_json",
      )
      .run(
        ...creditScopeValues(account.scope),
        account.revision,
        JSON.stringify(account),
      );
  }

  #writeReservation(reservation: CreditReservation): void {
    this.#database
      .prepare(
        "UPDATE plugin_credit_reservations SET record_json=? WHERE tenant_id=? AND principal_id=? AND pool_id=? AND reservation_id=?",
      )
      .run(
        JSON.stringify(reservation),
        ...creditScopeValues(reservation.scope),
        reservation.reservationId,
      );
  }

  #appendEntry(entry: PluginCreditEntry): void {
    this.#database
      .prepare("INSERT INTO plugin_credit_entries VALUES(?,?,?,?,?)")
      .run(
        ...creditScopeValues(entry.scope),
        entry.revision,
        JSON.stringify(entry),
      );
  }

  #transaction<T>(body: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#assertOpen();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
