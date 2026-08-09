import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  compileAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { InMemoryToolBroker } from "@crewon/tool-broker";

import {
  ConfiguredAgentVersionRuntimeFactory,
  type AgentVersionRuntimeBinding,
} from "./configured-agent-version-runtime-factory.ts";
import { AgentVersionRuntimeError } from "./agent-version-runtime.ts";

test("materializes independent digest-bound provider runtimes", async () => {
  const first = version("agent-a", "adapter-a", "model-a");
  const second = version("agent-b", "adapter-b", "model-b");
  const observations = new Map<string, { prewarmed: number; closed: number }>();
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    binding("tenant-1", first, observations),
    binding("tenant-1", second, observations),
  ]);

  assert.deepEqual(factory.deploymentBindings("tenant-1"), [
    {
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: "tenant-1",
      agentVersionId: first.agentVersionId,
      contentDigest: first.contentDigest,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      authorityId: "authority-agent-a",
      workspaceBindingId: null,
    },
    {
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: "tenant-1",
      agentVersionId: second.agentVersionId,
      contentDigest: second.contentDigest,
      materializationDigest: `sha256:${"d".repeat(64)}`,
      authorityId: "authority-agent-b",
      workspaceBindingId: null,
    },
  ]);
  const firstRuntime = await factory.create({
    tenantId: "tenant-1",
    version: first,
  });
  const secondRuntime = await factory.create({
    tenantId: "tenant-1",
    version: second,
  });

  assert.deepEqual(firstRuntime.kernel.modelIdentity, {
    adapterName: first.model.adapterName,
    adapterVersion: first.model.adapterVersion,
    modelId: first.model.modelId,
  });
  assert.deepEqual(secondRuntime.kernel.modelIdentity, {
    adapterName: second.model.adapterName,
    adapterVersion: second.model.adapterVersion,
    modelId: second.model.modelId,
  });
  assert.equal(observations.get("agent-a")?.prewarmed, 1);
  assert.equal(observations.get("agent-b")?.prewarmed, 1);
  await Promise.all([firstRuntime.close?.(), secondRuntime.close?.()]);
  await firstRuntime.close?.();
  assert.equal(observations.get("agent-a")?.closed, 1);
  assert.equal(observations.get("agent-b")?.closed, 1);
});

test("rejects undeployed tenants and digest drift before opening a provider", async () => {
  const deployed = version("agent-a", "adapter-a", "model-a");
  let opened = 0;
  const configured = binding("tenant-1", deployed, new Map());
  const factory = new ConfiguredAgentVersionRuntimeFactory([
    {
      ...configured,
      createTransport: (item) => {
        opened += 1;
        return configured.createTransport(item);
      },
    },
  ]);
  const drifted = compileAgentVersion(
    {
      ...source("agent-a", "adapter-a", "model-a"),
      instructions: "digest drift",
    },
    { sha256 },
  );

  await assert.rejects(
    factory.create({ tenantId: "tenant-2", version: deployed }),
    hasRuntimeCode("agent_version_runtime_not_deployed"),
  );
  await assert.rejects(
    factory.create({ tenantId: "tenant-1", version: drifted }),
    hasRuntimeCode("agent_version_runtime_digest_not_deployed"),
  );
  assert.equal(opened, 0);
});

function binding(
  tenantId: string,
  compiled: CompiledAgentVersion,
  observations: Map<string, { prewarmed: number; closed: number }>,
): AgentVersionRuntimeBinding {
  observations.set(compiled.agentVersionId, { prewarmed: 0, closed: 0 });
  return {
    tenantId,
    agentVersionId: compiled.agentVersionId,
    contentDigest: compiled.contentDigest,
    authorityId: `authority-${compiled.agentVersionId}`,
    workspaceBindingId: null,
    materializationDigest: `sha256:${"d".repeat(64)}`,
    createTransport: () => {
      const state = observations.get(compiled.agentVersionId);
      assert.ok(state !== undefined);
      const transport: ModelTransportPort = {
        adapterName: compiled.model.adapterName,
        adapterVersion: compiled.model.adapterVersion,
        modelId: compiled.model.modelId,
        prewarm: async () => {
          state.prewarmed += 1;
        },
        async *stream() {
          yield { type: "completed", checkpoint: null };
        },
        close: async () => {
          state.closed += 1;
        },
      };
      return transport;
    },
    createToolRuntime: () => new InMemoryToolBroker(),
  };
}

function version(
  agentVersionId: string,
  adapterName: string,
  modelId: string,
): CompiledAgentVersion {
  return compileAgentVersion(source(agentVersionId, adapterName, modelId), {
    sha256,
  });
}

function source(agentVersionId: string, adapterName: string, modelId: string) {
  return {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId,
    runtimeGeneration: "ts-v0",
    policySnapshotId: `policy-${agentVersionId}`,
    instructions: null,
    model: {
      adapterName,
      adapterVersion: "1",
      modelId,
      contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: {
      workspaceRequired: false,
      governedContextDigest: null,
    },
    tools: [],
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasRuntimeCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof AgentVersionRuntimeError && error.code === code;
}
