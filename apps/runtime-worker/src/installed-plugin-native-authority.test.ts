import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { createInstalledPluginWorkerAuthority } from "./plugins/installed-plugin-worker-authority.ts";
import { parseInstalledPluginWorkerConfig } from "./plugins/installed-plugin-worker-config.ts";
import {
  loadInstalledPluginAuthorityConfig,
  parseInstalledPluginAuthorityConfig,
} from "./plugins/installed-plugin-authority-config.ts";
import {
  nativeActor,
  nativeAuthorityFixture,
  nativeDigest,
} from "./installed-plugin-native-authority.test-support.ts";
test("Native candidate package permission requires the exact disabled selection revision and never relaxes submit", async (t) => {
  const f = await nativeAuthorityFixture(t),
    execution = f.authority.installedPluginExecution,
    prepare = execution.authorizeCandidatePackage;
  assert.ok(prepare);
  const candidate = {
    packageDigest: f.identity.packageDigest,
    descriptor: parsePluginPackageDescriptor({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: f.identity.pluginId,
      publisherId: f.identity.publisherId,
      version: f.identity.version,
      title: "Named Native policy metadata test",
      description: "Metadata only; no plugin execution or external service.",
      entrypoints: { node: "node.mjs", ui: null },
      businessManifestPath: null,
      requires: [],
      provides: [],
      contributions: [],
      files: [
        { path: "node.mjs", byteLength: 1, sha256: nativeDigest("x").slice(7) },
      ],
    }),
  };
  const selection = await f.store.pluginInstallationStore().loadSelection({
    scope: f.scope,
    pluginId: f.identity.pluginId,
  });
  assert.ok(selection);
  const request = {
    candidate,
    scope: f.scope,
    expectedSelectionRevision: selection.revision,
  };
  const submit = () =>
    execution.authorizePackage(
      { candidate, scope: f.scope, purpose: "submit" },
      f.signal,
    );
  assert.equal(await prepare(request, f.signal), "allow");
  assert.equal(await submit(), "deny");
  assert.equal(
    await prepare(
      { ...request, expectedSelectionRevision: selection.revision + 1 },
      f.signal,
    ),
    "deny",
  );
  for (const field of ["pluginId", "publisherId", "version"] as const)
    assert.equal(
      await prepare(
        {
          ...request,
          candidate: {
            ...candidate,
            descriptor: {
              ...candidate.descriptor,
              [field]: field === "version" ? "2.0.0" : "foreign.identity",
            },
          },
        },
        f.signal,
      ),
      "deny",
    );
  assert.equal(
    await prepare(
      {
        ...request,
        candidate: { ...candidate, packageDigest: nativeDigest("foreign") },
      },
      f.signal,
    ),
    "deny",
  );
  await f.select("enabled");
  assert.equal(await prepare(request, f.signal), "deny");
  assert.equal(
    await prepare(
      { ...request, expectedSelectionRevision: selection.revision + 1 },
      f.signal,
    ),
    "deny",
  );
  assert.equal(await submit(), "allow");
  await f.select("disabled");
  assert.equal(await prepare(request, f.signal), "deny");
  assert.equal(
    await prepare(
      { ...request, expectedSelectionRevision: selection.revision + 2 },
      f.signal,
    ),
    "allow",
  );
  assert.equal(await submit(), "deny");
  let getterReads = 0;
  await assert.rejects(
    prepare(
      {
        ...request,
        get expectedSelectionRevision() {
          getterReads++;
          return selection.revision + 2;
        },
      },
      f.signal,
    ),
  );
  assert.equal(getterReads, 0);
  writeFileSync(
    f.policyPath,
    Buffer.concat([readFileSync(f.policyPath), Buffer.from(" ")]),
  );
  assert.throws(
    () =>
      prepare(
        { ...request, expectedSelectionRevision: selection.revision + 2 },
        f.signal,
      ),
    /file_changed/u,
  );
});
test("Native authority uses real Main bootstrap and actual SQLite installation, permits disabled candidate reads and requires enabled selection for submit", async (t) => {
  const f = await nativeAuthorityFixture(t),
    execution = f.authority.installedPluginExecution;
  assert.deepEqual(
    await execution.resolveActor(
      {
        tenantId: nativeActor.tenantId,
        spaceId: nativeActor.spaceId,
        actorId: nativeActor.actorId,
      },
      f.signal,
    ),
    nativeActor,
  );
  assert.equal(
    await execution.resolveActor(
      {
        tenantId: "foreign",
        spaceId: nativeActor.spaceId,
        actorId: nativeActor.actorId,
      },
      f.signal,
    ),
    null,
  );
  assert.deepEqual(
    await f.authority.resolveProfile(nativeActor, f.signal),
    f.scope,
  );
  await assert.rejects(
    f.authority.resolveProfile(
      { ...nativeActor, principalId: "foreign" },
      f.signal,
    ),
    /owner_mismatch/u,
  );
  assert.equal(
    await f.authority.authorizeRead(
      { identity: f.identity, scope: f.scope, purpose: "read" },
      f.signal,
    ),
    "allow",
  );
  assert.equal(
    await f.authority.authorizeRead(
      {
        identity: { ...f.identity, publisherId: "foreign.publisher" },
        scope: f.scope,
        purpose: "read",
      },
      f.signal,
    ),
    "deny",
  );
  const request = {
    actor: nativeActor,
    action: "extension:run" as const,
    resource: {
      kind: "extension" as const,
      tenantId: nativeActor.tenantId,
      spaceId: nativeActor.spaceId,
      pluginId: f.identity.pluginId,
    },
  };
  assert.equal(
    (await execution.authorization.authorize(request)).outcome,
    "deny",
  );
  await f.select("enabled");
  assert.equal(
    (await execution.authorization.authorize(request)).outcome,
    "allow",
  );
  await f.select("disabled");
  assert.equal(
    (await execution.authorization.authorize(request)).outcome,
    "deny",
  );
  assert.equal(
    (
      await execution.authorization.authorize({
        ...request,
        action: "extension:read",
      })
    ).outcome,
    "allow",
  );
  await f.authority.close();
  assert.throws(
    () => f.authority.resolveProfile(nativeActor, f.signal),
    /closed/u,
  );
});
for (const field of [
  "approvalPath",
  "policyPath",
  "profilePath",
  "authorityPath",
  "configurationPath",
] as const)
  test(`Native authority immediately rejects changed ${field} before another decision`, async (t) => {
    const f = await nativeAuthorityFixture(t),
      path = f[field],
      bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from(" ")]));
    assert.throws(
      () => f.authority.resolveProfile(nativeActor, f.signal),
      /file_changed/u,
    );
  });
