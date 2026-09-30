import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAuthorizationAction } from "@crewon/application";
import { DynamicPolicyAuthorization } from "./production-security-adapters.ts";
import { StandaloneAuthorization } from "./standalone-adapters.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const resource = {
  kind: "extension" as const,
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  pluginId: "crewon.comfyui-krea2",
};
const actions: readonly ExtensionAuthorizationAction[] = [
  "extension:read",
  "extension:configure",
  "extension:activate",
  "extension:run",
  "extension:query",
];

test("production policy receives distinct extension actions and checks current scope and revocation", async () => {
  let allowed = false;
  const calls: string[] = [];
  const authorization = new DynamicPolicyAuthorization({
    timeoutMs: 1_000,
    policy: {
      async decide(request) {
        calls.push(request.action);
        assert.deepEqual(request.resource, resource);
        return allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "no_extension_grant" };
      },
    },
  });
  for (const action of actions) {
    assert.equal(
      (await authorization.authorize({ actor, action, resource })).outcome,
      "deny",
    );
    allowed = true;
    assert.equal(
      (await authorization.authorize({ actor, action, resource })).outcome,
      "allow",
    );
    allowed = false;
    assert.equal(
      (await authorization.authorize({ actor, action, resource })).outcome,
      "deny",
    );
  }
  assert.deepEqual(
    calls,
    actions.flatMap((action) => [action, action, action]),
  );
  allowed = true;
  for (const patch of [{ tenantId: "other" }, { spaceId: "other" }])
    assert.equal(
      (
        await authorization.authorize({
          actor,
          action: "extension:run",
          resource: { ...resource, ...patch },
        })
      ).outcome,
      "deny",
    );
  assert.equal(
    calls.length,
    actions.length * 3,
    "scope mismatch must not reach external policy",
  );
});

test("standalone extension permission is restricted to the explicitly configured owner and space", async () => {
  const authorization = new StandaloneAuthorization(actor);
  for (const action of actions) {
    assert.equal(
      (await authorization.authorize({ actor, action, resource })).outcome,
      "allow",
    );
    for (const patch of [
      { actorId: "other" },
      { principalId: "other" },
      { tenantId: "other" },
      { spaceId: "other" },
    ])
      assert.equal(
        (
          await authorization.authorize({
            actor: { ...actor, ...patch },
            action,
            resource,
          })
        ).outcome,
        "deny",
      );
  }
});
