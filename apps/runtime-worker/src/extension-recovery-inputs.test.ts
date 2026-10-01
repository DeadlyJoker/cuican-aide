import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import { extensionRecoveryDirectory } from "@crewon/agent-version/extension-recovery";
import { createExtensionConfiguration } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { RuntimeReleaseAuthorization } from "./release-authority.ts";
import type { RuntimeBindingConfig } from "./runtime-binding-config.ts";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import {
  inspectExtensionRecoveryInputs,
  prepareExtensionRecoveryInputs,
} from "./extensions/extension-recovery-inputs.ts";
import {
  loadExtensionReleaseInput,
  type ExtensionReleaseInput,
} from "./extensions/extension-release-input.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const owner = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "actor",
  principalId: "principal",
};
const timestamp = "2026-10-02T00:00:00.000Z";
const endpoint = "https://provider.example/v1/responses";
async function fixture(t: TestContext) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-recovery-inputs-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot);
  const databasePath = join(root, "control.sqlite");
  const store = new SqliteRunStore(databasePath);
  t.after(() => store.close());
  const bootstrap = {
    runtimeTenantId: owner.tenantId,
    route: {
      agentVersionId: "default-agent",
      runtimeGeneration: "default-generation",
      policySnapshotId: "default-policy",
      authorityId: "default-authority",
      workspaceBindingId: null,
    },
    transport: {
      adapterName: "direct-responses",
      adapterVersion: "1",
      modelId: "model",
      async *stream(): AsyncGenerator<never> {
        throw new Error("fixture_model_must_not_run");
      },
    },
    agentInstructions: "Existing default instructions.",
    streamMaxRetries: 0,
    autoCompactAtTokens: 3072,
    modelContextWindowTokens: 4096,
  };
  const base = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: bootstrap.route.agentVersionId,
      runtimeGeneration: bootstrap.route.runtimeGeneration,
      policySnapshotId: bootstrap.route.policySnapshotId,
      instructions: bootstrap.agentInstructions,
      model: {
        adapterName: "direct-responses",
        adapterVersion: "1",
        modelId: "model",
        contextWindowTokens: 4096,
        autoCompactAtTokens: 3072,
      },
      execution: { streamMaxRetries: 0, maxToolRounds: 32 },
      resources: { workspaceRequired: false, governedContextDigest: null },
      tools: [],
    },
    digester,
  );
  const version = compileComfyAgentVersion({
    base: { executionAuthority: "crewonKernel", version: base },
    agentVersionId: "plugin-agent",
    runtimeGeneration: "plugin-generation",
    policySnapshotId: "plugin-policy",
    digester,
  });
  const registration = bundledComfyRegistration();
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: owner.tenantId,
      spaceId: owner.spaceId,
      pluginId: registration.manifest.pluginId,
      pluginVersion: registration.manifest.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: owner.actorId,
      createdAt: timestamp,
    },
    digester,
  );
  const snapshotPath = join(root, "operator-snapshot.json");
  writeFileSync(
    snapshotPath,
    `${JSON.stringify({ schemaVersion: "crewon.extension-runtime-config.v0", configuration, approvalRequirement: "perAction" }, null, 2)}\n`,
  );
  const binding: RuntimeBindingConfig["bindings"][number] = {
    tenantId: owner.tenantId,
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: "plugin-authority",
    workspaceBindingId: null,
    provider: {
      kind: "directResponses",
      endpoint,
      apiKeyEnvironment: null,
      requestProfile: "standard",
      storeResponses: false,
      idleTimeoutMs: 5000,
      sequencePolicy: "required",
    },
    mcpStdioConfigPath: null,
    deviceToolConfigPath: null,
    remoteMcpConfigPath: null,
    extensionConfigPath: snapshotPath,
  };
  const runtimeBindingsPath = join(root, "operator-bindings.json");
  const writeBindings = (bindings = [binding]) =>
    writeFileSync(
      runtimeBindingsPath,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings,
      }),
    );
  writeBindings();
  const agentVersionAssetsPath = join(root, "operator-assets.json");
  writeFileSync(
    agentVersionAssetsPath,
    `${JSON.stringify(
      {
        schemaVersion: "crewon.extension-agent-version-assets.v0",
        assets: [
          createAgentVersionAsset({
            tenantId: owner.tenantId,
            version,
            createdAt: timestamp,
          }),
        ],
      },
      null,
      2,
    )}\n`,
  );
  const writeVersion = (next = version) =>
    writeFileSync(
      agentVersionAssetsPath,
      JSON.stringify({
        schemaVersion: "crewon.extension-agent-version-assets.v0",
        assets: [
          createAgentVersionAsset({
            tenantId: owner.tenantId,
            version: next,
            createdAt: timestamp,
          }),
        ],
      }),
    );
  const load = () =>
    loadExtensionReleaseInput({
      environment: {
        CREWON_EXTENSIONS_ENABLED: "1",
        CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: runtimeBindingsPath,
        CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: agentVersionAssetsPath,
      },
      tenantId: owner.tenantId,
      defaultAgentVersionId: base.agentVersionId,
    })!;
  const inspect = (
    model = {
      endpoint,
      credentialEnvironment: null as "CREWON_MODEL_API_KEY" | null,
    },
  ) =>
    inspectExtensionRecoveryInputs({
      extension: load(),
      runtimeBindingsPath,
      agentVersionAssetsPath,
      owner,
      defaultAgentVersionId: base.agentVersionId,
      model,
    });
  const selection = {
    dataRoot,
    capsuleId: digester.sha256("trusted-build+bootstrap+source"),
  };
  const prepare = (inspection = inspect(), selected = selection) =>
    prepareExtensionRecoveryInputs({
      inspection,
      selection: selected,
      deployments: store,
    });
  const publish = (extension: ExtensionReleaseInput, activationId = "first") =>
    activateStandaloneRuntimeAgentVersionRelease({
      ...bootstrap,
      databasePath,
      actor: owner,
      authorization: new RuntimeReleaseAuthorization(owner),
      clock: { now: () => timestamp },
      activationId,
      additionalAgentVersions: extension.versions,
      agentVersionDeployments: extension.deployments,
    });
  return {
    root,
    dataRoot,
    databasePath,
    store,
    base,
    version,
    snapshotPath,
    binding,
    runtimeBindingsPath,
    agentVersionAssetsPath,
    selection,
    load,
    inspect,
    prepare,
    publish,
    writeBindings,
    writeVersion,
  };
}

