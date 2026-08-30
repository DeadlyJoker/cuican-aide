import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { AgentKernelPort } from "@crewon/agent-kernel";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { RunExecutionPolicyPort } from "@crewon/application";
import type { ContextCompactorPort } from "@crewon/context";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { InMemoryRunStore } from "@crewon/store";

import {
  AgentVersionRuntimeError,
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import { DurableAgentVersionRuntimeLoader } from "./durable-agent-version-runtime-loader.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";

test("retains multiple immutable runtimes and resolves the prior compactor", async () => {
  const registry = new InMemoryAgentVersionRuntimeRegistry({ sha256 });
  const large = runtime("agent-large", "model-large", 256_000);
  const small = runtime("agent-small", "model-small", 128_000);

  assert.deepEqual(
    registry.register({ tenantId: "tenant-1", runtime: large }),
    {
      disposition: "registered",
    },
  );
  assert.deepEqual(registry.register({ tenantId: null, runtime: small }), {
    disposition: "registered",
  });
  assert.equal(
    registry.resolve({ tenantId: "tenant-1", agentVersionId: "agent-large" }),
    large,
  );
  assert.equal(
    registry.resolve({ tenantId: "tenant-2", agentVersionId: "agent-large" }),
    null,
  );
  assert.equal(
    registry.resolve({ tenantId: "tenant-2", agentVersionId: "agent-small" }),
    small,
  );
  assert.equal(
    registry.resolve({ tenantId: "tenant-1", agentVersionId: "missing" }),
    null,
  );

  const prior = await registry.priorModelCompactionResolver().resolve({
    schemaVersion: "crewon.thread-model-state.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    agentVersionId: "agent-large",
    adapterName: "test-adapter",
    adapterVersion: "1",
    modelId: "model-large",
    contextWindowTokens: 256_000,
    autoCompactAtTokens: 200_000,
    throughHistorySequence: 4,
    contextRevision: "canonical",
    latestUsage: null,
    updatedAt: "2026-08-09T00:00:00Z",
  });
  assert.equal(prior?.compactor, large.contextCompactor);
  await registry.close();
});

test("rejects runtime bindings that disagree with compiled model identity", () => {
  const registry = new InMemoryAgentVersionRuntimeRegistry({ sha256 });
  const candidate = runtime("agent-1", "model-1", 128_000);
  assert.throws(
    () =>
      registry.register({
        tenantId: "tenant-1",
        runtime: {
          ...candidate,
          kernel: kernel("different-model"),
        },
      }),
    (error) =>
      error instanceof AgentVersionRuntimeError &&
      error.code === "agent_version_runtime_model_mismatch",
  );
});

test("loads, verifies and tenant-scopes durable AgentVersion runtimes", async () => {
  const store = new InMemoryRunStore();
  const registry = new InMemoryAgentVersionRuntimeRegistry({ sha256 });
  const first = compiledVersion("agent-a", "model-a", 128_000);
  const second = compiledVersion("agent-b", "model-b", 256_000);
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: "tenant-1",
      version: second,
      createdAt: "2026-08-09T00:00:01Z",
    }),
  );
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: "tenant-1",
      version: first,
      createdAt: "2026-08-09T00:00:00Z",
    }),
  );
  let closed = 0;
  const loader = new DurableAgentVersionRuntimeLoader({
    store,
    digester: { sha256 },
    registry,
    pageSize: 1,
    factory: {
      create: ({ version }) => ({
        ...runtimeForVersion(version),
        close: async () => {
          closed += 1;
        },
      }),
    },
  });

  assert.deepEqual(await loader.loadTenant("tenant-1"), {
    loaded: 2,
    existing: 0,
  });
  assert.equal(
    registry.resolve({ tenantId: "tenant-1", agentVersionId: "agent-a" })
      ?.version.model.modelId,
    "model-a",
  );
  assert.equal(
    registry.resolve({ tenantId: "tenant-2", agentVersionId: "agent-a" }),
    null,
  );
  assert.deepEqual(await loader.loadTenant("tenant-1"), {
    loaded: 0,
    existing: 2,
  });
  assert.equal(closed, 2);
  await registry.close();
  assert.equal(closed, 4);
  await store.close();
});

