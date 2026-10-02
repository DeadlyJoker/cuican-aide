import type { PoolClient } from "pg";
import {
  CreditLedgerError,
  reserveCreditAccount,
  validateCreditReservationInput,
  type CreditReservation,
  type CreditReservationInput,
  type CreditScope,
} from "@crewon/domain";
import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";
import {
  assertCreditReservationReplay,
  creditEntry,
  creditScopeValues,
  decodeCreditAccount,
  decodeCreditReservation,
} from "./plugin-credit-support.ts";

/** The caller owns BEGIN/COMMIT; every mutation of this personal pool uses this lock. */
export async function lockPostgresPluginCreditAccount(input: {
  client: PoolClient;
  schema: string;
  scope: CreditScope;
  assertOpen(): void;
}): Promise<void> {
  pluginCreditSchemaName(input.schema);
  input.assertOpen();
  await input.client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [
      JSON.stringify([
        "plugin-credit-account",
        input.schema,
        ...creditScopeValues(input.scope),
      ]),
    ],
  );
  input.assertOpen();
}

/** Requires an open caller transaction and its personal-account advisory lock. */
export async function reservePostgresPluginCreditsWithinTransaction(input: {
  client: PoolClient;
  schema: string;
  input: CreditReservationInput;
  assertOpen(): void;
  /** New Runs cannot adopt an existing reservation or an orphaned idempotency key. */
  requireNew?: true;
}): Promise<CreditReservation> {
  const checked = validateCreditReservationInput(input.input);
  const prefix = `${pluginCreditSchemaName(input.schema)}.`;
  const query = async (sql: string, values: unknown[]) => {
    input.assertOpen();
    const result = await input.client.query(sql, values);
    input.assertOpen();
    return result;
  };
  const accountRows = await query(
    `SELECT revision,account_json FROM ${prefix}plugin_credit_accounts WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3`,
    [...creditScopeValues(checked.scope)],
  );
  const account = decodeCreditAccount(
    accountRows.rows[0] as
      | { revision: unknown; account_json: unknown }
      | undefined,
    checked.scope,
  );
  if (account === null)
    throw new CreditLedgerError("plugin_credit_account_not_found");
  const reservation = async (
    column: "reservation_id" | "idempotency_key",
    value: string,
  ) => {
    const rows = await query(
      `SELECT reservation_id,idempotency_key,record_json FROM ${prefix}plugin_credit_reservations WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND ${column}=$4`,
      [...creditScopeValues(checked.scope), value],
    );
    return decodeCreditReservation(
      rows.rows[0] as
        | {
            reservation_id: unknown;
            idempotency_key: unknown;
            record_json: unknown;
          }
        | undefined,
      checked.scope,
    );
  };
  const replay = await reservation("idempotency_key", checked.idempotencyKey);
  if (replay !== null) {
    if (input.requireNew)
      throw new CreditLedgerError("plugin_credit_idempotency_conflict");
    assertCreditReservationReplay(replay, checked);
    return replay;
  }
  if ((await reservation("reservation_id", checked.reservationId)) !== null)
    throw new CreditLedgerError("plugin_credit_reservation_id_conflict");
  const next = reserveCreditAccount(account, checked);
  await query(
    `INSERT INTO ${prefix}plugin_credit_accounts VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,principal_id,pool_id) DO UPDATE SET revision=excluded.revision,account_json=excluded.account_json`,
    [
      ...creditScopeValues(next.account.scope),
      next.account.revision,
      JSON.stringify(next.account),
    ],
  );
  await query(
    `INSERT INTO ${prefix}plugin_credit_reservations VALUES($1,$2,$3,$4,$5,$6)`,
    [
      ...creditScopeValues(checked.scope),
      checked.reservationId,
      checked.idempotencyKey,
      JSON.stringify(next.reservation),
    ],
  );
  const entry = creditEntry({
    account: next.account,
    kind: "reserve",
    credits: checked.quotedCredits,
    reservationId: checked.reservationId,
  });
  await query(
    `INSERT INTO ${prefix}plugin_credit_entries VALUES($1,$2,$3,$4,$5)`,
    [...creditScopeValues(entry.scope), entry.revision, JSON.stringify(entry)],
  );
  return next.reservation;
}