test("first SQLite publication uses the final snapshot materialization, and a second start reuses the exact prepared inputs", async (t) => {
  const f = await fixture(t);
  const original = f.load();
  const operatorBytes = [
    f.snapshotPath,
    f.runtimeBindingsPath,
    f.agentVersionAssetsPath,
  ].map((path) => readFileSync(path));
  const inspected = f.inspect();
  assert.equal(inspected.eligibility.outcome, "eligible");
  const prepared = await f.prepare(inspected);
  assert.equal(prepared.outcome, "prepared");
  if (prepared.outcome !== "prepared") return;
  assert.equal(prepared.files.length, 3);
  assert.equal(
    prepared.extension.versions[0]!.contentDigest,
    original.versions[0]!.contentDigest,
  );
  assert.equal(
    readFileSync(prepared.agentVersionAssetsPath).equals(operatorBytes[2]!),
    true,
  );
  const snapshot =
    prepared.extension.runtimeBindings.bindings[0]!.extensionConfigPath!;
  assert.equal(
    snapshot,
    join(
      await extensionRecoveryDirectory({
        selection: f.selection,
        create: false,
      }),
      "snapshot-00.json",
    ),
  );
  assert.equal(readFileSync(snapshot).equals(operatorBytes[0]!), true);
  assert.notEqual(
    prepared.targets[0]!.materializationDigest,
    original.deployments[0]!.materializationDigest,
  );
  const published = await f.publish(prepared.extension);
  assert.equal(
    published.plan.bootstrapVersion.contentDigest,
    f.base.contentDigest,
  );
  const durable = await f.store.loadAgentVersionDeployment({
    tenantId: owner.tenantId,
    agentVersionId: f.version.agentVersionId,
  });
  assert.equal(
    durable?.materializationDigest,
    prepared.targets[0]!.materializationDigest,
  );
  assert.equal(durable?.authorityId, prepared.targets[0]!.authorityId);
  const reopened = new SqliteRunStore(f.databasePath);
  try {
    const second = await prepareExtensionRecoveryInputs({
      inspection: f.inspect(),
      selection: f.selection,
      deployments: reopened,
    });
    assert.deepEqual(second, prepared);
    assert.equal(
      existsSync(
        join(
          await extensionRecoveryDirectory({
            selection: f.selection,
            create: false,
          }),
          "manifest.json",
        ),
      ),
      false,
    );
  } finally {
    await reopened.close();
  }
  await f.publish(prepared.extension, "second");
  [f.snapshotPath, f.runtimeBindingsPath, f.agentVersionAssetsPath].forEach(
    (path, index) =>
      assert.ok(readFileSync(path).equals(operatorBytes[index]!)),
  );
});

