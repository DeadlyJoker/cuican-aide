import assert from "node:assert/strict";
import test from "node:test";
import { errorResponse } from "./control-api-errors.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { HttpControlTokenVerifier } from "./production-http-security-ports.ts";
import { ProductionControlApiIdentity } from "./production-security-adapters.ts";
import { SecurityAuthorityVerificationError } from "./security-authority-errors.ts";

const NOW = Date.parse("2026-10-14T00:00:00.000Z");
const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const assertion = () => ({
  issuer: "https://identity.example",
  audience: "crewon-control",
  ...actor,
  issuedAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
});
const request = {
  method: "GET",
  url: "/api/v1/plugins/ui/mounts/current",
  remoteAddress: "127.0.0.1",
  headers: { authorization: "Bearer user-control-token" },
};
function identity(
  fetch: ConstructorParameters<typeof HttpControlTokenVerifier>[0]["fetch"],
  timeoutMs = 1000,
) {
  return new ProductionControlApiIdentity({
    trustedBff: { verify() {} },
    tokens: new HttpControlTokenVerifier({
      url: "https://identity.example/verify",
      serviceToken: "private-service-token-is-long-enough",
      fetch,
    }),
    expectedIssuer: "https://identity.example",
    expectedAudience: "crewon-control",
    timeoutMs,
    now: () => NOW,
  });
}
async function rejected(current: ProductionControlApiIdentity) {
  try {
    await current.resolveActor(request);
    assert.fail("Unavailable or denied authority must not produce an actor");
  } catch (error) {
    assert.ok(error instanceof ControlApiIdentityError);
    return errorResponse(error, "request-1");
  }
}

for (const status of [401, 403, 404, 429, 502, 503]) {
  test(`actual identity HTTP ${status} preserves definitive denial and distinguishes authority unavailability`, async () => {
    let calls = 0;
    let cancelled = false;
    const current = identity(async () => {
      calls++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          status,
          headers: { "content-type": "text/html" },
        },
      );
    });
    const unavailable = status >= 500 || status === 429;
    const result = await rejected(current);
    assert.equal(
      result.statusCode,
      unavailable ? 503 : status === 403 ? 403 : 401,
    );
    assert.equal(
      result.body.error.category,
      unavailable
        ? "providerUnavailable"
        : status === 403
          ? "authorization"
          : "authentication",
    );
    assert.equal(
      result.body.error.code,
      unavailable
        ? "identity_authority_unavailable"
        : status === 404
          ? "identity_assertion_invalid"
          : "identity_verification_failed",
    );
    assert.equal(calls, 1); // No verification retries or authority fallback.
    assert.equal(cancelled, true);
    assert.equal(JSON.stringify(result).includes("user-control-token"), false);
  });
}

test("actual transport failure returns 503 without granting or caching an actor, and an independent observation can recover", async () => {
  let failed = true;
  let calls = 0;
  const current = identity(async () => {
    calls++;
    if (failed) throw new TypeError("private-upstream-network-address");
    return Response.json(assertion());
  });
  const result = await rejected(current);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, "identity_authority_unavailable");
  assert.equal(JSON.stringify(result).includes("private-upstream"), false);
  await rejected(current);
  assert.equal(calls, 2); // Failed observations did not populate the bounded identity cache.
  failed = false;
  assert.deepEqual(await current.resolveActor(request), actor);
  assert.equal(calls, 3);
});

test("the original actual deadline aborts physical identity HTTP and returns 503 rather than 401", async () => {
  let aborted = false;
  let calls = 0;
  const current = identity(async (_url, init) => {
    calls++;
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      ),
    );
  }, 20);
  await assert.rejects(
    current.resolveCurrentActor(request, new AbortController().signal),
    (error) => {
      assert.ok(error instanceof ControlApiIdentityError);
      const response = errorResponse(error, "request-1");
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.error.code, "identity_authority_unavailable");
      return true;
    },
  );
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});

test("200 malformed, oversized, wrong-issuer and expired assertions remain hard identity rejections", async () => {
  const cases = [
    () =>
      new Response("not json", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(17 * 1024),
        },
      }),
    () => Response.json({ ...assertion(), issuer: "https://wrong.example" }),
    () =>
      Response.json({
        ...assertion(),
        expiresAt: new Date(NOW - 1).toISOString(),
      }),
  ];
  for (const response of cases) {
    const result = await rejected(identity(async () => response()));
    assert.equal(result.statusCode, 401);
    assert.equal(result.body.error.code, "identity_assertion_invalid");
  }
});

test("truncated HTTP body is typed unavailable, while exceeding the body limit is a protocol rejection", async () => {
  const transport = new HttpControlTokenVerifier({
    url: "https://identity.example/verify",
    serviceToken: "private-service-token-is-long-enough",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("stream closed"));
          },
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
  });
  await assert.rejects(
    transport.verify({
      accessToken: "user-token",
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.ok(error instanceof SecurityAuthorityVerificationError);
      assert.equal(error.kind, "unavailable");
      return true;
    },
  );
  const result = await rejected(
    identity(
      async () =>
        new Response('"' + "x".repeat(17 * 1024) + '"', {
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  assert.equal(result.statusCode, 401);
});
