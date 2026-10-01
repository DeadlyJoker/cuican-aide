import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { fileURLToPath } from "node:url";
import test, { after, type TestContext } from "node:test";
import { createAgentVersionAsset } from "@crewon/agent-version";
import {
  createScopedExtensionBuildIdentity,
  EXTENSION_BUILD_IDENTITY_FILE,
  getComfyImplementationDigest,
} from "@crewon/agent-version/extension-build";
import {
  commitExtensionRecoveryCapsule,
  readExtensionRecoveryStartupReport,
  resolveExtensionRecoveryCapsule,
} from "@crewon/agent-version/extension-recovery";
import { createExtensionConfiguration } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { compileRuntimeAgentVersion } from "./agent-version-release.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";
import { createModelTransport } from "./runtime-process-environment.ts";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const sourceRelease = fileURLToPath(
  new URL("./release-main.ts", import.meta.url),
);
const owner = {
  principalId: "native-principal",
  actorId: "native-actor",
  tenantId: "native-tenant",
  spaceId: "native-space",
};
const timestamp = "2026-10-02T00:00:00.000Z";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
let installed: string | undefined;
after(() => {
  if (installed) rmSync(installed, { recursive: true, force: true });
});

async function stageInstalled() {
  if (installed !== undefined) return installed;
  installed = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-capsule-installed-")),
  );
  const stage = await import(
    new URL("../../../scripts/stage-desktop-runtime.ts", import.meta.url).href
  );
  const implementationDigest = getComfyImplementationDigest();
  const specs = stage.runtimeBundleSpecs(repository, installed) as readonly {
    entry: string;
    output: string;
  }[];
  assert.equal(specs.length, 7);
  for (const spec of specs) stage.bundleRuntime(spec, implementationDigest);
  const identity = createScopedExtensionBuildIdentity({
    implementationDigest,
    bundlePaths: specs.map((spec) => spec.output),
  });
  writeFileSync(
    join(installed, EXTENSION_BUILD_IDENTITY_FILE),
    JSON.stringify(identity),
  );
  return installed;
}