test("an existing SQLite deployment without saved inputs stays on its original path and cannot be relocated", async (t) => {
  const f = await fixture(t);
  const original = f.load();
  await f.publish(original);
  const result = await f.prepare();
  assert.equal(result.outcome, "unsupported");
  assert.equal(result.runtimeBindingsPath, f.runtimeBindingsPath);
  assert.deepEqual(result.extension, original);
  assert.equal(existsSync(join(f.dataRoot, "extension-recoveries")), false);
  assert.equal(
    (
      await f.store.loadAgentVersionDeployment({
        tenantId: owner.tenantId,
        agentVersionId: f.version.agentVersionId,
      })
    )?.materializationDigest,
    original.deployments[0]!.materializationDigest,
  );
  await f.publish(result.extension, "compatible-current-restart");
});

test("current recovery ineligibility preserves the exact published SQLite target and saved inputs across reopen", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.outcome, "prepared");
  if (prepared.outcome !== "prepared") return;
  await f.publish(prepared.extension);
  const paths = [
    prepared.runtimeBindingsPath,
    prepared.agentVersionAssetsPath,
    prepared.extension.runtimeBindings.bindings[0]!.extensionConfigPath!,
  ];
  const saved = paths.map((path) => readFileSync(path));
  const reopened = new SqliteRunStore(f.databasePath);
  try {
    // This preparer grants no credential authority and never invokes a provider.
    for (const model of [
      { endpoint, credentialEnvironment: "CREWON_MODEL_API_KEY" as const },
      {
        endpoint: "https://other.example/v1/responses",
        credentialEnvironment: null,
      },
    ]) {
      const inspection = f.inspect(model);
      assert.equal(inspection.eligibility.outcome, "unsupported");
      const reused = await prepareExtensionRecoveryInputs({
        inspection,
        selection: f.selection,
        deployments: reopened,
      });
      assert.deepEqual(reused, prepared);
      const binding = reused.extension.runtimeBindings.bindings[0]!;
      assert.equal(binding.provider.kind, "directResponses");
      if (binding.provider.kind === "directResponses") {
        assert.equal(binding.provider.endpoint, endpoint);
        assert.equal(binding.provider.apiKeyEnvironment, null);
      }
      await f.publish(reused.extension, "current-ineligible-reuse");
    }
  } finally {
    await reopened.close();
  }
  paths.forEach((path, index) =>
    assert.ok(readFileSync(path).equals(saved[index]!)),
  );
  assert.equal(
    (
      await f.store.loadAgentVersionDeployment({
        tenantId: owner.tenantId,
        agentVersionId: f.version.agentVersionId,
      })
    )?.materializationDigest,
    prepared.targets[0]!.materializationDigest,
  );
});

