import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
  type AgentVersionSource,
} from "@crewon/agent-version";
import { createExtensionConfiguration } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import {
  agentVersionDeploymentCandidates,
  type RuntimeBindingConfig,
} from "./runtime-binding-config.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { RuntimeReleaseAuthorization } from "./release-authority.ts";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import {
  EXTENSION_AGENT_VERSION_ASSETS_SCHEMA,
  loadExtensionReleaseInput,
  mergeExtensionReleaseInput,
} from "./extensions/extension-release-input.ts";

const timestamp = "2026-10-01T00:00:00.000Z";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "crewon-extension-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: "base-agent",
      runtimeGeneration: "ts-v0",
      policySnapshotId: "base-policy",
      instructions: "Base instructions.",
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "explicit-model",
        contextWindowTokens: 4_096,
        autoCompactAtTokens: 3_072,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 8 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  const makeVersion = (agentVersionId = "plugin-agent") =>
    compileComfyAgentVersion({
      base: { executionAuthority: "crewonKernel", version: base },
      agentVersionId,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "plugin-policy",
      digester,
    });
  const version = makeVersion();
  const asset = createAgentVersionAsset({
    tenantId: "tenant-1",
    version,
    createdAt: timestamp,
  });
  const registration = bundledComfyRegistration();
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
  const snapshotPath = join(dir, "plugin-configuration.json");
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      schemaVersion: "crewon.extension-runtime-config.v0",
      configuration,
      approvalRequirement: "perAction",
    }),
  );
  const binding: RuntimeBindingConfig["bindings"][number] = {
    tenantId: "tenant-1",
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: "plugin-authority",
    workspaceBindingId: null,
    provider: {
      kind: "directResponses",
      endpoint: "https://provider.example/v1/responses",
      apiKeyEnvironment: null,
      storeResponses: false,
      requestProfile: "standard",
      sequencePolicy: "required",
      idleTimeoutMs: 60_000,
    },
    mcpStdioConfigPath: null,
    deviceToolConfigPath: null,
    remoteMcpConfigPath: null,
    extensionConfigPath: snapshotPath,
  };
  const bindingsPath = join(dir, "plugin-bindings.json");
  const assetsPath = join(dir, "plugin-assets.json");
  const writeBindings = (bindings = [binding]) =>
    writeFileSync(
      bindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings,
      }),
    );
  const writeAssets = (assets: unknown = [asset], extra = {}) =>
    writeFileSync(
      assetsPath,
      JSON.stringify({
        schemaVersion: EXTENSION_AGENT_VERSION_ASSETS_SCHEMA,
        assets,
        ...extra,
      }),
    );
  writeBindings();
  writeAssets();
  const environment = {
    CREWON_EXTENSIONS_ENABLED: "1",
    CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: bindingsPath,
    CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: assetsPath,
    CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: join(dir, "base-bindings.json"),
  };
  const input = {
    environment,
    tenantId: "tenant-1",
    defaultAgentVersionId: "default-agent-v1",
  };
  return {
    dir,
    base,
    makeVersion,
    version,
    asset,
    binding,
    assetsPath,
    bindingsPath,
    snapshotPath,
    writeAssets,
    writeBindings,
    input,
    load: () => loadExtensionReleaseInput(input)!,
  };
}

test("disabled extension release input retains prior behavior without reading files or security mode", () => {
  for (const environment of [
    {},
    { CREWON_CONTROL_SECURITY_MODE: "production" },
  ])
    assert.equal(
      loadExtensionReleaseInput({
        environment,
        tenantId: "tenant-1",
        defaultAgentVersionId: "default-agent-v1",
      }),
      null,
    );
});

