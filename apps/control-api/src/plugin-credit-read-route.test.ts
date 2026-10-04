import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  PluginCreditReadApplicationService,
  type PluginCreditReadAuthorizationRequest,
} from "@crewon/application";
import {
  ControlApiClient,
  ControlApiClientError,
} from "@crewon/control-client";
import { SqliteRunStore } from "@crewon/store";
import { errorResponse } from "./control-api-errors.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { registerPluginCreditReadRoutes } from "./plugin-credit-read-route.ts";
import {
  pluginRouteActor as actor,
  pluginRouteCredentials as credentials,
  pluginRouteHeaders as headers,
} from "./plugin-control-route.test-support.ts";

const poolId = "创作/独立积分";
const scope = {
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId,
};
async function fixture(t: TestContext) {
  const parent = new SqliteRunStore(":memory:");
  const creditStore = parent.pluginCreditStore();
  let allowed = true;
  const decisions: PluginCreditReadAuthorizationRequest[] = [];
  const service = new PluginCreditReadApplicationService({
    store: creditStore,
    authorization: {
      async authorize(request) {
        decisions.push(request);
        return allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "policy_withdrawn" };
      },
    },
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  registerPluginCreditReadRoutes(app, {
    identity: new StandaloneIdentity({
      actor,
      ...credentials,
      allowedOrigins: [credentials.origin],
    }),
    service,
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await parent.close();
  });
  return {
    app,
    parent,
    creditStore,
    decisions,
    withdraw() {
      allowed = false;
    },
  };
}
const query = (afterRevision = 0, limit = 50) =>
  new URLSearchParams({
    poolId,
    afterRevision: String(afterRevision),
    limit: String(limit),
  });

test("original HTTP identity reads an unconfigured ledger without creating any credit schema or account", async (t) => {
  const f = await fixture(t);
  for (const path of ["accounts", `entries?${query()}`]) {
    const response = await f.app.inject({
      method: "GET",
      url: `/api/v1/plugins/credits/${path}`,
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.json().state, "unconfigured");
  }
  // A subsequent explicit migration is the first funding integration operation in this fixture.
  await f.creditStore.migrate();
  assert.equal(await f.creditStore.getAccount(scope), null);
  const ready = await f.app.inject({
    method: "GET",
    url: "/api/v1/plugins/credits/accounts",
    headers,
  });
  assert.deepEqual(ready.json(), {
    schemaVersion: "crewon.plugin-credit-accounts.v1",
    state: "ready",
    accounts: [],
    nextPoolId: null,
  });
});

test("real SQLite grant/reserve/settle history crosses HTTP and authenticated client with exact personal projections", async (t) => {
  const f = await fixture(t);
  await f.creditStore.migrate();
  const credits = "123456789012345678901234567890123456789012345678";
  await f.creditStore.grant({
    scope,
    grantId: "test-authorized-funding",
    credits,
  });
  await f.creditStore.grant({
    scope: { ...scope, principalId: "other-user" },
    grantId: "other-funding",
    credits: "999",
  });
  await f.creditStore.grant({
    scope: { ...scope, tenantId: "other-tenant" },
    grantId: "other-tenant-funding",
    credits: "888",
  });
  await f.creditStore.reserve({
    scope,
    reservationId: "test-reservation-private",
    idempotencyKey: "test-reservation-key",
    requestDigest: `sha256:${"a".repeat(64)}`,
    pluginId: "example.short-drama",
    priceRevision: 1,
    quotedCredits: "30",
  });
  await f.creditStore.settle({
    scope,
    reservationId: "test-reservation-private",
    actualCredits: "18",
  });
  const expected = await f.creditStore.getAccount(scope);
  const before = await f.creditStore.listEntries({
    scope,
    afterRevision: 0,
    limit: 50,
  });
  const requests: RequestInit[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: credentials.sessionToken,
    origin: credentials.origin,
    fetch: async (url, init) => {
      requests.push(init ?? {});
      const target = new URL(String(url));
      const requestHeaders: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
      const response = await f.app.inject({
        method: "GET",
        url: `${target.pathname}${target.search}`,
        headers: requestHeaders,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
      });
    },
  });
  const accounts = await client.pluginCredits.listAccounts();
  assert.deepEqual(
    accounts.accounts.map((account) => account.poolId),
    [poolId],
  );
  assert.equal(
    accounts.accounts[0]!.availableCredits,
    (BigInt(credits) - 18n).toString(),
  );
  const first = await client.pluginCredits.getEntries({ poolId, limit: 2 });
  assert.deepEqual(
    first.entries.map((entry) => entry.kind),
    ["grant", "reserve"],
  );
  assert.equal(
    first.entries[1]!.account.availableCredits,
    (BigInt(credits) - 30n).toString(),
  );
  assert.equal(first.account!.spentCredits, "18");
  const next = await client.pluginCredits.getEntries({
    poolId,
    afterRevision: first.nextRevision!,
    limit: 2,
  });
  assert.deepEqual(
    next.entries.map((entry) => entry.kind),
    ["settle"],
  );
  assert.equal(next.nextRevision, null);
  const publicJson = JSON.stringify([accounts, first, next]);
  for (const privateValue of [
    actor.tenantId,
    actor.principalId,
    "test-authorized-funding",
    "test-reservation-private",
    "grantId",
    "reservationId",
    "createdAt",
  ])
    assert.ok(!publicJson.includes(privateValue), privateValue);
  assert.deepEqual(await f.creditStore.getAccount(scope), expected);
  assert.deepEqual(
    await f.creditStore.listEntries({ scope, afterRevision: 0, limit: 50 }),
    before,
  );
  assert.ok(
    requests.every(
      (request) =>
        request.method === "GET" &&
        request.body === undefined &&
        !new Headers(request.headers).has("x-csrf-token"),
    ),
  );
  assert.ok(
    f.decisions.every(
      (decision) =>
        decision.resource.principalId === actor.principalId &&
        decision.actor.tenantId === actor.tenantId,
    ),
  );
  f.withdraw();
  await assert.rejects(
    client.pluginCredits.listAccounts(),
    (error) => error instanceof ControlApiClientError && error.status === 403,
  );
});

test("missing, foreign and malformed selectors never become zero balances or choose another account", async (t) => {
  const f = await fixture(t);
  await f.creditStore.migrate();
  await f.creditStore.grant({
    scope: { ...scope, principalId: "another" },
    grantId: "foreign-only",
    credits: "25",
  });
  const missing = await f.app.inject({
    method: "GET",
    url: `/api/v1/plugins/credits/entries?${query()}`,
    headers,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "plugin_credit_account_not_found");
  const calls = f.decisions.length;
  for (const search of [
    "tenantId=other",
    "principalId=another",
    "limit=17",
    "limit=0",
    "limit=01",
    "limit=1&limit=2",
  ]) {
    const response = await f.app.inject({
      method: "GET",
      url: `/api/v1/plugins/credits/accounts?${search}`,
      headers,
    });
    assert.equal(response.statusCode, 400, search);
  }
  for (const search of [
    "",
    "poolId=x&afterRevision=-1",
    "poolId=x&limit=51",
    "poolId=x&afterRevision=2147483648",
    "poolId=x&poolId=y",
    "poolId=x&spaceId=other",
  ]) {
    const response = await f.app.inject({
      method: "GET",
      url: `/api/v1/plugins/credits/entries?${search}`,
      headers,
    });
    assert.equal(response.statusCode, 400, search);
  }
  assert.equal(f.decisions.length, calls);
  const unauthenticated = await f.app.inject({
    method: "GET",
    url: "/api/v1/plugins/credits/accounts",
    headers: { origin: credentials.origin },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(f.decisions.length, calls);
});