test("complete prepared files cannot relocate an Agent already published at its original materialization", async (t) => {
  const f = await fixture(t);
  const original = f.load();
  const prepared = await f.prepare();
  assert.equal(prepared.outcome, "prepared");
  if (prepared.outcome !== "prepared") return;
  await f.publish(original);
  const before = readFileSync(prepared.runtimeBindingsPath);
  const inspection = f.inspect({
    endpoint,
    credentialEnvironment: "CREWON_MODEL_API_KEY",
  });
  assert.equal(inspection.eligibility.outcome, "unsupported");
  const result = await f.prepare(inspection);
  assert.equal(result.outcome, "unsupported");
  if (result.outcome === "unsupported")
    assert.equal(
      result.reasonCode,
      "extension_recovery_published_target_mismatch",
    );
  assert.equal(result.runtimeBindingsPath, f.runtimeBindingsPath);
  assert.ok(readFileSync(prepared.runtimeBindingsPath).equals(before));
  assert.equal(
    (
      await f.store.loadAgentVersionDeployment({
        tenantId: owner.tenantId,
        agentVersionId: f.version.agentVersionId,
      })
    )?.materializationDigest,
    original.deployments[0]!.materializationDigest,
  );
});

test("extra Agent tools, governed context and external tool paths affect recovery eligibility without blocking current publication", async (t) => {
  for (const resource of [
    "extra-tool",
    "governed-context",
    "mcp-path",
    "owner-space",
  ] as const) {
    await t.test(resource, async (sub) => {
      const f = await fixture(sub);
      if (resource === "extra-tool" || resource === "governed-context") {
        const { contentDigest: _, schemaVersion: __, ...source } = f.version;
        const changed = compileAgentVersion(
          {
            ...source,
            schemaVersion: "crewon.agent-version-source.v0",
            resources:
              resource === "governed-context"
                ? {
                    ...source.resources,
                    governedContextDigest: digester.sha256("external-context"),
                  }
                : source.resources,
            tools:
              resource === "extra-tool"
                ? [
                    ...source.tools,
                    {
                      schemaVersion: "crewon.tool-definition.v0",
                      kind: "function",
                      name: "external_tool",
                      description: "Unknown executable capability",
                      execution: "serial",
                      inputSchema: { type: "object" },
                    },
                  ]
                : source.tools,
          },
          digester,
        );
        f.writeVersion(changed);
        f.writeBindings([
          { ...f.binding, contentDigest: changed.contentDigest },
        ]);
      }
      if (resource === "mcp-path") {
        const path = join(f.root, "external-tool-config.json");
        writeFileSync(path, "{}\n");
        f.writeBindings([{ ...f.binding, mcpStdioConfigPath: path }]);
      }
      const inspection =
        resource === "owner-space"
          ? inspectExtensionRecoveryInputs({
              extension: f.load(),
              runtimeBindingsPath: f.runtimeBindingsPath,
              agentVersionAssetsPath: f.agentVersionAssetsPath,
              owner: { ...owner, spaceId: "other-space" },
              defaultAgentVersionId: f.base.agentVersionId,
              model: { endpoint, credentialEnvironment: null },
            })
          : f.inspect();
      assert.equal(inspection.eligibility.outcome, "unsupported");
      const result = await f.prepare(inspection);
      assert.equal(result.outcome, "unsupported");
      assert.equal(result.runtimeBindingsPath, f.runtimeBindingsPath);
      assert.equal(existsSync(join(f.dataRoot, "extension-recoveries")), false);
      await f.publish(result.extension);
    });
  }
});

test("approved credential references and equivalent provider URL spelling preserve the original binding literal", async (t) => {
  const f = await fixture(t);
  assert.equal(f.binding.provider.kind, "directResponses");
  if (f.binding.provider.kind !== "directResponses") return;
  const literal = "https://PROVIDER.EXAMPLE:443/v1/responses";
  f.writeBindings([
    {
      ...f.binding,
      provider: {
        ...f.binding.provider,
        endpoint: literal,
        apiKeyEnvironment: "CREWON_MODEL_API_KEY",
      },
    },
  ]);
  const result = await f.prepare(
    f.inspect({ endpoint, credentialEnvironment: "CREWON_MODEL_API_KEY" }),
  );
  assert.equal(result.outcome, "prepared");
  assert.equal(
    result.extension.runtimeBindings.bindings[0]!.provider.kind,
    "directResponses",
  );
  if (
    result.extension.runtimeBindings.bindings[0]!.provider.kind ===
    "directResponses"
  ) {
    assert.equal(
      result.extension.runtimeBindings.bindings[0]!.provider.endpoint,
      literal,
    );
    assert.equal(
      result.extension.runtimeBindings.bindings[0]!.provider.apiKeyEnvironment,
      "CREWON_MODEL_API_KEY",
    );
  }
});

