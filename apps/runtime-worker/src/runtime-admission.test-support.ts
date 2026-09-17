import type { TestContext } from "node:test";
import {
  createAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { DirectResponsesTransport } from "@crewon/agent-responses";
import type { AgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { digester } from "./shared-agent-runtime-cache.test-support.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

export async function capacityHttpFixture(
  t: TestContext,
  options: {
    backend: "sqlite" | "postgres";
    stored: boolean;
    capacity: AgentRuntimeCapacity;
    crashAfterResolved?: boolean;
    crashAfterCommit?: boolean;
  },
) {
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester, {
    capacity: options.capacity,
  });
  let resolver!: StoreBackedAgentVersionRuntimeResolver,
    version!: CompiledAgentVersion;
  let created = 0,
    closed = 0;
  const headers: unknown[] = [];
  const f = await createFixture(t, {
    backend: options.backend,
    storeResponses: options.stored,
    crashAfterCommit: options.crashAfterCommit ?? false,
    crashAfterResolved: options.crashAfterResolved,
    modelResponseHeaders: { "x-codex-turn-state": "stable-admission-state" },
    observeModelHeaders: ({ headers: values }) =>
      headers.push(values["x-codex-turn-state"]),
    runtimeResolverFactory(base, store, shared) {
      resolver?.close();
      version = base.version;
      const configured = new ConfiguredAgentVersionRuntimeFactory([
        {
          tenantId: "tenant-1",
          agentVersionId: version.agentVersionId,
          contentDigest: version.contentDigest,
          authorityId: shared.route.authorityId,
          workspaceBindingId: null,
          materializationDigest: `sha256:${"d".repeat(64)}`,
          executionAuthority: "crewonKernel",
          transportOwnership: "request",
          createTransport: () =>
            new DirectResponsesTransport({
              endpoint: shared.endpoint,
              model: "fixture-model",
              storeResponses: options.stored,
            }),
          createToolRuntime: () => {
            created++;
            return base.toolRuntime;
          },
        },
      ]);
      resolver = new StoreBackedAgentVersionRuntimeResolver({
        registry,
        store,
        digester,
        factory: {
          async create(input) {
            const runtime = await configured.create(input);
            return {
              ...runtime,
              close: async () => {
                await runtime.close?.();
                closed++;
              },
            };
          },
        },
      });
      return resolver;
    },
  });
  t.after(async () => {
    await f.worker().close();
    resolver.close();
    await registry.close();
  });
  await f.store().registerAgentVersion(
    createAgentVersionAsset({
      tenantId: "tenant-1",
      version,
      createdAt: "2026-09-15T00:00:00Z",
    }),
  );
  return {
    ...f,
    registry,
    headers,
    counts: () => ({ created, closed }),
    locator: { tenantId: "tenant-1", agentVersionId: version.agentVersionId },
  };
}
