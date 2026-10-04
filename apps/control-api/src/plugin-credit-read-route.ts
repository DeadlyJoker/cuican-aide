import {
  ApplicationError,
  type PluginCreditReadApplicationService,
} from "@crewon/application";
import {
  PLUGIN_CREDIT_ACCOUNTS_PATH,
  PLUGIN_CREDIT_ENTRIES_PATH,
  parsePluginCreditAccountsQuery,
  parsePluginCreditEntriesQuery,
  parsePluginCreditAccountsResponse,
  parsePluginCreditEntriesResponse,
  type PluginCreditAccountView,
} from "@crewon/contracts";
import type { CreditAccount } from "@crewon/domain";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";

export type PluginCreditReadControlService = Pick<
  PluginCreditReadApplicationService,
  "listAccounts" | "getEntries"
>;

/** Personal read projections contain no tenant/principal, grant or reservation references. */
export function registerPluginCreditReadRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    identity: ControlApiIdentityPort;
    service: PluginCreditReadControlService;
  }>,
): void {
  app.get<{ Querystring: unknown }>(
    PLUGIN_CREDIT_ACCOUNTS_PATH,
    async (request, reply) => {
      readHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parsePluginCreditAccountsQuery(httpQuery(request.query));
      const result = await dependencies.service.listAccounts(actor, query);
      return checked(() =>
        parsePluginCreditAccountsResponse(
          {
            schemaVersion: "crewon.plugin-credit-accounts.v1",
            state: result.state,
            accounts: result.accounts.map(accountView),
            nextPoolId: result.nextPoolId,
          },
          query,
        ),
      );
    },
  );
  app.get<{ Querystring: unknown }>(
    PLUGIN_CREDIT_ENTRIES_PATH,
    async (request, reply) => {
      readHeaders(reply);
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parsePluginCreditEntriesQuery(httpQuery(request.query));
      const result = await dependencies.service.getEntries(actor, query);
      return checked(() =>
        parsePluginCreditEntriesResponse(
          {
            schemaVersion: "crewon.plugin-credit-entries.v1",
            state: result.state,
            account:
              result.account === null ? null : accountView(result.account),
            entries: result.entries.map((entry) => ({
              revision: entry.revision,
              kind: entry.kind,
              credits: entry.credits,
              account: accountView(entry.account),
            })),
            nextRevision: result.nextRevision,
          },
          query,
        ),
      );
    },
  );
}

function accountView(account: CreditAccount): PluginCreditAccountView {
  return {
    poolId: account.scope.poolId,
    revision: account.revision,
    availableCredits: account.availableCredits,
    reservedCredits: account.reservedCredits,
    spentCredits: account.spentCredits,
    grantedCredits: account.grantedCredits,
  };
}
/** Fastify supplies its own query prototype. Preserve descriptors for strict field validation. */
function httpQuery(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return input;
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(input));
}
function readHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.header("cross-origin-resource-policy", "same-origin");
}
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch (cause) {
    throw new ApplicationError(
      "internal",
      "plugin_credit_read_response_invalid",
      { cause },
    );
  }
}
