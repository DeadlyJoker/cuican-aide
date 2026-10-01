import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  compileAgentVersion,
  type AgentVersionSource,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { CurrentExtensionExecutionAuthorization } from "@crewon/application";
import {
  createExtensionConfiguration,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import type { AgentVersionRuntime } from "./agent-version-runtime.ts";
import {
  loadAgentVersionDeployments,
  loadAgentVersionRuntimeFactory,
  parseRuntimeBindingConfig,
  type RuntimeBindingConfig,
} from "./runtime-binding-config.ts";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import { comfyManifest } from "./extensions/comfyui-manifest.ts";
import {
  COMFY_OBSERVE_TOOL,
  COMFY_SUBMIT_TOOL,
  comfyToolDefinitions,
} from "./extensions/comfyui-tool-catalog.ts";
import type { RuntimeExtensionDependencies } from "./extensions/extension-runtime-config.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const timestamp = "2026-10-01T00:00:00.000Z";
const directProvider = {
  kind: "directResponses" as const,
  endpoint: "https://provider.example/v1/responses",
  apiKeyEnvironment: null,
  storeResponses: false,
  requestProfile: "standard" as const,
  idleTimeoutMs: 60_000,
  sequencePolicy: "required" as const,
};

function baseVersion(): CompiledAgentVersion {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "base-agent-version",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "base-policy",
      instructions: "Base instructions.",
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "fixture-model",
        contextWindowTokens: 4_096,
        maxOutputTokens: 512,
        autoCompactAtTokens: 3_072,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 8 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "crewon-extension-runtime-"));
  const parent = new SqliteRunStore(join(dir, "control.sqlite"));
  const runtimes: AgentVersionRuntime[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close?.();
    await parent.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const extensions = parent.extensionStore();
  await extensions.migrate();
  const bundled = bundledComfyRegistration();
  const registration = {
    manifest: bundled.manifest,
    manifestDigest: bundled.manifestDigest,
    implementationDigest: bundled.implementationDigest,
  };
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: "tenant-1",
      spaceId: "space-1",
      pluginId: registration.manifest.pluginId,
      pluginVersion: registration.manifest.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: "actor-1",
      createdAt: timestamp,
    },
    digester,
  );
  await extensions.saveExtensionConfiguration({
    configuration,
    expectedRevision: 0,
    receipt: {
      actorId: "actor-1",
      idempotencyKey: "configuration-1",
      requestDigest: digester.sha256("configuration-1"),
    },
  });
  const version = compileComfyAgentVersion({
    base: { executionAuthority: "crewonKernel", version: baseVersion() },
    agentVersionId: "plugin-agent-version",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "plugin-policy",
    digester,
  });
  let networkCalls = 0;
  const dependencies: RuntimeExtensionDependencies = {
    extensions,
    operations: parent.externalOperationStore(),
    runs: parent,
    access: new CurrentExtensionExecutionAuthorization({
      resolveActor: async (owner) => ({
        ...owner,
        principalId: "fixture-principal",
      }),
      authorization: { authorize: async () => ({ outcome: "allow" }) },
    }),
    dns: {
      resolveAll: async () => {
        networkCalls += 1;
        throw new Error("unexpected_dns_request");
      },
    },
    transport: {
      request: async () => {
        networkCalls += 1;
        throw new Error("unexpected_http_request");
      },
    },
  };
  const path = join(dir, "bindings.json");
  const extensionPath = join(dir, "extension.json");
  const binding: RuntimeBindingConfig["bindings"][number] = {
    tenantId: configuration.tenantId,
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: "authority-1",
    workspaceBindingId: null,
    provider: directProvider,
    mcpStdioConfigPath: null,
    deviceToolConfigPath: null,
    remoteMcpConfigPath: null,
    extensionConfigPath: extensionPath,
  };
  const writeBinding = (
    patch: Partial<RuntimeBindingConfig["bindings"][number]> = {},
  ) => {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [{ ...binding, ...patch }],
      }),
    );
  };
  const writeExtension = (
    input: ExtensionConfiguration = configuration,
    approvalRequirement: "none" | "perAction" = "perAction",
  ) => {
    writeFileSync(
      extensionPath,
      JSON.stringify({
        schemaVersion: "crewon.extension-runtime-config.v0",
        configuration: input,
        approvalRequirement,
      }),
    );
  };
  writeBinding();
  writeExtension();
  return {
    parent,
    registration,
    configuration,
    version,
    binding,
    dependencies,
    path,
    writeBinding,
    writeExtension,
    networkCalls: () => networkCalls,
    retain: (runtime: AgentVersionRuntime) => {
      runtimes.push(runtime);
      return runtime;
    },
    load: () =>
      loadAgentVersionRuntimeFactory(
        path,
        {},
        undefined,
        undefined,
        dependencies,
      ),
  };
}

