import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  deriveExtensionRecoveryCapsuleId,
  extensionRecoveryOriginalInputIdentity,
  inspectInstalledExtensionRuntimeBuild,
  matchExtensionRecoveryOriginalInputs,
  readExtensionRecoverySourceFile,
} from "./extension-recovery-inputs.ts";
import { retainExtensionBuild } from "./extension-build-archive.ts";
import {
  commitExtensionRecoveryCapsule,
  extensionRecoveryDirectory,
  putExtensionRecoveryFile,
  type ExtensionRecoveryManifest,
} from "./extension-recovery.ts";
import { parseRuntimeBindingConfig } from "./runtime-binding-schema.ts";

const hash = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const owner = {
  principalId: "principal",
  actorId: "actor",
  tenantId: "tenant",
  spaceId: "space",
};
const bundleFiles = [
  "control-api.mjs",
  "device-gateway.mjs",
  "local-workspace-checks-mcp.mjs",
  "provider-model-catalog.mjs",
  "provider-settings-coordinator.mjs",
  "runtime-release.mjs",
  "runtime-worker.mjs",
];
function fixture(t: TestContext) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-recovery-shared-inputs-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data"),
    installed = join(root, "runtime");
  mkdirSync(dataRoot);
  mkdirSync(installed);
  return { root, dataRoot, installed };
}
function installedBuild(directory: string) {
  const identity = {
    schemaVersion: "crewon.extension-build-identity.v1",
    implementationDigest: hash(
      "genuine fixture source declaration; not executable readiness",
    ),
    bundles: bundleFiles.map((file) => {
      const content = `export const fixture = ${JSON.stringify(file)};\n`;
      writeFileSync(join(directory, file), content);
      return { file, digest: hash(content) };
    }),
    historicalWorkItemScope: "crewon.extension-work-item-scope.v1",
  };
  writeFileSync(
    join(directory, "extension-build-identity.json"),
    JSON.stringify(identity),
  );
  return identity;
}
async function capsule(t: TestContext, count = 1, originalKey = true) {
  const f = fixture(t),
    runtimeBindingsPath = join(f.root, "original-bindings.json"),
    agentVersionAssetsPath = join(f.root, "original-assets.json");
  const snapshots = Array.from({ length: count }, (_, index) => {
    const path = join(f.root, `original-${index}.json`),
      bytes = Buffer.from(JSON.stringify({ snapshot: index }));
    writeFileSync(path, bytes);
    return { path, bytes };
  });
  const binding = (index: number) => ({
    tenantId: owner.tenantId,
    agentVersionId: `agent-${index}`,
    contentDigest: hash(`asset-${index}`),
    authorityId: `authority-${index}`,
    workspaceBindingId: null,
    provider: {
      kind: "directResponses",
      endpoint:
        count === 32
          ? `https://provider.example/${"p".repeat(1850)}`
          : "https://provider.example/v1/responses",
      apiKeyEnvironment: null,
      storeResponses: false,
      requestProfile: "responsesLite",
      idleTimeoutMs: 5000,
      sequencePolicy: "whenPresent",
    },
    mcpStdioConfigPath: null,
    deviceToolConfigPath: null,
    remoteMcpConfigPath: null,
    extensionConfigPath: snapshots[index]!.path,
    toolRuntimeMode: "independent",
  });
  // Deliberately reverse raw key order. The Worker authoritative parser projects fixed keys.
  const source = {
    bindings: Array.from({ length: count }, (_, index) =>
      Object.fromEntries(Object.entries(binding(index)).reverse()),
    ),
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
  };
  const rawBindings = Buffer.from(JSON.stringify(source, null, 2)),
    assets = Buffer.from(
      JSON.stringify({
        schemaVersion: "crewon.extension-agent-version-assets.v0",
        assets: [{ fixture: true }],
      }),
    );
  writeFileSync(runtimeBindingsPath, rawBindings);
  writeFileSync(agentVersionAssetsPath, assets);
  const originalInputIdentityDigest = extensionRecoveryOriginalInputIdentity({
    bindings: rawBindings,
    assets,
    snapshots: snapshots.map(({ bytes }) => bytes),
  });
  const implementationDigest = hash("original-source"),
    buildIdentityDigest = hash("original-collection");
  const selection = {
    dataRoot: f.dataRoot,
    capsuleId: originalKey
      ? deriveExtensionRecoveryCapsuleId({
          implementationDigest,
          buildIdentityDigest,
          owner,
          originalInputIdentityDigest,
        })
      : hash("preexisting committed fixed paths"),
  };
  const directory = await extensionRecoveryDirectory({
    selection,
    create: true,
  });
  const parsed = parseRuntimeBindingConfig(source);
  const frozen = {
    ...parsed,
    bindings: parsed.bindings.map((binding, index) => ({
      ...binding,
      extensionConfigPath: join(
        directory,
        `snapshot-${String(index).padStart(2, "0")}.json`,
      ),
    })),
  };
  const pins = [];
  for (const [index, snapshot] of snapshots.entries())
    pins.push(
      await putExtensionRecoveryFile({
        selection,
        file: `snapshot-${String(index).padStart(2, "0")}.json`,
        bytes: snapshot.bytes,
      }),
    );
  for (const [file, bytes] of [
    ["plugin-bindings.json", Buffer.from(JSON.stringify(frozen) + "\n")],
    ["plugin-assets.json", assets],
    ["base-bindings.json", Buffer.from("{}")],
    ["bootstrap.json", Buffer.from("{}")],
    ["release.json", Buffer.from("{}")],
  ] as const)
    pins.push(await putExtensionRecoveryFile({ selection, file, bytes }));
  // JSON-pin fixtures only. Actual Worker/store tests separately establish release/target authority.
  const manifest: ExtensionRecoveryManifest = {
    schemaVersion: "crewon.extension-recovery-capsule.v0",
    capsuleId: selection.capsuleId,
    owner,
    implementationDigest,
    buildIdentityDigest,
    providerBinding: {
      providerId: "provider",
      endpoint: "https://provider.example/v1",
      responsesEndpoint: "https://provider.example/v1/responses",
      credentialRequired: false,
    },
    releaseId: "release",
    registrations: [
      {
        pluginId: "crewon.fixture",
        pluginVersion: "1.0.0",
        manifestDigest: hash("manifest"),
        implementationDigest: hash("registration"),
      },
    ],
    targets: parsed.bindings.map((binding) => ({
      executionAuthority: "crewonKernel",
      agentVersionId: binding.agentVersionId,
      agentVersionContentDigest: binding.contentDigest,
      materializationDigest: hash(binding.agentVersionId),
      authorityId: binding.authorityId,
      runtimeGeneration: "generation",
      policySnapshotId: "policy",
      workspaceBindingId: null,
    })),
    files: pins,
  };
  await commitExtensionRecoveryCapsule({ selection, manifest });
  return {
    ...f,
    selection,
    directory,
    runtimeBindingsPath,
    agentVersionAssetsPath,
    rawBindings,
    assets,
    snapshots,
    source,
    frozen,
    originalInputIdentityDigest,
  };
}

