import assert from "node:assert/strict";
import test from "node:test";
import { createWebBff } from "./web-bff.ts";
import { PimControlSessions } from "./pim-control-sessions.ts";

const origin = "https://crewon.example.test";
const token = "e30.eyJzdWIiOiIxIn0.c2ln";
function fixture() {
  const accounts = new Map<string, string>();
  let calls = 0;
  const authority = new PimControlSessions({
    issuer: origin + "/identity/pim",
    packages: new Map(),
    accounts: {
      verify: async () => ({
        userId: 1,
        tenantId: 2,
        spaceId: 3,
        userRole: "user",
        tenantRole: "member",
        spaceRole: "member",
        expiresAt: Date.now() + 3600000,
      }),
    },
    profiles: {
      resolveVerifiedAccount: async ({ actor, membershipDigest }) => ({
        scope: {
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          profileId: "account-profile-1",
        },
        authorityEpoch: "epoch_1",
        membershipDigest,
        revoked: false,
      }),
    },
  });
  const bff = createWebBff({
    identity: authority,
    accountExchange: authority,
    publicOrigin: origin,
    controlTarget: "http://127.0.0.1:3210",
    controlBffToken: "b".repeat(32),
    controlCsrfToken: "c".repeat(32),
    csrfSecret: "s".repeat(32),
    fetch: async (_, init) => {
      calls++;
      accounts.set(
        "authorization",
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return Response.json({ ok: true });
    },
  });
  return { bff, accounts, calls: () => calls };
}
test("PIM bootstrap uses a same-origin credential exchange and exposes only the standard bootstrap shape", async () => {
  const { bff, accounts, calls } = fixture();
  const response = await bff.handle(
    new Request(origin + "/control-api/session", {
      method: "POST",
      headers: { origin, authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.deepEqual(Object.keys(json).sort(), ["baseUrl", "csrfToken"]);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal(
    (
      await bff.handle(
        new Request(origin + "/api/v1/threads", {
          headers: { cookie, authorization: `Bearer ${token}` },
        }),
      )
    ).status,
    200,
  );
  assert.equal(calls(), 1);
  assert.notEqual(accounts.get("authorization"), `Bearer ${token}`);
  assert.equal(
    (
      await bff.handle(
        new Request(origin + "/api/v1/threads", { headers: { cookie } }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await bff.handle(
        new Request(origin + "/api/v1/threads", {
          headers: { cookie, authorization: "Bearer e30.e30.c2ln" },
        }),
      )
    ).status,
    401,
  );
  assert.equal(calls(), 1);
});
test("rejects cross-origin exchange, actor/body injection and non-PIM bearer without reaching Control", async () => {
  const { bff, calls } = fixture();
  for (const [headers, body, status] of [
    [
      { origin: "https://attacker.example", authorization: `Bearer ${token}` },
      undefined,
      403,
    ],
    [{ origin, authorization: "Bearer control-token" }, undefined, 401],
    [
      { origin, authorization: `Bearer ${token}` },
      JSON.stringify({ actorId: "victim" }),
      400,
    ],
  ] as const) {
    const response = await bff.handle(
      new Request(origin + "/control-api/session", {
        method: "POST",
        headers,
        body,
      }),
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(calls(), 0);
});
test("unconfigured deployments keep rejecting POST session bootstrap", async () => {
  const bff = createWebBff({
    identity: { resolve: async () => null },
    publicOrigin: origin,
    controlTarget: "http://127.0.0.1:3210",
    controlBffToken: "b".repeat(32),
    controlCsrfToken: "c".repeat(32),
    csrfSecret: "s".repeat(32),
  });
  assert.equal(
    (
      await bff.handle(
        new Request(origin + "/control-api/session", {
          method: "POST",
          headers: { origin, authorization: `Bearer ${token}` },
        }),
      )
    ).status,
    405,
  );
});
