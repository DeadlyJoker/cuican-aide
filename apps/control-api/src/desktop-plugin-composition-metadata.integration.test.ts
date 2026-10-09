import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteRunStore } from "@crewon/store";
import {
  createDesktopPluginRuntime,
  type DesktopPluginRuntime,
} from "./desktop-plugin-runtime.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";

const actor = {
  principalId: "native-owner",
  actorId: "native-user",
  tenantId: "native-tenant",
  spaceId: "native-space",
};
const scope = {
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "native-profile",
};
const clock = { now: () => "2026-10-10T00:00:00.000Z" };
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

async function fixture(t: TestContext) {
  let runtime: DesktopPluginRuntime | undefined;
  let store: SqliteRunStore | undefined;
  const f = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
      await store?.close();
    },
  });
  const v1 = await f.source("report-v1", { validNode: true });
  const v2 = await f.source("report-v2", { validNode: true, version: "2.0.0" });
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "native-approved-metadata-epoch-fixture-01",
    installRoot: f.installRoot,
    sources: [v1, v2].map(({ descriptor: _descriptor, ...source }) => source),
    publications: [],
  });
  store = new SqliteRunStore(join(f.root, "control.sqlite"));
  runtime = await createDesktopPluginRuntime(
    { configuration },
    {
      store,
      identity: new StandaloneIdentity({
        actor,
        sessionToken: "s".repeat(32),
        csrfToken: "c".repeat(32),
        allowedOrigins: ["crewon://desktop"],
      }),
      clock,
      digester,
    },
  );
  const current = runtime;
  const ledger = store.pluginInstallationStore();
  const compositions = ledger.compositionStore();
  let sequence = 0;
  const install = (pkg: typeof v1, expectedSelectionRevision: number | null) =>
    current.installation.install(actor, {
      sourceId: pkg.sourceId,
      expectedPluginId: pkg.pluginId,
      expectedPackageDigest: pkg.packageDigest,
      expectedSelectionRevision,
      idempotencyKey: `native-install-${++sequence}`,
    });
  const select = (
    revision: number,
    state: "enabled" | "disabled" | "uninstalled",
    digest: string | null,
    key = `native-select-${++sequence}`,
  ) =>
    current.installation.select(actor, {
      pluginId: v1.pluginId,
      expectedSelectionRevision: revision,
      state,
      selectedPackageDigest: digest,
      idempotencyKey: key,
    });
  return {
    ...f,
    v1,
    v2,
    runtime: current,
    ledger,
    compositions,
    install,
    select,
  };
}

test("actual Native installation profile automatically publishes exact graph after confirmed selection and retains it on receipt replay", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.runtime.compositionState(actor), { outcome: "unknown" });
  await f.install(f.v1, null);
  assert.equal(await f.compositions.loadCurrent({ scope }), null);
  const enabled = await f.select(
    1,
    "enabled",
    f.v1.packageDigest,
    "native-enable-original",
  );
  assert.equal(enabled.projection.outcome, "applied");
  const first = await f.compositions.loadCurrent({ scope });
  assert.ok(first);
  assert.equal(first.nodes[0]?.selectionRevision, 2);
  assert.equal(first.nodes[0]?.packageDigest, f.v1.packageDigest);
  assert.deepEqual(f.runtime.compositionState(actor), {
    outcome: "published",
    lockDigest: first.lockDigest,
    revision: first.revision,
  });
  assert.equal(
    (await f.select(1, "enabled", f.v1.packageDigest, "native-enable-original"))
      .mutation.disposition,
    "replayed",
  );
  assert.deepEqual(await f.compositions.loadCurrent({ scope }), first);
  await f.install(f.v2, 2);
  assert.deepEqual(await f.compositions.loadCurrent({ scope }), first);
  await f.select(2, "enabled", f.v2.packageDigest);
  const upgraded = await f.compositions.loadCurrent({ scope });
  assert.ok(upgraded);
  assert.equal(upgraded.nodes[0]?.packageDigest, f.v2.packageDigest);
  assert.equal(upgraded.revision, 2);
  await f.select(3, "disabled", f.v2.packageDigest);
  assert.deepEqual((await f.compositions.loadCurrent({ scope }))?.nodes, []);
  await f.select(4, "uninstalled", null);
  assert.equal((await f.compositions.loadCurrent({ scope }))?.revision, 4);
  assert.deepEqual(
    await f.compositions.loadLock({ scope, lockDigest: first.lockDigest }),
    first,
  );
  assert.equal(
    (
      await f.ledger.listPackages({
        scope,
        pluginId: null,
        afterPackageDigest: null,
        limit: 50,
      })
    ).packages.length,
    2,
  );
  assert.throws(() =>
    f.runtime.compositionState({ ...actor, actorId: "foreign-user" }),
  );
});

test("actual Native metadata failure preserves the committed selection and receipt with a separate unavailable state", async (t) => {
  const f = await fixture(t);
  await f.install(f.v1, null);
  // Root cannot mutate the claimed profile. Force the independent metadata write
  // to fail through an actual SQLite trigger, never by replacing service results.
  const { DatabaseSync } = await import("node:sqlite");
  const observer = new DatabaseSync(join(f.root, "control.sqlite"));
  try {
    observer.exec(
      "CREATE TRIGGER fixture_metadata_failure BEFORE INSERT ON plugin_composition_heads BEGIN SELECT RAISE(ABORT,'fixture_metadata_failure'); END;",
    );
  } finally {
    observer.close();
  }
  const selected = await f.select(
    1,
    "enabled",
    f.v1.packageDigest,
    "native-known-selection",
  );
  assert.equal(selected.mutation.disposition, "committed");
  assert.equal(selected.projection.outcome, "applied");
  assert.equal(f.runtime.compositionState(actor).outcome, "unavailable");
  assert.equal(
    (
      await f.runtime.installation.getSelection(actor, {
        pluginId: f.v1.pluginId,
      })
    )?.state,
    "enabled",
  );
  assert.equal(await f.compositions.loadCurrent({ scope }), null);
  assert.equal(
    (await f.select(1, "enabled", f.v1.packageDigest, "native-known-selection"))
      .mutation.disposition,
    "replayed",
  );
  assert.equal(await f.compositions.loadCurrent({ scope }), null);
});
