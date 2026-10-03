import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import { createDesktopPluginConfigurationRuntime } from "./desktop-plugin-configuration-runtime.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  createDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { createStandaloneControlApiWithPlugins } from "./standalone-composition.ts";
import {
  nativeConfigurationActor as actor,
  nativeConfigurationHeaders as headers,
  nativeConfigurationFixture,
  nativeConfigurationManifest as manifest,
  nativeConfigurationSave as save,
} from "./desktop-plugin-configuration.test-support.ts";

const clock = { now: () => "2026-10-03T00:00:00.000Z" };
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const base = `/api/v1/extensions/${manifest.pluginId}`;

test("Native configuration observes actual profile sidecar takeover before reads, writes or receipt replay while its new owner remains usable", async (t) => {
  let replacementOwner:
    | Awaited<ReturnType<typeof createStandaloneControlApiWithPlugins>>
    | undefined;
  let originalLock: string | undefined;
  let savedLock: string | undefined;
  const restore = async () => {
    if (originalLock === undefined || savedLock === undefined) return;
    await rm(originalLock);
    await rename(savedLock, originalLock);
    originalLock = undefined;
    savedLock = undefined;
  };
  const f = await nativeConfigurationFixture(t, {
    beforeCleanup: async () => {
      await replacementOwner?.app.close();
      await restore();
    },
  });
  const pkg = await f.source("actual-profile-owner-business");
  const configuration = f.configuration([pkg]);
  await f.open(configuration);
  await f.install(pkg);
  const committed = await f.request(
    "PUT",
    `${base}/configuration`,
    save,
    "actual-owner-original-save",
  );
  assert.equal(committed.statusCode, 200, committed.body);
  const lockRoot = f.databasePath + ".plugin-profile-locks";
  const lockFiles = (await readdir(lockRoot)).filter((path) =>
    path.endsWith(".sqlite"),
  );
  assert.equal(lockFiles.length, 1);
  originalLock = join(lockRoot, lockFiles[0]!);
  savedLock = join(f.root, "original-held-profile-sidecar.sqlite");
  await rename(originalLock, savedLock);
  const replacement = new DatabaseSync(originalLock);
  replacement.close();
  await chmod(originalLock, 0o600);
  // This actual second Control acquires BEGIN IMMEDIATE on the replacement inode, while
  // the first still owns its original opened sidecar. No ownership callback is injected.
  replacementOwner = await createStandaloneControlApiWithPlugins({
    ...f.baseConfig(),
    desktopPlugins: configuration,
  });
  const readable = await replacementOwner.app.inject({
    method: "GET",
    url: `${base}/configuration`,
    headers,
  });
  assert.equal(readable.statusCode, 200, readable.body);
  assert.deepEqual(
    readable.json().configuration,
    committed.json().configuration,
  );
  const changed = {
    ...save,
    expectedRevision: 1,
    parameters: { organization: "Actual replacement owner" },
  };
  for (const [method, url, payload, key] of [
    ["GET", `${base}/configuration`, undefined, undefined],
    ["GET", "/api/v1/extensions", undefined, undefined],
    ["PUT", `${base}/configuration`, changed, "old-owner-cannot-write"],
    ["PUT", `${base}/configuration`, save, "actual-owner-original-save"],
  ] as const) {
    const denied = await f.request(method, url, payload, key);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(
      denied.json().error.code,
      "installed_plugin_request_authority_unavailable",
    );
  }
  assert.equal(f.facts().counts.extension_configurations, 1);
  assert.equal(f.facts().counts.extension_mutation_receipts, 1);
  const saved = await replacementOwner.app.inject({
    method: "PUT",
    url: `${base}/configuration`,
    headers: { ...headers, "idempotency-key": "replacement-owner-save" },
    payload: changed,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().configuration.revision, 2);
  await f.close();
  // Closing the obsolete claim does not close the replacement owner's connection or grant.
  const stillOwned = await replacementOwner.app.inject({
    method: "GET",
    url: `${base}/configuration`,
    headers,
  });
  assert.equal(stillOwned.statusCode, 200, stillOwned.body);
  assert.deepEqual(stillOwned.json().configuration, saved.json().configuration);
  await replacementOwner.app.close();
  replacementOwner = undefined;
  await restore();
  await f.open(configuration);
  const reopened = await f.request("GET", `${base}/configuration`);
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.deepEqual(reopened.json().configuration, saved.json().configuration);
  await f.assertMetadataOnly();
});

test("Native configuration requires the actual issued profile coordinator with its exact parent Store, grant and registry before migration", async (t) => {
  let store: SqliteRunStore | undefined;
  let foreignStore: SqliteRunStore | undefined;
  let installation: DesktopPluginInstallationRuntime | undefined;
  const f = await nativeConfigurationFixture(t, {
    beforeCleanup: async () => {
      await installation?.close();
      await store?.close();
      await foreignStore?.close();
    },
  });
  const pkg = await f.source("issued-profile-owner-business");
  const configuration = f.configuration([pkg]);
  const registry = await createDesktopPluginSourceRegistry(configuration);
  const authority = new DesktopPluginAuthority(configuration);
  const copiedGrant = new DesktopPluginAuthority(configuration);
  const anotherRegistry =
    await createDesktopPluginSourceRegistry(configuration);
  store = new SqliteRunStore(f.databasePath);
  foreignStore = new SqliteRunStore(join(f.root, "foreign-parent.sqlite"));
  await store.pluginInstallationStore().migrate();
  installation = await createDesktopPluginInstallationRuntime(
    { configuration, registry, authority },
    { store, clock, digester },
  );
  const identity = new StandaloneIdentity({
    actor,
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
  });
  await assert.rejects(
    createDesktopPluginConfigurationRuntime(
      { configuration, registry, authority, installation: { ...installation } },
      { store, identity, clock, digester },
    ),
    /desktop_plugin_installation_runtime_required/u,
  );
  for (const changed of [
    { store: foreignStore, registry, authority },
    { store, registry: anotherRegistry, authority },
    { store, registry, authority: copiedGrant },
  ]) {
    await assert.rejects(
      createDesktopPluginConfigurationRuntime(
        {
          configuration,
          registry: changed.registry,
          authority: changed.authority,
          installation,
        },
        { store: changed.store, identity, clock, digester },
      ),
      /desktop_plugin_installation_runtime_configuration_mismatch/u,
    );
  }
  assert.ok(!f.facts().tables.includes("extension_configurations"));
  const observer = new DatabaseSync(join(f.root, "foreign-parent.sqlite"));
  try {
    assert.equal(
      observer
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='extension_configurations'",
        )
        .get()!.n,
      0,
    );
  } finally {
    observer.close();
  }
  const actual = await createDesktopPluginConfigurationRuntime(
    { configuration, registry, authority, installation },
    { store, identity, clock, digester },
  );
  try {
    const catalog = await actual.requests.run(
      {
        request: {
          method: "GET",
          url: "/api/v1/extensions",
          remoteAddress: "127.0.0.1",
          headers,
        },
        actor,
        preparation: "configuration",
      },
      () => actual.extensionReads.getCatalog(actor),
    );
    assert.deepEqual(catalog, { extensions: [] });
  } finally {
    await actual.close();
    await copiedGrant.close();
  }
});
