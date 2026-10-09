import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { RunExecutionService } from "@crewon/application";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { actor } from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import {
  installedResolverFixture,
  signal,
} from "./installed-plugin-runtime-resolver.test-support.ts";

test("actual application task captures the persisted two-package graph with one paid Turn and cannot fall through the old execution host", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  assert.ok(f.originalComposition && f.providerPackage && f.compositions);
  assert.equal(f.task.binding.schemaVersion, "crewon.extension-run-binding.v1");
  if (f.task.binding.schemaVersion !== "crewon.extension-run-binding.v1")
    assert.fail();
  assert.equal(
    f.task.binding.composition.lockDigest,
    f.originalComposition.lockDigest,
  );
  assert.deepEqual(
    await f.first.store.loadExtensionRunBinding(f.task.binding),
    f.task.binding,
  );
  const snapshot = await f.contexts.load({
    locator: {
      tenantId: f.run.tenantId,
      spaceId: f.run.spaceId,
      runId: f.run.runId,
    },
    expectedTarget: f.target,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(snapshot);
  assert.deepEqual(
    f.contexts.verifiedComposition(snapshot),
    f.originalComposition,
  );
  assert.deepEqual(
    await f.contexts.assertCompositionNodeCurrent(
      snapshot,
      f.providerPackage.pluginId,
      "submit",
      signal(),
    ),
    f.providerPackage,
  );
  await assert.rejects(
    f.resolver().acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /composition_execution_unavailable/,
  );
  assert.deepEqual(f.controls.records, []);
  assert.equal(await f.count("messages"), 1);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("real composed Run calls its captured provider through the existing tool channel and closes runtime before both Node resources", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  const resolver = f.resolver(32, {
    compositionExecution: { hostServiceMetadata: [] },
  });
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const command = f.execution();
  const result = await lease.resource.execute(command, signal());
  assert.equal(
    result.status === "completed" && result.result.output,
    "installed:0.1.0:original-provider",
  );
  assert.equal(f.controls.baseCalls, 0);
  assert.ok(f.controls.records.includes("provider-read"));
  lease.release();
  await resolver.close();
  assert.deepEqual(f.controls.records.slice(-4), [
    "runtime-close",
    "runtime-closed",
    "node-dispose",
    "provider-dispose",
  ]);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("warm composed dispatch rechecks provider disable while original result remains observable without re-execution", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  assert.ok(f.providerPackage);
  const resolver = f.resolver(32, {
    compositionExecution: { hostServiceMetadata: [] },
  });
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const command = f.execution();
  const completed = await lease.resource.execute(command, signal());
  const selection = await f.installations.loadSelection({
    scope: f.profile,
    pluginId: f.providerPackage.pluginId,
  });
  assert.ok(selection);
  await f.installations.commitSelection(
    selectionRecipe(selection, "composed-provider-disabled", {
      actor,
      state: "disabled",
    }),
  );
  await assert.rejects(
    lease.resource.execute(
      { ...command, executionId: "new-execution" },
      signal(),
    ),
    /generation_disabled/,
  );
  assert.deepEqual(
    await lease.resource.reconcile(command, signal()),
    completed,
  );
  assert.equal(
    f.controls.records.filter((value) => value === "execute").length,
    1,
  );
  lease.release();
  await resolver.close();
});

test("post-setup publisher denial cleans the actual composed graph without opening its factory", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  f.controls.onSetup = async () => {
    f.controls.publisherAllowed = false;
  };
  const resolver = f.resolver(32, {
    compositionExecution: { hostServiceMetadata: [] },
  });
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /composition_activation_failed/,
  );
  assert.equal(f.controls.records.includes("factory"), false);
  assert.ok(f.controls.records.includes("provider-dispose"));
  assert.ok(f.controls.records.includes("node-dispose"));
  await resolver.close();
});

test("actual composed paid Turn streams through RuntimeWorker and stores the user-visible answer once", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  const resolver = f.compositionResolver({
    compositionExecution: { hostServiceMetadata: [] },
  });
  const worker = new RuntimeWorker(
    {
      store: f.first.parent,
      execution: new RunExecutionService({
        store: f.first.parent,
        clock: { now: () => timestamp },
        ids: { nextId: () => randomUUID() },
        digester: f.dependencies.digester,
      }),
      kernel: f.base.kernel,
      policy: new PinnedRunExecutionPolicy(f.target),
      toolRuntime: f.base.toolRuntime,
      agentVersionRuntimeResolver: { resolve: () => f.base },
      pluginTaskAdmissions: f.first.store,
      installedPluginRuntimeResolver: resolver,
    },
    {
      ownerId: randomUUID(),
      nextLeaseId: randomUUID,
      leaseDurationMs: 30_000,
      retryAfterMs: 0,
      approvalRecheckMs: 1,
      scanIntervalMs: null,
    },
  );
  t.after(() => worker.close());
  const outcome = await worker.wake();
  assert.deepEqual(outcome, { kind: "completed", runId: f.run.runId });
  assert.equal((await worker.wake()).kind, "idle");
  const messages = await f.first.parent.listMessages(f.task.binding, 0, 100);
  assert.match(
    JSON.stringify(messages.at(-1)?.content),
    /answer:installed:0.1.0:original-provider/,
  );
  const events = await f.first.parent.listRunEvents(f.task.binding, 0, 100);
  assert.ok(events.some((event) => event.type === "run.completed"));
  assert.equal(
    f.controls.records.filter((value) => value === "execute").length,
    1,
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
  await worker.close();
  await resolver.close();
});

test("cold recovery keeps the original graph after both selections are disabled and the current head becomes empty", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  assert.ok(f.providerPackage && f.compositions && f.originalComposition);
  const first = f.compositionResolver({
    compositionExecution: { hostServiceMetadata: [] },
  });
  const lease = await first.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  const command = f.execution();
  await lease.resource.execute(command, signal());
  lease.release();
  await first.close();
  for (const pluginId of [
    f.recipe.package.pluginId,
    f.providerPackage.pluginId,
  ]) {
    const selection = await f.installations.loadSelection({
      scope: f.profile,
      pluginId,
    });
    assert.ok(selection);
    await f.installations.commitSelection(
      selectionRecipe(selection, `cold-disable-${pluginId}`, {
        actor,
        state: "disabled",
      }),
    );
  }
  const next = createPluginCompositionLock(
    {
      schemaVersion: "crewon.plugin-composition-lock.v1",
      scope: { ...f.profile, authorityEpoch: "cold-new-epoch" },
      revision: 2,
      nodes: [],
      hostServices: [],
    },
    f.dependencies.digester,
  );
  await f.compositions.commit({
    scope: next.scope,
    actor,
    lock: next,
    expectedRevision: 1,
  });
  const cold = f.compositionResolver({
    compositionExecution: { hostServiceMetadata: [] },
  });
  await assert.rejects(
    cold.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /generation_disabled/,
  );
  const recovery = await cold.acquire({
    run: f.run,
    base: f.base,
    purpose: "observe",
    signal: signal(),
  });
  assert.ok(recovery);
  assert.equal(
    (await recovery.resource.reconcile(command, signal())).status,
    "unknownOutcome",
  );
  assert.equal(
    f.controls.records.filter((value) => value === "execute").length,
    1,
  );
  assert.deepEqual(
    await f.first.store.loadExtensionRunBinding(f.task.binding),
    f.task.binding,
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
  recovery.release();
  await cold.close();
});

test("provider publisher denial cannot borrow the root publisher grant or load either package setup", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  assert.ok(f.providerPackage);
  f.controls.deniedPublisherPluginId = f.providerPackage.pluginId;
  const resolver = f.resolver(32, {
    compositionExecution: { hostServiceMetadata: [] },
  });
  await assert.rejects(
    resolver.acquire({
      run: f.run,
      base: f.base,
      purpose: "submit",
      signal: signal(),
    }),
    /composition_activation_failed/,
  );
  assert.deepEqual(f.controls.records, []);
  await resolver.close();
});

test("a later root publisher check cannot hide a provider selection change from whole-graph dispatch", async (t) => {
  const f = await installedResolverFixture(t, { composition: true });
  assert.ok(f.providerPackage);
  const resolver = f.resolver(32, {
    compositionExecution: { hostServiceMetadata: [] },
  });
  const lease = await resolver.acquire({
    run: f.run,
    base: f.base,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(lease);
  let calls = 0;
  f.controls.publisherHook = async () => {
    if (++calls === 2) {
      const selection = await f.installations.loadSelection({
        scope: f.profile,
        pluginId: f.providerPackage!.pluginId,
      });
      assert.ok(selection);
      await f.installations.commitSelection(
        selectionRecipe(selection, "cross-node-disable", {
          actor,
          state: "disabled",
        }),
      );
    }
  };
  await assert.rejects(
    lease.resource.execute(f.execution(), signal()),
    /selection_changed/,
  );
  assert.equal(f.controls.records.includes("execute"), false);
  lease.release();
  await resolver.close();
});