async function fixture(t: TestContext, authenticated = false) {
  const build = await stageInstalled();
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-capsule-release-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot);
  const databasePath = join(root, "control.sqlite");
  const baseBindings = join(root, "current-base.json");
  const operatorBindings = join(root, "operator-plugin.json");
  const operatorAssets = join(root, "operator-assets.json");
  const operatorSnapshot = join(root, "operator-snapshot.json");
  const endpoint = "https://provider.example/v1/responses";
  const environment = {
    PATH: process.env.PATH!,
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_DB_PATH: databasePath,
    CREWON_TENANT_ID: owner.tenantId,
    CREWON_SPACE_ID: owner.spaceId,
    CREWON_PRINCIPAL_ID: owner.principalId,
    CREWON_ACTOR_ID: owner.actorId,
    CREWON_RELEASE_PRINCIPAL_ID: owner.principalId,
    CREWON_RELEASE_ACTOR_ID: owner.actorId,
    CREWON_AUTHORITY_ID: "native-authority",
    CREWON_AGENT_VERSION_ID: "default-old",
    CREWON_RUNTIME_GENERATION: "ts-v0",
    CREWON_POLICY_SNAPSHOT_ID: "native-policy",
    CREWON_MODEL_ID: "model-old",
    CREWON_MODEL_API_KEY: "must-never-persist-api-key",
    CREWON_MODEL_CREDENTIAL_REQUIRED: authenticated ? "1" : "0",
    CREWON_RESPONSES_ENDPOINT: endpoint,
    CREWON_MODEL_CONTEXT_WINDOW_TOKENS: "4096",
    CREWON_AUTO_COMPACT_AT_TOKENS: "3072",
    CREWON_RESPONSES_STREAM_MAX_RETRIES: "0",
    CREWON_AGENT_INSTRUCTIONS: "Original default instructions.",
    CREWON_MODEL_CATALOG_JSON: '["model-old"]',
    CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: baseBindings,
    CREWON_EXTENSIONS_ENABLED: "1",
    CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: operatorBindings,
    CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH: operatorAssets,
    CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: dataRoot,
    CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "a".repeat(64),
    CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: JSON.stringify({
      providerId: "native-provider",
      endpoint: "https://provider.example/v1",
      responsesEndpoint: endpoint,
      credentialRequired: authenticated,
    }),
  };
  const agent = resolveRuntimeBootstrapAgent(environment);
  const transport = createModelTransport("responses", {}, environment);
  let base;
  try {
    base = compileRuntimeAgentVersion({
      runtimeTenantId: owner.tenantId,
      route: resolveRuntimeBootstrapRoute(environment),
      transport,
      agentInstructions: agent.instructions,
      modelContextWindowTokens: agent.contextWindowTokens,
      autoCompactAtTokens: agent.autoCompactAtTokens,
      streamMaxRetries: agent.streamMaxRetries,
    });
  } finally {
    await transport.close?.();
  }
  const plugin = compileComfyAgentVersion({
    base: { executionAuthority: "crewonKernel", version: base },
    agentVersionId: "image-pinned",
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
      revision: 1,
      pluginVersion: registration.manifest.version,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: owner.actorId,
      createdAt: timestamp,
    },
    digester,
  );
  writeFileSync(
    operatorSnapshot,
    JSON.stringify({
      schemaVersion: "crewon.extension-runtime-config.v0",
      configuration,
      approvalRequirement: "perAction",
    }),
  );
  writeFileSync(
    operatorBindings,
    JSON.stringify({
      schemaVersion: "crewon.agent-version-runtime-bindings.v0",
      bindings: [
        {
          tenantId: owner.tenantId,
          agentVersionId: plugin.agentVersionId,
          contentDigest: plugin.contentDigest,
          authorityId: "plugin-authority",
          workspaceBindingId: null,
          provider: {
            kind: "directResponses",
            endpoint,
            apiKeyEnvironment: authenticated ? "CREWON_MODEL_API_KEY" : null,
            storeResponses: false,
            requestProfile: "responsesLite",
            sequencePolicy: "whenPresent",
            idleTimeoutMs: 60000,
          },
          mcpStdioConfigPath: null,
          deviceToolConfigPath: null,
          remoteMcpConfigPath: null,
          extensionConfigPath: operatorSnapshot,
        },
      ],
    }),
  );
  writeFileSync(
    operatorAssets,
    JSON.stringify({
      schemaVersion: "crewon.extension-agent-version-assets.v0",
      assets: [
        createAgentVersionAsset({
          tenantId: owner.tenantId,
          version: plugin,
          createdAt: timestamp,
        }),
      ],
    }),
  );
  const run = (
    overrides: Record<string, string | undefined> = {},
    source = false,
  ) => {
    const env = { ...environment, ...overrides };
    for (const name of Object.keys(env))
      if (env[name as keyof typeof env] === undefined)
        delete env[name as keyof typeof env];
    return JSON.parse(
      execFileSync(
        process.execPath,
        source
          ? ["--experimental-strip-types", sourceRelease]
          : [join(build, "runtime-release.mjs")],
        {
          cwd: root,
          env,
          encoding: "utf8",
          maxBuffer: 256 * 1024,
          timeout: 15000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ) as { releaseId: string; agentVersionIds: string[] };
  };
  const report = (
    attemptId = environment.CREWON_EXTENSION_RECOVERY_ATTEMPT_ID,
  ) =>
    readExtensionRecoveryStartupReport({
      dataRoot,
      expectedAttemptId: attemptId,
    });
  const deployment = async () => {
    const store = new SqliteRunStore(databasePath);
    try {
      return await store.loadAgentVersionDeployment({
        tenantId: owner.tenantId,
        agentVersionId: plugin.agentVersionId,
      });
    } finally {
      await store.close();
    }
  };
  return {
    root,
    dataRoot,
    environment,
    baseBindings,
    run,
    report,
    deployment,
    plugin,
    operatorBindings,
  };
}

test(
  "actual installed Release preserves valid bootstrap and full publication metadata above the plugin JSON limit",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const profiles = Array.from({ length: 4 }, (_, index) => ({
      agentVersionId: `long-profile-${index}`,
      instructions: `${index}-${"p".repeat(8098)}`,
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(profiles)) < 32 * 1024);
    const activation = f.run({
      CREWON_AGENT_INSTRUCTIONS: "b".repeat(32 * 1024),
      CREWON_DEV_AGENT_PROFILES_JSON: JSON.stringify(profiles),
    });
    const report = await f.report();
    assert.equal(report.outcome, "prepared");
    if (report.outcome !== "prepared") throw new Error("expected_candidate");
    assert.equal(report.manifest.releaseId, activation.releaseId);
    const directory = join(
      f.dataRoot,
      "extension-recoveries",
      report.manifest.capsuleId.slice(7),
    );
    const bootstrap = readFileSync(join(directory, "bootstrap.json"));
    const release = readFileSync(join(directory, "release.json"));
    assert.ok(
      bootstrap.byteLength > 65_536 && bootstrap.byteLength < 128 * 1024,
    );
    assert.ok(release.byteLength > 65_536 && release.byteLength < 256 * 1024);
    const parsed = JSON.parse(bootstrap.toString("utf8"));
    assert.equal(parsed.agent.instructions.length, 32 * 1024);
    assert.deepEqual(parsed.profiles, profiles);
    assert.equal(JSON.parse(release.toString("utf8")).plan.versions.length, 6);
    for (const bytes of [bootstrap, release])
      assert.equal(
        bytes.toString("utf8").includes("must-never-persist-api-key"),
        false,
      );
    const second = f.run({
      CREWON_AGENT_INSTRUCTIONS: "b".repeat(32 * 1024),
      CREWON_DEV_AGENT_PROFILES_JSON: JSON.stringify(profiles),
      CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "b".repeat(64),
    });
    assert.equal(second.releaseId, activation.releaseId);
    assert.equal((await f.report("b".repeat(64))).outcome, "prepared");
    assert.deepEqual(
      readFileSync(join(directory, "bootstrap.json")),
      bootstrap,
    );
    assert.deepEqual(readFileSync(join(directory, "release.json")), release);
  },
);

test(
  "actual installed Release freezes plugin paths, verifies publication, and emits only a pending candidate",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const activation = f.run();
    const report = await f.report();
    assert.equal(report.outcome, "prepared");
    if (report.outcome !== "prepared") throw new Error("expected_candidate");
    assert.equal(report.manifest.releaseId, activation.releaseId);
    assert.deepEqual(activation.agentVersionIds, [
      "default-old",
      "image-pinned",
    ]);
    const selection = {
      dataRoot: f.dataRoot,
      capsuleId: report.manifest.capsuleId,
    };
    const directory = join(
      f.dataRoot,
      "extension-recoveries",
      report.manifest.capsuleId.slice(7),
    );
    assert.equal(
      existsSync(join(directory, "manifest.json")),
      false,
      "Release cannot grant historical readiness",
    );
    const binding = JSON.parse(
      readFileSync(join(directory, "plugin-bindings.json"), "utf8"),
    ).bindings[0];
    assert.equal(
      binding.extensionConfigPath,
      join(directory, "snapshot-00.json"),
    );
    assert.equal(
      (await f.deployment())?.materializationDigest,
      report.manifest.targets[0]?.materializationDigest,
    );
    assert.equal(
      report.manifest.targets[0]?.agentVersionContentDigest,
      f.plugin.contentDigest,
    );
    assert.equal(
      readFileSync(join(directory, "base-bindings.json")).equals(
        readFileSync(f.baseBindings),
      ),
      true,
    );
    const metadata = readFileSync(join(directory, "release.json"), "utf8");
    assert.equal(metadata.includes("activationId"), false);
    assert.equal(metadata.includes("createdAt"), false);
    for (const { file } of report.manifest.files)
      assert.equal(
        readFileSync(join(directory, file), "utf8").includes(
          "must-never-persist-api-key",
        ),
        false,
      );
    await assert.rejects(resolveExtensionRecoveryCapsule(selection), {
      code: "ENOENT",
    });

    test(
      "published frozen inputs survive recovery-only workspace and Provider ID eligibility drift",
      { timeout: 60000 },
      async (t) => {
        const f = await fixture(t);
        f.run();
        const first = await f.report();
        if (first.outcome !== "prepared") throw new Error("expected_candidate");
        const complete = await commitExtensionRecoveryCapsule({
          selection: {
            dataRoot: f.dataRoot,
            capsuleId: first.manifest.capsuleId,
          },
          manifest: first.manifest,
        });
        const saved = complete.files.map(({ path }) => ({
          path,
          bytes: readFileSync(path),
        }));
        const activation = f.run({
          CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "f".repeat(64),
          CREWON_AGENT_VERSION_ID: "default-workspace",
          CREWON_DESKTOP_WORKSPACE_ROOT: f.root,
        });
        assert.deepEqual(activation.agentVersionIds, [
          "default-workspace",
          "image-pinned",
        ]);
        assert.deepEqual(await f.report("f".repeat(64)), {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: "f".repeat(64),
          outcome: "unsupported",
          reasonCode: "runtime_bootstrap_workspace_unsupported",
          preparedInputCapsuleId: first.manifest.capsuleId,
        });
        const provider = JSON.parse(
          f.environment.CREWON_EXTENSION_RECOVERY_PROVIDER_JSON,
        );
        provider.providerId = "renamed-provider";
        f.run({
          CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "1".repeat(64),
          CREWON_AGENT_VERSION_ID: "default-renamed",
          CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: JSON.stringify(provider),
        });
        assert.deepEqual(await f.report("1".repeat(64)), {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: "1".repeat(64),
          outcome: "unsupported",
          reasonCode: "extension_recovery_provider_mismatch",
          preparedInputCapsuleId: first.manifest.capsuleId,
        });
        assert.equal(
          (await f.deployment())?.materializationDigest,
          first.manifest.targets[0]?.materializationDigest,
        );
        for (const file of saved)
          assert.equal(readFileSync(file.path).equals(file.bytes), true);
      },
    );

    test(
      "a published old model endpoint is omitted from the current release before a new key can reach its binding",
      { timeout: 60000 },
      async (t) => {
        const f = await fixture(t);
        f.run();
        const first = await f.report();
        if (first.outcome !== "prepared") throw new Error("expected_candidate");
        const previous = await f.deployment();
        const activation = f.run({
          CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "2".repeat(64),
          CREWON_AGENT_VERSION_ID: "default-other-provider",
          CREWON_RESPONSES_ENDPOINT:
            "https://new-provider.example/v1/responses",
          CREWON_MODEL_API_KEY: "new-provider-private-key",
          CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: JSON.stringify({
            providerId: "new-provider",
            endpoint: "https://new-provider.example/v1",
            responsesEndpoint: "https://new-provider.example/v1/responses",
            credentialRequired: false,
          }),
        });
        assert.deepEqual(activation.agentVersionIds, [
          "default-other-provider",
        ]);
        assert.deepEqual(await f.report("2".repeat(64)), {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: "2".repeat(64),
          outcome: "pluginUnavailable",
          reasonCode: "extension_recovery_current_provider_mismatch",
        });
        assert.deepEqual(await f.deployment(), previous);
      },
    );

    test(
      "missing a published fixed credential slot disables its plugin while leaving the current anonymous default release available",
      { timeout: 60000 },
      async (t) => {
        const f = await fixture(t, true);
        f.run();
        const previous = await f.deployment();
        const activation = f.run({
          CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "3".repeat(64),
          CREWON_AGENT_VERSION_ID: "default-anonymous",
          CREWON_MODEL_API_KEY: undefined,
          CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
          CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: JSON.stringify({
            providerId: "native-provider",
            endpoint: "https://provider.example/v1",
            responsesEndpoint: "https://provider.example/v1/responses",
            credentialRequired: false,
          }),
        });
        assert.deepEqual(activation.agentVersionIds, ["default-anonymous"]);
        assert.deepEqual(await f.report("3".repeat(64)), {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: "3".repeat(64),
          outcome: "pluginUnavailable",
          reasonCode: "extension_recovery_current_credential_unavailable",
        });
        assert.deepEqual(await f.deployment(), previous);
      },
    );

    test(
      "a legacy legitimate operator symlink remains publishable while optional recovery reports an unsafe source",
      { timeout: 60000 },
      async (t) => {
        const f = await fixture(t);
        const alias = join(f.root, "legacy-bindings-link.json");
        symlinkSync(f.operatorBindings, alias);
        const activation = f.run({
          CREWON_EXTENSION_RUNTIME_BINDINGS_PATH: alias,
        });
        assert.deepEqual(activation.agentVersionIds, [
          "default-old",
          "image-pinned",
        ]);
        assert.deepEqual(await f.report(), {
          schemaVersion: "crewon.extension-recovery-startup.v0",
          attemptId: "a".repeat(64),
          outcome: "unsupported",
          reasonCode: "extension_recovery_source_unsupported",
          preparedInputCapsuleId: null,
        });
        assert.equal(
          (await f.deployment())?.contentDigest,
          f.plugin.contentDigest,
        );
        assert.equal(
          existsSync(join(f.dataRoot, "extension-recoveries")),
          false,
        );
      },
    );
  },
);

