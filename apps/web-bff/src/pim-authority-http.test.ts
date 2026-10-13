import assert from "node:assert/strict";
import test from "node:test";
import { createPimAuthorityHttp } from "./pim-authority-http.ts";
import type { PimControlSessions } from "./pim-control-sessions.ts";
import { pimControlPolicy } from "./pim-control-policy.ts";

const actor = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "user-1",
  principalId: "principal-1",
};
function fixture() {
  const calls: string[] = [];
  // Named protocol fixture. Real account, PostgreSQL and private HTTPS integration
  // are independent acceptance requirements, not inferred from these callbacks.
  const sessions = {
    verifyControlToken: async () => {
      calls.push("verify");
      return {
        issuer: "https://crewon.test/identity",
        audience: "crewon-control",
        ...actor,
      };
    },
    pluginProfile: async () => {
      calls.push("profile");
      return { ...actor, profileId: "profile-1" };
    },
    pluginPolicy: async () => {
      calls.push("plugin-policy");
      return { outcome: "allow", authorityEpoch: "epoch_1" };
    },
    controlPolicy: async () => {
      calls.push("control-policy");
      return { outcome: "allow" };
    },
  } as unknown as PimControlSessions;
  return {
    calls,
    http: createPimAuthorityHttp({
      sessions,
      identityServiceToken: "i".repeat(32),
      policyServiceToken: "p".repeat(32),
    }),
  };
}
function request(path: string, body: unknown, key = "p".repeat(32)) {
  return new Request("https://authority.test" + path, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
test("private authorities authenticate their distinct service credential before processing any account data", async () => {
  const { calls, http } = fixture();
  assert.equal(
    (await http.handle(
      request("/internal/crewon/pim/verify", { accessToken: "a".repeat(43) }),
    ))!.status,
    401,
  );
  assert.deepEqual(calls, []);
  assert.equal(
    (await http.handle(
      request(
        "/internal/crewon/pim/verify",
        { accessToken: "a".repeat(43) },
        "i".repeat(32),
      ),
    ))!.status,
    200,
  );
  assert.equal(
    (await http.handle(request("/internal/crewon/pim/profile", { actor })))!
      .status,
    200,
  );
  assert.deepEqual(calls, ["verify", "profile"]);
});
test("rejects actor injection, malformed and excessive private bodies", async () => {
  const { calls, http } = fixture();
  for (const body of [
    { actor, profileId: "browser-chosen" },
    { actor: { ...actor, role: "admin" } },
    { actor: { ...actor, tenantId: "bad\nactor" } },
    { actor, padding: "x".repeat(17000) },
  ])
    assert.equal(
      (await http.handle(request("/internal/crewon/pim/profile", body)))!
        .status,
      400,
    );
  assert.deepEqual(calls, []);
  assert.equal(await http.handle(request("/api/v1/threads", {})), null);
});
test("core policy rejects other scopes, unknown actions and viewer mutations", () => {
  const resource = {
    kind: "thread",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    threadId: null,
  };
  assert.equal(
    pimControlPolicy({
      actor,
      resource,
      spaceRole: "owner",
      action: "thread:create",
    }).outcome,
    "allow",
  );
  assert.equal(
    pimControlPolicy({
      actor,
      resource,
      spaceRole: "viewer",
      action: "thread:read",
    }).outcome,
    "allow",
  );
  for (const input of [
    { actor, resource, spaceRole: "viewer", action: "thread:create" },
    {
      actor,
      resource: { ...resource, tenantId: "another" },
      spaceRole: "owner",
      action: "thread:read",
    },
    { actor, resource, spaceRole: "owner", action: "thread:unknown" },
  ])
    assert.equal(pimControlPolicy(input).outcome, "deny");
  assert.equal(
    pimControlPolicy({
      actor,
      resource: {
        kind: "agentVersion",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
      },
      spaceRole: "member",
      action: "agentVersion:publish",
    }).outcome,
    "deny",
  );
});
