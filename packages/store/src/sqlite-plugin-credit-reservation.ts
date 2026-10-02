import type { DatabaseSync } from "node:sqlite";
import {
  CreditLedgerError,
  reserveCreditAccount,
  validateCreditReservationInput,
  type CreditReservation,
  type CreditReservationInput,
  type CreditScope,
} from "@crewon/domain";
import {
  assertCreditReservationReplay,
  creditEntry,
  creditScopeValues,
  decodeCreditAccount,
  decodeCreditReservation,
} from "./plugin-credit-support.ts";

/** The caller owns the write transaction and host lifetime; this never starts or commits one. */
export function reserveSqlitePluginCreditsWithinTransaction(
  database: DatabaseSync,
  input: CreditReservationInput,
): Readonly<{
  disposition: "created" | "replayed";
  reservation: CreditReservation;
}> {
  const checked = validateCreditReservationInput(input);
  const accountRow = database
    .prepare(
      "SELECT revision,account_json FROM plugin_credit_accounts WHERE tenant_id=? AND principal_id=? AND pool_id=?",
    )
    .get(...creditScopeValues(checked.scope));
  const account = decodeCreditAccount(
    accountRow as { revision: unknown; account_json: unknown } | undefined,
    checked.scope,
  );
  if (account === null)
    throw new CreditLedgerError("plugin_credit_account_not_found");
  const replay = reservation(
    database,
    checked.scope,
    "idempotency_key",
    checked.idempotencyKey,
  );
  if (replay !== null) {
    assertCreditReservationReplay(replay, checked);
    return Object.freeze({ disposition: "replayed", reservation: replay });
  }
  if (
    reservation(
      database,
      checked.scope,
      "reservation_id",
      checked.reservationId,
    ) !== null
  )
    throw new CreditLedgerError("plugin_credit_reservation_id_conflict");
  const next = reserveCreditAccount(account, checked);
  database
    .prepare(
      "INSERT INTO plugin_credit_accounts VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,principal_id,pool_id) DO UPDATE SET revision=excluded.revision,account_json=excluded.account_json",
    )
    .run(
      ...creditScopeValues(next.account.scope),
      next.account.revision,
      JSON.stringify(next.account),
    );
  database
    .prepare("INSERT INTO plugin_credit_reservations VALUES(?,?,?,?,?,?)")
    .run(
      ...creditScopeValues(checked.scope),
      checked.reservationId,
      checked.idempotencyKey,
      JSON.stringify(next.reservation),
    );
  const entry = creditEntry({
    account: next.account,
    kind: "reserve",
    credits: checked.quotedCredits,
    reservationId: checked.reservationId,
  });
  database
    .prepare("INSERT INTO plugin_credit_entries VALUES(?,?,?,?,?)")
    .run(
      ...creditScopeValues(entry.scope),
      entry.revision,
      JSON.stringify(entry),
    );
  return Object.freeze({
    disposition: "created",
    reservation: next.reservation,
  });
}

function reservation(
  database: DatabaseSync,
  scope: CreditScope,
  column: "reservation_id" | "idempotency_key",
  value: string,
): CreditReservation | null {
  const row = database
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