test("materializes actual bundled Comfy tools with immutable configuration and exact runtime proof", async (t) => {
  const f = await fixture(t);
  const factory = f.load();
  const deployment = factory.deploymentBindings("tenant-1")[0]!;
  assert.deepEqual(loadAgentVersionDeployments(f.path), [deployment]);
  const runtime = f.retain(
    await factory.create({ tenantId: "tenant-1", version: f.version }),
  );
  assert.equal(runtime.executionAuthority, "crewonKernel");
  assert.deepEqual(runtime.toolRuntime.definitions(), comfyToolDefinitions());
  assert.deepEqual(runtime.toolRuntime.definitions(), f.version.tools);
  assert.deepEqual(runtime.kernel.modelIdentity, {
    adapterName: f.version.model.adapterName,
    adapterVersion: f.version.model.adapterVersion,
    modelId: f.version.model.modelId,
  });
  assert.equal(runtime.extensions?.length, 1);
  const proof = runtime.extensions![0]!;
  assert.deepEqual(proof.configuration, f.configuration);
  assert.deepEqual(proof.registration, f.registration);
  assert.deepEqual(proof.registration.manifest, comfyManifest());
  assert.deepEqual(proof.target, {
    executionAuthority: "crewonKernel",
    agentVersionId: f.version.agentVersionId,
    agentVersionContentDigest: f.version.contentDigest,
    materializationDigest: deployment.materializationDigest,
    authorityId: deployment.authorityId,
    runtimeGeneration: f.version.runtimeGeneration,
    policySnapshotId: f.version.policySnapshotId,
    workspaceBindingId: null,
  });
  assert.equal(proof.approvalRequirement, "perAction");
  assert.equal(
    runtime.toolRuntime.executionPolicy("function", COMFY_SUBMIT_TOOL)
      ?.approvalRequirement,
    "perAction",
  );
  assert.equal(
    runtime.toolRuntime.executionPolicy("function", COMFY_OBSERVE_TOOL)
      ?.approvalRequirement,
    "none",
  );
  assert.ok(Object.isFrozen(proof));
  assert.ok(Object.isFrozen(proof.target));
  assert.deepEqual(
    await f.dependencies.extensions.loadExtensionConfiguration({
      ...f.configuration,
      revision: 1,
    }),
    proof.configuration,
  );
  assert.equal(f.networkCalls(), 0);
});

test("extension-enabled runtime manifest fails startup without host dependencies", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => loadAgentVersionRuntimeFactory(f.path, {}),
    /extension_runtime_not_composed/u,
  );
});

test("shared tool runtimes and provider-owned Agents cannot receive host extensions", async (t) => {
  const f = await fixture(t);
  f.writeBinding({ toolRuntimeMode: "shared" });
  assert.throws(f.load, /agent_version_runtime_binding_invalid/u);
  f.writeBinding({
    provider: {
      kind: "cloudAgent",
      invocationUrl: "https://agents.example/invoke",
      modelId: "cloud-model",
      agentId: 42,
      apiKeyEnvironment: null,
      storeResponses: false,
      requestProfile: "standard",
      idleTimeoutMs: 60_000,
      sequencePolicy: "required",
    },
  });
  assert.throws(f.load, /agent_version_runtime_provider_authority_invalid/u);
  assert.equal(f.networkCalls(), 0);
});

