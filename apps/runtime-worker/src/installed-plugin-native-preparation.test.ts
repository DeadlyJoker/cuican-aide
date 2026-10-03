import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { compileAgentVersion } from "@crewon/agent-version";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  loadNativeInstalledPluginPreparation,
  parseNativeInstalledPluginPreparationConfiguration,
} from "./plugins/installed-plugin-native-preparation-config.ts";
import { prepareNativeInstalledPluginRelease as prepareRelease } from "./plugins/installed-plugin-native-preparation.ts";
import {
  readInstalledPluginReleaseDocument,
  installedPluginReleaseDigester,
  INSTALLED_PLUGIN_RELEASE_MAX_BYTES,
} from "./plugins/installed-plugin-release-document.ts";
import { nativePreparationCanonicalJson } from "./plugins/installed-plugin-native-preparation-json.ts";
import {
  nativePreparationFixture,
  scope,
} from "./installed-plugin-native-preparation.test-support.ts";

function prepareNativeInstalledPluginRelease(
  input: Parameters<typeof prepareRelease>[0],
) {
  const {
    inputPath,
    environment,
    actor,
    bootstrapVersion,
    defaultAgentVersionId,
    signal,
  } = input;
  return prepareRelease({
    inputPath,
    environment,
    actor,
    bootstrapVersion,
    defaultAgentVersionId,
    ...(signal === undefined ? {} : { signal }),
  });
}

test("Preparation preserves the original digest key ordering and bounds larger canonical recipes at the release limit", () => {
  const sample = {
    z: [3, { b: "later", a: "first" }],
    a: { nested: true, array: ["x", null] },
  };
  assert.equal(
    nativePreparationCanonicalJson(sample),
    extensionCanonicalJson(sample),
  );
  assert.ok(
    Buffer.byteLength(
      nativePreparationCanonicalJson({ bounded: "x".repeat(80_000) }),
    ) > 65_536,
  );
  assert.throws(
    () =>
      nativePreparationCanonicalJson({
        bounded: "x".repeat(INSTALLED_PLUGIN_RELEASE_MAX_BYTES),
      }),
    /json_limit/u,
  );
  let calls = 0;
  const getter = Object.defineProperty({}, "data", {
    enumerable: true,
    get() {
      calls++;
      return "unsafe";
    },
  });
  assert.throws(() => nativePreparationCanonicalJson(getter));
  assert.equal(calls, 0);
});

test("A legal bootstrap and both seed recipes above 64 KiB compile and write an actual bounded release", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  const { contentDigest: _digest, ...source } = input.bootstrapVersion;
  const bootstrapVersion = compileAgentVersion(
    {
      ...source,
      schemaVersion: "crewon.agent-version-source.v0",
      instructions: "\u0000".repeat(20_000),
      tools: [0, 1].map((index) => ({
        ...source.tools[0]!,
        name: `host_large_${index}`,
        inputSchema: {
          type: "object",
          properties: {
            large: { type: "string", description: "x".repeat(40_000) },
          },
        },
      })),
    },
    installedPluginReleaseDigester,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(bootstrapVersion)) > 65_536);
  const result = await prepareNativeInstalledPluginRelease({
    ...input,
    bootstrapVersion,
  });
  const outputBytes = await readFile(result.documentPath);
  assert.ok(outputBytes.byteLength > 65_536);
  assert.ok(outputBytes.byteLength <= INSTALLED_PLUGIN_RELEASE_MAX_BYTES);
  assert.deepEqual(
    readInstalledPluginReleaseDocument(result.documentPath),
    result.document,
  );
  assert.deepEqual(result.document.entries[0]!.modelSource.version.tools, []);
  assert.equal(
    result.document.entries[0]!.modelSource.version.instructions,
    bootstrapVersion.instructions,
  );
  await assert.rejects(lstat(fixture.marker), { code: "ENOENT" });
});

