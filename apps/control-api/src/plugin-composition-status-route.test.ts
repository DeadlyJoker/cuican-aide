import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ApplicationError } from "@crewon/application";
import {
  PLUGIN_COMPOSITION_STATUS_SCHEMA,
  type PluginCompositionStatusResponse,
} from "@crewon/contracts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { errorResponse, notFoundResponse } from "./control-api-errors.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import type { PluginCompositionStatusControlService } from "./plugin-composition-status-route.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import {
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";

const actor = {
  principalId: "test-principal",
  actorId: "test-actor",
  tenantId: "test-tenant",
  spaceId: "test-space",
};
const sessionToken = "s".repeat(32);
const headers = {
  authorization: `Bearer ${sessionToken}`,
  origin: "crewon://desktop",
};
const url = "/api/v1/plugins/composition/status";
const digest = `sha256:${"a".repeat(64)}`;
const response = (): PluginCompositionStatusResponse => ({
  schemaVersion: PLUGIN_COMPOSITION_STATUS_SCHEMA,
  metadata: { state: "published", lockDigest: digest, revision: 1 },
  plugins: [
    {
      selection: {
        pluginId: "sample.plugin",
        publisherId: "sample.publisher",
        revision: 2,
        state: "enabled",
        selectedPackageDigest: digest,
        updatedAt: "2026-10-11T00:00:00.000Z",
      },
      node: { state: "unobserved" },
    },
  ],
  next: null,
});
function fixture(service?: PluginCompositionStatusControlService) {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  app.setNotFoundHandler((request, reply) => {
    const result = notFoundResponse(request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity: new StandaloneIdentity({
      actor,
      sessionToken,
      csrfToken: "c".repeat(32),
      allowedOrigins: ["crewon://desktop"],
    }),
    pluginCompositionStatus: service,
  });
  return app;
}

test("composition status stays an unavailable optional route without an actual owner", async (t) => {
  const app = fixture();
  t.after(() => app.close());
  for (const credentials of [{}, headers]) {
    const result = await app.inject({
      method: "GET",
      url,
      headers: credentials,
    });
    assert.equal(result.statusCode, 404);
    assert.equal(result.json().error.code, "route_not_found");
    assert.equal(result.body.includes("ready"), false);
  }
});

test("configured status authenticates before parsing query or observing live state", async (t) => {
  let reads = 0;
  const app = fixture({
    listStatus: async () => {
      reads++;
      return response();
    },
  });
  t.after(() => app.close());
  for (const credentials of [{}, { authorization: "Bearer invalid" }]) {
    const result = await app.inject({
      method: "GET",
      url: `${url}?tenantId=foreign&limit=1000`,
      headers: credentials,
    });
    assert.equal(result.statusCode, 401);
  }
  assert.equal(reads, 0);
  for (const query of [
    "limit=51",
    "limit=01",
    "limit=20&limit=30",
    "profileId=foreign",
    "tenantId=foreign",
  ])
    assert.equal(
      (await app.inject({ method: "GET", url: `${url}?${query}`, headers }))
        .statusCode,
      400,
    );
  assert.equal(reads, 0);
});

test("actual owner receives the authenticated actor and bounded original cursor without status inference", async (t) => {
  let reads = 0;
  const app = fixture({
    listStatus: async (actualActor, query) => {
      reads++;
      assert.deepEqual(actualActor, actor);
      assert.deepEqual(query, { afterPluginId: "sample.before", limit: 2 });
      return response();
    },
  });
  t.after(() => app.close());
  const result = await app.inject({
    method: "GET",
    url: `${url}?afterPluginId=sample.before&limit=2`,
    headers,
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), response());
  assert.equal(result.json().plugins[0].node.state, "unobserved");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.equal(result.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(reads, 1);
  for (const key of [
    "tenantId",
    "spaceId",
    "profileId",
    "actorId",
    "installRoot",
    "services",
  ])
    assert.equal(result.body.includes(key), false);
});

test("current-owner scope denial is preserved instead of leaking another profile or inventing readiness", async (t) => {
  const app = fixture({
    listStatus: async (actualActor) => {
      assert.deepEqual(actualActor, actor);
      throw new ApplicationError("authorization", "plugin_profile_changed");
    },
  });
  t.after(() => app.close());
  const result = await app.inject({ method: "GET", url, headers });
  assert.equal(result.statusCode, 403);
  assert.equal(result.json().error.code, "plugin_profile_changed");
  assert.equal(result.body.includes("sample.plugin"), false);
});

test("invalid or oversized owner output fails closed with no private details", async (t) => {
  let supplied: unknown;
  const app = fixture({
    listStatus: async () => supplied as PluginCompositionStatusResponse,
  });
  t.after(() => app.close());
  const privateValue = "/private/install/root SECRET_CREDENTIAL";
  for (const invalid of [
    { ...response(), installRoot: privateValue },
    { ...response(), metadata: { state: "failed", reasonCode: privateValue } },
    { ...response(), schemaVersion: "crewon.plugin-composition-status.v0" },
    {
      ...response(),
      plugins: [
        {
          selection: { ...response().plugins[0]!.selection, state: "disabled" },
          node: { state: "ready" },
        },
      ],
    },
    {
      ...response(),
      plugins: Array.from({ length: 51 }, () => response().plugins[0]),
    },
    { ...response(), next: "sample.plugin" },
    {
      ...response(),
      metadata: { state: "failed", reasonCode: "s".repeat(65536) },
    },
  ]) {
    supplied = invalid;
    const result = await app.inject({ method: "GET", url, headers });
    assert.equal(result.statusCode, 500, result.body);
    assert.equal(
      result.json().error.code,
      "plugin_composition_status_response_invalid",
    );
    assert.equal(result.body.includes(privateValue), false);
    assert.equal(result.body.includes("sample.plugin"), false);
  }
});

test("source owner transport failure never fabricates an empty healthy graph", async (t) => {
  const app = fixture({
    listStatus: async () => {
      throw new Error("/private/path SECRET_CREDENTIAL");
    },
  });
  t.after(() => app.close());
  const result = await app.inject({ method: "GET", url, headers });
  assert.equal(result.statusCode, 500);
  assert.equal(result.json().error.code, "internal_error");
  assert.equal(result.body.includes("SECRET_CREDENTIAL"), false);
  assert.equal(result.body.includes("plugins"), false);
});

test("production identity rejects injected tenant scope and owner rejects a different verified actor", async (t) => {
  const now = Date.parse("2026-10-11T00:00:00.000Z");
  const serviceToken = "b".repeat(32);
  let verifications = 0;
  let observations = 0;
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error, request.id);
    return reply.code(result.statusCode).send(result.body);
  });
  registerPluginControlRoutes(app, {
    identity: new ProductionControlApiIdentity({
      trustedBff: new StaticTrustedBffRequestVerifier({
        serviceToken,
        allowedOrigins: ["crewon://desktop"],
        allowedRemoteAddresses: ["127.0.0.1"],
      }),
      tokens: {
        verify: async ({ accessToken }) => {
          verifications++;
          if (accessToken !== sessionToken && accessToken !== "foreign-session")
            throw new ControlApiIdentityError(
              "authentication",
              "token_invalid",
            );
          return {
            ...actor,
            ...(accessToken === "foreign-session"
              ? { tenantId: "foreign-tenant" }
              : {}),
            issuer: "https://identity.example.test",
            audience: "crewon-control",
            issuedAt: new Date(now - 1_000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
          };
        },
      },
      expectedIssuer: "https://identity.example.test",
      expectedAudience: "crewon-control",
      timeoutMs: 1_000,
      cacheTtlMs: 0,
      now: () => now,
    }),
    pluginCompositionStatus: {
      listStatus: async (actualActor) => {
        if (actualActor.tenantId !== actor.tenantId)
          throw new ApplicationError("authorization", "plugin_profile_changed");
        assert.deepEqual(actualActor, actor);
        observations++;
        return response();
      },
    },
  });
  const trustedHeaders = {
    ...headers,
    [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${serviceToken}`,
  };
  assert.equal(
    (await app.inject({ method: "GET", url, headers })).statusCode,
    401,
  );
  for (const key of [
    "x-crewon-principal-id",
    "x-crewon-actor-id",
    "x-crewon-tenant-id",
    "x-crewon-space-id",
  ])
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { ...trustedHeaders, [key]: "injected" },
        })
      ).statusCode,
      403,
    );
  assert.equal(verifications, 0);
  assert.equal(observations, 0);
  const own = await app.inject({ method: "GET", url, headers: trustedHeaders });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(verifications, 1);
  assert.equal(observations, 1);
  const foreign = await app.inject({
    method: "GET",
    url,
    headers: { ...trustedHeaders, authorization: "Bearer foreign-session" },
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, "plugin_profile_changed");
  assert.equal(foreign.body.includes("sample.plugin"), false);
  assert.equal(observations, 1);
  const invalid = await app.inject({
    method: "GET",
    url,
    headers: { ...trustedHeaders, authorization: "Bearer invalid-session" },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(observations, 1);
});