test("materialization rejects absent or altered Comfy tools and missing task instructions", async (t) => {
  const f = await fixture(t);
  const { schemaVersion: _, contentDigest: __, ...body } = f.version;
  const changes: Partial<AgentVersionSource>[] = [
    { tools: [] },
    { tools: f.version.tools.slice(1) },
    {
      tools: f.version.tools.map((tool, index) =>
        index === 0 ? { ...tool, description: "Changed tool meaning." } : tool,
      ),
    },
    { instructions: null },
    { instructions: "Base instructions." },
  ];
  for (const change of changes) {
    const version = compileAgentVersion(
      { schemaVersion: "crewon.agent-version-source.v0", ...body, ...change },
      digester,
    );
    f.writeBinding({ contentDigest: version.contentDigest });
    await assert.rejects(
      f.load().create({ tenantId: "tenant-1", version }),
      /extension_agent_version_mismatch/u,
    );
  }
  assert.equal(f.networkCalls(), 0);
});

test("configuration revision changes after factory load fail the pinned materialization", async (t) => {
  const f = await fixture(t);
  const factory = f.load();
  const before = factory.deploymentBindings("tenant-1")[0]!;
  const { contentDigest: _, ...body } = f.configuration;
  const changed = createExtensionConfiguration(
    {
      ...body,
      revision: 2,
      parameters: { baseUrl: "https://changed-comfy.example/" },
    },
    digester,
  );
  await f.dependencies.extensions.saveExtensionConfiguration({
    configuration: changed,
    expectedRevision: 1,
    receipt: {
      actorId: "actor-1",
      idempotencyKey: "configuration-2",
      requestDigest: digester.sha256("configuration-2"),
    },
  });
  f.writeExtension(changed);
  await assert.rejects(
    factory.create({ tenantId: "tenant-1", version: f.version }),
    /agent_version_runtime_materialization_drift/u,
  );
  assert.notEqual(
    f.load().deploymentBindings("tenant-1")[0]!.materializationDigest,
    before.materializationDigest,
  );
  assert.equal(f.networkCalls(), 0);
});

test("approval requirement changes after factory load fail the pinned materialization", async (t) => {
  const f = await fixture(t);
  const factory = f.load();
  const before = factory.deploymentBindings("tenant-1")[0]!;
  f.writeExtension(f.configuration, "none");
  await assert.rejects(
    factory.create({ tenantId: "tenant-1", version: f.version }),
    /agent_version_runtime_materialization_drift/u,
  );
  assert.notEqual(
    f.load().deploymentBindings("tenant-1")[0]!.materializationDigest,
    before.materializationDigest,
  );
  assert.equal(f.networkCalls(), 0);
});

test("legacy binding shape retains the pre-extension materialization digest", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "crewon-legacy-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = {
    schemaVersion: "crewon.agent-version-runtime-bindings.v0" as const,
    bindings: [
      {
        tenantId: "tenant-1",
        agentVersionId: "legacy-agent-version",
        contentDigest: `sha256:${"a".repeat(64)}`,
        authorityId: "authority-1",
        workspaceBindingId: null,
        provider: directProvider,
        mcpStdioConfigPath: null,
        deviceToolConfigPath: null,
        remoteMcpConfigPath: null,
      },
    ],
  };
  const parsed = parseRuntimeBindingConfig(legacy);
  assert.deepEqual(parsed, legacy);
  assert.equal(
    Object.hasOwn(parsed.bindings[0]!, "extensionConfigPath"),
    false,
  );
  const path = join(dir, "bindings.json");
  writeFileSync(path, JSON.stringify(legacy));
  // Fixed digest from the materialization envelope before plugin fields existed.
  const expected =
    "sha256:ee56577ddb9da63ea3838a1c391a9761c5c8d7db9dcb0a75b30f5797b307f321";
  assert.equal(
    loadAgentVersionDeployments(path)[0]!.materializationDigest,
    expected,
  );
  assert.equal(
    loadAgentVersionRuntimeFactory(path, {}).deploymentBindings("tenant-1")[0]!
      .materializationDigest,
    expected,
  );
});
