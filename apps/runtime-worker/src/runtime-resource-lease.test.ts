import assert from "node:assert/strict";
import test from "node:test";
import { createAgentVersionAsset } from "@crewon/agent-version";
import { InMemoryRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import {
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { sharedAgentVersionRuntimeFactory } from "./shared-agent-version-runtime-factory.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  RuntimeResourceOwner,
  RuntimeResourceScope,
} from "./runtime-resource-lease.ts";
import {
  acquireRuntimeResource,
  acquirePriorCompactorResource,
} from "./runtime-resource-resolution.ts";
import { RuntimePreflight } from "./runtime-preflight.ts";
import { ToolResultMaintenance } from "./tool-result-maintenance.ts";
import {
  deferred,
  storeAccessClock,
  until,
} from "./runtime-store-access.test-support.ts";
import {
  digester,
  route,
  version,
} from "./shared-agent-runtime-cache.test-support.ts";

const locator = { tenantId: "tenant", agentVersionId: "v1" };
const transport = {
  adapterName: "fixture",
  adapterVersion: "1",
  modelId: "fixture-model",
  async *stream(): AsyncGenerator<never> {
    throw new Error("unexpected model call");
  },
};
async function runtime(
  close: () => Promise<void> = async () => {},
): Promise<AgentVersionRuntime> {
  return {
    ...(await sharedAgentVersionRuntimeFactory(
      { route, transport },
      new InMemoryToolBroker(),
    ).create({ tenantId: "tenant", version: version("v1") })),
    close,
  };
}
function prior() {
  return {
    schemaVersion: "crewon.thread-model-state.v0" as const,
    ...locator,
    threadId: "thread",
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "fixture-model",
    contextWindowTokens: 128000,
    autoCompactAtTokens: 96000,
    throughHistorySequence: 1,
    contextRevision: "canonical",
    latestUsage: null,
    updatedAt: "2026-09-15T00:00:00Z",
  };
}

test("registry closes aliased owners once, joins repeated close and releases all strong registry entries", async () => {
  let closes = 0;
  const held = deferred();
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  const resource = await runtime(async () => {
    closes++;
    await held.promise;
  });
  registry.register({ tenantId: "tenant", runtime: resource });
  registry.register({ tenantId: "other", runtime: resource });
  const first = registry.acquire(locator)!,
    second = registry.acquire({ ...locator, tenantId: "other" })!;
  assert.equal(registry.acquire({ ...locator, tenantId: "foreign" }), null);
  const closing = registry.close();
  assert.equal(registry.close(), closing);
  assert.equal(registry.acquire(locator), null);
  assert.equal(registry.resolve(locator), null);
  assert.equal(registry.nextToolResultMaintenanceLease(), null);
  first.release();
  first.release();
  assert.equal(registry.resourceSnapshot().activeLeases, 1);
  assert.equal(closes, 0);
  second.release();
  await until(() => closes === 1);
  assert.equal(registry.resourceSnapshot().resourceOwners, 1);
  held.resolve();
  await closing;
  assert.deepEqual(registry.resourceSnapshot(), {
    registeredRuntimes: 0,
    resourceOwners: 0,
    activeLeases: 0,
    closed: true,
  });
});

test("registry waits for every owner even when an earlier close throws synchronously", async () => {
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester),
    held = deferred();
  let lastClosed = false,
    finished = false;
  registry.register({
    tenantId: "tenant",
    runtime: await runtime(() => {
      throw new Error("close failed");
    }),
  });
  registry.register({
    tenantId: "other",
    runtime: await runtime(async () => {
      await held.promise;
      lastClosed = true;
    }),
  });
  const closing = registry.close();
  const checked = assert
    .rejects(
      closing,
      (error) => error instanceof AggregateError && error.errors.length === 1,
    )
    .then(() => {
      finished = true;
    });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(finished, false);
  held.resolve();
  await checked;
  assert.equal(lastClosed, true);
  assert.equal(registry.resourceSnapshot().resourceOwners, 0);
  assert.equal(registry.close(), closing);
});

test("old-model compaction and maintenance borrow the same registered resource owner", async () => {
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  let closed = false;
  registry.register({
    tenantId: "tenant",
    runtime: await runtime(async () => {
      closed = true;
    }),
  });
  const compaction =
    await registry.priorModelCompactionResolver().acquire!(prior());
  const maintenance = registry.nextToolResultMaintenanceLease();
  assert.ok(compaction && maintenance);
  const closing = registry.close();
  compaction.release();
  assert.equal(closed, false);
  assert.equal(registry.resourceSnapshot().activeLeases, 1);
  maintenance.release();
  await closing;
  assert.equal(closed, true);
});