test("disabled paired operator paths remain dormant without opening files and flags stay strict", () => {
  for (const enabled of [undefined, "0"])
    assert.equal(
      loadExtensionReleaseInput({
        environment: {
          CREWON_EXTENSIONS_ENABLED: enabled,
          CREWON_EXTENSION_RUNTIME_BINDINGS_PATH:
            "/missing/plugin-bindings.json",
          CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH:
            "/missing/plugin-assets.json",
        },
        tenantId: "tenant-1",
        defaultAgentVersionId: "default-agent-v1",
      }),
      null,
    );
  for (const enabled of ["", "true", " 1", "2"])
    assert.throws(
      () =>
        loadExtensionReleaseInput({
          environment: { CREWON_EXTENSIONS_ENABLED: enabled },
          tenantId: "tenant-1",
          defaultAgentVersionId: "default-agent-v1",
        }),
      /CREWON_EXTENSION_CONFIGURATION_invalid/u,
    );
  assert.throws(
    () =>
      loadExtensionReleaseInput({
        environment: {
          CREWON_EXTENSIONS_ENABLED: "0",
          CREWON_EXTENSION_RUNTIME_BINDINGS_PATH:
            " /missing/plugin-bindings.json",
          CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH:
            "/missing/plugin-assets.json",
        },
        tenantId: "tenant-1",
        defaultAgentVersionId: "default-agent-v1",
      }),
    /CREWON_EXTENSION_RUNTIME_BINDINGS_PATH_invalid/u,
  );
});

test("requires the two operator files together and rejects non-standalone opt-in", (t) => {
  const f = fixture(t);
  for (const environment of [
    { CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: f.bindingsPath },
    { CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: f.assetsPath },
  ])
    assert.throws(
      () => loadExtensionReleaseInput({ ...f.input, environment }),
      /extension_release_configuration_incomplete/u,
    );
  assert.throws(
    () =>
      loadExtensionReleaseInput({
        ...f.input,
        environment: {
          ...f.input.environment,
          CREWON_CONTROL_SECURITY_MODE: "production",
        },
      }),
    /extension_release_security_mode_forbidden/u,
  );
});

test("loads actual compiled assets and bundled code into immutable supplemental release input", (t) => {
  const f = fixture(t);
  const loaded = f.load();
  assert.deepEqual(loaded.assets, [f.asset]);
  assert.deepEqual(loaded.versions, [f.version]);
  assert.deepEqual(loaded.runtimeBindings.bindings, [f.binding]);
  assert.deepEqual(
    loaded.deployments,
    agentVersionDeploymentCandidates(loaded.runtimeBindings),
  );
  for (const value of [
    loaded,
    loaded.assets,
    loaded.assets[0]!,
    loaded.versions,
    loaded.runtimeBindings,
    loaded.runtimeBindings.bindings[0]!.provider,
    loaded.deployments,
  ])
    assert.ok(Object.isFrozen(value));
  f.writeBindings([{ ...f.binding, authorityId: "later-authority" }]);
  f.writeAssets([]);
  assert.equal(
    loaded.runtimeBindings.bindings[0]!.authorityId,
    "plugin-authority",
  );
  assert.deepEqual(loaded.assets, [f.asset]);
});

test("rejects unknown manifest versions, injected fields, excessive assets and invalid UTF-8", (t) => {
  const f = fixture(t);
  for (const [assets, extra, code] of [
    [
      [f.asset],
      { schemaVersion: "crewon.extension-agent-version-assets.v99" },
      "version_unsupported",
    ],
    [[f.asset], { unexpected: true }, "assets_invalid"],
    [[], {}, "assets_invalid"],
    [Array.from({ length: 33 }, () => f.asset), {}, "assets_invalid"],
  ] as const) {
    f.writeAssets(assets, extra);
    assert.throws(f.load, new RegExp(code, "u"));
  }
  writeFileSync(f.assetsPath, Buffer.from([0xff, 0xff]));
  assert.throws(f.load, /CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH_invalid/u);
});

