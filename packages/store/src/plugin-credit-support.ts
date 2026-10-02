import {
  CreditLedgerError,
  validateCreditAccount,
  validateCreditReservation,
  validateCreditScope,
  type CreditAccount,
  type CreditReservation,
  type CreditReservationInput,
  type CreditScope,
} from "@crewon/domain";
import type { PluginCreditEntry } from "@crewon/application";

export function creditScopeValues(scope: CreditScope): readonly string[] {
  const checked = validateCreditScope(scope);
  return [checked.tenantId, checked.principalId, checked.poolId];
}

export function assertCreditScope(left: CreditScope, right: CreditScope): void {
  if (
    left.tenantId !== right.tenantId ||
    left.principalId !== right.principalId ||
    left.poolId !== right.poolId
  )
    throw new CreditLedgerError("plugin_credit_scope_mismatch");
}

export function creditIdentifier(value: unknown): string {
  // Scope validation uses the same bounded opaque-identity rules as mutation IDs.
  return validateCreditScope({
    tenantId: value,
    principalId: "id",
    poolId: "id",
  }).tenantId;
}

export function creditAmount(
  value: unknown,
  constraint: "positive" | "nonnegative" = "nonnegative",
): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,47})$/u.test(value) ||
    (constraint === "positive" && value === "0")
  )
    throw new CreditLedgerError("plugin_credit_amount_invalid");
  return value;
}

export function decodeCreditAccount(
  row: { revision: unknown; account_json: unknown } | undefined,
  scope: CreditScope,
): CreditAccount | null {
  if (row === undefined) return null;
  const account = validateCreditAccount(decodeJson(row.account_json, 4096));
  assertCreditScope(scope, account.scope);
  if (String(account.revision) !== String(row.revision))
    throw new CreditLedgerError("plugin_credit_account_revision_invalid");
  return account;
}

export function decodeCreditReservation(
  row:
    | {
        reservation_id: unknown;
        idempotency_key: unknown;
        record_json: unknown;
      }
    | undefined,
  scope: CreditScope,
): CreditReservation | null {
  if (row === undefined) return null;
  const reservation = validateCreditReservation(
    decodeJson(row.record_json, 8192),
  );
  assertCreditScope(scope, reservation.scope);
  if (
    reservation.reservationId !== row.reservation_id ||
    reservation.idempotencyKey !== row.idempotency_key
  )
    throw new CreditLedgerError("plugin_credit_reservation_identity_invalid");
  return reservation;
}

/** The caller's replacement ID is irrelevant; all charge-bearing inputs remain immutable. */
export function assertCreditReservationReplay(
  reservation: CreditReservation,
  input: CreditReservationInput,
): void {
  assertCreditScope(reservation.scope, input.scope);
  if (
    reservation.idempotencyKey !== input.idempotencyKey ||
    reservation.requestDigest !== input.requestDigest ||
    reservation.pluginId !== input.pluginId ||
    reservation.priceRevision !== input.priceRevision ||
    reservation.quotedCredits !== input.quotedCredits
  )
    throw new CreditLedgerError("plugin_credit_idempotency_conflict");
}

export function creditEntry(input: {
  account: CreditAccount;
  kind: PluginCreditEntry["kind"];
  credits: string;
  grantId?: string;
  reservationId?: string;
}): PluginCreditEntry {
  const account = validateCreditAccount(input.account);
  return Object.freeze({
    scope: account.scope,
    revision: account.revision,
    kind: input.kind,
    credits: creditAmount(input.credits),
    grantId:
      input.grantId === undefined ? null : creditIdentifier(input.grantId),
    reservationId:
      input.reservationId === undefined
        ? null
        : creditIdentifier(input.reservationId),
    account,
  });
}

export function decodeCreditEntry(
  row: { revision: unknown; entry_json: unknown },
  scope: CreditScope,
): PluginCreditEntry {
  const value = decodeJson(row.entry_json, 8192);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "account,credits,grantId,kind,reservationId,revision,scope"
  )
    throw new CreditLedgerError("plugin_credit_entry_invalid");
  const record = value as Record<string, unknown>;
  if (!["grant", "reserve", "settle", "release"].includes(String(record.kind)))
    throw new CreditLedgerError("plugin_credit_entry_invalid");
  const account = validateCreditAccount(record.account);
  const entryScope = validateCreditScope(record.scope);
  assertCreditScope(scope, entryScope);
  assertCreditScope(scope, account.scope);
  if (
    account.revision !== record.revision ||
    String(record.revision) !== String(row.revision) ||
    (record.kind === "grant"
      ? record.grantId === null || record.reservationId !== null
      : record.reservationId === null || record.grantId !== null)
  )
    throw new CreditLedgerError("plugin_credit_entry_invalid");
  return creditEntry({
    account,
    kind: record.kind as PluginCreditEntry["kind"],
    credits: creditAmount(record.credits),
    ...(record.grantId === null
      ? {}
      : { grantId: creditIdentifier(record.grantId) }),
    ...(record.reservationId === null
      ? {}
      : { reservationId: creditIdentifier(record.reservationId) }),
  });
}

export function creditEntriesQuery(input: {
  scope: CreditScope;
  afterRevision: number;
  limit: number;
}) {
  const scope = validateCreditScope(input.scope);
  if (
    !Number.isSafeInteger(input.afterRevision) ||
    input.afterRevision < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new CreditLedgerError("plugin_credit_entries_query_invalid");
  return Object.freeze({
    scope,
    afterRevision: input.afterRevision,
    limit: input.limit,
  });
}

function decodeJson(value: unknown, limit: number): unknown {
  try {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > limit)
      throw new Error();
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new CreditLedgerError("plugin_credit_persisted_json_invalid");
  }
}
