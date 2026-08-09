import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { compileAgentVersion } from "@crewon/agent-version";

import {
  loadAgentVersionDeployments,
  loadAgentVersionRuntimeFactory,
  parseRuntimeBindingConfig,
} from "./runtime-binding-config.ts";

test("loads a bounded Direct Responses runtime manifest without provider SDKs", async (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  writeFileSync(
    path,
    JSON.stringify(config(version.contentDigest, null)),
    "utf8",
  );
  const factory = loadAgentVersionRuntimeFactory(path, {});

  const [deployment] = factory.deploymentBindings("tenant-1");
  assert.ok(deployment !== undefined);
  assert.match(deployment.materializationDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(
    { ...deployment, materializationDigest: "<digest>" },
    {
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: "tenant-1",
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      materializationDigest: "<digest>",
      authorityId: "authority-1",
      workspaceBindingId: null,
    },
  );
  const runtime = await factory.create({ tenantId: "tenant-1", version });
  assert.deepEqual(runtime.kernel.modelIdentity, {
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "model-1",
  });
  assert.deepEqual(runtime.toolRuntime.definitions(), []);
  await runtime.close?.();
});

test("requires an explicitly named provider credential at startup", (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  writeFileSync(
    path,
    JSON.stringify(config(version.contentDigest, "PROVIDER_API_KEY")),
    "utf8",
  );

  assert.throws(
    () => loadAgentVersionRuntimeFactory(path, {}),
    hasMessage("agent_version_runtime_provider_key_missing"),
  );
  assert.doesNotThrow(() => loadAgentVersionDeployments(path));
  assert.doesNotThrow(() =>
    loadAgentVersionRuntimeFactory(path, {
      PROVIDER_API_KEY: "test-provider-key",
    }),
  );
});

test("rejects MCP materialization content drift after release compilation", async (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  const mcpPath = `${path}.mcp.json`;
  const mcpConfig = {
    schemaVersion: "crewon.mcp-stdio-config.v0",
    servers: [
      {
        serverId: "fixture",
        command: process.execPath,
        args: [],
        cwd: null,
        env: {},
        tools: {},
      },
    ],
  };
  writeFileSync(mcpPath, JSON.stringify(mcpConfig), "utf8");
  const manifest = config(version.contentDigest, null);
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      bindings: [{ ...manifest.bindings[0], mcpStdioConfigPath: mcpPath }],
    }),
    "utf8",
  );
  const factory = loadAgentVersionRuntimeFactory(path, {});
  writeFileSync(
    mcpPath,
    JSON.stringify({
      ...mcpConfig,
      servers: [{ ...mcpConfig.servers[0], env: { DRIFTED: "1" } }],
    }),
    "utf8",
  );

  await assert.rejects(
    factory.create({ tenantId: "tenant-1", version }),
    hasMessage("agent_version_runtime_materialization_drift"),
  );
});

test("rejects injected fields and unsafe runtime manifests", () => {
  const version = compileAgentVersion(source(), { sha256 });
  const valid = config(version.contentDigest, null);
  assert.throws(
    () =>
      parseRuntimeBindingConfig({
        ...valid,
        bindings: [
          {
            ...valid.bindings[0],
            apiKey: "secret-must-not-live-in-the-manifest",
          },
        ],
      }),
    hasMessage("agent_version_runtime_binding_invalid"),
  );
  assert.throws(
    () =>
      parseRuntimeBindingConfig({
        ...valid,
        bindings: [
          {
            ...valid.bindings[0],
            provider: {
              ...valid.bindings[0]?.provider,
              apiKeyEnvironment: "unsafe-name",
            },
          },
        ],
      }),
    hasMessage("agent_version_runtime_provider_key_invalid"),
  );
});

function config(contentDigest: string, apiKeyEnvironment: string | null) {
  return {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0" as const,
    bindings: [
      {
        tenantId: "tenant-1",
        agentVersionId: "agent-version-1",
        contentDigest,
        authorityId: "authority-1",
        workspaceBindingId: null,
        provider: {
          kind: "directResponses" as const,
          endpoint: "https://provider.example/v1/responses",
          apiKeyEnvironment,
          storeResponses: false,
          requestProfile: "standard" as const,
          idleTimeoutMs: 60_000,
          sequencePolicy: "required" as const,
        },
        mcpStdioConfigPath: null,
        deviceToolConfigPath: null,
      },
    ],
  };
}

function source() {
  return {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId: "agent-version-1",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "policy-1",
    instructions: null,
    model: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "model-1",
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

function temporaryFile(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-runtime-bindings-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "bindings.json");
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasMessage(message: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message === message;
}