test("fails closed when a durable AgentVersion definition was tampered", async () => {
  const store = new InMemoryRunStore();
  const registry = new InMemoryAgentVersionRuntimeRegistry({ sha256 });
  const version = compiledVersion("agent-a", "model-a", 128_000);
  const asset = createAgentVersionAsset({
    tenantId: "tenant-1",
    version,
    createdAt: "2026-08-09T00:00:00Z",
  });
  await store.registerAgentVersion({
    ...asset,
    definitionJson: JSON.stringify({
      ...JSON.parse(asset.definitionJson),
      instructions: "tampered",
    }),
  });
  const loader = new DurableAgentVersionRuntimeLoader({
    store,
    digester: { sha256 },
    registry,
    factory: { create: ({ version: item }) => runtimeForVersion(item) },
  });

  await assert.rejects(
    loader.loadTenant("tenant-1"),
    (error) =>
      error instanceof Error &&
      error.message === "agent_version_digest_mismatch",
  );
  assert.equal(
    registry.resolve({ tenantId: "tenant-1", agentVersionId: "agent-a" }),
    null,
  );
  await registry.close();
  await store.close();
});

test("single-flights a tenant runtime from the Store on first Run resolution", async () => {
  const store = new InMemoryRunStore();
  const registry = new InMemoryAgentVersionRuntimeRegistry({ sha256 });
  const version = compiledVersion("agent-lazy", "model-lazy", 128_000);
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: "tenant-1",
      version,
      createdAt: "2026-08-09T00:00:00Z",
    }),
  );
  let factoryCalls = 0;
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    digester: { sha256 },
    registry,
    factory: {
      create: ({ version: item }) => {
        factoryCalls += 1;
        return runtimeForVersion(item);
      },
    },
  });
  const locator = {
    tenantId: "tenant-1",
    agentVersionId: "agent-lazy",
  };

  const [first, second] = await Promise.all([
    resolver.resolve(locator),
    resolver.resolve(locator),
  ]);
  assert.equal(first, second);
  assert.deepEqual(first?.version, version);
  assert.equal(factoryCalls, 1);
  assert.equal(
    await resolver.resolve({
      tenantId: "tenant-2",
      agentVersionId: "agent-lazy",
    }),
    null,
  );
  const prior = await resolver.priorModelCompactionResolver().resolve({
    schemaVersion: "crewon.thread-model-state.v0",
    tenantId: "tenant-1",
    threadId: "thread-1",
    agentVersionId: "agent-lazy",
    adapterName: "test-adapter",
    adapterVersion: "1",
    modelId: "model-lazy",
    contextWindowTokens: 128_000,
    autoCompactAtTokens: 96_000,
    throughHistorySequence: 1,
    contextRevision: "revision-1",
    latestUsage: null,
    updatedAt: "2026-08-09T00:00:00Z",
  });
  assert.equal(prior?.compactor, first?.contextCompactor);
  await registry.close();
  await store.close();
});

function runtime(
  agentVersionId: string,
  modelId: string,
  contextWindowTokens: number,
): AgentVersionRuntime {
  return runtimeForVersion(
    compiledVersion(agentVersionId, modelId, contextWindowTokens),
  );
}

function compiledVersion(
  agentVersionId: string,
  modelId: string,
  contextWindowTokens: number,
): CompiledAgentVersion {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-1",
      instructions: null,
      model: {
        adapterName: "test-adapter",
        adapterVersion: "1",
        modelId,
        contextWindowTokens,
        autoCompactAtTokens: Math.floor(contextWindowTokens * 0.75),
      },
      execution: { streamMaxRetries: 2, maxToolRounds: 8 },
      resources: {
        workspaceRequired: false,
        governedContextDigest: null,
      },
      tools: [],
    },
    { sha256 },
  );
}

function runtimeForVersion(version: CompiledAgentVersion): AgentVersionRuntime {
  const toolRuntime = new InMemoryToolBroker();
  return {
    version,
    kernel: kernel(version.model.modelId),
    policy: allowPolicy,
    toolRuntime,
    contextCompactor: compactor,
  };
}

function kernel(modelId: string): AgentKernelPort {
  return {
    modelIdentity: {
      adapterName: "test-adapter",
      adapterVersion: "1",
      modelId,
    },
    async *runSegment() {
      throw new Error("not used");
    },
  };
}

const allowPolicy: RunExecutionPolicyPort = {
  evaluate: async () => ({ outcome: "allow" }),
};

const compactor: ContextCompactorPort = {
  compact: async () => ({
    summary: "summary",
    usage: {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
    },
  }),
};

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
