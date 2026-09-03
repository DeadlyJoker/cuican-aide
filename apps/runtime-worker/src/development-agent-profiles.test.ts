import assert from "node:assert/strict";
import test from "node:test";

import { compileAgentVersion } from "@crewon/agent-version";

import {
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
    workspaceBindingId: null,
    endpoint: "https://provider.example/v1/responses",
    requestProfile: "standard",
    sequencePolicy: "required",
    idleTimeoutMs: 60_000,
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
