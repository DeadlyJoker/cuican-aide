import { ContractValidationError } from "./contract-validation-error.ts";

export const PLUGIN_CREDIT_READ_LIMITS = Object.freeze({
  accounts: 16,
  entries: 50,
  poolId: 128,
  maximumRevision: 2_147_483_647,
});
export const MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES = 64 * 1024;
export const PLUGIN_CREDIT_ACCOUNTS_PATH = "/api/v1/plugins/credits/accounts";
export const PLUGIN_CREDIT_ENTRIES_PATH = "/api/v1/plugins/credits/entries";

export type PluginCreditAccountView = Readonly<{
  poolId: string;
  revision: number;
  availableCredits: string;
  reservedCredits: string;
  spentCredits: string;
  grantedCredits: string;
}>;
export type PluginCreditEntryView = Readonly<{
  revision: number;
  kind: "grant" | "reserve" | "settle" | "release";
  credits: string;
  account: PluginCreditAccountView;
}>;
export type PluginCreditAccountsQuery = Readonly<{
  afterPoolId: string | null;
  limit: number;
}>;
export type PluginCreditEntriesQuery = Readonly<{
  poolId: string;
  afterRevision: number;
  limit: number;
}>;
export type PluginCreditAccountsResponse = Readonly<{
  schemaVersion: "crewon.plugin-credit-accounts.v1";
  state: "unconfigured" | "ready";
  accounts: readonly PluginCreditAccountView[];
  nextPoolId: string | null;
}>;
export type PluginCreditEntriesResponse = Readonly<{
  schemaVersion: "crewon.plugin-credit-entries.v1";
  state: "unconfigured" | "ready";
  account: PluginCreditAccountView | null;
  entries: readonly PluginCreditEntryView[];
  nextRevision: number | null;
}>;

/** Pool identities retain the original opaque-ID rules, including slash and Unicode. */
export function parsePluginCreditPoolId(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 128 ||
    input.trim() !== input ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    fail("plugin_credit_read_pool_invalid");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      fail("plugin_credit_read_pool_invalid");
  }
  return input;
}

