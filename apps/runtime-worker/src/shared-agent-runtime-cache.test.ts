import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createAgentVersionAsset } from "@crewon/agent-version";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { InMemoryRunStore } from "@crewon/store";
import { InMemoryToolBroker, type ToolDefinition } from "@crewon/tool-broker";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { sharedAgentVersionRuntimeFactory } from "./shared-agent-version-runtime-factory.ts";
import {
  digester,
  route,
  version,
} from "./shared-agent-runtime-cache.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";

function fixture(t: TestContext, definitions: readonly ToolDefinition[] = []) {
  const store = new InMemoryRunStore(),
    registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  let transportCloses = 0,
    toolCloses = 0,
    creates = 0,
    reads = 0;
  const toolRuntime = new InMemoryToolBroker();
  t.mock.method(toolRuntime, "definitions", () => structuredClone(definitions));
  const owner = Object.assign(toolRuntime, {
    close: async () => {
      toolCloses++;
    },
  });
  const transport: ModelTransportPort = {
    adapterName: "fixture",
    adapterVersion: "1",
    modelId: "fixture-model",
    async *stream() {
      throw new Error("no model calls");
    },
    close: async () => {
      transportCloses++;
    },
  };
  const factory = sharedAgentVersionRuntimeFactory({ transport, route }, owner);
  const countedFactory = {
    sharedResourceOwner: owner,
    create: async (input: Parameters<typeof factory.create>[0]) => {
      creates++;
      return factory.create(input);
    },
  };
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store: {
      ...store,
      loadAgentVersion: async (input) => {
        reads++;
        return store.loadAgentVersion(input);
      },
      registerAgentVersion: (input) => store.registerAgentVersion(input),
      listAgentVersions: (input) => store.listAgentVersions(input),
    },
    registry,
    digester,
    factory: countedFactory,
  });
  t.after(async () => {
    resolver.close();
    await registry.close();
    await store.close();
  });
  async function add(id: string, tenantId = "tenant") {
    const compiled = version(id, definitions);
    await store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId,
        version: compiled,
        createdAt: "2026-09-15T00:00:00Z",
      }),
    );
    return { tenantId, agentVersionId: id };
  }
  return {
    store,
    registry,
    resolver,
    owner,
    transport,
    factory,
    countedFactory,
    add,
    counts: () => ({ creates, reads, transportCloses, toolCloses }),
  };
}

test("2,000 historical projections plateau at 64 without closing shared resources or losing live references", async (t) => {
  const f = fixture(t);
  const initial = await f.add("v-0"),
    old = await f.resolver.resolve(initial);
  assert.ok(old);
  for (let i = 1; i < 2000; i++)
    await f.resolver.resolve(await f.add(`v-${i}`));
  assert.equal(f.resolver.sharedRuntimeCacheSnapshot().entries, 64);
  assert.equal(f.resolver.resolveResident(initial), null);
  assert.equal(f.registry.resolve(initial), null);
  assert.equal(old.kernel.modelIdentity.modelId, "fixture-model");
  const restored = await f.resolver.resolve(initial);
  assert.ok(restored);
  assert.notEqual(restored, old);
  assert.deepEqual(restored.version, old.version);
  assert.equal(restored.toolRuntime, old.toolRuntime);
  assert.equal(f.counts().transportCloses, 0);
  assert.equal(f.counts().toolCloses, 0);
  f.resolver.close();
  assert.equal(f.resolver.sharedRuntimeCacheSnapshot().entries, 0);
  assert.equal(f.resolver.sharedRuntimeCacheSnapshot().definitionBytes, 0);
  assert.equal(await f.resolver.resolve(initial), null);
});

test("hot projections reuse the same object and calls without registry maintenance changing recency", async (t) => {
  const f = fixture(t),
    locators = [];
  for (let i = 0; i < 64; i++) {
    const locator = await f.add(`v-${i}`);
    locators.push(locator);
    await f.resolver.resolve(locator);
  }
  const hot = f.resolver.resolveResident(locators[0]!);
  for (let i = 0; i < 20000; i++) {
    assert.equal(f.resolver.resolveResident(locators[0]!), hot);
    f.resolver.nextToolResultMaintenanceRuntime();
  }
  assert.equal(f.counts().creates, 64);
  assert.equal(f.counts().reads, 64);
  await f.resolver.resolve(await f.add("next"));
  assert.equal(f.resolver.resolveResident(locators[0]!), hot);
  assert.equal(f.resolver.resolveResident(locators[1]!), null);
});

test("large valid tool catalogs respect the definition-byte budget before the entry limit", async (t) => {
  const definitions: ToolDefinition[] = Array.from({ length: 16 }, (_, i) => ({
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: `large_${i}`,
    description: "fixture",
    execution: "serial",
    inputSchema: { type: "object", description: "界".repeat(12000) },
  }));
  const f = fixture(t, definitions);
  for (let i = 0; i < 32; i++)
    await f.resolver.resolve(await f.add(`large-${i}`));
  const snapshot = f.resolver.sharedRuntimeCacheSnapshot();
  assert.ok(snapshot.entries < 32 && snapshot.entries > 0);
  assert.ok(snapshot.definitionBytes <= snapshot.maxDefinitionBytes);
  assert.ok(snapshot.definitionBytes > snapshot.maxDefinitionBytes / 2);
  assert.equal(f.counts().creates, 32);
});