test("published prepared targets reject a different capsule path, partial saved files and changed saved snapshots without filling or deleting them", async (t) => {
  for (const corruption of [
    "other-capsule",
    "missing-snapshot",
    "changed-snapshot",
    "authority",
  ] as const) {
    await t.test(corruption, async (sub) => {
      const f = await fixture(sub);
      const prepared = await f.prepare();
      assert.equal(prepared.outcome, "prepared");
      if (prepared.outcome !== "prepared") return;
      await f.publish(prepared.extension);
      const snapshotPath =
        prepared.extension.runtimeBindings.bindings[0]!.extensionConfigPath!;
      if (corruption === "missing-snapshot") rmSync(snapshotPath);
      if (corruption === "changed-snapshot") {
        chmodSync(snapshotPath, 0o600);
        writeFileSync(snapshotPath, "{}\n");
      }
      if (corruption === "authority")
        f.writeBindings([{ ...f.binding, authorityId: "changed-authority" }]);
      const inspection = f.inspect({
        endpoint,
        credentialEnvironment: "CREWON_MODEL_API_KEY",
      });
      assert.equal(inspection.eligibility.outcome, "unsupported");
      const result = await f.prepare(
        inspection,
        corruption === "other-capsule"
          ? { ...f.selection, capsuleId: digester.sha256("other-selection") }
          : f.selection,
      );
      assert.equal(result.outcome, "unsupported");
      if (result.outcome === "unsupported")
        assert.match(
          result.reasonCode,
          /published_input_(?:unavailable|mismatch)/u,
        );
      assert.equal(result.runtimeBindingsPath, f.runtimeBindingsPath);
      assert.ok(existsSync(prepared.runtimeBindingsPath));
      if (corruption === "missing-snapshot")
        assert.equal(existsSync(snapshotPath), false);
      if (corruption === "changed-snapshot")
        assert.equal(readFileSync(snapshotPath, "utf8"), "{}\n");
      assert.equal(
        (
          await f.store.loadAgentVersionDeployment({
            tenantId: owner.tenantId,
            agentVersionId: f.version.agentVersionId,
          })
        )?.materializationDigest,
        prepared.targets[0]!.materializationDigest,
      );
    });
  }
});

test("provider mismatch, credential slots and untrusted model URLs are recovery-only unsupported with zero files or publication", async (t) => {
  for (const model of [
    {
      endpoint: "https://other.example/v1/responses",
      credentialEnvironment: null,
    },
    { endpoint, credentialEnvironment: "CREWON_MODEL_API_KEY" },
    {
      endpoint: "https://secret:token@provider.example/v1/responses",
      credentialEnvironment: null,
    },
    { endpoint: `${endpoint}?api_key=secret`, credentialEnvironment: null },
    { endpoint: `${endpoint}#secret`, credentialEnvironment: null },
    { endpoint, credentialEnvironment: "SECRET_KEY" },
  ]) {
    await t.test(JSON.stringify(model), async (sub) => {
      const f = await fixture(sub);
      const original = f.load();
      const inspection = f.inspect(model as Parameters<typeof f.inspect>[0]);
      assert.equal(inspection.eligibility.outcome, "unsupported");
      const result = await f.prepare(inspection);
      assert.equal(result.outcome, "unsupported");
      assert.deepEqual(result.extension, original);
      assert.equal(existsSync(join(f.dataRoot, "extension-recoveries")), false);
      assert.equal(
        await f.store.loadAgentVersionDeployment({
          tenantId: owner.tenantId,
          agentVersionId: f.version.agentVersionId,
        }),
        null,
      );
    });
  }
});

