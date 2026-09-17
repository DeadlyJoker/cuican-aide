import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import {
  ModelPricingApplicationService,
  type ActorContext,
} from "@crewon/application";
import { InMemoryRunStore } from "@crewon/store";
import { registerModelPricingRoutes } from "./model-pricing-route.ts";
import { errorResponse } from "./control-api-errors.ts";
const actor: ActorContext = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "actor",
  principalId: "principal",
};
const price = {
  schemaVersion: "crewon.model-token-price.v0",
  currency: "USD",
  rates: { input: "2500000", cacheRead: "250000", output: "10000000" },
};
test("pricing HTTP routes authorize, validate, CAS, replay and leave the model version unchanged", async (t) => {
  const store = new InMemoryRunStore();
  const version = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "agent",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy",
      instructions: "stable prefix",
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "model",
        contextWindowTokens: 10000,
        autoCompactAtTokens: 8000,
      },
      execution: { streamMaxRetries: 1, maxToolRounds: 8 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  );
  const asset = createAgentVersionAsset({
    tenantId: actor.tenantId,
    version,
    createdAt: "2026-09-15T00:00:00Z",
  });
  await store.registerAgentVersion(asset);
  const service = new ModelPricingApplicationService({
    store,
    authorization: {
      authorize: async (request) => ({
        outcome: request.actor.tenantId === actor.tenantId ? "allow" : "deny",
        reasonCode: "scope",
      }),
    },
  });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await store.close();
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  registerModelPricingRoutes(app, {
    modelPricing: service,
    identity: {
      resolveActor: async (request) =>
        request.headers["x-foreign"]
          ? { ...actor, tenantId: "foreign" }
          : actor,
    },
  });
  const url = "/api/v1/agent-versions/agent/token-pricing";
  assert.deepEqual((await app.inject({ method: "GET", url })).json(), {
    pricing: { revision: 0, price: null },
  });
  const before = await store.loadAgentVersion({
    tenantId: actor.tenantId,
    agentVersionId: "agent",
  });
  for (let i = 0; i < 2; i++) {
    const response = await app.inject({
      method: "PUT",
      url,
      payload: { expectedRevision: 0, price },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { pricing: { revision: 1, price } });
  }
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url,
        payload: { expectedRevision: 0, price: null },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url,
        headers: { "x-foreign": "true" },
        payload: { expectedRevision: 1, price: null },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: "GET", url, headers: { "x-foreign": "true" } }))
      .statusCode,
    403,
  );
  for (const payload of [
    { expectedRevision: 1, price, tenantId: "foreign" },
    {
      expectedRevision: 1,
      price: { ...price, rates: { ...price.rates, input: "2.5" } },
    },
    { expectedRevision: -1, price },
    {},
  ])
    assert.equal(
      (await app.inject({ method: "PUT", url, payload })).statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/agent-versions/missing/token-pricing",
      })
    ).statusCode,
    404,
  );
  assert.deepEqual(
    await store.loadAgentVersion({
      tenantId: actor.tenantId,
      agentVersionId: "agent",
    }),
    before,
  );
  assert.deepEqual((await app.inject({ method: "GET", url })).json(), {
    pricing: { revision: 1, price },
  });
});