test(
  "the same pinned plugin capsule retains its first complete manifest when current default and catalog change",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.run();
    const first = await f.report();
    if (first.outcome !== "prepared") throw new Error("expected_candidate");
    const selection = {
      dataRoot: f.dataRoot,
      capsuleId: first.manifest.capsuleId,
    };
    const original = await commitExtensionRecoveryCapsule({
      selection,
      manifest: first.manifest,
    });
    const savedBase = readFileSync(
      join(original.directory, "base-bindings.json"),
    );
    const activation = f.run({
      CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "b".repeat(64),
      CREWON_AGENT_VERSION_ID: "default-new",
      CREWON_MODEL_ID: "model-new",
      CREWON_MODEL_CATALOG_JSON: '["model-new","model-extra"]',
      CREWON_AGENT_INSTRUCTIONS: "Current default instructions.",
    });
    const next = await f.report("b".repeat(64));
    assert.equal(next.outcome, "prepared");
    if (next.outcome !== "prepared") throw new Error("expected_candidate");
    assert.deepEqual(next.manifest, first.manifest);
    assert.notEqual(activation.releaseId, first.manifest.releaseId);
    assert.equal(activation.agentVersionIds.includes("default-new"), true);
    assert.equal(activation.agentVersionIds.includes("image-pinned"), true);
    assert.equal(
      readFileSync(join(original.directory, "base-bindings.json")).equals(
        savedBase,
      ),
      true,
    );
    assert.notDeepEqual(readFileSync(f.baseBindings), savedBase);
    assert.deepEqual(
      (await resolveExtensionRecoveryCapsule(selection)).manifest,
      first.manifest,
    );
  },
);

