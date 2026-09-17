import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import {
  AgentRuntimeCapacity,
  AgentRuntimeCapacityError,
} from "./agent-runtime-capacity.ts";
import { retirementFixture } from "./idle-agent-runtime-retirement.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { createAdmittedAgentRuntime } from "./admitted-agent-runtime-creation.ts";
import {
  digester,
  version,
} from "./shared-agent-runtime-cache.test-support.ts";

test("runtime admission validates upper bounds and pressure inspection does bounded work", () => {
  for (const limits of [
    { maximumOwners: 0 },
    { maximumOwners: 129 },
    { maximumDefinitionBytes: Infinity },
    { maximumCreations: 9 },
  ])
    assert.throws(() => new AgentRuntimeCapacity(limits), /capacity_invalid/);
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 32 });
  const reservations = Array.from({ length: 32 }, () => capacity.reserve(1));
  let inspected = 0;
  for (const reservation of reservations)
    reservation.setReclaimer(() => {
      inspected++;
    });
  assert.throws(() => capacity.reserve(1), AgentRuntimeCapacityError);
  assert.equal(inspected, 16);
  for (const reservation of reservations) {
    reservation.release();
    reservation.release();
  }
  assert.equal(capacity.snapshot().owners, 0);
  assert.equal(capacity.snapshot().definitionBytes, 0);
});

test("active borrowers hold admission while an idle owner can yield capacity below the warm target", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 2 });
  const f = await retirementFixture({ count: 3, capacity });
  const a = await f.acquire(0),
    b = await f.acquire(1);
  t.after(async () => {
    a.release();
    b.release();
    await f.close();
  });
  for (let n = 0; n < 100; n++)
    await assert.rejects(f.acquire(2), AgentRuntimeCapacityError);
  assert.equal(f.created.length, 2);
  assert.equal(capacity.snapshot().creating, 0);
  a.release();
  await assert.rejects(f.acquire(2), AgentRuntimeCapacityError);
  await nextTurn();
  assert.deepEqual(f.closed, ["v-0"]);
  const c = await f.acquire(2);
  c.release();
  assert.equal(f.registry.peekResident(f.locator(1)), b.resource);
  assert.equal(capacity.snapshot().owners, 2);
});

test("serialized definition bytes deny creation before tool initialization", async (t) => {
  const bytes = Buffer.byteLength(JSON.stringify(version("v-0")));
  const capacity = new AgentRuntimeCapacity({
    maximumOwners: 4,
    maximumDefinitionBytes: bytes,
  });
  const f = await retirementFixture({ count: 2, capacity });
  const a = await f.acquire(0);
  t.after(async () => {
    a.release();
    await f.close();
  });
  assert.equal(capacity.snapshot().definitionBytes, bytes);
  await assert.rejects(f.acquire(1), AgentRuntimeCapacityError);
  assert.equal(f.created.length, 1);
  assert.equal(capacity.snapshot().owners, 1);
});

test("capacity pressure can reclaim idle runtimes from another registry", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const first = await retirementFixture({ count: 1, capacity });
  const second = await retirementFixture({ count: 1, capacity });
  t.after(async () => {
    await first.close();
    await second.close();
  });
  (await first.acquire(0)).release();
  await assert.rejects(second.acquire(0), AgentRuntimeCapacityError);
  await nextTurn();
  assert.deepEqual(first.closed, ["v-0"]);
  (await second.acquire(0)).release();
  assert.equal(capacity.snapshot().owners, 1);
  assert.equal(second.created.length, 1);
});

test("raw borrowed runtimes stay pinned even when another registry needs their capacity", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const first = await retirementFixture({ count: 1, capacity });
  const second = await retirementFixture({ count: 1, capacity });
  t.after(async () => {
    await first.close();
    await second.close();
  });
  const raw = await first.resolver.resolve(first.locator(0));
  await assert.rejects(second.acquire(0), AgentRuntimeCapacityError);
  assert.equal(first.registry.peekResident(first.locator(0)), raw);
  assert.equal(first.closed.length, 0);
  assert.equal(second.created.length, 0);
});