test("rejects unsafe paths and bounded file growth without reading an unbounded buffer", (t) => {
  const f = fixture(t);
  for (const path of ["", `${f.assetsPath}\n`, "x".repeat(4_097), f.dir])
    assert.throws(
      () =>
        loadExtensionReleaseInput({
          ...f.input,
          environment: {
            ...f.input.environment,
            CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: path,
          },
        }),
      /CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH_invalid/u,
    );
  truncateSync(f.bindingsPath, 1024 * 1024 + 1);
  assert.throws(f.load, /CREWON_EXTENSION_RUNTIME_BINDINGS_PATH_invalid/u);
});

test("compiled asset digest, tenant, default identity and unknown asset fields fail closed", (t) => {
  const f = fixture(t);
  const defaultVersion = f.makeVersion(f.input.defaultAgentVersionId);
  for (const asset of [
    {
      ...f.asset,
      definitionJson: JSON.stringify({
        ...f.version,
        instructions: "tampered",
      }),
    },
    createAgentVersionAsset({
      tenantId: "other-tenant",
      version: f.version,
      createdAt: timestamp,
    }),
    createAgentVersionAsset({
      tenantId: "tenant-1",
      version: defaultVersion,
      createdAt: timestamp,
    }),
    { ...f.asset, executionAuthority: "crewonKernel" },
  ]) {
    f.writeAssets([asset]);
    assert.throws(f.load);
  }
});

test("requires a one-to-one asset and plugin binding set without duplicate IDs", (t) => {
  const f = fixture(t);
  f.writeAssets([f.asset, f.asset]);
  assert.throws(f.load, /runtime_release_duplicate_agent_version/u);
  f.writeAssets();
  f.writeBindings([f.binding, f.binding]);
  assert.throws(f.load, /runtime_release_duplicate_agent_version/u);
  f.writeBindings();
  const another = createAgentVersionAsset({
    tenantId: "tenant-1",
    version: f.makeVersion("another-plugin-version"),
    createdAt: timestamp,
  });
  f.writeAssets([another]);
  assert.throws(f.load, /runtime_release_version_deployment_mismatch/u);
});

test("supplemental bindings reject provider authority, shared mode, ordinary bindings, foreign tenants and defaults", (t) => {
  const f = fixture(t);
  const { extensionConfigPath: _, ...ordinary } = f.binding;
  for (const binding of [
    {
      ...f.binding,
      provider: {
        kind: "cloudAgent",
        invocationUrl: "https://agent.example/invoke",
        modelId: "provider-model",
        agentId: 42,
        apiKeyEnvironment: null,
        storeResponses: false,
        requestProfile: "standard",
        sequencePolicy: "required",
        idleTimeoutMs: 60_000,
      },
    },
    { ...f.binding, toolRuntimeMode: "shared" },
    ordinary,
    { ...f.binding, tenantId: "other-tenant" },
    { ...f.binding, agentVersionId: f.input.defaultAgentVersionId },
  ]) {
    writeFileSync(
      f.bindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [binding],
      }),
    );
    assert.throws(f.load);
  }
  f.writeBindings(
    Array.from({ length: 33 }, (_, index) => ({
      ...f.binding,
      agentVersionId: `plugin-version-${index}`,
    })),
  );
  assert.throws(f.load, /extension_runtime_bindings_invalid/u);
});

test("validly compiled assets still require exact bundled instructions and tool definitions", (t) => {
  const f = fixture(t);
  const { schemaVersion: _, contentDigest: __, ...body } = f.version;
  const patches: Partial<AgentVersionSource>[] = [
    { instructions: null },
    { instructions: "Base instructions." },
    { tools: [] },
    {
      tools: f.version.tools.map((tool, index) =>
        index === 0 ? { ...tool, description: "Changed behavior." } : tool,
      ),
    },
  ];
  for (const patch of patches) {
    const version = compileAgentVersion(
      { ...body, ...patch, schemaVersion: "crewon.agent-version-source.v0" },
      digester,
    );
    f.writeAssets([
      createAgentVersionAsset({
        tenantId: "tenant-1",
        version,
        createdAt: timestamp,
      }),
    ]);
    f.writeBindings([{ ...f.binding, contentDigest: version.contentDigest }]);
    assert.throws(f.load, /extension_agent_version_mismatch/u);
  }
});

