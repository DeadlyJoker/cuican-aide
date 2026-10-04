import type {
  PluginCreditAccountListInput,
  PluginCreditAccountsReadResult,
  PluginCreditEntriesReadInput,
  PluginCreditEntriesReadResult,
} from "@crewon/application";
import {
  CreditLedgerError,
  validateCreditScope,
  type CreditAccount,
} from "@crewon/domain";
import {
  creditIdentifier,
  decodeCreditAccount,
  decodeCreditEntry,
} from "./plugin-credit-support.ts";

export const creditReadTables = Object.freeze({
  plugin_credit_schema_version: { id: "integer", version: "integer" },
  plugin_credit_accounts: {
    tenant_id: "text",
    principal_id: "text",
    pool_id: "text",
    revision: "integer",
    account_json: "json",
  },
  plugin_credit_entries: {
    tenant_id: "text",
    principal_id: "text",
    pool_id: "text",
    revision: "integer",
    entry_json: "json",
  },
  plugin_credit_reservations: {
    tenant_id: "text",
    principal_id: "text",
    pool_id: "text",
    reservation_id: "text",
    idempotency_key: "text",
    record_json: "json",
  },
  plugin_credit_grant_receipts: {
    tenant_id: "text",
    principal_id: "text",
    pool_id: "text",
    grant_id: "text",
    credits: "text",
  },
} as const);
export const creditReadPrimaryKeys = Object.freeze({
  plugin_credit_schema_version: ["id"],
  plugin_credit_accounts: ["tenant_id", "principal_id", "pool_id"],
  plugin_credit_entries: ["tenant_id", "principal_id", "pool_id", "revision"],
  plugin_credit_reservations: [
    "tenant_id",
    "principal_id",
    "pool_id",
    "reservation_id",
  ],
  plugin_credit_grant_receipts: [
    "tenant_id",
    "principal_id",
    "pool_id",
    "grant_id",
  ],
} as const);
export const creditReadNames = Object.freeze(
  Object.keys(creditReadTables) as (keyof typeof creditReadTables)[],
);
export type CreditReadRow = Record<string, unknown>;

export function creditReadFailure(
  code = "plugin_credit_read_schema_invalid",
): never {
  throw new CreditLedgerError(code);
}
export function creditReadVersion(rows: readonly CreditReadRow[]): void {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.version !== 1)
    creditReadFailure("plugin_credit_schema_version_unsupported");
}
export function creditAccountListInput(
  input: PluginCreditAccountListInput,
): PluginCreditAccountListInput {
  const value = readRecord(input, [
    "tenantId",
    "principalId",
    "afterPoolId",
    "limit",
  ]);
  return Object.freeze({
    tenantId: creditIdentifier(value.tenantId),
    principalId: creditIdentifier(value.principalId),
    afterPoolId:
      value.afterPoolId === null ? null : creditIdentifier(value.afterPoolId),
    limit: readLimit(value.limit, 16),
  });
}
export function creditEntriesReadInput(
  input: PluginCreditEntriesReadInput,
): PluginCreditEntriesReadInput {
  const value = readRecord(input, ["scope", "afterRevision", "limit"]);
  if (
    !Number.isSafeInteger(value.afterRevision) ||
    Number(value.afterRevision) < 0 ||
    Number(value.afterRevision) > 2_147_483_647
  )
    creditReadFailure("plugin_credit_read_query_invalid");
  return Object.freeze({
    scope: validateCreditScope(value.scope),
    afterRevision: Number(value.afterRevision),
    limit: readLimit(value.limit, 50),
  });
}
export function creditAccountsReadPage(
  input: PluginCreditAccountListInput,
  rows: readonly CreditReadRow[],
): PluginCreditAccountsReadResult {
  if (rows.length > input.limit + 1)
    creditReadFailure("plugin_credit_read_page_invalid");
  let previous = input.afterPoolId;
  const accounts = rows.map((row) => {
    const poolId = creditIdentifier(row.pool_id);
    if (
      row.tenant_id !== input.tenantId ||
      row.principal_id !== input.principalId ||
      (previous !== null &&
        Buffer.compare(Buffer.from(poolId), Buffer.from(previous)) <= 0)
    )
      creditReadFailure("plugin_credit_read_page_invalid");
    previous = poolId;
    return decodeCreditAccount(
      row as { revision: unknown; account_json: unknown },
      { tenantId: input.tenantId, principalId: input.principalId, poolId },
    )!;
  });
  const page = Object.freeze(accounts.slice(0, input.limit));
  return Object.freeze({
    state: "ready",
    accounts: page,
    nextPoolId:
      accounts.length > input.limit ? page.at(-1)!.scope.poolId : null,
  });
}
export function creditEntriesReadPage(
  input: PluginCreditEntriesReadInput,
  account: CreditAccount | null,
  rows: readonly CreditReadRow[],
): PluginCreditEntriesReadResult {
  // The original ledger's empty account is revision 1; its first persisted grant is revision 2.
  const firstRevision = Math.max(2, input.afterRevision + 1);
  const expected =
    account === null
      ? 0
      : Math.min(
          input.limit + 1,
          Math.max(0, account.revision - firstRevision + 1),
        );
  if (rows.length !== expected)
    creditReadFailure("plugin_credit_read_page_invalid");
  const entries = rows.map((row, position) => {
    const entry = decodeCreditEntry(
      row as { revision: unknown; entry_json: unknown },
      input.scope,
    );
    if (
      entry.revision !== firstRevision + position ||
      entry.revision > account!.revision
    )
      creditReadFailure("plugin_credit_read_page_invalid");
    if (
      entry.revision === account!.revision &&
      JSON.stringify(entry.account) !== JSON.stringify(account)
    )
      creditReadFailure("plugin_credit_read_page_invalid");
    return entry;
  });
  const page = Object.freeze(entries.slice(0, input.limit));
  return Object.freeze({
    state: "ready",
    account,
    entries: page,
    nextRevision: entries.length > input.limit ? page.at(-1)!.revision : null,
  });
}
export const creditAccountsUnconfigured: PluginCreditAccountsReadResult =
  Object.freeze({
    state: "unconfigured",
    accounts: Object.freeze([]),
    nextPoolId: null,
  });
export const creditEntriesUnconfigured: PluginCreditEntriesReadResult =
  Object.freeze({
    state: "unconfigured",
    account: null,
    entries: Object.freeze([]),
    nextRevision: null,
  });

function readLimit(input: unknown, maximum: number): number {
  if (
    !Number.isSafeInteger(input) ||
    Number(input) < 1 ||
    Number(input) > maximum
  )
    creditReadFailure("plugin_credit_read_query_invalid");
  return Number(input);
}
function readRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    creditReadFailure("plugin_credit_read_query_invalid");
  const prototype = Object.getPrototypeOf(input),
    descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some(
      (key) =>
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  )
    creditReadFailure("plugin_credit_read_query_invalid");
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
