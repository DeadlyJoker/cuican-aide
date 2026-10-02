export type CreditScope = Readonly<{
  tenantId: string;
  principalId: string;
  poolId: string;
}>;

export type CreditAccount = Readonly<{
  schemaVersion: "crewon.plugin-credit-account.v0";
  scope: CreditScope;
  revision: number;
  availableCredits: string;
  reservedCredits: string;
  spentCredits: string;
  grantedCredits: string;
}>;

export type CreditReservationInput = Readonly<{
  scope: CreditScope;
  reservationId: string;
  idempotencyKey: string;
  requestDigest: string;
  pluginId: string;
  priceRevision: number;
  quotedCredits: string;
}>;

export type CreditReservation = CreditReservationInput &
  Readonly<{
    schemaVersion: "crewon.plugin-credit-reservation.v0";
    state: "reserved" | "settled" | "released";
    settledCredits: string | null;
  }>;

export type CreditMutation = Readonly<{
  account: CreditAccount;
  reservation: CreditReservation;
}>;

export class CreditLedgerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CreditLedgerError";
    this.code = code;
  }
}

const accountSchema = "crewon.plugin-credit-account.v0";
const reservationSchema = "crewon.plugin-credit-reservation.v0";
const maximumRevision = 2_147_483_647;
const scopeFields = ["tenantId", "principalId", "poolId"] as const;
const reservationInputFields = [
  "scope",
  "reservationId",
  "idempotencyKey",
  "requestDigest",
  "pluginId",
  "priceRevision",
  "quotedCredits",
] as const;

/** Validates and detaches the scope; poolId determines which balance is used. */
export function validateCreditScope(input: unknown): CreditScope {
  const value = record(input, scopeFields);
  return Object.freeze({
    tenantId: identifier(value.tenantId),
    principalId: identifier(value.principalId),
    poolId: identifier(value.poolId),
  });
}

export function validateCreditAccount(input: unknown): CreditAccount {
  const value = record(input, [
    "schemaVersion",
    "scope",
    "revision",
    "availableCredits",
    "reservedCredits",
    "spentCredits",
    "grantedCredits",
  ]);
  if (value.schemaVersion !== accountSchema)
    fail("plugin_credit_account_schema_unsupported");
  const availableCredits = credits(value.availableCredits);
  const reservedCredits = credits(value.reservedCredits);
  const spentCredits = credits(value.spentCredits);
  const grantedCredits = credits(value.grantedCredits);
  if (
    BigInt(availableCredits) +
      BigInt(reservedCredits) +
      BigInt(spentCredits) !==
    BigInt(grantedCredits)
  )
    fail("plugin_credit_account_invariant_invalid");
  return Object.freeze({
    schemaVersion: accountSchema,
    scope: validateCreditScope(value.scope),
    revision: revision(value.revision),
    availableCredits,
    reservedCredits,
    spentCredits,
    grantedCredits,
  });
}

export function validateCreditReservation(input: unknown): CreditReservation {
  const value = record(input, [
    ...reservationInputFields,
    "schemaVersion",
    "state",
    "settledCredits",
  ]);
  if (value.schemaVersion !== reservationSchema)
    fail("plugin_credit_reservation_schema_unsupported");
  const fields = reservationFields(value);
  let settledCredits: string | null;
  switch (value.state) {
    case "reserved":
      if (value.settledCredits !== null)
        fail("plugin_credit_reservation_settlement_invalid");
      settledCredits = null;
      break;
    case "settled":
      settledCredits = credits(value.settledCredits);
      if (BigInt(settledCredits) > BigInt(fields.quotedCredits))
        fail("plugin_credit_quote_exceeded");
      break;
    case "released":
      if (value.settledCredits !== "0")
        fail("plugin_credit_reservation_settlement_invalid");
      settledCredits = "0";
      break;
    default:
      fail("plugin_credit_reservation_state_invalid");
  }
  return Object.freeze({
    ...fields,
    schemaVersion: reservationSchema,
    state: value.state,
    settledCredits,
  });
}

export function validateCreditReservationInput(
  input: unknown,
): CreditReservationInput {
  return reservationFields(record(input, reservationInputFields));
}

/** Accounts start empty; this rule does not authorize a grant or select a pool. */
export function createCreditAccount(scope: CreditScope): CreditAccount {
  return validateCreditAccount({
    schemaVersion: accountSchema,
    scope,
    revision: 1,
    availableCredits: "0",
    reservedCredits: "0",
    spentCredits: "0",
    grantedCredits: "0",
  });
}

export function grantCreditAccount(
  account: CreditAccount,
  positiveCredits: string,
): CreditAccount {
  const current = validateCreditAccount(account);
  const amount = BigInt(credits(positiveCredits, true));
  return validateCreditAccount({
    ...current,
    revision: nextRevision(current.revision),
    availableCredits: (BigInt(current.availableCredits) + amount).toString(),
    grantedCredits: (BigInt(current.grantedCredits) + amount).toString(),
  });
}