test("Thirty-two actual installed entries above 64 KiB share a stable model source and remain within the release protocol", async (t) => {
  const fixture = await nativePreparationFixture(t),
    identities = [fixture.identity];
  for (let index = 1; index < 32; index++)
    identities.push(
      (await fixture.addPlugin(`example.native-${index}`)).identity,
    );
  const input = await fixture.input({
    approvedPackages: identities,
    plugins: identities.map(({ pluginId }) => ({
      pluginId,
      approvalRequirement: "none",
    })),
  });
  const result = await prepareNativeInstalledPluginRelease(input);
  const outputBytes = await readFile(result.documentPath);
  assert.equal(result.document.entries.length, 32);
  assert.ok(outputBytes.byteLength > 65_536);
  assert.ok(outputBytes.byteLength <= INSTALLED_PLUGIN_RELEASE_MAX_BYTES);
  assert.equal(
    new Set(
      result.document.entries.map(
        (entry) => entry.modelSource.version.agentVersionId,
      ),
    ).size,
    1,
  );
  assert.equal(
    new Set(
      result.document.entries.map((entry) => entry.version.agentVersionId),
    ).size,
    32,
  );
  assert.deepEqual(
    readInstalledPluginReleaseDocument(result.documentPath),
    result.document,
  );
  assert.ok(
    Object.values(await fixture.recordCounts()).every((count) => count === 0),
  );
  await assert.rejects(lstat(fixture.marker), { code: "ENOENT" });
});