test("shared source and selection recipes are byte-for-byte identical to existing Worker recipes", () => {
  const bindings = Buffer.from('{"bindings":[]}'),
    assets = Buffer.from('{"assets":[]}'),
    snapshots = [Buffer.from('{"configuration":{}}')];
  const expected = hash(
    extensionCanonicalJson({
      schemaVersion: "crewon.extension-recovery-source.v0",
      bindings: hash(bindings),
      assets: hash(assets),
      snapshots: snapshots.map(hash),
    }),
  );
  assert.equal(
    extensionRecoveryOriginalInputIdentity({ bindings, assets, snapshots }),
    expected,
  );
  const input = {
    implementationDigest: hash("source"),
    buildIdentityDigest: hash("collection"),
    owner,
    originalInputIdentityDigest: expected,
  };
  assert.equal(
    deriveExtensionRecoveryCapsuleId(input),
    hash(
      extensionCanonicalJson({
        schemaVersion: "crewon.extension-recovery-selection.v0",
        ...input,
      }),
    ),
  );
  assert.notEqual(
    extensionRecoveryOriginalInputIdentity({
      bindings: Buffer.from('{ "bindings":[] }'),
      assets,
      snapshots,
    }),
    expected,
  );
  assert.throws(
    () =>
      extensionRecoveryOriginalInputIdentity({
        bindings,
        assets,
        snapshots,
        ...{ unexpected: true },
      }),
    /source_identity_invalid/u,
  );
  assert.throws(() =>
    deriveExtensionRecoveryCapsuleId({
      ...input,
      owner: { ...owner, principalId: "" },
    }),
  );
});

test("strict installed seven-entry inspection agrees with retention identity and captures input before await", async (t) => {
  const f = fixture(t),
    identity = installedBuild(f.installed);
  const input = { directory: f.installed };
  const pending = inspectInstalledExtensionRuntimeBuild(input);
  input.directory = join(f.root, "missing");
  const actual = await pending,
    retained = await retainExtensionBuild({
      dataRoot: f.dataRoot,
      currentBuildDirectory: f.installed,
      expectedImplementationDigest: identity.implementationDigest,
    });
  assert.deepEqual(actual, {
    implementationDigest: retained.implementationDigest,
    buildIdentityDigest: retained.buildIdentityDigest,
  });
  assert.ok(Object.isFrozen(actual));
  assert.equal(
    Object.keys(actual).length,
    2,
    "Inspection must not expose an executable path",
  );
});

