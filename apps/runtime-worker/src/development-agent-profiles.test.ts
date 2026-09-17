import assert from "node:assert/strict";
import test from "node:test";

import { compileAgentVersion } from "@crewon/agent-version";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { InMemoryToolBroker } from "@crewon/tool-broker";

import {
  compileDevelopmentAgentProfileVersion,
  developmentAgentRuntimeBindings,
  parseDevelopmentAgentProfiles,
} from "./development-agent-profiles.ts";

test("parses bounded independent development profiles", () => {
  assert.deepEqual(
    parseDevelopmentAgentProfiles(
      JSON.stringify([
        { agentVersionId: "local-planner", instructions: "Plan the work." },
        {
          agentVersionId: "cloud-verifier",
          instructions: "Verify the work.",
          cloudAgent: {
            invocationUrl: "https://agents.example/invoke",
            modelId: "model-cloud",
            agentId: 42,
          },
        },
      ]),
    ),
    [
      { agentVersionId: "local-planner", instructions: "Plan the work." },
      {
        agentVersionId: "cloud-verifier",
        instructions: "Verify the work.",
        cloudAgent: {
          invocationUrl: "https://agents.example/invoke",
          modelId: "model-cloud",
          agentId: 42,
        },
      },
    ],
  );
  assert.equal(
    parseDevelopmentAgentProfiles(
      JSON.stringify([
        {
          agentVersionId: "cloud-with-provider-defaults",
          instructions: "",
          cloudAgent: {
            invocationUrl: "https://agents.example/invoke",
            modelId: "model-cloud",
            agentId: 43,
          },
        },
      ]),
    )[0]?.instructions,
    "",
  );
  assert.throws(
    () =>
      parseDevelopmentAgentProfiles(
        JSON.stringify([
          { agentVersionId: "duplicate", instructions: "one" },
          { agentVersionId: "duplicate", instructions: "two" },
        ]),
      ),
    /CREWON_DEV_AGENT_PROFILES_JSON_invalid/u,
  );
  for (const invalidProfile of [
    {
      agentVersionId: "injected",
      instructions: "one",
      unexpected: true,
    },
    {
      agentVersionId: "cloud",
      instructions: "one",
      cloudAgent: {
        invocationUrl: "https://agents.example/invoke",
        modelId: "",
        agentId: 1,
      },
    },
    {
      agentVersionId: "cloud",
      instructions: "one",
      cloudAgent: {
        invocationUrl: "https://agents.example/invoke",
        modelId: "model-cloud",
        agentId: 0,
      },
    },
  ]) {
    assert.throws(
      () => parseDevelopmentAgentProfiles(JSON.stringify([invalidProfile])),
      /CREWON_DEV_AGENT_PROFILES_JSON_invalid/u,
    );
  }
});

test("compiles cloud profiles without claiming provider-owned behavior", () => {
  const transport: ModelTransportPort = {
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "local-model",
    async *stream() {
      throw new Error("unused");
    },
  };
  const toolRuntime = new InMemoryToolBroker([
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "local_tool",
      description: "Local only.",
      execution: "serial",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ]);
  const config = {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
      agentVersionId: "bootstrap",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
    transport,
    agentInstructions: "Bootstrap instructions.",
    toolRuntime,
  } as const;

  const local = compileDevelopmentAgentProfileVersion(config, {
    agentVersionId: "local-planner",
    instructions: "Plan locally.",
  });
  assert.equal(local.instructions, "Plan locally.");
  assert.equal(local.model.modelId, "local-model");
  assert.equal(local.resources.workspaceRequired, true);
  assert.equal(local.tools.length, 1);

  const cloud = compileDevelopmentAgentProfileVersion(config, {
    agentVersionId: "cloud-verifier",
    instructions: "Provider-owned prompt snapshot.",
    cloudAgent: {
      invocationUrl: "https://agents.example/invoke",
      modelId: "cloud-model",
      agentId: 42,
    },
  });
  assert.equal(cloud.instructions, null);
  assert.deepEqual(cloud.tools, []);
  assert.deepEqual(cloud.model, {
    adapterName: "cloud-agent",
    adapterVersion: "1",
    modelId: "cloud-model",
    contextWindowTokens: 273_000,
    autoCompactAtTokens: 200_000,
  });
  assert.deepEqual(cloud.resources, {
    workspaceRequired: false,
    governedContextDigest: null,
  });
  assert.equal(cloud.execution.streamMaxRetries, 0);
});

test("creates one digest-pinned runtime binding per compiled version", () => {
  const versions = ["local-executor", "local-verifier"].map((agentVersionId) =>
    compileAgentVersion(source(agentVersionId), { sha256 }),
  );
  const manifest = developmentAgentRuntimeBindings({
    versions,
    profiles: versions.map(() => undefined),
    tenantId: "tenant-1",
    authorityId: "authority-1",
    workspaceBindingId: null,
    endpoint: "https://provider.example/v1/responses",
    requestProfile: "responsesLite",
    sequencePolicy: "whenPresent",
    idleTimeoutMs: 60_000,
  });

  assert.deepEqual(
    manifest.bindings.map(({ agentVersionId, contentDigest }) => ({
      agentVersionId,
      contentDigest,
    })),
    versions.map(({ agentVersionId, contentDigest }) => ({
      agentVersionId,
      contentDigest,
    })),
  );
});

