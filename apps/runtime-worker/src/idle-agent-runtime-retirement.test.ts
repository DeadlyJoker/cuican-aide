import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { AgentRuntimeCapacityError } from "./agent-runtime-capacity.ts";
import {
  command,
  committedResult,
  definition,
  policy,
} from "../../../packages/tool-broker/src/tool-execution.test-support.ts";
import { scopeToolRuntimeToAgentVersion } from "./agent-version-tool-runtime.ts";
import { retirementFixture } from "./idle-agent-runtime-retirement.test-support.ts";
import { deferred, until } from "./runtime-store-access.test-support.ts";

test("owned historical versions converge to the warm working set and reconstruct identical definitions after retirement", async (t) => {
  const f = await retirementFixture({ count: 300 });
  const held = await f.acquire(0);
  t.after(async () => {
    held.release();
    await f.close();
  });
  const old = held.resource;
  for (let n = 1; n < 300; n++) (await f.acquire(n)).release();
  await f.drain();
  assert.equal(f.registry.retirementSnapshot().candidates, 64);
  assert.equal(f.closed.length, 236);
  assert.equal(f.closed.includes("v-0"), false);
  assert.equal(f.registry.resourceSnapshot().activeLeases, 1);
  held.release();
  for (let n = 1; n < 80; n++) (await f.acquire(n)).release();
  await f.drain();
  assert.ok(f.closed.includes("v-0"));
  const restored = await f.acquire(0);
  assert.notEqual(restored.resource, old);
  assert.deepEqual(restored.resource.version, old.version);
  assert.deepEqual(
    restored.resource.kernel.modelIdentity,
    old.kernel.modelIdentity,
  );
  restored.release();
});

test("definition bytes retire large valid catalogs before reaching 64 entries", async (t) => {
  const definitions = Array.from({ length: 64 }, (_, n) => ({
    ...definition(`large_${n}`),
    inputSchema: { type: "object", description: "x".repeat(5000) },
  }));
  const f = await retirementFixture({ count: 40, definitions });
  t.after(f.close);
  for (let n = 0; n < 40; n++) (await f.acquire(n)).release();
  await f.drain();
  const state = f.registry.retirementSnapshot();
  assert.ok(state.candidates > 0 && state.candidates < 40);
  assert.ok(state.definitionBytes <= state.targetDefinitionBytes);
  assert.equal(f.created.length, 40);
});

test("an old-model compactor borrower protects its owner through version churn", async (t) => {
  const f = await retirementFixture();
  const lease = await f.resolver.priorModelCompactionResolver().acquire!({
    schemaVersion: "crewon.thread-model-state.v0",
    ...f.locator(0),
    threadId: "thread",
    ...f.versions[0]!.model,
    throughHistorySequence: 1,
    contextRevision: "canonical",
    latestUsage: null,
    updatedAt: "2026-09-15T00:00:00Z",
  });
  assert.ok(lease);
  t.after(async () => {
    lease.release();
    await f.close();
  });
  for (let n = 1; n < 160; n++) (await f.acquire(n)).release();
  await f.drain();
  assert.equal(f.closed.includes("v-0"), false);
  assert.equal(f.registry.resourceSnapshot().activeLeases, 1);
  lease.release();
  for (let n = 1; n < 100; n++) (await f.acquire(n)).release();
  await f.drain();
  assert.equal(f.closed.includes("v-0"), true);
});

test("legacy raw resolution pins ownership, while borrowed versions remain eligible for retirement", async (t) => {
  const f = await retirementFixture();
  t.after(f.close);
  const legacy = await f.resolver.resolve(f.locator(0));
  for (let n = 1; n < 160; n++) (await f.acquire(n)).release();
  await f.drain();
  assert.equal(f.registry.peekResident(f.locator(0)), legacy);
  assert.equal(f.closed.includes("v-0"), false);
  assert.equal(f.registry.retirementSnapshot().candidates, 64);
});

