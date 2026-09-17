import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import { InMemoryRunStore } from "@crewon/store";
import { AgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { loadAgentVersionRuntimeFactory } from "./runtime-binding-config.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  digester,
  version as baseVersion,
} from "./shared-agent-runtime-cache.test-support.ts";

export async function manifestCreationFixture(
  t: TestContext,
  options: {
    environment?: Record<string, string | undefined>;
    provider?: Record<string, unknown>;
    files?: { stdio?: unknown; device?: unknown; remote?: unknown };
    makeFiles?: (root: string) => {
      stdio?: unknown;
      device?: unknown;
      remote?: unknown;
    };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "crewon-creation-manifest-"));
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester, {
    capacity,
  });
  const store = new InMemoryRunStore();
  let resolver: StoreBackedAgentVersionRuntimeResolver | undefined;
  t.after(async () => {
    resolver?.close();
    try {
      await registry.close();
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  const base = baseVersion("manifest-version");
  const cloud = options.provider?.kind === "cloudAgent";
  const version = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: base.agentVersionId,
      runtimeGeneration: base.runtimeGeneration,
      policySnapshotId: base.policySnapshotId,
      instructions: cloud ? null : base.instructions,
      model: {
        ...base.model,
        adapterName: cloud ? "cloud-agent" : "direct-responses",
      },
      tools: base.tools,
      execution: base.execution,
      resources: base.resources,
    },
    digester,
  );
  const files = options.makeFiles?.(root) ?? options.files ?? {};
  for (const [key, value] of Object.entries(files))
    await writeFile(join(root, key + ".json"), JSON.stringify(value));
  const provider = options.provider ?? {
    kind: "directResponses",
    endpoint: "https://provider.invalid/v1/responses",
    apiKeyEnvironment: null,
    storeResponses: false,
    requestProfile: "standard",
    idleTimeoutMs: 1000,
    sequencePolicy: "required",
  };
  const path = join(root, "manifest.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: "crewon.agent-version-runtime-bindings.v0",
      bindings: [
        {
          tenantId: "tenant",
          agentVersionId: version.agentVersionId,
          contentDigest: version.contentDigest,
          authorityId: "authority",
          workspaceBindingId: null,
          provider,
          mcpStdioConfigPath:
            files.stdio === undefined ? null : join(root, "stdio.json"),
          deviceToolConfigPath:
            files.device === undefined ? null : join(root, "device.json"),
          remoteMcpConfigPath:
            files.remote === undefined ? null : join(root, "remote.json"),
        },
      ],
    }),
  );
  const factory = loadAgentVersionRuntimeFactory(
    path,
    options.environment ?? {},
  );
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: "tenant",
      version,
      createdAt: "2026-09-15T00:00:00Z",
    }),
  );
  resolver = new StoreBackedAgentVersionRuntimeResolver({
    registry,
    factory,
    store,
    digester,
  });
  return {
    root,
    capacity,
    registry,
    resolver,
    factory,
    version,
    acquire: async () => {
      const lease = await resolver!.acquire({
        tenantId: "tenant",
        agentVersionId: version.agentVersionId,
      });
      assert.ok(lease);
      return lease;
    },
    assertReleased: () => {
      const s = capacity.snapshot();
      assert.equal(s.owners, 0);
      assert.equal(s.definitionBytes, 0);
      assert.equal(s.creating, 0);
      assert.equal(s.uncertain, 0);
    },
  };
}