test("Native authority rejects same bytes replaced by another inode", async (t) => {
  const f = await nativeAuthorityFixture(t),
    replacement = `${f.authorityPath}.replacement`;
  writeFileSync(replacement, readFileSync(f.authorityPath), { mode: 0o600 });
  renameSync(replacement, f.authorityPath);
  assert.throws(
    () => f.authority.resolveProfile(nativeActor, f.signal),
    /file_changed/u,
  );
});
for (const kind of ["file", "symlink", "directory"] as const)
  test(`Native authority rejects a ${kind} at Main's fixed withdrawal marker before any further decision or new capture`, async (t) => {
    const f = await nativeAuthorityFixture(t);
    assert.deepEqual(
      await f.authority.resolveProfile(nativeActor, f.signal),
      f.scope,
    );
    const path = join(dirname(f.authorityPath), "withdrawn.json");
    if (kind === "directory") mkdirSync(path, { mode: 0o700 });
    else if (kind === "symlink") symlinkSync("nonexistent", path);
    else
      writeFileSync(
        path,
        JSON.stringify({ authorityId: f.document.authorityId }),
        { mode: 0o600, flag: "wx" },
      );
    assert.throws(
      () => f.authority.resolveProfile(nativeActor, f.signal),
      /withdrawn/u,
    );
    assert.throws(
      () => createInstalledPluginWorkerAuthority(f.config),
      /withdrawn/u,
    );
    if (kind === "file") {
      unlinkSync(path);
      assert.throws(
        () => f.authority.resolveProfile(nativeActor, f.signal),
        /withdrawn/u,
      );
    }
  });
test("Native authority rejects unsafe file mode and copied factory configuration", async (t) => {
  const f = await nativeAuthorityFixture(t);
  assert.throws(
    () => createInstalledPluginWorkerAuthority({ ...f.config }),
    /configuration_unissued/u,
  );
  chmodSync(f.authorityPath, 0o644);
  assert.throws(
    () => f.authority.resolveProfile(nativeActor, f.signal),
    /file_invalid/u,
  );
});
test("Native package decision refuses caller getters without evaluating nested identity fields", async (t) => {
  const f = await nativeAuthorityFixture(t);
  let reads = 0;
  const identity = { ...f.identity };
  Object.defineProperty(identity, "publisherId", {
    enumerable: true,
    get() {
      reads++;
      return f.identity.publisherId;
    },
  });
  await assert.rejects(
    f.authority.authorizeRead(
      { identity, scope: f.scope, purpose: "read" },
      f.signal,
    ),
  );
  assert.equal(reads, 0);
});

test("Native worker schema is distinct: legacy remote parser rejects it and Native parser never accepts remote service fields", async (t) => {
  const f = await nativeAuthorityFixture(t);
  assert.throws(
    () => parseInstalledPluginWorkerConfig(f.configuration, {}),
    /configuration_invalid/u,
  );
  assert.throws(() =>
    parseInstalledPluginAuthorityConfig(
      {
        ...f.configuration,
        actorAuthority: {
          url: "http://127.0.0.1:1234/",
          serviceTokenEnvironmentVariable: "FAKE",
        },
      },
      {},
    ),
  );
  const altered = {
    ...f.document,
    actor: { ...nativeActor, actorId: "foreign" },
  };
  writeFileSync(f.authorityPath, JSON.stringify(altered));
  assert.throws(
    () =>
      createInstalledPluginWorkerAuthority(
        loadInstalledPluginAuthorityConfig(f.configurationPath, {}),
      ),
    /desktop_native_plugin_authority_invalid/u,
  );
});