test("evicting shared projections does not release the bootstrap owner used by their borrowers", async () => {
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester),
    store = new InMemoryRunStore();
  let closed = false;
  const base = await runtime(async () => {
    closed = true;
  });
  registry.register({ tenantId: "tenant", runtime: base });
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    registry,
    store,
    digester,
    factory: sharedAgentVersionRuntimeFactory(
      { route, transport },
      base.toolRuntime,
    ),
    acquireSharedOwner() {
      const lease = registry.acquire(locator);
      return lease === null
        ? null
        : { resource: base.toolRuntime, release: lease.release };
    },
  });
  for (let n = 0; n < 100; n++) {
    await store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: "tenant",
        version: version(`historical-${n}`),
        createdAt: "2026-09-15T00:00:00Z",
      }),
    );
  }
  const historical = { tenantId: "tenant", agentVersionId: "historical-0" };
  const lease = await resolver.acquire(historical);
  assert.ok(lease);
  const digest = digester.sha256(JSON.stringify(lease.resource.version));
  for (let n = 1; n < 100; n++)
    (await resolver.acquire({
      ...historical,
      agentVersionId: `historical-${n}`,
    }))!.release();
  assert.equal(resolver.resolveResident(historical), null);
  assert.equal(resolver.sharedRuntimeCacheSnapshot().entries, 64);
  assert.equal(registry.resourceSnapshot().activeLeases, 1);
  resolver.close();
  const closing = registry.close();
  assert.equal(closed, false);
  assert.equal(digester.sha256(JSON.stringify(lease.resource.version)), digest);
  lease.release();
  await closing;
  await store.close();
  assert.equal(closed, true);
});

for (const kind of ["runtime", "priorCompactor"] as const) {
  test(`a ${kind} borrow returned after preflight timeout is released by its original closed scope`, async () => {
    const clock = storeAccessClock(),
      held = deferred(),
      entered = deferred();
    let closed = false;
    const resource = await runtime(async () => {
      closed = true;
    });
    const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
    registry.register({ tenantId: "tenant", runtime: resource });
    const scope = new RuntimeResourceScope(),
      preflight = new RuntimePreflight({
        leaseDurationMs: 30000,
        time: clock.time,
      });
    const operation =
      kind === "runtime"
        ? acquireRuntimeResource({
            locator,
            scope,
            preflight,
            resolver: {
              resolve() {
                throw new Error("legacy lookup must not run");
              },
              async acquire() {
                const lease = registry.acquire(locator);
                entered.resolve();
                await held.promise;
                return lease;
              },
            },
          })
        : acquirePriorCompactorResource({
            prior: prior(),
            scope,
            preflight,
            resolver: {
              resolve() {
                throw new Error("legacy compactor must not run");
              },
              async acquire() {
                const lease =
                  await registry.priorModelCompactionResolver().acquire!(
                    prior(),
                  );
                entered.resolve();
                await held.promise;
                return lease;
              },
            },
          });
    const failure = assert.rejects(operation, {
      code: "runtime_preflight_timeout",
    });
    await entered.promise;
    clock.advance(10000);
    await failure;
    scope.close();
    const closing = registry.close();
    assert.equal(closed, false);
    assert.equal(registry.resourceSnapshot().activeLeases, 1);
    held.resolve();
    await closing;
    assert.equal(closed, true);
    assert.equal(preflight.snapshot().pendingRequests, 0);
    preflight.close();
  });
}

test("a logical scope close retains every borrow until its pending physical prerequisite settles", async () => {
  const held = deferred(),
    owner = new RuntimeResourceOwner({}, async () => {}),
    scope = new RuntimeResourceScope();
  scope.use(owner.acquire()!);
  const pending = scope.run(() => held.promise);
  scope.close();
  scope.close();
  assert.equal(owner.users, 1);
  await assert.rejects(
    scope.run(() => {}),
    /runtime_resource_scope_closed/,
  );
  held.resolve();
  await pending;
  assert.equal(owner.users, 0);
  const late = owner.acquire()!;
  assert.throws(() => scope.use(late), /runtime_resource_scope_closed/);
  assert.equal(owner.users, 0);
  await owner.close();
});