test("marks generated model bindings for the already-composed shared tools", () => {
  const version = compileAgentVersion(source("model-variant"), { sha256 });
  const manifest = developmentAgentRuntimeBindings({
    versions: [version],
    profiles: [undefined],
    tenantId: "tenant-1",
    authorityId: "authority-1",
    workspaceBindingId: null,
    endpoint: "https://provider.example/v1/responses",
    requestProfile: "standard",
    sequencePolicy: "required",
    idleTimeoutMs: 60_000,
    toolRuntimeMode: "shared",
  });

  assert.equal(manifest.bindings[0]?.toolRuntimeMode, "shared");
  assert.equal(manifest.bindings[0]?.mcpStdioConfigPath, null);
});

test("binds independent development profiles to the configured local MCP", () => {
  const version = compileAgentVersion(source("local-planner"), { sha256 });
  const manifest = developmentAgentRuntimeBindings({
    versions: [version],
    profiles: [undefined],
    tenantId: "tenant-1",
    authorityId: "authority-1",
    workspaceBindingId: null,
    endpoint: "https://provider.example/v1/responses",
    requestProfile: "standard",
    sequencePolicy: "required",
    idleTimeoutMs: 60_000,
    mcpStdioConfigPath: "/tmp/local-workspace-mcp.json",
  });

  assert.equal(
    manifest.bindings[0]?.mcpStdioConfigPath,
    "/tmp/local-workspace-mcp.json",
  );
});

test("binds cloud development profiles to their configured Agent service", () => {
  const version = compileAgentVersion(source("cloud-verifier"), { sha256 });
  const manifest = developmentAgentRuntimeBindings({
    versions: [version],
    profiles: [
      {
        agentVersionId: "cloud-verifier",
        instructions: "Verify the work.",
        cloudAgent: {
          invocationUrl: "https://agents.example/invoke",
          modelId: "model-cloud",
          agentId: 42,
        },
      },
    ],
    tenantId: "tenant-1",
    authorityId: "authority-1",
    workspaceBindingId: "workspace-local",
    endpoint: "https://provider.example/v1/responses",
    requestProfile: "standard",
    sequencePolicy: "required",
    idleTimeoutMs: 60_000,
    mcpStdioConfigPath: "/tmp/local-workspace-mcp.json",
    toolRuntimeMode: "shared",
  });

  assert.deepEqual(manifest.bindings[0]?.provider, {
    kind: "cloudAgent",
    invocationUrl: "https://agents.example/invoke",
    modelId: "model-cloud",
    agentId: 42,
    apiKeyEnvironment: "CREWON_AGENT_PLATFORM_API_KEY",
    storeResponses: false,
    requestProfile: "standard",
    idleTimeoutMs: 60_000,
    sequencePolicy: "required",
  });
  assert.deepEqual(
    {
      workspaceBindingId: manifest.bindings[0]?.workspaceBindingId,
      mcpStdioConfigPath: manifest.bindings[0]?.mcpStdioConfigPath,
      toolRuntimeMode: manifest.bindings[0]?.toolRuntimeMode,
    },
    {
      workspaceBindingId: null,
      mcpStdioConfigPath: null,
      toolRuntimeMode: "independent",
    },
  );
});

test("keeps release manifest credentials separated and secret-free", () => {
  const directVersion = compileAgentVersion(source("local-executor"), {
    sha256,
  });
  const cloudVersion = compileAgentVersion(source("cloud-verifier"), {
    sha256,
  });
  const manifest = developmentAgentRuntimeBindings({
    versions: [directVersion, cloudVersion],
    profiles: [
      undefined,
      {
        agentVersionId: "cloud-verifier",
        instructions: "Verify the work.",
        cloudAgent: {
          invocationUrl: "https://pim.example/api/v1/open/agent/42/chat",
          modelId: "model-cloud",
          agentId: 42,
        },
      },
    ],
    tenantId: "tenant-1",
    authorityId: "authority-1",
    workspaceBindingId: "workspace-local",
    endpoint: "https://provider.example/v1/responses",
    requestProfile: "standard",
    sequencePolicy: "required",
    idleTimeoutMs: 60_000,
    directApiKeyEnvironment: "CREWON_MODEL_API_KEY",
    toolRuntimeMode: "shared",
  });

  assert.equal(
    manifest.bindings[0]?.provider.apiKeyEnvironment,
    "CREWON_MODEL_API_KEY",
  );
  assert.equal(
    manifest.bindings[1]?.provider.apiKeyEnvironment,
    "CREWON_AGENT_PLATFORM_API_KEY",
  );
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /model-provider-secret/u);
  assert.doesNotMatch(serialized, /bpk_agent-platform-secret/u);
});

test("rejects profile arrays that do not align with compiled versions", () => {
  const version = compileAgentVersion(source("local-planner"), { sha256 });

  assert.throws(
    () =>
      developmentAgentRuntimeBindings({
        versions: [version],
        profiles: [],
        tenantId: "tenant-1",
        authorityId: "authority-1",
        workspaceBindingId: null,
        endpoint: "https://provider.example/v1/responses",
        requestProfile: "standard",
        sequencePolicy: "required",
        idleTimeoutMs: 60_000,
      }),
    /development_agent_profiles_alignment_invalid/u,
  );
});

function source(agentVersionId: string) {
  return {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId,
    runtimeGeneration: "web-runtime-test",
    policySnapshotId: "policy-test",
    instructions: null,
    model: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "model-test",
      contextWindowTokens: 128_000,
      autoCompactAtTokens: 96_000,
    },
    execution: { streamMaxRetries: 2, maxToolRounds: 16 },
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: [],
  };
}

function sha256(): string {
  return `sha256:${"a".repeat(64)}`;
}