test("generated base bindings cannot alias plugin bindings, assets or configuration files", (t) => {
  const f = fixture(t);
  const symbolic = join(f.dir, "base-symbolic.json");
  const hard = join(f.dir, "base-hard.json");
  symlinkSync(f.bindingsPath, symbolic);
  linkSync(f.bindingsPath, hard);
  const original = readFileSync(f.bindingsPath);
  for (const basePath of [
    f.bindingsPath,
    f.assetsPath,
    f.snapshotPath,
    symbolic,
    hard,
  ])
    assert.throws(
      () =>
        loadExtensionReleaseInput({
          ...f.input,
          environment: {
            ...f.input.environment,
            CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: basePath,
          },
        }),
      /extension_runtime_bindings_path_conflict/u,
    );
  assert.deepEqual(readFileSync(f.bindingsPath), original);
});

test("release merge is additive and rejects duplicate, default and foreign-tenant inputs", (t) => {
  const f = fixture(t);
  const extension = f.load();
  const { extensionConfigPath: _, ...ordinary } = f.binding;
  const existingDeployment = agentVersionDeploymentCandidates({
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
    bindings: [
      {
        ...ordinary,
        agentVersionId: f.base.agentVersionId,
        contentDigest: f.base.contentDigest,
      },
    ],
  })[0]!;
  const merged = mergeExtensionReleaseInput({
    extension,
    existingVersions: [f.base],
    existingDeployments: [existingDeployment],
    tenantId: "tenant-1",
    defaultAgentVersionId: f.input.defaultAgentVersionId,
  });
  assert.deepEqual(merged.additionalAgentVersions, [f.base, f.version]);
  assert.deepEqual(merged.agentVersionDeployments, [
    existingDeployment,
    extension.deployments[0],
  ]);
  for (const patch of [
    { existingVersions: [f.version] },
    { existingDeployments: extension.deployments },
    {
      existingDeployments: [
        { ...existingDeployment, tenantId: "other-tenant" },
      ],
    },
    { existingVersions: [f.makeVersion(f.input.defaultAgentVersionId)] },
  ])
    assert.throws(() =>
      mergeExtensionReleaseInput({
        extension,
        existingVersions: [],
        existingDeployments: [],
        tenantId: "tenant-1",
        defaultAgentVersionId: f.input.defaultAgentVersionId,
        ...patch,
      }),
    );
});

test("checked plugin assets publish through the existing authorized release service without changing default selection", async (t) => {
  const f = fixture(t);
  const extension = f.load();
  const actor = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "actor-1",
    principalId: "principal-1",
  };
  const activated = await activateStandaloneRuntimeAgentVersionRelease({
    actor,
    authorization: new RuntimeReleaseAuthorization(actor),
    clock: { now: () => timestamp },
    activationId: "release-activation",
    runtimeTenantId: actor.tenantId,
    route: {
      agentVersionId: f.input.defaultAgentVersionId,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "default-policy",
      authorityId: "default-authority",
      workspaceBindingId: null,
    },
    transport: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "default-model",
      async *stream(): AsyncGenerator<never> {
        throw new Error("model must not run during release");
      },
    },
    databasePath: join(f.dir, "control.sqlite"),
    additionalAgentVersions: extension.versions,
    agentVersionDeployments: extension.deployments,
  });
  assert.equal(
    activated.plan.bundle.defaultAgentVersionId,
    f.input.defaultAgentVersionId,
  );
  assert.equal(activated.plan.bootstrapVersion.model.modelId, "default-model");
  const store = new SqliteRunStore(join(f.dir, "control.sqlite"));
  try {
    assert.deepEqual(
      await store.loadAgentVersion({
        tenantId: actor.tenantId,
        agentVersionId: f.version.agentVersionId,
      }),
      f.asset,
    );
  } finally {
    await store.close();
  }
});
