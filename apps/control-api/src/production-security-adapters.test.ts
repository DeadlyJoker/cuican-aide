import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorizationPort } from "@crewon/application";

import { ControlApiIdentityError } from "./control-api-ports.ts";
import {
  DynamicPolicyAuthorization,
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
  type ControlTokenVerifierPort,
  type PolicyDecisionPort,
  type SecurityDeadlinePort,
  type TrustedBffRequestVerifierPort,
} from "./production-security-adapters.ts";

const NOW = Date.parse("2026-08-09T00:00:00.000Z");
const ACTOR = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;

test("derives actor only from the verified token and bounds the identity cache", async () => {
  let trustedCalls = 0;
  let tokenCalls = 0;
  const trustedBff: TrustedBffRequestVerifierPort = {
    verify(request) {
      trustedCalls += 1;
      assert.deepEqual(request, {
        method: "GET",
        url: "/api/v1/threads",
        remoteAddress: "10.0.0.7",
        origin: "https://bff.internal.example",
        serviceAuthorization: "Bearer bff-service-token",
      });
    },
  };
  const tokens: ControlTokenVerifierPort = {
    async verify({ accessToken, signal }) {
      tokenCalls += 1;
      assert.equal(accessToken, "user-control-token");
      assert.equal(signal.aborted, false);
      return assertion(ACTOR);
    },
  };
  const identity = new ProductionControlApiIdentity({
    trustedBff,
    tokens,
    expectedIssuer: "https://identity.example",
    expectedAudience: "crewon-control",
    timeoutMs: 2_000,
    cacheTtlMs: 5_000,
    cacheMaxEntries: 1,
    now: () => NOW,
  });

  assert.deepEqual(await identity.resolveActor(request()), ACTOR);
  assert.deepEqual(await identity.resolveActor(request()), ACTOR);
  assert.deepEqual(
    { trustedCalls, tokenCalls },
    { trustedCalls: 2, tokenCalls: 1 },
  );
});

test("rejects actor injection headers without consulting the token authority", async () => {
  let tokenCalls = 0;
  const identity = new ProductionControlApiIdentity({
    trustedBff: { verify() {} },
    tokens: {
      async verify() {
        tokenCalls += 1;
        return assertion(ACTOR);
      },
    },
    expectedIssuer: "https://identity.example",
    expectedAudience: "crewon-control",
    timeoutMs: 2_000,
    now: () => NOW,
  });

  await assert.rejects(
    identity.resolveActor({
      ...request(),
      headers: { ...request().headers, "x-crewon-tenant-id": "forged" },
    }),
    hasIdentityError("authorization", "actor_header_forbidden"),
  );
  assert.equal(tokenCalls, 0);
});

test("fails closed on malformed, wrong-scope, and expired identity assertions", async () => {
  const invalidAssertions = [
    { ...assertion(ACTOR), issuer: "https://attacker.example" },
    { ...assertion(ACTOR), audience: "different-audience" },
    { ...assertion(ACTOR), expiresAt: "2026-08-08T23:59:59.000Z" },
    { ...assertion(ACTOR), injected: "not-accepted" },
  ];
  for (const invalid of invalidAssertions) {
    const identity = new ProductionControlApiIdentity({
      trustedBff: { verify() {} },
      tokens: {
        async verify() {
          return invalid;
        },
      },
      expectedIssuer: "https://identity.example",
      expectedAudience: "crewon-control",
      timeoutMs: 2_000,
      now: () => NOW,
    });
    await assert.rejects(
      identity.resolveActor(request()),
      hasIdentityError("authentication", "identity_assertion_invalid"),
    );
  }
});

test("applies the configured identity authority deadline without timers in the test", async () => {
  const deadline = new RejectingDeadline();
  const identity = new ProductionControlApiIdentity({
    trustedBff: { verify() {} },
    tokens: {
      async verify() {
        return assertion(ACTOR);
      },
    },
    expectedIssuer: "https://identity.example",
    expectedAudience: "crewon-control",
    timeoutMs: 1_234,
    deadline,
    now: () => NOW,
  });

  await assert.rejects(
    identity.resolveActor(request()),
    hasIdentityError("authentication", "identity_verification_failed"),
  );
  assert.equal(deadline.timeoutMs, 1_234);
});