test("all registries share four physical retirement slots and wait for slow closes", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 6 });
  const gate = deferred();
  let started = 0;
  const fixtures = await Promise.all(
    Array.from({ length: 6 }, () =>
      retirementFixture({
        count: 2,
        capacity,
        close: async () => {
          started++;
          await gate.promise;
        },
      }),
    ),
  );
  t.after(async () => {
    gate.resolve();
    await Promise.all(fixtures.map((f) => f.close()));
  });
  for (const f of fixtures) (await f.acquire(0)).release();
  // Recently borrowed owners should survive pressure ahead of older idle ones,
  // even when the owner was created in an earlier registry.
  const hot = await fixtures[0]!.acquire(0);
  hot.release();
  await assert.rejects(fixtures[0]!.acquire(1), AgentRuntimeCapacityError);
  await nextTurn();
  assert.equal(started, 4);
  assert.equal(capacity.snapshot().retiring, 4);
  assert.equal(capacity.snapshot().owners, 6);
  gate.resolve();
  await nextTurn();
  assert.equal(capacity.snapshot().retiring, 0);
  assert.equal(capacity.snapshot().owners, 2);
  assert.equal(
    fixtures[0]!.registry.peekResident(fixtures[0]!.locator(0)),
    hot.resource,
  );
  assert.equal(fixtures[0]!.closed.length, 0);
  for (const f of fixtures.slice(1, 5)) assert.equal(f.closed.length, 1);
  (await fixtures[0]!.acquire(1)).release();
});

