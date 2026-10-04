import {
  parsePluginCreditAccountsResponse,
  parsePluginCreditEntriesResponse,
  parsePluginCreditEntryView,
  parsePluginCreditPoolId,
  validatePluginCreditAccountsQuery,
  validatePluginCreditEntriesQuery,
  type PluginCreditAccountView,
  type PluginCreditAccountsQuery,
  type PluginCreditEntriesQuery,
} from "@crewon/contracts";
import {
  validateCreditAccount,
  validateCreditScope,
  type CreditAccount,
  type CreditScope,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { PluginCreditEntry } from "./plugin-credit-store-port.ts";
import type {
  PluginCreditReadAuthorizationPort,
  PluginCreditReadAuthorizationRequest,
} from "./plugin-credit-read-authorization-port.ts";
import type {
  PluginCreditAccountsReadResult,
  PluginCreditEntriesReadResult,
  PluginCreditReadStore,
} from "./plugin-credit-read-store-port.ts";

export type PluginCreditReadApplicationDependencies = Readonly<{
  store: PluginCreditReadStore;
  authorization: PluginCreditReadAuthorizationPort;
}>;

/** Reads only original personal-ledger facts. It never selects a default pool or funds an account. */
export class PluginCreditReadApplicationService {
  readonly #list: PluginCreditReadStore["listAccounts"];
  readonly #entries: PluginCreditReadStore["readEntries"];
  readonly #authorize: PluginCreditReadAuthorizationPort["authorize"];

  constructor(input: PluginCreditReadApplicationDependencies) {
    const value = record(input, ["store", "authorization"]);
    this.#list = method(
      value.store,
      "listAccounts",
    ) as PluginCreditReadStore["listAccounts"];
    this.#entries = method(
      value.store,
      "readEntries",
    ) as PluginCreditReadStore["readEntries"];
    this.#authorize = method(
      value.authorization,
      "authorize",
    ) as PluginCreditReadAuthorizationPort["authorize"];
  }

  async listAccounts(
    actorInput: ActorContext,
    queryInput: PluginCreditAccountsQuery,
  ): Promise<PluginCreditAccountsReadResult> {
    const { actor, query } = validatedInput(() => ({
      actor: actorOf(actorInput),
      query: validatePluginCreditAccountsQuery(queryInput),
    }));
    const permission = permissionOf(actor, null);
    await this.#check(permission);
    let raw: unknown;
    try {
      raw = await this.#list(
        Object.freeze({
          tenantId: actor.tenantId,
          principalId: actor.principalId,
          ...query,
        }),
      );
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_credit_read_store_unavailable",
        { cause },
      );
    }
    const result = stored(() => accountsOf(raw, actor, query));
    await this.#check(permission);
    return result;
  }

  async getEntries(
    actorInput: ActorContext,
    queryInput: PluginCreditEntriesQuery,
  ): Promise<PluginCreditEntriesReadResult> {
    const { actor, query } = validatedInput(() => ({
      actor: actorOf(actorInput),
      query: validatePluginCreditEntriesQuery(queryInput),
    }));
    const scope = validateCreditScope({
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      poolId: query.poolId,
    });
    const permission = permissionOf(actor, scope.poolId);
    await this.#check(permission);
    let raw: unknown;
    try {
      raw = await this.#entries(
        Object.freeze({
          scope,
          afterRevision: query.afterRevision,
          limit: query.limit,
        }),
      );
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_credit_read_store_unavailable",
        { cause },
      );
    }
    const result = stored(() => entriesOf(raw, scope, query));
    await this.#check(permission);
    if (result.state === "ready" && result.account === null)
      throw new ApplicationError("notFound", "plugin_credit_account_not_found");
    return result;
  }

  async #check(
    permission: PluginCreditReadAuthorizationRequest,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.#authorize(permission);
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_credit_read_authorization_unavailable",
        { cause },
      );
    }
    let outcome: unknown;
    try {
      const fields = record(raw, ["outcome", "reasonCode"], ["reasonCode"]);
      outcome = fields.outcome;
      if (outcome === "allow") {
        if (Object.hasOwn(fields, "reasonCode"))
          throw new Error("Unexpected allow reason");
      } else if (outcome === "deny") {
        if (
          typeof fields.reasonCode !== "string" ||
          !/^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(fields.reasonCode)
        )
          throw new Error("Invalid denial");
      } else throw new Error("Invalid decision");
    } catch (cause) {
      throw new ApplicationError(
        "internal",
        "plugin_credit_read_authorization_invalid",
        { cause },
      );
    }
    if (outcome !== "allow")
      throw new ApplicationError(
        "authorization",
        "plugin_credit_read_forbidden",
      );
  }
}

