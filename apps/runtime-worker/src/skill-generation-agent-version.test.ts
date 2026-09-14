import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { compileSkillGenerationAgentVersion } from "./skill-generation-agent-version.ts";
import type { RuntimeAgentVersionReleaseConfig } from "./agent-version-release.ts";

const config: RuntimeAgentVersionReleaseConfig = {
  runtimeTenantId: "tenant",
  route: {
    authorityId: "authority",
    runtimeGeneration: "runtime",
    agentVersionId: "default",
    policySnapshotId: "policy",
    workspaceBindingId: null,
  },
  transport: {
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "configured-model",
    async *stream() {
      throw new Error("not a provider test");
    },
  },
  toolRuntime: new InMemoryToolBroker([
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "source_mutation",
      description: "Must not reach generation.",
      execution: "serial",
      inputSchema: { type: "object", properties: {} },
    },
  ]),
  nativeWorkspaceReadCatalog: "enabled",
  maxToolRounds: 20,
};
test("fixed generation role retains the configured model but removes every tool catalog and tool round", () => {
  const version = compileSkillGenerationAgentVersion(config, "fixed-generator");
  assert.equal(version.model.modelId, "configured-model");
  assert.equal(version.agentVersionId, "fixed-generator");
  assert.deepEqual(version.tools, []);
  assert.equal(version.execution.maxToolRounds, 0);
  assert.equal(version.resources.governedContextDigest, null);
  assert.equal(
    compileSkillGenerationAgentVersion(config, "fixed-generator").contentDigest,
    version.contentDigest,
  );
});
test("provider-owned hidden tools cannot be advertised as text-only generation", () => {
  assert.throws(
    () =>
      compileSkillGenerationAgentVersion(
        {
          ...config,
          transport: { ...config.transport, adapterName: "cloud-agent" },
        },
        "fixed-generator",
      ),
    /skill_generation_provider_tools_not_controllable/,
  );
});