test("tenant scopes and permanently registered owners retain their identity during cache churn", async (t) => {
  const f = fixture(t),
    first = await f.add("same", "a"),
    second = await f.add("same", "b");
  const a = await f.resolver.resolve(first),
    b = await f.resolver.resolve(second);
  assert.notEqual(a, b);
  assert.equal(
    await f.resolver.resolve({ tenantId: "c", agentVersionId: "same" }),
    null,
  );
  let closes = 0;
  const pinnedVersion = version("pinned");
  const pinned = {
    ...(await f.factory.create({ tenantId: "tenant", version: pinnedVersion })),
    close: async () => {
      closes++;
    },
  };
  f.registry.register({ tenantId: "tenant", runtime: pinned });
  for (let i = 0; i < 128; i++) await f.resolver.resolve(await f.add(`v-${i}`));
  assert.equal(
    f.resolver.resolveResident({
      tenantId: "tenant",
      agentVersionId: "pinned",
    }),
    pinned,
  );
  assert.equal(closes, 0);
  await f.registry.close();
  assert.equal(closes, 1);
  assert.equal(
    f.resolver.resolveResident({ tenantId: "tenant", agentVersionId: "v-127" }),
    null,
  );
  assert.equal(f.resolver.sharedRuntimeCacheSnapshot().entries, 0);
});

test("cold concurrent reads coalesce and resolver close cannot resurrect a late projection", async (t) => {
  const f = fixture(t),
    locator = await f.add("held"),
    held = deferred(),
    entered = deferred();
  let creates = 0;
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store: f.store,
    registry: f.registry,
    digester,
    factory: {
      sharedResourceOwner: f.owner,
      create: async (input) => {
        creates++;
        entered.resolve();
        await held.promise;
        return f.factory.create(input);
      },
    },
  });
  t.after(() => {
    held.resolve();
    resolver.close();
  });
  const calls = Array.from({ length: 1000 }, () => resolver.resolve(locator));
  await entered.promise;
  assert.equal(creates, 1);
  resolver.close();
  held.resolve();
  assert.ok((await Promise.all(calls)).every((value) => value === null));
  assert.equal(resolver.sharedRuntimeCacheSnapshot().entries, 0);
  assert.equal(f.registry.resolve(locator), null);
});

test("shared-resource opt-in rejects owned close hooks and preserves ordinary owned factories", async (t) => {
  const f = fixture(t),
    locator = await f.add("owned");
  let closes = 0;
  const factory = {
    create: async (input: Parameters<typeof f.factory.create>[0]) => ({
      ...(await f.factory.create(input)),
      close: async () => {
        closes++;
      },
    }),
  };
  const invalid = new StoreBackedAgentVersionRuntimeResolver({
    store: f.store,
    registry: f.registry,
    digester,
    factory: { ...factory, sharedResourceOwner: f.owner },
  });
  await assert.rejects(invalid.resolve(locator), {
    message: "agent_version_shared_runtime_owns_resources",
  });
  assert.equal(closes, 1);
  assert.equal(invalid.sharedRuntimeCacheSnapshot().entries, 0);
  const valid = new StoreBackedAgentVersionRuntimeResolver({
    store: f.store,
    registry: f.registry,
    digester,
    factory,
  });
  const owned = await valid.resolve(locator);
  assert.equal(f.registry.resolve(locator), owned);
  assert.equal(valid.sharedRuntimeCacheSnapshot().entries, 0);
  valid.close();
  assert.equal(closes, 1);
  await f.registry.close();
  assert.equal(closes, 2);
});

test("an evicted durable version keeps immutable conflict and identity validation", async (t) => {
  const f = fixture(t),
    initial = await f.add("first");
  await f.resolver.resolve(initial);
  for (let i = 0; i < 64; i++) await f.resolver.resolve(await f.add(`v-${i}`));
  const asset = await f.store.loadAgentVersion(initial);
  assert.ok(asset);
  const intercept = t.mock.method(f.store, "loadAgentVersion", async () => ({
    ...asset,
    agentVersionId: "other",
  }));
  await assert.rejects(f.resolver.resolve(initial), {
    message: "agent_version_store_identity_mismatch",
  });
  intercept.mock.restore();
  const tamper = t.mock.method(f.store, "loadAgentVersion", async () => ({
    ...asset,
    definitionJson: asset.definitionJson.replace(
      "stable instructions",
      "tampered instructions",
    ),
  }));
  await assert.rejects(f.resolver.resolve(initial), {
    message: "agent_version_digest_mismatch",
  });
  tamper.mock.restore();
  assert.deepEqual(
    (await f.resolver.resolve(initial))?.version,
    version("first"),
  );
});

test("evicted runtimes, kernels and compiled definitions become collectable while the shared owner remains live", async (t) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./shared-agent-runtime-gc.test-support.ts", import.meta.url),
      ),
    ],
    { timeout: 10000, maxBuffer: 32768 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.evictedProjectionsCollected, 64);
  assert.equal(result.hotEntries, 64);
  assert.equal(result.modelCalls, 0);
  t.diagnostic(JSON.stringify(result));
});