/** The store owns idempotency lookup and atomic persistence of this pair. */
export function reserveCreditAccount(
  account: CreditAccount,
  input: CreditReservationInput,
): CreditMutation {
  const current = validateCreditAccount(account);
  const reservation = validateCreditReservation({
    ...validateCreditReservationInput(input),
    schemaVersion: reservationSchema,
    state: "reserved",
    settledCredits: null,
  });
  matchScope(current.scope, reservation.scope);
  const amount = BigInt(reservation.quotedCredits);
  if (BigInt(current.availableCredits) < amount)
    fail("plugin_credit_insufficient_balance");
  return mutation(
    validateCreditAccount({
      ...current,
      revision: nextRevision(current.revision),
      availableCredits: (BigInt(current.availableCredits) - amount).toString(),
      reservedCredits: (BigInt(current.reservedCredits) + amount).toString(),
    }),
    reservation,
  );
}

export function settleCreditReservation(
  account: CreditAccount,
  reservation: CreditReservation,
  actualCredits: string,
): CreditMutation {
  const current = validateCreditAccount(account);
  const hold = validateCreditReservation(reservation);
  matchScope(current.scope, hold.scope);
  const actual = credits(actualCredits);
  if (BigInt(actual) > BigInt(hold.quotedCredits))
    fail("plugin_credit_quote_exceeded");
  if (hold.state === "settled") {
    if (hold.settledCredits !== actual)
      fail("plugin_credit_settlement_conflict");
    return mutation(current, hold);
  }
  if (hold.state === "released")
    fail("plugin_credit_reservation_terminal_conflict");
  const quoted = reservedAmount(current, hold);
  return mutation(
    validateCreditAccount({
      ...current,
      revision: nextRevision(current.revision),
      availableCredits: (
        BigInt(current.availableCredits) +
        quoted -
        BigInt(actual)
      ).toString(),
      reservedCredits: (BigInt(current.reservedCredits) - quoted).toString(),
      spentCredits: (BigInt(current.spentCredits) + BigInt(actual)).toString(),
    }),
    validateCreditReservation({
      ...hold,
      state: "settled",
      settledCredits: actual,
    }),
  );
}

/** Releases an unsettled hold; it is not a refund or supplier cancellation. */
export function releaseCreditReservation(
  account: CreditAccount,
  reservation: CreditReservation,
): CreditMutation {
  const current = validateCreditAccount(account);
  const hold = validateCreditReservation(reservation);
  matchScope(current.scope, hold.scope);
  if (hold.state === "released") return mutation(current, hold);
  if (hold.state === "settled")
    fail("plugin_credit_reservation_terminal_conflict");
  const quoted = reservedAmount(current, hold);
  return mutation(
    validateCreditAccount({
      ...current,
      revision: nextRevision(current.revision),
      availableCredits: (BigInt(current.availableCredits) + quoted).toString(),
      reservedCredits: (BigInt(current.reservedCredits) - quoted).toString(),
    }),
    validateCreditReservation({
      ...hold,
      state: "released",
      settledCredits: "0",
    }),
  );
}

function reservationFields(
  value: Record<string, unknown>,
): CreditReservationInput {
  const requestDigest = value.requestDigest;
  if (
    typeof requestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(requestDigest)
  )
    fail("plugin_credit_request_digest_invalid");
  const pluginId = identifier(value.pluginId);
  if (
    pluginId.length > 48 ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(pluginId)
  )
    fail("plugin_credit_plugin_id_invalid");
  return Object.freeze({
    scope: validateCreditScope(value.scope),
    reservationId: identifier(value.reservationId),
    idempotencyKey: identifier(value.idempotencyKey),
    requestDigest,
    pluginId,
    priceRevision: revision(value.priceRevision),
    quotedCredits: credits(value.quotedCredits, true),
  });
}

function mutation(
  account: CreditAccount,
  reservation: CreditReservation,
): CreditMutation {
  return Object.freeze({ account, reservation });
}

function reservedAmount(
  account: CreditAccount,
  reservation: CreditReservation,
): bigint {
  const quoted = BigInt(reservation.quotedCredits);
  if (BigInt(account.reservedCredits) < quoted)
    fail("plugin_credit_reserved_balance_mismatch");
  return quoted;
}

function matchScope(left: CreditScope, right: CreditScope): void {
  if (scopeFields.some((field) => left[field] !== right[field]))
    fail("plugin_credit_scope_mismatch");
}

function credits(input: unknown, positive = false): string {
  if (
    typeof input !== "string" ||
    !/^(?:0|[1-9][0-9]{0,47})$/u.test(input) ||
    (positive && input === "0")
  )
    fail("plugin_credit_amount_invalid");
  return input;
}

function identifier(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.trim() !== input ||
    input.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    fail("plugin_credit_identity_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      fail("plugin_credit_identity_invalid");
  }
  return input;
}

function revision(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > maximumRevision
  )
    fail("plugin_credit_revision_invalid");
  return input;
}

function nextRevision(current: number): number {
  return revision(current + 1);
}

/** Reads data descriptors only, so validation cannot execute caller accessors. */
function record(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("plugin_credit_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    fail("plugin_credit_object_invalid");
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    Object.values(descriptors).some(
      (descriptor) =>
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value"),
    )
  )
    fail("plugin_credit_fields_invalid");
  return Object.fromEntries(
    fields.map((field) => [field, descriptors[field]!.value]),
  );
}

function fail(code: string): never {
  throw new CreditLedgerError(code);
}