test("unscoped retained results and unstarted reservations protect owned tools until explicit release", async (t) => {
  const tools = new Map<string, InMemoryToolBroker>();
  const f = await retirementFixture({
    definitions: [definition("tool")],
    tools(id) {
      const tool = new InMemoryToolBroker(
        [definition("tool")],
        new Map([["function:tool", async () => ({ output: id })]]),
        new Map([["function:tool", policy("readOnly", "replaySafe")]]),
      );
      tools.set(id, tool);
      return tool;
    },
  });
  t.after(f.close);
  const first = await f.acquire(0),
    second = await f.acquire(1);
  const input = command();
  const result = await first.resource.toolRuntime.execute(
    input,
    new AbortController().signal,
  );
  const reservation = second.resource.toolRuntime.reserveExecution!(
    input,
    new AbortController().signal,
  )!;
  first.release();
  second.release();
  for (let n = 2; n < 160; n++) (await f.acquire(n)).release();
  await f.drain();
  assert.deepEqual(
    tools.get("v-0")!.scanRetainedExecutionResults({ limit: 128 }),
    [],
  );
  assert.equal(f.closed.includes("v-0"), false);
  assert.equal(f.closed.includes("v-1"), false);
  tools
    .get("v-0")!
    .acknowledgeExecutionResult(
      committedResult(input, result.providerReceiptId),
    );
  reservation.release();
  for (let n = 2; n < 80; n++) (await f.acquire(n)).release();
  await f.drain();
  assert.ok(f.closed.includes("v-0") && f.closed.includes("v-1"));
});

test("scoped catalogs cannot hide recovery ownership from retirement checks", async () => {
  const tools = new InMemoryToolBroker(
    [definition("tool")],
    new Map([["function:tool", async () => ({ output: "hidden" })]]),
    new Map([["function:tool", policy("readOnly", "replaySafe")]]),
  );
  const projected = scopeToolRuntimeToAgentVersion(tools, []),
    input = command();
  const result = await tools.execute(input, new AbortController().signal);
  assert.deepEqual(projected.scanRetainedExecutionResults!({ limit: 1 }), []);
  assert.equal(projected.canRetire!(), false);
  tools.acknowledgeExecutionResult(
    committedResult(input, result.providerReceiptId),
  );
  assert.equal(projected.canRetire!(), true);
});

test("slow disposers keep at most four retirement slots and closing still joins them", async (t) => {
  const held = deferred();
  t.after(() => held.resolve());
  let started = 0;
  const f = await retirementFixture({
    close: async () => {
      started++;
      await held.promise;
    },
  });
  t.after(f.close);
  for (let n = 0; n < 128; n++) (await f.acquire(n)).release();
  await assert.rejects(f.acquire(128), AgentRuntimeCapacityError);
  assert.equal(started, 4);
  assert.equal(f.registry.retirementSnapshot().retiring, 4);
  // This is a protected overflow, not permission to detach unknown physical owners.
  assert.ok(f.registry.retirementSnapshot().candidates > 64);
  held.resolve();
  await f.drain();
  assert.equal(f.registry.retirementSnapshot().candidates, 64);
});

test("failed retirement remains visible and occupies its slot instead of allowing unbounded failed closes", async () => {
  const f = await retirementFixture({
    close: async (id) => {
      if (Number(id.slice(2)) < 4) throw new Error("close failed");
    },
  });
  for (let n = 0; n < 128; n++) (await f.acquire(n)).release();
  await assert.rejects(f.acquire(128), AgentRuntimeCapacityError);
  await until(() => f.registry.retirementSnapshot().failures === 4);
  assert.equal(f.registry.retirementSnapshot().retiring, 4);
  const snapshot = f.registry.retirementSnapshot();
  for (let n = 0; n < 100; n++)
    f.registry.nextToolResultMaintenanceLease()?.release();
  assert.deepEqual(f.registry.retirementSnapshot(), snapshot);
  await assert.rejects(f.close(), AggregateError);
});