test("installed inspection rejects old markers, partial collections, aliases, hardlinks and unbounded files", async (t) => {
  for (const defect of [
    "old-schema",
    "old-scope",
    "missing",
    "extra",
    "tamper",
    "leaf-link",
    "ancestor-link",
    "hardlink",
    "large",
    "unknown-key",
  ] as const)
    await t.test(defect, async (t) => {
      const f = fixture(t),
        identity = installedBuild(f.installed);
      let directory = f.installed;
      if (defect === "old-schema") {
        writeFileSync(
          join(f.installed, "extension-build-identity.json"),
          JSON.stringify({
            schemaVersion: "crewon.extension-build-identity.v0",
            implementationDigest: identity.implementationDigest,
            bundles: identity.bundles,
          }),
        );
      }
      if (defect === "old-scope")
        writeFileSync(
          join(f.installed, "extension-build-identity.json"),
          JSON.stringify({
            ...identity,
            historicalWorkItemScope: "crewon.extension-work-item-scope.v0",
          }),
        );
      if (defect === "missing") rmSync(join(f.installed, bundleFiles[0]!));
      if (defect === "extra")
        writeFileSync(join(f.installed, "unlisted.mjs"), "export {};\n");
      if (defect === "tamper")
        writeFileSync(join(f.installed, bundleFiles[0]!), "changed\n");
      if (defect === "leaf-link") {
        rmSync(join(f.installed, bundleFiles[0]!));
        symlinkSync(
          join(f.installed, bundleFiles[1]!),
          join(f.installed, bundleFiles[0]!),
        );
      }
      if (defect === "ancestor-link") {
        directory = join(f.root, "alias");
        symlinkSync(f.installed, directory, "dir");
      }
      if (defect === "hardlink")
        linkSync(
          join(f.installed, bundleFiles[0]!),
          join(f.root, "bundle-alias.mjs"),
        );
      if (defect === "large")
        truncateSync(join(f.installed, bundleFiles[0]!), 32 * 1024 * 1024 + 1);
      if (defect === "unknown-key")
        writeFileSync(
          join(f.installed, "extension-build-identity.json"),
          JSON.stringify({ ...identity, unexpected: true }),
        );
      await assert.rejects(
        inspectInstalledExtensionRuntimeBuild({ directory }),
        /extension_/u,
      );
      assert.equal(
        existsSync(f.installed),
        true,
        "Inspection must never mutate the installed build",
      );
    });
  let read = false;
  await assert.rejects(
    inspectInstalledExtensionRuntimeBuild(
      Object.defineProperty({}, "directory", {
        enumerable: true,
        get() {
          read = true;
          return "/tmp";
        },
      }) as { directory: string },
    ),
    /input_invalid/u,
  );
  assert.equal(read, false);
});

test("original matching uses the authoritative parsed projection and exact raw assets/snapshot pins", async (t) => {
  const f = await capsule(t);
  const args = {
    selection: f.selection,
    runtimeBindingsPath: f.runtimeBindingsPath,
    agentVersionAssetsPath: f.agentVersionAssetsPath,
  };
  assert.deepEqual(await matchExtensionRecoveryOriginalInputs(args), {
    matches: true,
    inputKind: "original",
  });
  writeFileSync(f.runtimeBindingsPath, JSON.stringify(f.source));
  assert.deepEqual(
    await matchExtensionRecoveryOriginalInputs(args),
    { matches: false, inputKind: null },
    "Formatting changes remain a different original raw identity",
  );
  writeFileSync(f.runtimeBindingsPath, f.rawBindings);
  writeFileSync(f.snapshots[0]!.path, '{"snapshot":"changed"}');
  assert.deepEqual(await matchExtensionRecoveryOriginalInputs(args), {
    matches: false,
    inputKind: null,
  });
});

test("a legal 32-binding projection above 64 KiB remains bounded and can match", async (t) => {
  const f = await capsule(t, 32);
  assert.ok(f.rawBindings.byteLength > 64 * 1024);
  assert.deepEqual(
    await matchExtensionRecoveryOriginalInputs({
      selection: f.selection,
      runtimeBindingsPath: f.runtimeBindingsPath,
      agentVersionAssetsPath: f.agentVersionAssetsPath,
    }),
    { matches: true, inputKind: "original" },
  );
});