/** UTF-8 byte ordering matches SQLite BINARY and PostgreSQL C keyset ordering. */
export function comparePluginCreditPoolIds(
  left: string,
  right: string,
): number {
  const a = new TextEncoder().encode(parsePluginCreditPoolId(left));
  const b = new TextEncoder().encode(parsePluginCreditPoolId(right));
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export function validatePluginCreditAccountsQuery(
  input: unknown,
): PluginCreditAccountsQuery {
  const value = record(input, ["afterPoolId", "limit"]);
  return Object.freeze({
    afterPoolId:
      value.afterPoolId === null
        ? null
        : parsePluginCreditPoolId(value.afterPoolId),
    limit: integer(value.limit, 1, 16),
  });
}
export function validatePluginCreditEntriesQuery(
  input: unknown,
): PluginCreditEntriesQuery {
  const value = record(input, ["poolId", "afterRevision", "limit"]);
  return Object.freeze({
    poolId: parsePluginCreditPoolId(value.poolId),
    afterRevision: integer(value.afterRevision, 0),
    limit: integer(value.limit, 1, 50),
  });
}
export function parsePluginCreditAccountsQuery(
  input: unknown,
): PluginCreditAccountsQuery {
  const value = record(
    input,
    ["afterPoolId", "limit"],
    ["afterPoolId", "limit"],
  );
  return validatePluginCreditAccountsQuery({
    afterPoolId: Object.hasOwn(value, "afterPoolId")
      ? parsePluginCreditPoolId(value.afterPoolId)
      : null,
    limit: Object.hasOwn(value, "limit")
      ? queryInteger(value.limit, 1, 16)
      : 16,
  });
}
export function parsePluginCreditEntriesQuery(
  input: unknown,
): PluginCreditEntriesQuery {
  const value = record(
    input,
    ["poolId", "afterRevision", "limit"],
    ["afterRevision", "limit"],
  );
  return validatePluginCreditEntriesQuery({
    poolId: parsePluginCreditPoolId(value.poolId),
    afterRevision: Object.hasOwn(value, "afterRevision")
      ? queryInteger(value.afterRevision, 0)
      : 0,
    limit: Object.hasOwn(value, "limit")
      ? queryInteger(value.limit, 1, 50)
      : 50,
  });
}
export function pluginCreditAccountsPath(
  input: PluginCreditAccountsQuery,
): string {
  const query = validatePluginCreditAccountsQuery(input),
    search = new URLSearchParams();
  if (query.afterPoolId !== null) search.set("afterPoolId", query.afterPoolId);
  search.set("limit", String(query.limit));
  return `${PLUGIN_CREDIT_ACCOUNTS_PATH}?${search}`;
}
export function pluginCreditEntriesPath(
  input: PluginCreditEntriesQuery,
): string {
  const query = validatePluginCreditEntriesQuery(input);
  const search = new URLSearchParams({
    poolId: query.poolId,
    afterRevision: String(query.afterRevision),
    limit: String(query.limit),
  });
  return `${PLUGIN_CREDIT_ENTRIES_PATH}?${search}`;
}
export function parsePluginCreditAccountView(
  input: unknown,
): PluginCreditAccountView {
  const value = record(input, [
    "poolId",
    "revision",
    "availableCredits",
    "reservedCredits",
    "spentCredits",
    "grantedCredits",
  ]);
  const availableCredits = amount(value.availableCredits),
    reservedCredits = amount(value.reservedCredits),
    spentCredits = amount(value.spentCredits),
    grantedCredits = amount(value.grantedCredits);
  if (
    BigInt(availableCredits) +
      BigInt(reservedCredits) +
      BigInt(spentCredits) !==
    BigInt(grantedCredits)
  )
    fail("plugin_credit_read_balance_invalid");
  return Object.freeze({
    poolId: parsePluginCreditPoolId(value.poolId),
    revision: integer(value.revision, 1),
    availableCredits,
    reservedCredits,
    spentCredits,
    grantedCredits,
  });
}
export function parsePluginCreditEntryView(
  input: unknown,
): PluginCreditEntryView {
  const value = record(input, ["revision", "kind", "credits", "account"]);
  const revision = integer(value.revision, 1),
    account = parsePluginCreditAccountView(value.account),
    credits = amount(value.credits);
  if (
    account.revision !== revision ||
    typeof value.kind !== "string" ||
    !["grant", "reserve", "settle", "release"].includes(value.kind)
  )
    fail("plugin_credit_read_entry_invalid");
  if (value.kind !== "settle" && credits === "0")
    fail("plugin_credit_read_entry_invalid");
  return Object.freeze({
    revision,
    kind: value.kind as PluginCreditEntryView["kind"],
    credits,
    account,
  });
}
export function parsePluginCreditAccountsResponse(
  input: unknown,
  context: PluginCreditAccountsQuery,
): PluginCreditAccountsResponse {
  const query = validatePluginCreditAccountsQuery(context);
  const value = record(input, [
    "schemaVersion",
    "state",
    "accounts",
    "nextPoolId",
  ]);
  if (value.schemaVersion !== "crewon.plugin-credit-accounts.v1")
    fail("plugin_credit_read_schema_invalid");
  const state = readState(value.state),
    accounts = array(value.accounts, query.limit).map(
      parsePluginCreditAccountView,
    );
  const nextPoolId =
    value.nextPoolId === null
      ? null
      : parsePluginCreditPoolId(value.nextPoolId);
  let previous = query.afterPoolId;
  for (const account of accounts) {
    if (
      previous !== null &&
      comparePluginCreditPoolIds(account.poolId, previous) <= 0
    )
      fail("plugin_credit_read_page_order_invalid");
    previous = account.poolId;
  }
  if (
    nextPoolId !== null &&
    (accounts.length !== query.limit || nextPoolId !== previous)
  )
    fail("plugin_credit_read_page_cursor_invalid");
  if (
    state === "unconfigured" &&
    (accounts.length !== 0 || nextPoolId !== null)
  )
    fail("plugin_credit_read_unconfigured_invalid");
  return bounded(
    Object.freeze({
      schemaVersion: "crewon.plugin-credit-accounts.v1",
      state,
      accounts: Object.freeze(accounts),
      nextPoolId,
    }),
  );
}
export function parsePluginCreditEntriesResponse(
  input: unknown,
  context: PluginCreditEntriesQuery,
): PluginCreditEntriesResponse {
  const query = validatePluginCreditEntriesQuery(context);
  const value = record(input, [
    "schemaVersion",
    "state",
    "account",
    "entries",
    "nextRevision",
  ]);
  if (value.schemaVersion !== "crewon.plugin-credit-entries.v1")
    fail("plugin_credit_read_schema_invalid");
  const state = readState(value.state),
    account =
      value.account === null
        ? null
        : parsePluginCreditAccountView(value.account);
  const entries = array(value.entries, query.limit).map(
    parsePluginCreditEntryView,
  );
  const nextRevision =
    value.nextRevision === null ? null : integer(value.nextRevision, 1);
  if (state === "unconfigured") {
    if (account !== null || entries.length !== 0 || nextRevision !== null)
      fail("plugin_credit_read_unconfigured_invalid");
  } else if (account === null) fail("plugin_credit_read_account_missing");
  if (account !== null && account.poolId !== query.poolId)
    fail("plugin_credit_read_pool_mismatch");
  let previous = query.afterRevision;
  for (const entry of entries) {
    if (
      account === null ||
      entry.account.poolId !== query.poolId ||
      entry.revision <= previous ||
      entry.revision > account.revision
    )
      fail("plugin_credit_read_page_order_invalid");
    if (
      entry.revision === account.revision &&
      !sameAccount(entry.account, account)
    )
      fail("plugin_credit_read_balance_snapshot_invalid");
    previous = entry.revision;
  }
  if (
    nextRevision !== null &&
    (entries.length !== query.limit ||
      nextRevision !== previous ||
      account === null ||
      nextRevision >= account.revision)
  )
    fail("plugin_credit_read_page_cursor_invalid");
  return bounded(
    Object.freeze({
      schemaVersion: "crewon.plugin-credit-entries.v1",
      state,
      account,
      entries: Object.freeze(entries),
      nextRevision,
    }),
  );
}

function sameAccount(
  a: PluginCreditAccountView,
  b: PluginCreditAccountView,
): boolean {
  return (
    a.poolId === b.poolId &&
    a.revision === b.revision &&
    a.availableCredits === b.availableCredits &&
    a.reservedCredits === b.reservedCredits &&
    a.spentCredits === b.spentCredits &&
    a.grantedCredits === b.grantedCredits
  );
}
function amount(input: unknown): string {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]{0,47})$/u.test(input))
    fail("plugin_credit_read_amount_invalid");
  return input;
}
function integer(
  input: unknown,
  minimum: number,
  maximum: number = PLUGIN_CREDIT_READ_LIMITS.maximumRevision,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    fail("plugin_credit_read_query_invalid");
  return input;
}
function queryInteger(
  input: unknown,
  minimum: number,
  maximum: number = PLUGIN_CREDIT_READ_LIMITS.maximumRevision,
): number {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/u.test(input))
    fail("plugin_credit_read_query_invalid");
  return integer(Number(input), minimum, maximum);
}
function readState(input: unknown): "unconfigured" | "ready" {
  if (input !== "unconfigured" && input !== "ready")
    fail("plugin_credit_read_state_invalid");
  return input;
}
function record(
  input: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail("plugin_credit_read_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype)
    fail("plugin_credit_read_object_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input),
    keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some(
      (key) => !optional.includes(key) && !Object.hasOwn(descriptors, key),
    ) ||
    keys.some((key) => {
      const d = descriptors[key as string]!;
      return !d.enumerable || !Object.hasOwn(d, "value");
    })
  )
    fail("plugin_credit_read_fields_invalid");
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key as string]!.value]),
  );
}
function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum)
    fail("plugin_credit_read_page_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== input.length + 1)
    fail("plugin_credit_read_page_invalid");
  const result: unknown[] = [];
  for (let i = 0; i < input.length; i++) {
    const d = descriptors[String(i)];
    if (d === undefined || !d.enumerable || !Object.hasOwn(d, "value"))
      fail("plugin_credit_read_page_invalid");
    result.push(d.value);
  }
  return result;
}
function bounded<T>(input: T): T {
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength >
    MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES
  )
    fail("plugin_credit_read_response_too_large");
  return input;
}
function fail(code: string): never {
  throw new ContractValidationError(code);
}
