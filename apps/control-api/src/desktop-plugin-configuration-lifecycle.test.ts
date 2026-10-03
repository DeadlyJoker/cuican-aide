import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SqliteRunStore } from "@crewon/store";
import {
  createDesktopPluginRuntime,
  type DesktopPluginRuntime,
} from "./desktop-plugin-runtime.ts";
import { createDesktopPluginConfigurationRuntime } from "./desktop-plugin-configuration-runtime.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { createDesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import {
  nativeConfigurationActor as actor,
  nativeConfigurationHeaders as headers,
  nativeConfigurationFixture,
  nativeConfigurationManifest as manifest,
  nativeConfigurationScope as scope,
} from "./desktop-plugin-configuration.test-support.ts";

const clock = { now: () => "2026-10-03T00:00:00.000Z" };
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const request = Object.freeze({
  method: "PUT",
  url: `/api/v1/extensions/${manifest.pluginId}/configuration`,
  remoteAddress: "127.0.0.1",
  headers,
});
function identity() {
  return new StandaloneIdentity({
    actor,
    sessionToken: "s".repeat(32),
    csrfToken: "c".repeat(32),
    allowedOrigins: ["crewon://desktop"],
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  "Native close revokes configuration authority synchronously and joins an actual captured request before releasing its profile",
  { timeout: 10000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    let runtime: DesktopPluginRuntime | undefined;
    let store: SqliteRunStore | undefined;
    const f = await nativeConfigurationFixture(t, {
      beforeCleanup: async () => {
        release.resolve();
        await runtime?.close();
        await store?.close();
      },
    });
    const pkg = await f.source("close-business");
    const configuration = f.configuration([pkg]);
    store = new SqliteRunStore(f.databasePath);
    runtime = await createDesktopPluginRuntime(
      { configuration },
      {
        store,
        identity: identity(),
        clock,
        digester,
      },
    );
    const owner = runtime.configuration.requests;
    const pending = owner.run(
      { request, actor, preparation: "configuration" },
      async () => {
        assert.deepEqual(owner.currentActor(), actor);
        assert.equal(owner.currentSignal().aborted, false);
        entered.resolve();
        await release.promise;
        await owner.assertCurrent();
      },
    );
    const rejected = assert.rejects(
      pending,
      /installed_plugin_request_authority_unavailable/u,
    );
    await entered.promise;
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    assert.throws(
      () =>
        owner.run(
          { request, actor, preparation: "configuration" },
          async () => {},
        ),
      /installed_plugin_request_authority_unavailable/u,
    );
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(
      closed,
      false,
      "the actual pending callback is still physically blocked",
    );
    // The parent SQLite remains open until its runtime owner finishes.
    assert.equal(
      await store.loadThread({ tenantId: actor.tenantId, threadId: "unused" }),
      null,
    );
    release.resolve();
    await rejected;
    await closing;
    assert.equal(closed, true);
    assert.equal(f.facts().counts.extension_configurations, 0);
    await f.assertMetadataOnly();
    // A new real runtime can acquire the same file-backed profile after joined close.
    runtime = await createDesktopPluginRuntime(
      { configuration },
      {
        store,
        identity: identity(),
        clock,
        digester,
      },
    );
    const reopened = await runtime.configuration.requests.run(
      { request, actor, preparation: "configuration" },
      async () =>
        runtime!.configuration.extensions.getConfiguration(actor, {
          pluginId: pkg.pluginId,
          revision: null,
        }),
    );
    assert.equal(reopened, null);
  },
);

test("Native request actor cannot replace the actual StandaloneIdentity, and copied identity dependencies grant no configuration authority", async (t) => {
  let runtime: DesktopPluginRuntime | undefined;
  let store: SqliteRunStore | undefined;
  const f = await nativeConfigurationFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
      await store?.close();
    },
  });
  const pkg = await f.source("actual-identity-business");
  const configuration = f.configuration([pkg]);
  store = new SqliteRunStore(f.databasePath);
  const actualIdentity = identity();
  await assert.rejects(
    createDesktopPluginRuntime(
      { configuration },
      {
        store,
        identity: { ...actualIdentity } as StandaloneIdentity,
        clock,
        digester,
      },
    ),
    /desktop_plugin_identity_required/u,
  );
  assert.ok(!f.facts().tables.includes("extension_configurations"));
  runtime = await createDesktopPluginRuntime(
    { configuration },
    {
      store,
      identity: actualIdentity,
      clock,
      digester,
    },
  );
  let work = 0;
  for (const changed of [
    { principalId: "foreign-principal" },
    { actorId: "foreign-actor" },
    { tenantId: "foreign-tenant" },
    { spaceId: "foreign-space" },
  ]) {
    await assert.rejects(
      runtime.configuration.requests.run(
        {
          request,
          actor: { ...actor, ...changed },
          preparation: "configuration",
        },
        async () => {
          work++;
        },
      ),
      /installed_plugin_request_authority_unavailable/u,
    );
  }
  assert.equal(work, 0);
  assert.equal(f.facts().counts.extension_configurations, 0);
  await f.assertMetadataOnly();
});

test("Native metadata composition refuses an authority for a different real profile before schema migration", async (t) => {
  let store: SqliteRunStore | undefined;
  const f = await nativeConfigurationFixture(t, {
    beforeCleanup: async () => {
      await store?.close();
    },
  });
  const pkg = await f.source("profile-business");
  const configuration = f.configuration([pkg]);
  const wrongProfile = f.configuration([pkg], {
    ...scope,
    profileId: "another-native-profile",
  });
  const registry = await createDesktopPluginSourceRegistry(configuration);
  const authority = new DesktopPluginAuthority(wrongProfile);
  const actualAuthority = new DesktopPluginAuthority(configuration);
  store = new SqliteRunStore(f.databasePath);
  const ledger = store.pluginInstallationStore();
  await ledger.migrate();
  const installation = await createDesktopPluginInstallationRuntime(
    { configuration, registry, authority: actualAuthority },
    { store, clock, digester },
  );
  try {
    await assert.rejects(
      createDesktopPluginConfigurationRuntime(
        { configuration, registry, authority, installation },
        {
          store,
          identity: identity(),
          clock,
          digester,
        },
      ),
      /desktop_plugin_profile_mismatch/u,
    );
    assert.ok(!f.facts().tables.includes("extension_configurations"));
  } finally {
    await installation.close();
    await authority.close();
  }
});