test(
  "a partial capsule parameter conflict keeps frozen plugin inputs and the first bytes without claiming recovery readiness",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.run();
    const first = await f.report();
    if (first.outcome !== "prepared") throw new Error("expected_candidate");
    const directory = join(
      f.dataRoot,
      "extension-recoveries",
      first.manifest.capsuleId.slice(7),
    );
    const saved = readFileSync(join(directory, "base-bindings.json"));
    const activation = f.run({
      CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "c".repeat(64),
      CREWON_AGENT_VERSION_ID: "default-new",
      CREWON_MODEL_ID: "model-new",
      CREWON_MODEL_CATALOG_JSON: '["model-new"]',
    });
    const report = await f.report("c".repeat(64));
    assert.deepEqual(report, {
      schemaVersion: "crewon.extension-recovery-startup.v0",
      attemptId: "c".repeat(64),
      outcome: "unsupported",
      reasonCode: "extension_recovery_release_inputs_unsupported",
      preparedInputCapsuleId: first.manifest.capsuleId,
    });
    assert.equal(activation.agentVersionIds.includes("default-new"), true);
    assert.equal(
      readFileSync(join(directory, "base-bindings.json")).equals(saved),
      true,
    );
    assert.equal(
      (await f.deployment())?.materializationDigest,
      first.manifest.targets[0]?.materializationDigest,
    );
    assert.equal(existsSync(join(directory, "manifest.json")), false);
  },
);