test("cold single-flight and global creation admission precede Store I/O", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumCreations: 2 });
  const f = await retirementFixture({ count: 3, capacity });
  const gate = deferred();
  let reads = 0;
  const store = new Proxy(f.store, {
    get(target, key) {
      if (key === "loadAgentVersion")
        return async (input: Parameters<typeof target.loadAgentVersion>[0]) => {
          reads++;
          await gate.promise;
          return target.loadAgentVersion(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const a = new StoreBackedAgentVersionRuntimeResolver({
    registry: f.registry,
    factory: f.factory,
    store,
    digester,
  });
  const b = new StoreBackedAgentVersionRuntimeResolver({
    registry: f.registry,
    factory: f.factory,
    store,
    digester,
  });
  t.after(async () => {
    gate.resolve();
    a.close();
    b.close();
    await f.close();
  });
  const first = a.resolve(f.locator(0)),
    duplicate = a.resolve(f.locator(0)),
    second = b.resolve(f.locator(1));
  await assert.rejects(b.resolve(f.locator(2)), AgentRuntimeCapacityError);
  assert.equal(reads, 2);
  assert.equal(capacity.snapshot().creating, 2);
  gate.resolve();
  const [original, same] = await Promise.all([first, duplicate, second]);
  assert.equal(original, same);
  assert.equal(capacity.snapshot().creating, 0);
  assert.equal(f.created.length, 2);
});

test("resolver shutdown does not release a still-creating owner and closes its late result", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const entered = deferred(),
    gate = deferred();
  const f = await retirementFixture({
    count: 1,
    capacity,
    tools: async () => {
      entered.resolve();
      await gate.promise;
      return new InMemoryToolBroker();
    },
  });
  t.after(async () => {
    gate.resolve();
    await f.close();
  });
  const pending = f.resolver.acquire(f.locator(0));
  await entered.promise;
  await f.close();
  assert.equal(capacity.snapshot().creating, 1);
  assert.equal(capacity.snapshot().owners, 1);
  gate.resolve();
  assert.equal(await pending, null);
  assert.equal(f.closed.length, 1);
  assert.equal(capacity.snapshot().creating, 0);
  assert.equal(capacity.snapshot().owners, 0);
});

test("late Store lookup reuses a concurrently registered owner when capacity is full", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const f = await retirementFixture({ count: 1, capacity });
  const gate = deferred();
  const store = new Proxy(f.store, {
    get(target, key) {
      if (key === "loadAgentVersion")
        return async (input: Parameters<typeof target.loadAgentVersion>[0]) => {
          await gate.promise;
          return target.loadAgentVersion(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const other = new StoreBackedAgentVersionRuntimeResolver({
    registry: f.registry,
    factory: f.factory,
    store,
    digester,
  });
  const pending = other.acquire(f.locator(0));
  const first = await f.acquire(0);
  let second: Awaited<typeof pending> = null;
  t.after(async () => {
    gate.resolve();
    first.release();
    second?.release();
    other.close();
    await f.close();
  });
  gate.resolve();
  second = await pending;
  assert.ok(second);
  assert.equal(first.resource, second.resource);
  assert.equal(f.created.length, 1);
  assert.equal(capacity.snapshot().owners, 1);
  assert.equal(f.registry.resourceSnapshot().activeLeases, 2);
});

test("a known pre-allocation factory error returns capacity and preserves its original error", async () => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const factory = new ConfiguredAgentVersionRuntimeFactory([]);
  for (let n = 0; n < 100; n++)
    await assert.rejects(
      createAdmittedAgentRuntime({
        capacity,
        factory,
        ownership: "ownedRuntime",
        tenantId: "tenant",
        version: version("v-0"),
      }),
      { message: "agent_version_runtime_not_deployed" },
    );
  assert.equal(capacity.snapshot().owners, 0);
  assert.equal(capacity.snapshot().uncertain, 0);
});

test("a creator that throws without returning its resources keeps an uncertain reservation", async (t) => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 2 });
  const failure = new Error("creator failed before returning its owner");
  const f = await retirementFixture({
    count: 1,
    capacity,
    tools: async () => {
      throw failure;
    },
  });
  t.after(f.close);
  for (let n = 0; n < 2; n++)
    await assert.rejects(f.acquire(0), (error) => error === failure);
  await assert.rejects(f.acquire(0), AgentRuntimeCapacityError);
  assert.equal(f.created.length, 2);
  assert.equal(capacity.snapshot().owners, 2);
  assert.equal(capacity.snapshot().uncertain, 2);
  assert.equal(capacity.snapshot().creating, 0);
});

test("failed closes keep both byte and owner capacity after registry shutdown", async () => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 2 });
  const f = await retirementFixture({
    count: 3,
    capacity,
    close: async () => {
      throw new Error("unknown physical close");
    },
  });
  (await f.acquire(0)).release();
  (await f.acquire(1)).release();
  await assert.rejects(f.acquire(2), AgentRuntimeCapacityError);
  await nextTurn();
  const bytes = capacity.snapshot().definitionBytes;
  assert.equal(capacity.snapshot().uncertain, 2);
  await assert.rejects(f.close(), AggregateError);
  assert.equal(capacity.snapshot().owners, 2);
  assert.equal(capacity.snapshot().definitionBytes, bytes);
  assert.equal(capacity.snapshot().retiring, 2);
});

test("late confirmed creation cleanup releases an uncertain slot without changing the failure", async () => {
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const failure = new Error("physical cleanup still pending");
  let confirm!: () => void;
  await assert.rejects(
    createAdmittedAgentRuntime({
      capacity,
      ownership: "ownedRuntime",
      tenantId: "tenant",
      version: version("v-0"),
      factory: {
        create(input) {
          confirm = input.failedCreationCleanup!.confirmReleased;
          throw failure;
        },
      },
    }),
    (error) => error === failure,
  );
  assert.equal(capacity.snapshot().uncertain, 1);
  assert.throws(() => capacity.reserve(1), AgentRuntimeCapacityError);
  confirm();
  confirm();
  assert.equal(capacity.snapshot().owners, 0);
  assert.equal(capacity.snapshot().uncertain, 0);
  const next = capacity.reserve(1);
  next.release();
});