function actorOf(input: unknown): ActorContext {
  const value = record(input, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  return Object.freeze({
    principalId: parsePluginCreditPoolId(value.principalId),
    actorId: actorIdentifier(value.actorId),
    tenantId: parsePluginCreditPoolId(value.tenantId),
    spaceId: actorIdentifier(value.spaceId),
  });
}
/** Session and space IDs preserve the original Control identity's 512-character bound. */
function actorIdentifier(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 512 ||
    input.trim() !== input ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    throw new Error("Invalid actor identity");
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new Error("Invalid actor identity");
  }
  return input;
}
function permissionOf(
  actor: ActorContext,
  poolId: string | null,
): PluginCreditReadAuthorizationRequest {
  return Object.freeze({
    actor,
    action: "pluginCredit:read",
    resource: Object.freeze({
      kind: "pluginCredit",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      principalId: actor.principalId,
      poolId,
    }),
  });
}
function accountsOf(
  input: unknown,
  actor: ActorContext,
  query: PluginCreditAccountsQuery,
): PluginCreditAccountsReadResult {
  const value = record(input, ["state", "accounts", "nextPoolId"]);
  const accounts = array(value.accounts, query.limit).map((item) => {
    const account = validateCreditAccount(item);
    assertScope(account.scope, {
      tenantId: actor.tenantId,
      principalId: actor.principalId,
      poolId: account.scope.poolId,
    });
    return account;
  });
  const checked = parsePluginCreditAccountsResponse(
    {
      schemaVersion: "crewon.plugin-credit-accounts.v1",
      state: value.state,
      accounts: accounts.map(accountView),
      nextPoolId: value.nextPoolId,
    },
    query,
  );
  return Object.freeze({
    state: checked.state,
    accounts: Object.freeze(accounts),
    nextPoolId: checked.nextPoolId,
  });
}
function entriesOf(
  input: unknown,
  scope: CreditScope,
  query: PluginCreditEntriesQuery,
): PluginCreditEntriesReadResult {
  const value = record(input, ["state", "account", "entries", "nextRevision"]);
  const account =
    value.account === null ? null : validateCreditAccount(value.account);
  if (account !== null) assertScope(account.scope, scope);
  const entries = array(value.entries, query.limit).map((item) =>
    entryOf(item, scope),
  );
  if (value.state === "ready" && account === null) {
    if (entries.length !== 0 || value.nextRevision !== null)
      throw new Error("Missing account has entries");
    return Object.freeze({
      state: "ready",
      account: null,
      entries: Object.freeze([]),
      nextRevision: null,
    });
  }
  const checked = parsePluginCreditEntriesResponse(
    {
      schemaVersion: "crewon.plugin-credit-entries.v1",
      state: value.state,
      account: account === null ? null : accountView(account),
      entries: entries.map((entry) => ({
        revision: entry.revision,
        kind: entry.kind,
        credits: entry.credits,
        account: accountView(entry.account),
      })),
      nextRevision: value.nextRevision,
    },
    query,
  );
  return Object.freeze({
    state: checked.state,
    account,
    entries: Object.freeze(entries),
    nextRevision: checked.nextRevision,
  });
}
function entryOf(input: unknown, scope: CreditScope): PluginCreditEntry {
  const value = record(input, [
    "scope",
    "revision",
    "kind",
    "credits",
    "grantId",
    "reservationId",
    "account",
  ]);
  const entryScope = validateCreditScope(value.scope),
    account = validateCreditAccount(value.account);
  assertScope(entryScope, scope);
  assertScope(account.scope, scope);
  const checked = parsePluginCreditEntryView({
    revision: value.revision,
    kind: value.kind,
    credits: value.credits,
    account: accountView(account),
  });
  const grantId =
    value.grantId === null ? null : parsePluginCreditPoolId(value.grantId);
  const reservationId =
    value.reservationId === null
      ? null
      : parsePluginCreditPoolId(value.reservationId);
  if (
    checked.kind === "grant"
      ? grantId === null || reservationId !== null
      : grantId !== null || reservationId === null
  )
    throw new Error("Invalid ledger reference");
  return Object.freeze({
    scope: entryScope,
    revision: checked.revision,
    kind: checked.kind,
    credits: checked.credits,
    grantId,
    reservationId,
    account,
  });
}
function accountView(account: CreditAccount): PluginCreditAccountView {
  return Object.freeze({
    poolId: account.scope.poolId,
    revision: account.revision,
    availableCredits: account.availableCredits,
    reservedCredits: account.reservedCredits,
    spentCredits: account.spentCredits,
    grantedCredits: account.grantedCredits,
  });
}
function assertScope(actual: CreditScope, expected: CreditScope): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.principalId !== expected.principalId ||
    actual.poolId !== expected.poolId
  )
    throw new Error("Credit scope mismatch");
}
function validatedInput<T>(read: () => T): T {
  try {
    return read();
  } catch (cause) {
    throw new ApplicationError(
      "validation",
      "plugin_credit_read_input_invalid",
      { cause },
    );
  }
}
function stored<T>(read: () => T): T {
  try {
    return read();
  } catch (cause) {
    throw new ApplicationError("internal", "plugin_credit_read_store_invalid", {
      cause,
    });
  }
}
function record(
  input: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected data object");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype)
    throw new Error("Expected plain data");
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
    throw new Error("Invalid data fields");
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key as string]!.value]),
  );
}
function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || input.length > maximum)
    throw new Error("Invalid page");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== input.length + 1)
    throw new Error("Invalid page");
  const result: unknown[] = [];
  for (let i = 0; i < input.length; i++) {
    const d = descriptors[String(i)];
    if (d === undefined || !d.enumerable || !Object.hasOwn(d, "value"))
      throw new Error("Invalid page");
    result.push(d.value);
  }
  return result;
}
function method(input: unknown, name: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_credit_read_port_invalid");
  for (
    let current: object | null = input;
    current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      throw new Error("plugin_credit_read_port_invalid");
    return descriptor.value.bind(input) as (...args: never[]) => unknown;
  }
  throw new Error("plugin_credit_read_port_invalid");
}
