import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { PluginNodeHost } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import {
  createDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { InstallationProfile } from "./production-plugin-installation-profile.ts";
import {
  deferred,
  managementActor,
  managementFixture,
  managementScope,
  postgresOptions,
} from "./production-plugin-installation-runtime.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";

/** Intercept only scheduling: identity, dependencies, authorization and publication remain real. */
function beforeActualNodeCommit(t: TestContext, beforeCommit: () => void) {
  const prepare = PluginNodeHost.prototype.prepare;
  t.mock.method(
    PluginNodeHost.prototype,
    "prepare",
    async function (
      this: PluginNodeHost,
      input: Parameters<PluginNodeHost["prepare"]>[0],
    ) {
      const actual = await prepare.call(this, input);
      return Object.freeze({
        ...actual,
        commit(value: Parameters<typeof actual.commit>[0]) {
          beforeCommit();
          return actual.commit(value);
        },
      });
    },
  );
}

test("SQLite close synchronously invalidates a real post-COMMIT candidate before its queued publication", async (t) => {
  let store: SqliteRunStore | undefined;
  let runtime: DesktopPluginInstallationRuntime | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
      await store?.close();
    },
  });
  const pkg = await f.source("shutdown-node", { validNode: true });
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor: managementActor,
    scope: managementScope,
    authorityEpoch: "native-approved-shutdown-regression-epoch-01",
    installRoot: f.installRoot,
    sources: [
      {
        sourceId: pkg.sourceId,
        directory: pkg.directory,
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        version: pkg.version,
        packageDigest: pkg.packageDigest,
      },
    ],
    publications: [],
  });
  const databasePath = join(f.root, "shutdown.sqlite");
  store = new SqliteRunStore(databasePath);
  const ledger = store.pluginInstallationStore();
  await ledger.migrate();
  runtime = await createDesktopPluginInstallationRuntime(
    {
      configuration,
      registry: await createDesktopPluginSourceRegistry(configuration),
      authority: new DesktopPluginAuthority(configuration),
    },
    {
      store,
      clock: { now: () => "2026-10-03T04:00:00.000Z" },
      digester: {
        sha256: (value) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
    },
  );
  await runtime.service.install(managementActor, {
    sourceId: pkg.sourceId,
    expectedPluginId: pkg.pluginId,
    expectedPackageDigest: pkg.packageDigest,
    expectedSelectionRevision: null,
    idempotencyKey: "shutdown-install",
  });
  const observer = new DatabaseSync(databasePath);
  let closing: Promise<void> | undefined;
  let commits = 0;
  beforeActualNodeCommit(t, () => {
    commits++;
    // This barrier is after the actual main SQLite COMMIT and the private refresh/stamp.
    const row = observer
      .prepare("SELECT state,revision FROM plugin_profile_selections")
      .get();
    assert.equal(row?.state, "enabled");
    assert.equal(row?.revision, 2);
    closing = runtime!.close();
    assert.equal(runtime!.close(), closing);
  });
  let result;
  try {
    result = await runtime.service.select(managementActor, {
      pluginId: pkg.pluginId,
      state: "enabled",
      selectedPackageDigest: pkg.packageDigest,
      expectedSelectionRevision: 1,
      idempotencyKey: "shutdown-enable",
    });
  } finally {
    observer.close();
  }
  assert.equal(commits, 1);
  assert.equal(result.mutation.disposition, "committed");
  assert.equal(result.mutation.selection.state, "enabled");
  assert.equal(result.projection.outcome, "pending");
  await closing;
  assert.match(await readFile(f.marker, "utf8"), /shutdown-node:dispose/u);
  assert.throws(
    () =>
      runtime!.service.getSelection(managementActor, {
        pluginId: pkg.pluginId,
      }),
    /runtime_closed/u,
  );
  // Close physically released the actual sidecar reservation; durable selection remains exact.
  const nextOwner = await ledger.acquireProfileOwner({
    scope: managementScope,
    onOwnershipLost() {},
  });
  try {
    assert.deepEqual(
      nextOwner.currentSelection({
        scope: managementScope,
        pluginId: pkg.pluginId,
      }),
      result.mutation.selection,
    );
  } finally {
    await nextOwner.close();
  }
});

test(
  "Postgres close synchronously invalidates a real stamped candidate while preserving its committed receipt",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const pkg = await f.source();
    const runtime = await f.open();
    await f.install(runtime, pkg);
    let closing: Promise<void> | undefined;
    let commits = 0;
    beforeActualNodeCommit(t, () => {
      commits++;
      closing = runtime.close();
      assert.equal(runtime.close(), closing);
    });
    const result = await f.select(
      runtime,
      pkg,
      1,
      "enabled",
      "shutdown-enable",
    );
    assert.equal(commits, 1);
    assert.equal(result.mutation.disposition, "committed");
    assert.equal(result.mutation.selection.state, "enabled");
    assert.equal(result.projection.outcome, "pending");
    assert.deepEqual(
      await f.selection(pkg.pluginId),
      result.mutation.selection,
    );
    await closing;
    assert.deepEqual(await f.ownerPids(), []);
    assert.deepEqual(await f.events(), [
      "setup:test.management:1.0.0",
      "cleanup:test.management:1.0.0",
    ]);
    const reopened = await f.open();
    const replay = await f.select(
      reopened,
      pkg,
      1,
      "enabled",
      "shutdown-enable",
    );
    assert.equal(replay.mutation.disposition, "replayed");
    assert.deepEqual(replay.mutation.selection, result.mutation.selection);
    assert.equal(replay.projection.outcome, "unchanged");
    assert.equal((await f.events()).length, 2);
  },
);

test(
  "Postgres close joins an actual late profile owner and withdraws it before use",
  postgresOptions,
  async (t) => {
    const f = await managementFixture(t);
    const pkg = await f.source();
    const runtime = await f.open();
    const entered = deferred();
    const release = deferred();
    const open = InstallationProfile.open;
    let actual: InstallationProfile | undefined;
    t.mock.method(
      InstallationProfile,
      "open",
      async (dependencies: Parameters<typeof open>[0]) => {
        actual = await open.call(InstallationProfile, dependencies);
        entered.resolve();
        await release.promise;
        return actual;
      },
    );
    const read = runtime.service.getSelection(managementActor, {
      pluginId: pkg.pluginId,
    });
    const rejected = assert.rejects(read, /runtime_closed/u);
    await entered.promise;
    assert.equal((await f.ownerPids()).length, 1);
    let completed = false;
    const closing = runtime.close();
    void closing.then(() => {
      completed = true;
    });
    try {
      assert.equal(runtime.close(), closing);
      assert.equal(completed, false);
      assert.equal((await f.ownerPids()).length, 1);
      assert.equal(
        await f.ledger.loadSelection({
          scope: managementScope,
          pluginId: pkg.pluginId,
        }),
        null,
      );
    } finally {
      release.resolve();
    }
    await rejected;
    assert.throws(
      () =>
        actual!.run(managementActor, "getSelection", {
          pluginId: pkg.pluginId,
        }),
      /profile_unavailable/u,
    );
    await closing;
    assert.deepEqual(await f.ownerPids(), []);
    assert.deepEqual(await f.events(), []);
  },
);