test("authenticates the BFF service credential, direct peer, and origin independently", () => {
  const verifier = new StaticTrustedBffRequestVerifier({
    serviceToken: "bff-service-token-that-is-long-enough-123",
    allowedOrigins: ["https://bff.internal.example"],
    allowedRemoteAddresses: ["10.0.0.7"],
  });
  const valid = {
    method: "POST",
    url: "/api/v1/threads",
    remoteAddress: "10.0.0.7",
    origin: "https://bff.internal.example",
    serviceAuthorization: "Bearer bff-service-token-that-is-long-enough-123",
  } as const;
  assert.doesNotThrow(() => verifier.verify(valid));
  assert.throws(
    () => verifier.verify({ ...valid, remoteAddress: "10.0.0.8" }),
    hasIdentityError("authorization", "bff_peer_not_allowed"),
  );
  assert.throws(
    () => verifier.verify({ ...valid, origin: "https://browser.example" }),
    hasIdentityError("authorization", "bff_origin_not_allowed"),
  );
  assert.throws(
    () =>
      verifier.verify({
        ...valid,
        serviceAuthorization: "Bearer wrong-service-token",
      }),
    hasIdentityError("authentication", "bff_service_credential_invalid"),
  );
});

test("dynamic policy denies cross-scope locally and strictly parses decisions", async () => {
  const calls: Parameters<PolicyDecisionPort["decide"]>[0][] = [];
  let response: unknown = { outcome: "allow" };
  const policy: PolicyDecisionPort = {
    async decide(input) {
      calls.push(input);
      return response;
    },
  };
  const authorization = new DynamicPolicyAuthorization({
    policy,
    timeoutMs: 2_000,
  });
  const sameScope = authorizationRequest();

  assert.deepEqual(await authorization.authorize(sameScope), {
    outcome: "allow",
  });
  assert.equal(calls.length, 1);
  const automationRequest = {
    actor: ACTOR,
    action: "automation:run" as const,
    resource: {
      kind: "automation" as const,
      tenantId: ACTOR.tenantId,
      spaceId: ACTOR.spaceId,
      automationId: "automation-1",
      threadId: "thread-1",
    },
  };
  assert.deepEqual(await authorization.authorize(automationRequest), {
    outcome: "allow",
  });
  assert.deepEqual(calls.at(-1), {
    ...automationRequest,
    signal: calls.at(-1)?.signal,
  });
  assert.deepEqual(
    await authorization.authorize({
      ...sameScope,
      resource: { ...sameScope.resource, tenantId: "tenant-2" },
    }),
    { outcome: "deny", reasonCode: "actor_scope_mismatch" },
  );
  assert.equal(calls.length, 2);

  response = { outcome: "deny", reasonCode: "pim_role_missing" };
  assert.deepEqual(await authorization.authorize(sameScope), response);
  response = { outcome: "allow", unexpected: true };
  await assert.rejects(
    authorization.authorize(sameScope),
    /policy_decision_invalid/u,
  );
});

test("applies the configured policy deadline", async () => {
  const deadline = new RejectingDeadline();
  const authorization = new DynamicPolicyAuthorization({
    policy: {
      async decide() {
        return { outcome: "allow" };
      },
    },
    timeoutMs: 987,
    deadline,
  });
  await assert.rejects(
    authorization.authorize(authorizationRequest()),
    /test_deadline/u,
  );
  assert.equal(deadline.timeoutMs, 987);
});

class RejectingDeadline implements SecurityDeadlinePort {
  timeoutMs: number | null = null;

  async run<T>(
    timeoutMs: number,
    _operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.timeoutMs = timeoutMs;
    throw new Error("test_deadline");
  }
}

function request() {
  return {
    method: "GET",
    url: "/api/v1/threads",
    remoteAddress: "10.0.0.7",
    headers: {
      authorization: "Bearer user-control-token",
      origin: "https://bff.internal.example",
      [PRODUCTION_BFF_AUTHORIZATION_HEADER]: "Bearer bff-service-token",
    },
  } as const;
}

function assertion(actor: typeof ACTOR) {
  return {
    issuer: "https://identity.example",
    audience: ["crewon-control"],
    ...actor,
    issuedAt: "2026-08-08T23:55:00.000Z",
    expiresAt: "2026-08-09T00:05:00.000Z",
  };
}

function authorizationRequest(): Parameters<AuthorizationPort["authorize"]>[0] {
  return {
    actor: ACTOR,
    action: "thread:read",
    resource: {
      kind: "thread",
      tenantId: ACTOR.tenantId,
      spaceId: ACTOR.spaceId,
      threadId: "thread-1",
    },
  };
}

function hasIdentityError(
  category: ControlApiIdentityError["category"],
  code: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ControlApiIdentityError &&
    error.category === category &&
    error.code === code;
}
