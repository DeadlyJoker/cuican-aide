import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpControlTokenVerifier,
  HttpPolicyDecisionPort,
} from "./production-http-security-ports.ts";

const SERVICE_TOKEN = "security-service-token-that-is-long-enough";

test("identity verifier sends only the user token to the configured HTTPS authority", async () => {
  const captured: { url: string; init: RequestInit }[] = [];
  const verifier = new HttpControlTokenVerifier({
    url: "https://identity.example/v1/control-token:verify",
    serviceToken: SERVICE_TOKEN,
    fetch: async (input, init = {}) => {
      captured.push({ url: String(input), init });
      return Response.json({ issuer: "https://identity.example" });
    },
  });

  const result = await verifier.verify({
    accessToken: "short-lived-user-token",
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { issuer: "https://identity.example" });
  const request = captured[0];
  assert.notEqual(request, undefined);
  assert.equal(request.url, "https://identity.example/v1/control-token:verify");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.deepEqual(request.init.headers, {
    "accept": "application/json",
    "authorization": `Bearer ${SERVICE_TOKEN}`,
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    accessToken: "short-lived-user-token",
  });
});

test("policy port sends the complete actor/action/resource tuple", async () => {
  let body: unknown;
  const policy = new HttpPolicyDecisionPort({
    url: "https://policy.example/v1/authorize",
    serviceToken: SERVICE_TOKEN,
    fetch: async (_input, init = {}) => {
      body = JSON.parse(String(init.body));
      return Response.json({ outcome: "allow" });
    },
  });
  const input = {
    actor: {
      principalId: "principal-1",
      actorId: "actor-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
    },
    action: "thread:read" as const,
    resource: {
      kind: "thread" as const,
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
    },
    signal: new AbortController().signal,
  };

  assert.deepEqual(await policy.decide(input), { outcome: "allow" });
  assert.deepEqual(body, {
    actor: input.actor,
    action: input.action,
    resource: input.resource,
  });
});

test("policy port preserves the complete Automation authorization tuple", async () => {
  let body: unknown;
  const policy = new HttpPolicyDecisionPort({
    url: "https://policy.example/v1/authorize",
    serviceToken: SERVICE_TOKEN,
    fetch: async (_input, init = {}) => {
      body = JSON.parse(String(init.body));
      return Response.json({ outcome: "allow" });
    },
  });
  const input = {
    actor: {
      principalId: "principal-1",
      actorId: "actor-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
    },
    action: "automation:create" as const,
    resource: {
      kind: "automation" as const,
      tenantId: "tenant-1",
      spaceId: "space-1",
      automationId: null,
      threadId: "thread-1",
    },
    signal: new AbortController().signal,
  };

  assert.deepEqual(await policy.decide(input), { outcome: "allow" });
  assert.deepEqual(body, {
    actor: input.actor,
    action: input.action,
    resource: input.resource,
  });
});

test("security HTTP ports require HTTPS and bounded JSON responses", async () => {
  assert.throws(
    () =>
      new HttpControlTokenVerifier({
        url: "http://identity.example/verify",
        serviceToken: SERVICE_TOKEN,
      }),
    /identity_verify_url_invalid/u,
  );
  const verifier = new HttpControlTokenVerifier({
    url: "https://identity.example/verify",
    serviceToken: SERVICE_TOKEN,
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(17 * 1_024),
        },
      }),
  });
  await assert.rejects(
    verifier.verify({
      accessToken: "user-token",
      signal: new AbortController().signal,
    }),
    /identity_authority_unavailable/u,
  );
});