test("prepared paths match only both exact frozen files and never a mixed pair", async (t) => {
  const f = await capsule(t, 1, false);
  const frozenBindings = join(f.directory, "plugin-bindings.json"),
    frozenAssets = join(f.directory, "plugin-assets.json");
  assert.deepEqual(
    await matchExtensionRecoveryOriginalInputs({
      selection: f.selection,
      runtimeBindingsPath: frozenBindings,
      agentVersionAssetsPath: frozenAssets,
    }),
    { matches: true, inputKind: "prepared" },
  );
  for (const [runtimeBindingsPath, agentVersionAssetsPath] of [
    [frozenBindings, f.agentVersionAssetsPath],
    [f.runtimeBindingsPath, frozenAssets],
  ])
    assert.deepEqual(
      await matchExtensionRecoveryOriginalInputs({
        selection: f.selection,
        runtimeBindingsPath: runtimeBindingsPath!,
        agentVersionAssetsPath: agentVersionAssetsPath!,
      }),
      { matches: false, inputKind: null },
    );
});

test("capsule ID alone never bypasses full projected binding/assets/snapshot verification", async (t) => {
  const f = await capsule(t);
  const path = join(f.directory, "plugin-bindings.json");
  // Recreate a committed fixture whose recipe key still matches original inputs, but has different authority.
  const bytes = Buffer.from(
    JSON.stringify({
      ...f.frozen,
      bindings: f.frozen.bindings.map((binding) => ({
        ...binding,
        authorityId: "changed-authority",
      })),
    }),
  );
  const markerPath = join(f.directory, "manifest.json"),
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  chmodSync(path, 0o600);
  writeFileSync(path, bytes);
  marker.files = marker.files.map((pin: { file: string; digest: string }) =>
    pin.file === "plugin-bindings.json" ? { ...pin, digest: hash(bytes) } : pin,
  );
  chmodSync(markerPath, 0o600);
  writeFileSync(markerPath, JSON.stringify(marker));
  assert.deepEqual(
    await matchExtensionRecoveryOriginalInputs({
      selection: f.selection,
      runtimeBindingsPath: f.runtimeBindingsPath,
      agentVersionAssetsPath: f.agentVersionAssetsPath,
    }),
    { matches: false, inputKind: null },
  );
});

test("unknown binding fields, unsafe source paths and sources changed during await fail closed without writes", async (t) => {
  const f = await capsule(t),
    args = {
      selection: { ...f.selection },
      runtimeBindingsPath: f.runtimeBindingsPath,
      agentVersionAssetsPath: f.agentVersionAssetsPath,
    };
  const pending = matchExtensionRecoveryOriginalInputs(args);
  args.runtimeBindingsPath = join(f.root, "missing");
  args.selection.capsuleId = hash("changed-selection");
  assert.deepEqual(await pending, { matches: true, inputKind: "original" });
  const stable = {
    selection: f.selection,
    runtimeBindingsPath: f.runtimeBindingsPath,
    agentVersionAssetsPath: f.agentVersionAssetsPath,
  };
  const race = matchExtensionRecoveryOriginalInputs(stable);
  writeFileSync(f.snapshots[0]!.path, '{"changed":true}');
  await assert.rejects(race, /input_changed/u);
  writeFileSync(f.snapshots[0]!.path, f.snapshots[0]!.bytes);
  writeFileSync(
    f.runtimeBindingsPath,
    JSON.stringify({ ...f.source, unknown: true }),
  );
  await assert.rejects(
    matchExtensionRecoveryOriginalInputs(stable),
    /bindings_invalid/u,
  );
  writeFileSync(f.runtimeBindingsPath, f.rawBindings);
  rmSync(f.agentVersionAssetsPath);
  symlinkSync(
    join(f.directory, "plugin-assets.json"),
    f.agentVersionAssetsPath,
  );
  await assert.rejects(matchExtensionRecoveryOriginalInputs(stable));
  assert.equal(
    readFileSync(join(f.directory, "plugin-assets.json")).equals(f.assets),
    true,
  );
});

test("shared Worker source reader preserves its nofollow, UTF-8 and byte-bound checks", (t) => {
  const f = fixture(t),
    path = join(f.root, "raw.json");
  writeFileSync(path, "{}\n");
  assert.equal(readExtensionRecoverySourceFile(path, 4).toString(), "{}\n");
  assert.throws(
    () => readExtensionRecoverySourceFile(path, 2),
    /source_size_invalid/u,
  );
  writeFileSync(path, Buffer.from([0xff, 0xff]));
  assert.throws(() => readExtensionRecoverySourceFile(path, 32));
  rmSync(path);
  mkdirSync(path);
  assert.throws(
    () => readExtensionRecoverySourceFile(path, 32),
    /source_size_invalid/u,
  );
});
