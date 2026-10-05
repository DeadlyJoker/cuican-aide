import assert from "node:assert/strict";
import test from "node:test";
import { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { InstalledPluginDelegatedIdentityInput } from "./installed-plugin-delegated-identity.ts";
import {
  actor,
  scope,
  digester,
  deferred,
} from "./installed-plugin-task.test-support.ts";

const input: InstalledPluginDelegatedIdentityInput = {
  actor,
  scope,
  installation: {
    ...scope,
    pluginId: "example.short-drama",
    publisherId: "example",
    version: "17.0.0",
    packageDigest: digester.sha256("named-package"),
    selectionRevision: 2,
  },
  delegation: {
    kind: "pluginUi",
    contributionId: "workbench",
    actionId: "crewon.project-text-plans.v1.start",
    invocationId: "server-invocation",
    idempotencyKey: "start-key",
    inputDigest: digester.sha256("named-actual-input"),
  },
};
function fixture(
  resolve?: (
    i: InstalledPluginDelegatedIdentityInput,
    s: AbortSignal,
  ) => Promise<typeof actor>,
) {
  let http = 0,
    preparations = 0;
  const owner = new InstalledPluginRequestOwner({
    identity: {
      resolveCurrentActor: async () => {
        http++;
        return actor;
      },
    },
    profiles: { resolve: async () => scope },
    ...(resolve ? { delegatedIdentity: { resolveCurrentActor: resolve } } : {}),
    peer: {
      prepare: async () => {
        preparations++;
        return {
          catalog: { list: () => [], resolve: () => null },
          host: {
            taskAdmissionMode: () => "installed",
            validateConfiguration: async () => {},
            evaluate: async () => ({
              outcome: "unavailable",
              reasonCode: "extension_runtime_unavailable",
            }),
          },
          pluginQueryHost: {
            resolveRegistration: async () => null,
            evaluate: async () => ({
              outcome: "unavailable",
              reasonCode: "extension_runtime_unavailable",
            }),
          },
        };
      },
    },
  });
  return { owner, http: () => http, preparations: () => preparations };
}
test("saved delegation without deployment identity cannot reuse HTTP identity or prepare execution", async () => {
  const f = fixture();
  assert.equal(f.owner.supportsDelegatedIdentity(), false);
  assert.throws(
    () => f.owner.runDelegated(input, async () => {}),
    /project_text_plan_authorization_unavailable/,
  );
  assert.equal(f.http(), 0);
  assert.equal(f.preparations(), 0);
  await f.owner.close();
});
test("named deployment callback is a distinct live branch; metadata does not prepare Node until explicit stage admission", async () => {
  let checks = 0;
  const f = fixture(async (i, s) => {
    checks++;
    s.throwIfAborted();
    assert.deepEqual(i, input);
    return actor;
  });
  await f.owner.runDelegated(input, async () => {
    assert.deepEqual(f.owner.currentActor(), actor);
    assert.deepEqual(f.owner.currentScope(), scope);
    assert.equal(f.preparations(), 0);
    await f.owner.prepareDelegatedExecution();
    assert.equal(f.preparations(), 1);
    await f.owner.assertCurrent();
  });
  assert.ok(checks >= 4);
  assert.equal(f.http(), 0);
  assert.throws(() => f.owner.currentActor());
  await f.owner.close();
});
test("current delegated actor/profile changes withdraw the original owner before additional work", async () => {
  let current = actor;
  const f = fixture(async () => current);
  await assert.rejects(
    f.owner.runDelegated(input, async () => {
      current = { ...actor, principalId: "withdrawn-person" };
      await f.owner.prepareDelegatedExecution();
    }),
    /authority_unavailable/,
  );
  assert.equal(f.preparations(), 1);
  assert.equal(f.http(), 0);
  await f.owner.close();
});
test("delegated input getter is rejected without executing it and caller mutation cannot change captured installation", async () => {
  let getters = 0;
  const f = fixture(async (i) => {
    assert.equal(i.installation.pluginId, input.installation.pluginId);
    return actor;
  });
  const copied = { ...input, installation: { ...input.installation } };
  await f.owner.runDelegated(copied, async () => {
    copied.installation.pluginId = "foreign.plugin";
    await f.owner.assertCurrent();
  });
  assert.throws(() =>
    f.owner.runDelegated(
      Object.defineProperty({ ...input }, "actor", {
        enumerable: true,
        get() {
          getters++;
          return actor;
        },
      }),
      async () => {},
    ),
  );
  assert.equal(getters, 0);
  await f.owner.close();
});
test("close waits for genuine started delegated callback settlement and prevents the late work", async () => {
  const entered = deferred(),
    release = deferred();
  const f = fixture(async (_i, s) => {
    entered.resolve();
    await release.promise;
    s.throwIfAborted();
    return actor;
  });
  let calls = 0;
  const work = f.owner.runDelegated(input, async () => {
    calls++;
  });
  await entered.promise;
  let joined = false;
  const closing = f.owner.close().then(() => {
    joined = true;
  });
  await Promise.resolve();
  assert.equal(joined, false);
  release.resolve();
  await assert.rejects(work);
  await closing;
  assert.equal(calls, 0);
  assert.equal(joined, true);
  assert.equal(f.preparations(), 0);
});
