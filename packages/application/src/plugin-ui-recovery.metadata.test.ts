import assert from "node:assert/strict";
import test from "node:test";
import { capturePluginUiRecoveryPublications } from "./plugin-ui-recovery-application-service.ts";
import {
  recoveryFixture,
  recoveryRequest,
} from "./plugin-ui-recovery.test-support.ts";

test("empty recovery actions need an explicit metadata-read mode; the business default and accessor boundary remain strict", () => {
  const publication = {
    pluginId: "example.metadata",
    packageDigest: `sha256:${"a".repeat(64)}`,
    contributionId: "workbench",
    actions: [],
  };
  assert.throws(() => capturePluginUiRecoveryPublications([publication]));
  const parsed = capturePluginUiRecoveryPublications([publication], {
    publicationMode: "metadata-read",
  });
  assert.deepEqual(parsed, [publication]);
  assert.ok(Object.isFrozen(parsed[0]!.actions));
  assert.throws(() =>
    capturePluginUiRecoveryPublications([publication], {
      publicationMode: "other",
    } as never),
  );
  let calls = 0;
  const accessor = Object.defineProperty({}, "publicationMode", {
    enumerable: true,
    get() {
      calls++;
      return "metadata-read";
    },
  });
  assert.throws(() =>
    capturePluginUiRecoveryPublications([publication], accessor as never),
  );
  assert.equal(calls, 0);
});

test("metadata-only recovery reads a real empty journal but rejects every stage and business dispatch before journal writes", async () => {
  const f = recoveryFixture({ publicationMode: "metadata-read", actions: [] });
  const lease = await f.mount();
  assert.deepEqual(
    (await f.service.getRecovery(f.actor, { mountRef: lease.mountRef }))
      .intents,
    [],
  );
  for (const lane of ["generation", "query", "selection"] as const) {
    const command = { mountRef: lease.mountRef, ...recoveryRequest(lane) };
    await assert.rejects(() => f.service.stageRecovery(f.actor, command));
    await assert.rejects(() => f.service.invoke(f.actor, command));
  }
  assert.deepEqual(f.events, ["read"]);
  assert.equal(f.records.size, 0);
  assert.equal(f.behavior.calls, 0);
  f.state.allowed.delete("invoke");
  await assert.rejects(() =>
    f.service.getRecovery(f.actor, { mountRef: lease.mountRef }),
  );
  assert.deepEqual(f.events, ["read"]);
});

test("metadata-read projection retains an original prepared record and reports it nonretryable without executing it", async () => {
  const original = recoveryFixture();
  const oldLease = await original.mount();
  const request = recoveryRequest();
  await original.service.stageRecovery(original.actor, {
    mountRef: oldLease.mountRef,
    ...request,
  });
  const f = recoveryFixture({ publicationMode: "metadata-read", actions: [] });
  for (const [id, record] of original.records) f.records.set(id, record);
  const before = [...f.records.values()];
  const lease = await f.mount();
  const hints = await f.service.getRecovery(f.actor, {
    mountRef: lease.mountRef,
  });
  assert.equal(hints.intents[0]!.phase, "prepared");
  assert.equal(hints.intents[0]!.retryable, false);
  assert.deepEqual(hints.intents[0]!.request, request);
  await assert.rejects(() =>
    f.service.invoke(f.actor, { mountRef: lease.mountRef, ...request }),
  );
  assert.deepEqual([...f.records.values()], before);
  assert.equal(f.behavior.calls, 0);
});