test(
  "a complete capsule with a missing or changed pinned file is rejected after exact database verification",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.run();
    const first = await f.report();
    if (first.outcome !== "prepared") throw new Error("expected_candidate");
    const complete = await commitExtensionRecoveryCapsule({
      selection: { dataRoot: f.dataRoot, capsuleId: first.manifest.capsuleId },
      manifest: first.manifest,
    });
    const path = join(complete.directory, "bootstrap.json");
    const original = readFileSync(path);
    writeFileSync(path, '{"changed":true}');
    assert.throws(
      () => f.run({ CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "d".repeat(64) }),
      /extension_recovery_file_mismatch/,
    );
    writeFileSync(path, original);
    rmSync(path);
    assert.throws(
      () => f.run({ CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: "e".repeat(64) }),
      /extension_recovery_inventory_invalid/,
    );
    assert.equal(existsSync(path), false);
  },
);

test(
  "first-publication capsule capacity exhaustion disables optional recovery while preserving the ordinary release",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const capsules = join(f.dataRoot, "extension-recoveries");
    mkdirSync(capsules);
    for (let index = 0; index < 64; index++)
      mkdirSync(join(capsules, index.toString(16).padStart(64, "0")));
    const activation = f.run();
    assert.deepEqual(activation.agentVersionIds, [
      "default-old",
      "image-pinned",
    ]);
    assert.deepEqual(await f.report(), {
      schemaVersion: "crewon.extension-recovery-startup.v0",
      attemptId: "a".repeat(64),
      outcome: "unsupported",
      reasonCode: "extension_recovery_storage_unavailable",
      preparedInputCapsuleId: null,
    });
    assert.equal((await f.deployment())?.contentDigest, f.plugin.contentDigest);
  },
);