test("inspection and storage awaits detect original input drift without publishing or replacing final files", async (t) => {
  const f = await fixture(t);
  const inspection = f.inspect();
  const before = readFileSync(f.agentVersionAssetsPath);
  writeFileSync(f.agentVersionAssetsPath, `${before.toString()} `);
  await assert.rejects(
    f.prepare(inspection),
    /extension_recovery_input_changed/u,
  );
  assert.equal(existsSync(join(f.dataRoot, "extension-recoveries")), false);
  writeFileSync(f.agentVersionAssetsPath, before);
  const second = f.inspect();
  await assert.rejects(
    prepareExtensionRecoveryInputs({
      inspection: second,
      selection: f.selection,
      deployments: {
        loadAgentVersionDeployment: async () => {
          writeFileSync(f.snapshotPath, "{}\n");
          return null;
        },
      },
    }),
    /extension_recovery_input_changed/u,
  );
  assert.equal(existsSync(join(f.dataRoot, "extension-recoveries")), false);
});

test("selection values are captured before a real SQLite lookup awaits, and accessors are never invoked", async (t) => {
  const f = await fixture(t);
  const inspection = f.inspect();
  const selection = { ...f.selection };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = prepareExtensionRecoveryInputs({
    inspection,
    selection,
    deployments: {
      loadAgentVersionDeployment: async (locator) => {
        entered();
        await gate;
        return f.store.loadAgentVersionDeployment(locator);
      },
    },
  });
  await started;
  selection.dataRoot = join(f.root, "caller-moved-root");
  selection.capsuleId = digester.sha256("caller-moved-id");
  release();
  const prepared = await pending;
  assert.equal(prepared.outcome, "prepared");
  assert.equal(existsSync(selection.dataRoot), false);
  assert.equal(
    prepared.runtimeBindingsPath,
    join(
      f.dataRoot,
      "extension-recoveries",
      f.selection.capsuleId.slice(7),
      "plugin-bindings.json",
    ),
  );
  let calls = 0;
  const accessor = {
    capsuleId: f.selection.capsuleId,
    get dataRoot() {
      calls++;
      return f.dataRoot;
    },
  };
  await assert.rejects(
    prepareExtensionRecoveryInputs({
      inspection,
      selection: accessor,
      deployments: f.store,
    }),
    /selection_invalid/u,
  );
  assert.equal(calls, 0);
});

test("source symlinks, parent symlinks, nonregular files, oversized inputs and forged inspections fail closed", async (t) => {
  const f = await fixture(t);
  const source = f.load();
  const alias = join(f.root, "alias.json");
  symlinkSync(f.runtimeBindingsPath, alias);
  assert.throws(() =>
    inspectExtensionRecoveryInputs({
      extension: source,
      runtimeBindingsPath: alias,
      agentVersionAssetsPath: f.agentVersionAssetsPath,
      owner,
      defaultAgentVersionId: f.base.agentVersionId,
      model: { endpoint, credentialEnvironment: null },
    }),
  );
  const directoryAlias = join(f.root, "alias-directory");
  symlinkSync(f.root, directoryAlias, "dir");
  assert.throws(
    () =>
      inspectExtensionRecoveryInputs({
        extension: source,
        runtimeBindingsPath: join(directoryAlias, "operator-bindings.json"),
        agentVersionAssetsPath: f.agentVersionAssetsPath,
        owner,
        defaultAgentVersionId: f.base.agentVersionId,
        model: { endpoint, credentialEnvironment: null },
      }),
    /source_path_invalid/u,
  );
  assert.throws(
    () =>
      inspectExtensionRecoveryInputs({
        extension: source,
        runtimeBindingsPath: f.root,
        agentVersionAssetsPath: f.agentVersionAssetsPath,
        owner,
        defaultAgentVersionId: f.base.agentVersionId,
        model: { endpoint, credentialEnvironment: null },
      }),
    /source_size_invalid/u,
  );
  await assert.rejects(
    f.prepare({
      eligibility: { outcome: "eligible" },
      originalInputIdentityDigest: digester.sha256("forged"),
    }),
    /inspection_invalid/u,
  );
  writeFileSync(f.runtimeBindingsPath, Buffer.alloc(1024 * 1024 + 1, 32));
  assert.throws(
    () =>
      inspectExtensionRecoveryInputs({
        extension: source,
        runtimeBindingsPath: f.runtimeBindingsPath,
        agentVersionAssetsPath: f.agentVersionAssetsPath,
        owner,
        defaultAgentVersionId: f.base.agentVersionId,
        model: { endpoint, credentialEnvironment: null },
      }),
    /source_size_invalid/u,
  );
});
