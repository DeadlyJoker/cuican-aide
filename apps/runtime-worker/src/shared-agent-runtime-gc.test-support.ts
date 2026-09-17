import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { createAgentVersionAsset } from "@crewon/agent-version";
import { InMemoryRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { sharedAgentVersionRuntimeFactory } from "./shared-agent-version-runtime-factory.ts";
import {
  digester,
  route,
  version,
} from "./shared-agent-runtime-cache.test-support.ts";
const store = new InMemoryRunStore(),
  registry = new InMemoryAgentVersionRuntimeRegistry(digester),
  owner = new InMemoryToolBroker();
const resolver = new StoreBackedAgentVersionRuntimeResolver({
  store,
  registry,
  digester,
  factory: sharedAgentVersionRuntimeFactory(
    {
      route,
      transport: {
        adapterName: "fixture",
        adapterVersion: "1",
        modelId: "fixture-model",
        async *stream() {
          throw Error("no model");
        },
      },
    },
    owner,
  ),
});
async function populate() {
  const weak: {
    runtime: WeakRef<object>;
    kernel: WeakRef<object>;
    version: WeakRef<object>;
  }[] = [];
  for (let i = 0; i < 128; i++) {
    const compiled = version(`v-${i}`);
    await store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: "tenant",
        version: compiled,
        createdAt: "2026-09-15T00:00:00Z",
      }),
    );
    const runtime = await resolver.resolve({
      tenantId: "tenant",
      agentVersionId: compiled.agentVersionId,
    });
    assert.ok(runtime);
    if (i < 64)
      weak.push({
        runtime: new WeakRef(runtime),
        kernel: new WeakRef(runtime.kernel),
        version: new WeakRef(runtime.version),
      });
  }
  return weak;
}
const weak = await populate();
let collected = 0;
for (let i = 0; i < 30; i++) {
  await turn();
  global.gc!();
  await turn();
  collected = weak.filter(
    (value) =>
      value.runtime.deref() === undefined &&
      value.kernel.deref() === undefined &&
      value.version.deref() === undefined,
  ).length;
  if (collected === weak.length) break;
}
assert.equal(collected, 64);
assert.equal(resolver.sharedRuntimeCacheSnapshot().entries, 64);
assert.equal(resolver.nextToolResultMaintenanceRuntime(), owner);
console.log(
  JSON.stringify({
    evictedProjectionsCollected: collected,
    hotEntries: 64,
    modelCalls: 0,
    forcedGC: "isolated child only",
  }),
);
resolver.close();
await registry.close();
await store.close();