test(
  "legacy no-request source publication stays unchanged and explicit source recovery cannot pretend to retain a bundle",
  { timeout: 60000 },
  async (t) => {
    const legacy = await fixture(t);
    const activation = legacy.run(
      {
        CREWON_EXTENSION_RECOVERY_ATTEMPT_ID: undefined,
        CREWON_EXTENSION_RECOVERY_PROVIDER_JSON: undefined,
        CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT: undefined,
      },
      true,
    );
    assert.deepEqual(activation.agentVersionIds, [
      "default-old",
      "image-pinned",
    ]);
    assert.equal(
      existsSync(join(legacy.dataRoot, "extension-recoveries")),
      false,
    );
    assert.equal(
      existsSync(join(legacy.dataRoot, "extension-recovery-startup.json")),
      false,
    );
    const explicit = await fixture(t);
    assert.equal(
      explicit.run({}, true).agentVersionIds.includes("image-pinned"),
      true,
    );
    assert.deepEqual(await explicit.report(), {
      schemaVersion: "crewon.extension-recovery-startup.v0",
      attemptId: "a".repeat(64),
      outcome: "unsupported",
      reasonCode: "extension_recovery_build_unavailable",
      preparedInputCapsuleId: null,
    });
    assert.equal(
      existsSync(join(explicit.dataRoot, "extension-builds")),
      false,
    );
    assert.equal(
      existsSync(join(explicit.dataRoot, "extension-recoveries")),
      false,
    );
  },
);
