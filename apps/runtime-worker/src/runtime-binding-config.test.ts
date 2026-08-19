import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { compileAgentVersion } from "@crewon/agent-version";

import {
  loadAgentVersionDeployments,
  loadAgentVersionRuntimeFactory,
  loadRemoteMcpManifestBindings,
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

test("production requires every configured Provider response to be retrievable", (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  const manifest = config(version.contentDigest, null);
  writeFileSync(path, JSON.stringify(manifest), "utf8");

  assert.throws(
    () => loadAgentVersionDeployments(path, "production"),
    hasMessage("production_response_retrieval_required"),
  );
  assert.throws(
    () => loadAgentVersionRuntimeFactory(path, {}, undefined, "production"),
    hasMessage("production_response_retrieval_required"),
  );
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      bindings: [
        {
          ...manifest.bindings[0],
          provider: {
            ...manifest.bindings[0]!.provider,
            storeResponses: true,
          },
        },
      ],
    }),
    "utf8",
  );
  assert.doesNotThrow(() => loadAgentVersionDeployments(path, "production"));
  assert.doesNotThrow(() =>
    loadAgentVersionRuntimeFactory(path, {}, undefined, "production"),
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

test("canonically digests every remote endpoint, descriptor, and policy field", (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  const remotePath = `${path}.remote.json`;
  const manifest = config(version.contentDigest, null);
  const remote = remoteConfig();
  writeFileSync(remotePath, JSON.stringify(remote), "utf8");
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      bindings: [{ ...manifest.bindings[0], remoteMcpConfigPath: remotePath }],
    }),
    "utf8",
  );
  const original = loadAgentVersionDeployments(path)[0]!.materializationDigest;

  const reordered = {
    servers: remote.servers.map((server) => ({
      tools: server.tools.map((tool) => ({
        policy: tool.policy,
        descriptor: tool.descriptor,
      })),
      credentialBindingId: server.credentialBindingId,
      endpoint: server.endpoint,
      mode: server.mode,
      serverBindingId: server.serverBindingId,
      serverId: server.serverId,
    })),
    schemaVersion: remote.schemaVersion,
  };
  writeFileSync(remotePath, JSON.stringify(reordered), "utf8");
  assert.equal(
    loadAgentVersionDeployments(path)[0]!.materializationDigest,
    original,
  );

  const mutations = [
    { endpoint: "https://mcp.example:9443/mcp" },
    { toolName: "update_record" },
    { timeoutMs: 30_001 },
  ];
  for (const mutation of mutations) {
    const changed = structuredClone(remote);
    if (mutation.endpoint !== undefined)
      changed.servers[0]!.endpoint = mutation.endpoint;
    if (mutation.toolName !== undefined)
      changed.servers[0]!.tools[0]!.descriptor.name = mutation.toolName;
    if (mutation.timeoutMs !== undefined)
      changed.servers[0]!.tools[0]!.policy.limits.timeoutMs =
        mutation.timeoutMs;
    writeFileSync(remotePath, JSON.stringify(changed), "utf8");
    assert.notEqual(
      loadAgentVersionDeployments(path)[0]!.materializationDigest,
      original,
    );
  }
});

test("detects remote config drift and fails closed while composition is absent", async (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  const remotePath = `${path}.remote.json`;
  const manifest = config(version.contentDigest, null);
  const remote = remoteConfig();
  writeFileSync(remotePath, JSON.stringify(remote), "utf8");
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      bindings: [{ ...manifest.bindings[0], remoteMcpConfigPath: remotePath }],
    }),
    "utf8",
  );
  let composeAttempts = 0;
  const driftFactory = loadAgentVersionRuntimeFactory(
    path,
    {},
    {
      mode: "production",
      credentialLeaseFactory: () => {
        composeAttempts += 1;
        throw new Error("unexpected_compose");
      },
      tenantEgressFactory: () => {
        throw new Error("unexpected_compose");
      },
    },
  );
  const changed = structuredClone(remote);
  changed.servers[0]!.endpoint = "https://mcp.example:9443/mcp";
  writeFileSync(remotePath, JSON.stringify(changed), "utf8");
  await assert.rejects(
    driftFactory.create({ tenantId: "tenant-1", version }),
    hasMessage("agent_version_runtime_materialization_drift"),
  );
  assert.equal(composeAttempts, 0);

  writeFileSync(remotePath, JSON.stringify(remote), "utf8");
  const factory = loadAgentVersionRuntimeFactory(path, {});
  await assert.rejects(
    factory.create({ tenantId: "tenant-1", version }),
    hasMessage("remote_mcp_runtime_not_composed"),
  );
});