test("failed shared-owner acquisition releases the already acquired version lease", async () => {
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester),
    store = new InMemoryRunStore();
  const base = await runtime();
  registry.register({ tenantId: "tenant", runtime: base });
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    registry,
    store,
    digester,
    factory: sharedAgentVersionRuntimeFactory(
      { route, transport },
      base.toolRuntime,
    ),
    acquireSharedOwner() {
      throw new Error("shared owner unavailable");
    },
  });
  assert.throws(
    () => resolver.acquireResident(locator),
    /shared owner unavailable/,
  );
  assert.equal(registry.resourceSnapshot().activeLeases, 0);
  resolver.close();
  await registry.close();
  await store.close();
});

test("failed factory construction still closes the model when tool cleanup throws", async () => {
  const compiled = version("v1"),
    held = deferred();
  let modelCloses = 0,
    toolCloses = 0;
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: "tenant",
      agentVersionId: "v1",
      contentDigest: compiled.contentDigest,
      authorityId: "authority",
      workspaceBindingId: null,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      executionAuthority: "crewonKernel",
      createTransport: () => ({
        ...transport,
        close: async () => {
          modelCloses++;
          await held.promise;
        },
      }),
      createToolRuntime: () =>
        Object.assign(new InMemoryToolBroker(), {
          close: () => {
            toolCloses++;
            throw new Error("tool close failed");
          },
        }),
      createGovernedContext() {
        throw new Error("construction failed");
      },
    },
  ]);
  const checked = assert.rejects(
    factory.create({ tenantId: "tenant", version: compiled }),
    /construction failed/,
  );
  await until(() => modelCloses === 1 && toolCloses === 1);
  held.resolve();
  await checked;
  assert.equal(modelCloses, 1);
  assert.equal(toolCloses, 1);
});

test("factory close joins the pending tool and model closes and preserves both failures", async () => {
  const compiled = version("v1"),
    held = deferred();
  let modelCloses = 0,
    toolCloses = 0;
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: "tenant",
      agentVersionId: "v1",
      contentDigest: compiled.contentDigest,
      authorityId: "authority",
      workspaceBindingId: null,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      executionAuthority: "crewonKernel",
      createTransport: () => ({
        ...transport,
        close: async () => {
          modelCloses++;
          await held.promise;
          throw new Error("model close failed");
        },
      }),
      createToolRuntime: () =>
        Object.assign(new InMemoryToolBroker(), {
          close: () => {
            toolCloses++;
            throw new Error("tool close failed");
          },
        }),
    },
  ]);
  const value = await factory.create({ tenantId: "tenant", version: compiled });
  const closing = value.close!();
  assert.equal(value.close!(), closing);
  const checked = assert.rejects(
    closing,
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  await until(() => modelCloses === 1 && toolCloses === 1);
  held.resolve();
  await checked;
  assert.equal(modelCloses, 1);
  assert.equal(toolCloses, 1);
});

test("a maintenance pass retains its lease after poll timeout and releases it on shutdown", async () => {
  const entered = deferred(),
    held = deferred<null>();
  let closed = false,
    acknowledged = 0;
  const base = await runtime(async () => {
    closed = true;
  });
  const tools = Object.assign(new InMemoryToolBroker(), {
    scanRetainedExecutionResults: () => [
      {
        tenantId: "tenant",
        runId: "run",
        executionId: "execution",
        actionDigest: "digest",
        idempotencyKey: "key",
        kind: "function" as const,
        name: "fixture",
      },
    ],
    acknowledgeExecutionResult: () => {
      acknowledged++;
      return true;
    },
  });
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  registry.register({
    tenantId: "tenant",
    runtime: { ...base, toolRuntime: tools },
  });
  const maintenance = new ToolResultMaintenance({
    store: {
      loadToolExecutionReceiptByAction: async () => {
        entered.resolve();
        return held.promise;
      },
    },
    nextRuntimeLease: () => registry.nextToolResultMaintenanceLease(),
  });
  const poll = maintenance.poll();
  await entered.promise;
  assert.equal((await poll).pending, true);
  for (let i = 0; i < 1000; i++) await maintenance.poll();
  assert.equal(registry.resourceSnapshot().activeLeases, 1);
  const closing = registry.close();
  assert.equal(closed, false);
  maintenance.close();
  await closing;
  held.resolve(null);
  await until(() => !maintenance.snapshot().pending);
  assert.equal(acknowledged, 0);
  assert.equal(registry.resourceSnapshot().activeLeases, 0);
});
