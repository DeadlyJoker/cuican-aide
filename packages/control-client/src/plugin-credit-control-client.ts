import {
  MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES,
  parsePluginCreditAccountsResponse,
  parsePluginCreditEntriesResponse,
  pluginCreditAccountsPath,
  pluginCreditEntriesPath,
  validatePluginCreditAccountsQuery,
  validatePluginCreditEntriesQuery,
  type PluginCreditAccountsQuery,
  type PluginCreditEntriesQuery,
} from "@crewon/contracts";
import type {
  PluginControlRequestOptions,
  PluginControlTransport,
} from "./plugin-control-client.ts";

export type PluginCreditAccountsClientQuery =
  Partial<PluginCreditAccountsQuery>;
export type PluginCreditEntriesClientQuery = Pick<
  PluginCreditEntriesQuery,
  "poolId"
> &
  Partial<Omit<PluginCreditEntriesQuery, "poolId">>;

/** Uses the authenticated host transport; callers cannot choose an account owner. */
export class PluginCreditControlClient {
  readonly #transport: PluginControlTransport;
  constructor(transport: PluginControlTransport) {
    this.#transport = transport;
  }

  async listAccounts(
    query: PluginCreditAccountsClientQuery = {},
    options: PluginControlRequestOptions = {},
  ) {
    options.signal?.throwIfAborted();
    const checked = this.#input(() =>
      validatePluginCreditAccountsQuery({
        afterPoolId: null,
        limit: 16,
        ...queryFields(query, ["afterPoolId", "limit"]),
      }),
    );
    const result = await this.#transport.json(
      "GET",
      pluginCreditAccountsPath(checked),
      null,
      {
        ...options,
        expectedStatuses: [200],
        maximumResponseBytes: MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES,
        redirect: "manual",
      },
    );
    options.signal?.throwIfAborted();
    return this.#output(() =>
      parsePluginCreditAccountsResponse(result, checked),
    );
  }

  async getEntries(
    query: PluginCreditEntriesClientQuery,
    options: PluginControlRequestOptions = {},
  ) {
    options.signal?.throwIfAborted();
    const checked = this.#input(() =>
      validatePluginCreditEntriesQuery({
        afterRevision: 0,
        limit: 50,
        ...queryFields(query, ["poolId", "afterRevision", "limit"]),
      }),
    );
    const result = await this.#transport.json(
      "GET",
      pluginCreditEntriesPath(checked),
      null,
      {
        ...options,
        expectedStatuses: [200],
        maximumResponseBytes: MAX_PLUGIN_CREDIT_READ_RESPONSE_BYTES,
        redirect: "manual",
      },
    );
    options.signal?.throwIfAborted();
    return this.#output(() =>
      parsePluginCreditEntriesResponse(result, checked),
    );
  }

  #input<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw this.#transport.protocolError(
        "control_client_plugin_credit_query_invalid",
      );
    }
  }
  #output<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw this.#transport.protocolError(
        "control_client_plugin_credit_response_invalid",
      );
    }
  }
}

function queryFields(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid credit query");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype)
    throw new Error("Invalid credit query");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)!;
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !field.enumerable ||
      !Object.hasOwn(field, "value")
    )
      throw new Error("Invalid credit query");
    result[key] = field.value;
  }
  return result;
}