test("createBoundToolRuntime composes remote MCP only with explicit exact dependencies", async (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  const remotePath = `${path}.remote.json`;
  const manifest = config(version.contentDigest, null);
  const productionRemote = remoteConfig();
  const remote = {
    ...productionRemote,
    servers: productionRemote.servers.map((server) => ({
      ...server,
      mode: "standaloneLoopback" as const,
      endpoint: "http://127.0.0.1:1234/mutations",
    })),
  };
  writeFileSync(remotePath, JSON.stringify(remote), "utf8");
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      bindings: [{ ...manifest.bindings[0], remoteMcpConfigPath: remotePath }],
    }),
    "utf8",
  );
  const identities: unknown[] = [];
  const factory = loadAgentVersionRuntimeFactory(
    path,
    {},
    {
      mode: "standaloneLoopback",
      staticBearerResolver: (identity) => {
        identities.push(identity);
        return "static-test-bearer";
      },
    },
  );
  const runtime = await factory.create({ tenantId: "tenant-1", version });
  context.after(() => runtime.close?.());

  assert.deepEqual(runtime.toolRuntime.definitions(), [
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "mcp__reviewed-mcp__create_record",
      description: "Creates one record.",
      execution: "serial",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ]);
  assert.deepEqual(identities, [
    {
      tenantId: "tenant-1",
      workspaceBindingId: null,
      agentVersionId: "agent-version-1",
      contentDigest: version.contentDigest,
      materializationDigest:
        factory.deploymentBindings("tenant-1")[0]!.materializationDigest,
      mode: "standaloneLoopback",
      serverBindingId: "remote-1",
      credentialBindingId: "credential-1",
      endpoint: "http://127.0.0.1:1234/mutations",
    },
  ]);
});

test("validates and composes one remote manifest snapshot per create", async (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  const remotePath = `${path}.remote.json`;
  const manifest = config(version.contentDigest, null);
  const checked = remoteConfig();
  checked.servers[0]!.mode = "standaloneLoopback" as never;
  checked.servers[0]!.endpoint = "http://127.0.0.1:1234/mutations";
  const unchecked = structuredClone(checked);
  unchecked.servers[0]!.tools[0]!.descriptor.name = "unchecked_tool";
  writeFileSync(remotePath, JSON.stringify(checked), "utf8");
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      bindings: [{ ...manifest.bindings[0], remoteMcpConfigPath: remotePath }],
    }),
    "utf8",
  );
  const factory = loadAgentVersionRuntimeFactory(
    path,
    {},
    {
      mode: "standaloneLoopback",
      staticBearerResolver: () => "static-test-bearer",
    },
  );

  const mutableFs = createRequire(import.meta.url)("node:fs") as {
    readFileSync: typeof import("node:fs").readFileSync;
  };
  const originalReadFileSync = mutableFs.readFileSync;
  let remoteReads = 0;
  mutableFs.readFileSync = ((candidate: unknown, ...args: unknown[]) => {
    if (candidate === remotePath) {
      remoteReads += 1;
      return JSON.stringify(remoteReads === 1 ? checked : unchecked);
    }
    return Reflect.apply(originalReadFileSync, mutableFs, [candidate, ...args]);
  }) as typeof import("node:fs").readFileSync;
  syncBuiltinESMExports();
  try {
    const runtime = await factory.create({ tenantId: "tenant-1", version });
    context.after(() => runtime.close?.());
    assert.equal(remoteReads, 1);
    assert.deepEqual(
      runtime.toolRuntime.definitions().map(({ name }) => name),
      ["mcp__reviewed-mcp__create_record"],
    );
  } finally {
    mutableFs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
});

test("extracts remote identities from exactly one manifest snapshot", (context) => {
  const version = compileAgentVersion(source(), { sha256 });
  const path = temporaryFile(context);
  const remotePath = `${path}.remote.json`;
  const manifest = config(version.contentDigest, null);
  writeFileSync(remotePath, JSON.stringify(remoteConfig()), "utf8");
  writeFileSync(
    path,
    JSON.stringify({
      ...manifest,
      bindings: [{ ...manifest.bindings[0], remoteMcpConfigPath: remotePath }],
    }),
    "utf8",
  );
  const mutableFs = createRequire(import.meta.url)("node:fs") as {
    readFileSync: typeof import("node:fs").readFileSync;
  };
  const originalReadFileSync = mutableFs.readFileSync;
  let remoteReads = 0;
  mutableFs.readFileSync = ((candidate: unknown, ...args: unknown[]) => {
    if (candidate === remotePath) remoteReads += 1;
    return Reflect.apply(originalReadFileSync, mutableFs, [candidate, ...args]);
  }) as typeof import("node:fs").readFileSync;
  syncBuiltinESMExports();
  try {
    assert.equal(loadRemoteMcpManifestBindings(path).length, 1);
    assert.equal(remoteReads, 1);
  } finally {
    mutableFs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
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
          idleTimeoutMs: 60_000,
          sequencePolicy: "required" as const,
        },
        mcpStdioConfigPath: null,
        remoteMcpConfigPath: null,
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

function remoteConfig() {
  return {
    schemaVersion: "crewon.remote-mcp-runtime.v0" as const,
    servers: [
      {
        serverId: "reviewed-mcp",
        serverBindingId: "remote-1",
        mode: "production" as const,
        endpoint: "https://mcp.example:8443/mcp",
        credentialBindingId: "credential-1",
        tools: [
          {
            descriptor: {
              name: "create_record",
              description: "Creates one record.",
              inputSchema: { type: "object", additionalProperties: false },
            },
            policy: {
              effect: "mutation" as const,
              recovery: "reconcilable" as const,
              resourceBindingId: null,
              credentialBindingId: "credential-1",
              executionTarget: {
                kind: "remote" as const,
                bindingId: "remote-1",
              },
              capability: "records.create",
              approvalRequirement: "perAction" as const,
              limits: {
                timeoutMs: 30_000,
                maxOutputBytes: 64_000,
                maxArtifactBytes: 1_000_000,
              },
            },
          },
        ],
      },
    ],
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
