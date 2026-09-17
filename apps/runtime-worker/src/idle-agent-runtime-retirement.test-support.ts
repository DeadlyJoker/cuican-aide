import assert from "node:assert/strict";
import { createAgentVersionAsset } from "@crewon/agent-version";
import { InMemoryRunStore } from "@crewon/store";
import {
  InMemoryToolBroker,
  type ToolRuntimePort,
  type ToolDefinition,
} from "@crewon/tool-broker";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import type { AgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  digester,
  version,
} from "./shared-agent-runtime-cache.test-support.ts";

export async function retirementFixture(
  input: {
    count?: number;
    definitions?: readonly ToolDefinition[];
    tools?: (id: string) => ToolRuntimePort | Promise<ToolRuntimePort>;
    close?: (id: string) => Promise<void>;
    capacity?: AgentRuntimeCapacity;
  } = {},
) {
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester, {
      capacity: input.capacity,
    }),
    store = new InMemoryRunStore();
  const closed: string[] = [],
    created: string[] = [];
  const closing = new Set<Promise<void>>();
  const versions = Array.from({ length: input.count ?? 160 }, (_, n) =>
    version(`v-${n}`, input.definitions ?? []),
  );
  for (const compiled of versions)
    await store.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: "tenant",
        version: compiled,
        createdAt: "2026-09-15T00:00:00Z",
      }),
    );
  const factory = new ConfiguredAgentVersionRuntimeFactory(
    versions.map((compiled) => ({
      tenantId: "tenant",
      agentVersionId: compiled.agentVersionId,
      contentDigest: compiled.contentDigest,
      authorityId: "authority",
      workspaceBindingId: null,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      executionAuthority: "crewonKernel",
      transportOwnership: "request",
      createTransport: () => ({
        adapterName: "fixture",
        adapterVersion: "1",
        modelId: "fixture-model",
        async *stream(): AsyncGenerator<never> {
          throw new Error("unexpected model call");
        },
      }),
      createToolRuntime: async () => {
        const id = compiled.agentVersionId;
        created.push(id);
        const tools: ToolRuntimePort = await (input.tools?.(id) ??
          new InMemoryToolBroker(compiled.tools));
        const close = tools.close?.bind(tools);
        return Object.assign(tools, {
          close: async () => {
            const physical = Promise.resolve().then(async () => {
              await input.close?.(id);
              await close?.();
              closed.push(id);
            });
            closing.add(physical);
            try {
              await physical;
            } finally {
              closing.delete(physical);
            }
          },
        });
      },
    })),
  );
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    registry,
    store,
    digester,
    factory,
  });
  const locator = (n: number) => ({
    tenantId: "tenant",
    agentVersionId: `v-${n}`,
  });
  const acquire = async (n: number) => {
    const lease = await resolver.acquire(locator(n));
    assert.ok(lease);
    return lease;
  };
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      const lease = registry.nextToolResultMaintenanceLease();
      lease?.release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Join actual disposers, including child-process exit. A fixed number of
      // event-loop turns cannot prove that external I/O has completed.
      await Promise.all([...closing]);
      const state = registry.retirementSnapshot();
      if (
        state.retiring === 0 &&
        state.candidates <= state.targetEntries &&
        state.definitionBytes <= state.targetDefinitionBytes
      )
        return;
    }
    assert.fail("idle owners did not retire");
  };
  return {
    registry,
    store,
    resolver,
    factory,
    closed,
    created,
    versions,
    locator,
    acquire,
    drain,
    close: async () => {
      resolver.close();
      try {
        await registry.close();
      } finally {
        await store.close();
      }
    },
  };
}