test("An automatic release exceeding the original 1 MiB aggregate limit is rejected without an output or publication", async (t) => {
  const fixture = await nativePreparationFixture(t),
    identities = [fixture.identity];
  for (let index = 1; index < 8; index++)
    identities.push(
      (await fixture.addPlugin(`example.oversized-${index}`)).identity,
    );
  const input = await fixture.input({
    approvedPackages: identities,
    plugins: identities.map(({ pluginId }) => ({
      pluginId,
      approvalRequirement: "none",
    })),
  });
  const { contentDigest: _digest, ...source } = input.bootstrapVersion;
  const bootstrapVersion = compileAgentVersion(
    {
      ...source,
      schemaVersion: "crewon.agent-version-source.v0",
      instructions: "\u0000".repeat(20_000),
    },
    installedPluginReleaseDigester,
  );
  await assert.rejects(
    prepareNativeInstalledPluginRelease({ ...input, bootstrapVersion }),
    /document_invalid|json_limit/u,
  );
  await assert.rejects(lstat(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
  assert.ok(
    Object.values(await fixture.recordCounts()).every((count) => count === 0),
  );
  await assert.rejects(lstat(fixture.marker), { code: "ENOENT" });
});

test("Native saved disabled configuration compiles without a prior default publication or importing installed Node", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  await fixture.removeSource();
  const before = await fixture.recordCounts();
  assert.ok(Object.values(before).every((count) => count === 0));
  const result = await prepareNativeInstalledPluginRelease(input);
  assert.equal(result.documentPath, join(input.directory, "release.json"));
  assert.deepEqual(
    readInstalledPluginReleaseDocument(result.documentPath),
    result.document,
  );
  assert.deepEqual(await fixture.recordCounts(), before);
  const entry = result.document.entries[0]!;
  assert.equal(entry.configuration.revision, 1);
  assert.equal(
    entry.packageIdentity.packageDigest,
    fixture.identity.packageDigest,
  );
  assert.equal(
    entry.modelSource.version.model.modelId,
    input.bootstrapVersion.model.modelId,
  );
  assert.deepEqual(entry.modelSource.version.tools, []);
  assert.deepEqual(entry.modelSource.version.resources, {
    workspaceRequired: false,
    governedContextDigest: null,
  });
  assert.equal(entry.modelSource.runtimeBinding.toolRuntimeMode, "independent");
  assert.equal(
    entry.modelSource.runtimeBinding.provider.kind,
    "directResponses",
  );
  assert.equal(entry.modelSource.runtimeBinding.workspaceBindingId, null);
  assert.equal(entry.version.tools.length, 1);
  assert.equal((await lstat(result.documentPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(result.documentPath)).nlink, 1);
  assert.equal(
    (await fixture.store
      .pluginInstallationStore()
      .loadSelection({ scope, pluginId: fixture.identity.pluginId }))!.state,
    "disabled",
  );
  assert.ok(fixture.state.requests.includes("/package"));
  await assert.rejects(lstat(fixture.marker), { code: "ENOENT" });
  assert.ok(
    fixture.state.requests.every((path) =>
      ["/actor", "/profile", "/package", "/policy"].includes(path),
    ),
  );
});

test("Preparation identities exclude private paths and credential values and share the unchanged real model source across configuration revisions", async (t) => {
  const fixture = await nativePreparationFixture(t);
  const first = await prepareNativeInstalledPluginRelease(
    await fixture.input(),
  );
  const nextInput = await fixture.input();
  nextInput.environment.CREWON_MODEL_API_KEY = "different-named-model-secret";
  nextInput.environment.NATIVE_INSTALLED_AUTHORITY_TOKEN = "b".repeat(48);
  const same = await prepareNativeInstalledPluginRelease(nextInput);
  assert.deepEqual(first.document, same.document);
  await fixture.revise();
  const revised = await prepareNativeInstalledPluginRelease(
    await fixture.input(),
  );
  assert.equal(revised.document.entries[0]!.configuration.revision, 2);
  assert.deepEqual(
    first.document.entries[0]!.modelSource,
    revised.document.entries[0]!.modelSource,
  );
  assert.notEqual(
    first.document.entries[0]!.version.agentVersionId,
    revised.document.entries[0]!.version.agentVersionId,
  );
  assert.notEqual(
    first.document.entries[0]!.target.materializationDigest,
    revised.document.entries[0]!.target.materializationDigest,
  );
});

test("Preparation reads enabled selection metadata but rejects an uninstalled selection", async (t) => {
  const fixture = await nativePreparationFixture(t);
  await fixture.select("enabled");
  await prepareNativeInstalledPluginRelease(await fixture.input());
  await fixture.select("uninstalled");
  const input = await fixture.input();
  await assert.rejects(
    prepareNativeInstalledPluginRelease(input),
    /selection_unavailable/u,
  );
  await assert.rejects(lstat(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
});

test("Preparation rejects a changed scope, actor or actual package authority without output", async (t) => {
  const fixture = await nativePreparationFixture(t);
  fixture.state.profile = { ...scope, profileId: "other-profile" };
  await assert.rejects(
    prepareNativeInstalledPluginRelease(await fixture.input()),
    /profile_changed/u,
  );
  fixture.state.profile = { ...scope };
  fixture.state.resolvedActor = null;
  await assert.rejects(
    prepareNativeInstalledPluginRelease(await fixture.input()),
    /actor_changed/u,
  );
  fixture.state.resolvedActor = {
    ...fixture.installation.package,
    principalId: "native-preparation-principal",
    actorId: "native-preparation-actor",
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
  };
  // The actual actor response is strict; metadata/audit fields must not impersonate an actor.
  await assert.rejects(
    prepareNativeInstalledPluginRelease(await fixture.input()),
  );
  fixture.state.resolvedActor = {
    principalId: "native-preparation-principal",
    actorId: "native-preparation-actor",
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
  };
  fixture.state.packageAllowed = false;
  await assert.rejects(
    prepareNativeInstalledPluginRelease(await fixture.input()),
    /package_forbidden/u,
  );
  fixture.state.packageAllowed = true;
  fixture.state.policyAllowed = false;
  await assert.rejects(
    prepareNativeInstalledPluginRelease(await fixture.input()),
    /read_forbidden/u,
  );
});

test("Latest saved configuration changing during package authorization prevents a stale output", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  fixture.state.beforeReply = async (path) => {
    if (path === "/package") {
      fixture.state.beforeReply = null;
      await fixture.revise();
    }
  };
  await assert.rejects(
    prepareNativeInstalledPluginRelease(input),
    /state_changed/u,
  );
  await assert.rejects(lstat(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
  assert.equal(
    (await fixture.store.extensionStore().loadLatestExtensionConfiguration({
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: fixture.identity.pluginId,
    }))!.revision,
    2,
  );
});

test("Actual private input mutation during an authority call prevents output", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  fixture.state.beforeReply = async () => {
    fixture.state.beforeReply = null;
    await writeFile(input.inputPath, JSON.stringify(input.preparation), {
      mode: 0o600,
    });
  };
  await assert.rejects(
    prepareNativeInstalledPluginRelease(input),
    /files_changed/u,
  );
  await assert.rejects(lstat(join(input.directory, "release.json")), {
    code: "ENOENT",
  });
});

test("Replacing the preparation directory inode is rejected even when its files remain identical", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  fixture.state.beforeReply = async () => {
    fixture.state.beforeReply = null;
    await rename(input.directory, `${input.directory}-old`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(input.directory, { mode: 0o700 });
    await writeFile(input.inputPath, JSON.stringify(input.preparation), {
      mode: 0o600,
    });
    await writeFile(input.workerPath, JSON.stringify(input.worker), {
      mode: 0o600,
    });
  };
  await assert.rejects(
    prepareNativeInstalledPluginRelease(input),
    /files_changed/u,
  );
});

test("An existing output is preserved and is never replaced by a preparation", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  const output = join(input.directory, "release.json");
  await writeFile(output, "existing owner content", { mode: 0o600 });
  await assert.rejects(
    prepareNativeInstalledPluginRelease(input),
    /output_exists/u,
  );
  assert.equal(await readFile(output, "utf8"), "existing owner content");
  assert.deepEqual(fixture.state.requests, []);
});

test("Private preparation rejects symlinks, hard links, broad permissions and wrong fixed paths before authority calls", async (t) => {
  const fixture = await nativePreparationFixture(t);
  const broad = await fixture.input();
  await chmod(broad.inputPath, 0o644);
  assert.throws(
    () =>
      loadNativeInstalledPluginPreparation({
        inputPath: broad.inputPath,
        environment: broad.environment,
        actor: broad.actor,
      }),
    /file_invalid/u,
  );
  const hard = await fixture.input();
  await link(hard.inputPath, join(hard.directory, "hard.json"));
  assert.throws(
    () =>
      loadNativeInstalledPluginPreparation({
        inputPath: hard.inputPath,
        environment: hard.environment,
        actor: hard.actor,
      }),
    /file_invalid/u,
  );
  const symbolic = await fixture.input();
  await rename(symbolic.inputPath, join(symbolic.directory, "original.json"));
  await symlink(join(symbolic.directory, "original.json"), symbolic.inputPath);
  assert.throws(
    () =>
      loadNativeInstalledPluginPreparation({
        inputPath: symbolic.inputPath,
        environment: symbolic.environment,
        actor: symbolic.actor,
      }),
    /file_invalid/u,
  );
  const wrong = await fixture.input({
    workerConfigurationPath: "/wrong/worker.json",
  });
  assert.throws(
    () =>
      loadNativeInstalledPluginPreparation({
        inputPath: wrong.inputPath,
        environment: wrong.environment,
        actor: wrong.actor,
      }),
    /path_invalid/u,
  );
  assert.deepEqual(fixture.state.requests, []);
});

test("Pure configuration parsing rejects unknown fields, getters, duplicates and missing package approval", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  assert.throws(() =>
    parseNativeInstalledPluginPreparationConfiguration({
      ...input.preparation,
      extra: true,
    }),
  );
  let getterCalls = 0;
  const accessor = { ...input.preparation };
  Object.defineProperty(accessor, "actor", {
    enumerable: true,
    get() {
      getterCalls++;
      return input.actor;
    },
  });
  assert.throws(() =>
    parseNativeInstalledPluginPreparationConfiguration(accessor),
  );
  assert.equal(getterCalls, 0);
  assert.throws(() =>
    parseNativeInstalledPluginPreparationConfiguration({
      ...input.preparation,
      plugins: [...input.preparation.plugins, ...input.preparation.plugins],
    }),
  );
  assert.throws(() =>
    parseNativeInstalledPluginPreparationConfiguration({
      ...input.preparation,
      approvedPackages: [
        ...input.preparation.approvedPackages,
        ...input.preparation.approvedPackages,
      ],
    }),
  );
  assert.throws(() =>
    parseNativeInstalledPluginPreparationConfiguration({
      ...input.preparation,
      plugins: [
        { pluginId: "unapproved.business", approvalRequirement: "none" },
      ],
    }),
  );
});

test("Native preparation rejects legacy or non-Native store environments before authority calls", async (t) => {
  const fixture = await nativePreparationFixture(t),
    input = await fixture.input();
  for (const extra of [
    { CREWON_EXTENSIONS_ENABLED: "1" },
    { CREWON_EXTENSION_HOST_TOKEN: "" },
    { CREWON_CONTROL_DATABASE_URL: "postgresql://database.invalid/db" },
    { CREWON_CONTROL_DB_PATH: join(fixture.dataDirectory, "other.sqlite") },
    { CREWON_RELEASE_PRINCIPAL_ID: "other-principal" },
  ]) {
    await assert.rejects(
      prepareNativeInstalledPluginRelease({
        ...input,
        environment: { ...input.environment, ...extra },
      }),
    );
  }
  assert.deepEqual(fixture.state.requests, []);
});
