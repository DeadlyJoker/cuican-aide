import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  actor,
  scope,
  businessManifest,
  digester,
  metadataFixture,
} from "./installed-plugin-configuration.test-support.ts";
import { deferred } from "./installed-plugin-task.test-support.ts";

test("disabled actual installed package exposes verified generic metadata without executing its throwing Node entry", async (t) => {
  const f = await metadataFixture(t),
    prepared = await f.prepare();
  const registration = prepared.catalog.resolve({
    pluginId: businessManifest.pluginId,
    pluginVersion: "1.0.0",
  });
  assert.ok(registration);
  assert.deepEqual(registration.manifest, businessManifest);
  assert.equal(prepared.catalog.list().length, 1);
  assert.equal(
    prepared.host.taskAdmissionMode?.({
      registration: structuredClone(registration),
    }),
    "installed",
  );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: businessManifest.pluginId,
      pluginVersion: "1.0.0",
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      revision: 1,
      parameters: { organization: "Actual fixture" },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    digester,
  );
  await prepared.host.validateConfiguration({
    actor,
    registration: structuredClone(registration),
    configuration,
  });
  assert.deepEqual(
    await prepared.host.evaluate({
      actor,
      registration,
      configuration,
      agentVersionId: "unpublished-agent",
    }),
    { outcome: "unavailable", reasonCode: "extension_runtime_unavailable" },
  );
  const foreign = createExtensionConfiguration(
    { ...configuration, tenantId: "foreign-tenant", spaceId: "foreign-space" },
    digester,
  );
  await assert.rejects(
    prepared.host.validateConfiguration({
      actor,
      registration,
      configuration: foreign,
    }),
    /metadata_authority_denied/,
  );
  assert.deepEqual((await f.prepare("2.0.0")).catalog.list(), []);
  assert.equal(
    prepared.catalog.resolve({ ...configuration, pluginVersion: "2.0.0" }),
    null,
  );
});
test("current installed selection changes invalidate captured metadata and no uninstalled version is substituted", async (t) => {
  const f = await metadataFixture(t),
    prepared = await f.prepare();
  const registration = prepared.catalog.list()[0]!;
  await f.uninstall();
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: businessManifest.pluginId,
      pluginVersion: "1.0.0",
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      revision: 1,
      parameters: { organization: "Actual fixture" },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    digester,
  );
  await assert.rejects(
    prepared.host.validateConfiguration({ actor, registration, configuration }),
    /metadata_authority_denied/,
  );
  assert.deepEqual((await f.prepare()).catalog.list(), []);
});
test("damaged actual immutable business bytes and denied read permission fail rather than disappearing as UI-only entries", async (t) => {
  const f = await metadataFixture(t);
  f.state.allowed = false;
  await assert.rejects(f.prepare());
  f.state.allowed = true;
  const path = join(f.artifact.installed.directory, "business.json");
  await chmod(path, 0o600);
  await writeFile(path, "{}");
  await assert.rejects(f.prepare());
});
test("metadata command getters are never evaluated and returned catalog/host cannot escape owner lifetime", async (t) => {
  const f = await metadataFixture(t);
  let hooks = 0;
  const hostile = Object.defineProperty({}, "kind", {
    enumerable: true,
    get() {
      hooks++;
      return "catalog";
    },
  });
  assert.throws(() =>
    f.metadata.prepare(
      { actor, scope, request: hostile as never },
      { signal: new AbortController().signal },
    ),
  );
  assert.equal(hooks, 0);
  const prepared = await f.prepare();
  await f.metadata.close();
  assert.throws(() => prepared.catalog.list());
  assert.throws(() =>
    prepared.catalog.resolve({
      pluginId: businessManifest.pluginId,
      pluginVersion: "1.0.0",
    }),
  );
  await assert.rejects(prepared.host.evaluate({} as never));
});
test("withdrawal synchronously rejects metadata but close physically joins already-started read authority", async (t) => {
  const f = await metadataFixture(t),
    entered = deferred(),
    release = deferred();
  f.state.onRead = async () => {
    entered.resolve();
    await release.promise;
  };
  const operation = f.prepare();
  void operation.catch(() => {});
  await entered.promise;
  let closed = false;
  const closing = f.metadata.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.throws(() => f.prepare());
  release.resolve();
  await assert.rejects(operation);
  await closing;
  assert.equal(closed, true);
});
test("metadata admission keeps physical pending capacity after caller abort and rejects a 129th operation", async (t) => {
  const f = await metadataFixture(t),
    release = deferred();
  let reads = 0;
  const { InstalledPluginConfigurationMetadata } = await import(
    "./installed-plugin-configuration-metadata.ts"
  );
  const actual = f.storage.first.store;
  const metadata = new InstalledPluginConfigurationMetadata({
    installRoot: f.artifact.input.installRoot,
    maximumPackages: 8,
    installations: {
      loadSelection: async (input) => {
        reads++;
        await release.promise;
        return actual.loadSelection(input);
      },
      loadPackage: actual.loadPackage.bind(actual),
      listSelections: actual.listSelections.bind(actual),
    },
    authorizeRead: async () => "allow",
  });
  const caller = new AbortController(),
    work: Promise<unknown>[] = [];
  for (let i = 0; i < 128; i++) {
    const pending = metadata.prepare(
      {
        actor,
        scope,
        request: {
          kind: "registration",
          pluginId: businessManifest.pluginId,
          pluginVersion: "1.0.0",
        },
      },
      { signal: caller.signal },
    );
    void pending.catch(() => {});
    work.push(pending);
  }
  await Promise.resolve();
  assert.equal(reads, 128);
  caller.abort();
  assert.throws(
    () =>
      metadata.prepare(
        { actor, scope, request: { kind: "catalog" } },
        { signal: new AbortController().signal },
      ),
    /capacity_exceeded/,
  );
  let closed = false;
  const closing = metadata.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release.resolve();
  await Promise.allSettled(work);
  await closing;
});
test("real ledger uninstall history spans pages without consuming the live selected package budget", async (t) => {
  const f = await metadataFixture(t);
  const { installationRecipe, selectionRecipe } = await import(
    "../../../packages/store/src/plugin-installation-store.test-support.ts"
  );
  for (let i = 0; i < 55; i++) {
    const installed = await f.storage.first.store.recordInstalledPackage(
      installationRecipe(`historical-${i}`, {
        actor,
        scope,
        pluginId: `aaa.history-${String(i).padStart(2, "0")}`,
      }),
    );
    await f.storage.first.store.commitSelection(
      selectionRecipe(installed.selection, `uninstall-historical-${i}`, {
        actor,
        state: "uninstalled",
      }),
    );
  }
  const prepared = await f.metadata.prepare(
    { actor, scope, request: { kind: "catalog" } },
    { signal: new AbortController().signal },
  );
  assert.equal(prepared.catalog.list().length, 1);
  assert.equal(
    prepared.catalog.list()[0]?.manifest.pluginId,
    businessManifest.pluginId,
  );
  assert.ok(f.state.reads > 0);
});
test("two actually installed live packages exceed an explicit one-package metadata verification budget", async (t) => {
  const f = await metadataFixture(t);
  const { createHash } = await import("node:crypto");
  const { mkdir, mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { installLocalPluginPackage } = await import("@crewon/plugin-host");
  const { installationRecipe } = await import(
    "../../../packages/store/src/plugin-installation-store.test-support.ts"
  );
  const { InstalledPluginConfigurationMetadata } = await import(
    "./installed-plugin-configuration-metadata.ts"
  );
  const source = await mkdtemp(
    join(tmpdir(), "crewon-second-business-metadata-"),
  );
  t.after(() => rm(source, { recursive: true, force: true }));
  const files = [];
  for (const declared of f.artifact.installed.descriptor.files) {
    const bytes =
      declared.path === "business.json"
        ? Buffer.from(
            JSON.stringify({
              ...businessManifest,
              pluginId: "example.secondary",
            }),
          )
        : await readFile(join(f.artifact.installed.directory, declared.path));
    await mkdir(join(source, declared.path, ".."), { recursive: true });
    await writeFile(join(source, declared.path), bytes);
    files.push({
      path: declared.path,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(
    join(source, "crewon.plugin.json"),
    JSON.stringify({
      ...f.artifact.installed.descriptor,
      pluginId: "example.secondary",
      files,
    }),
  );
  const actual = await installLocalPluginPackage({
    directory: source,
    installRoot: f.artifact.input.installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  await f.storage.first.store.recordInstalledPackage(
    installationRecipe("second-real-installed", {
      actor,
      scope,
      pluginId: actual.descriptor.pluginId,
      version: actual.descriptor.version,
      publisherId: actual.descriptor.publisherId,
      packageDigest: actual.packageDigest,
    }),
  );
  let verified = 0;
  const bounded = new InstalledPluginConfigurationMetadata({
    installRoot: f.artifact.input.installRoot,
    installations: f.storage.first.store,
    maximumPackages: 1,
    authorizeRead: async () => {
      verified++;
      return "allow";
    },
  });
  t.after(() => bounded.close());
  await assert.rejects(
    bounded.prepare(
      { actor, scope, request: { kind: "catalog" } },
      { signal: new AbortController().signal },
    ),
    /metadata_capacity_exceeded/,
  );
  assert.equal(verified, 0);
});
