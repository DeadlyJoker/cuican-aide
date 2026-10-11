import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { PluginInstallationApplicationService } from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { parsePluginSelection } from "@crewon/domain";
import { publishInstalledPluginComposition } from "./installed-plugin-composition-publisher.ts";
import {
  compositionFixture,
  scope,
  digester,
  allow,
  borrow,
  service,
} from "./plugin-composition-fixture.test-support.ts";

async function fixture(t: TestContext) {
  const f = await compositionFixture(t);
  const store = new SqliteRunStore(join(f.installRoot, "control.sqlite"));
  f.ownOwner(store);
  const ledger = store.pluginInstallationStore();
  await ledger.migrate();
  const compositions = ledger.compositionStore();
  await compositions.migrate();
  const observer = new DatabaseSync(join(f.installRoot, "control.sqlite"), {
    readOnly: true,
  });
  f.ownOwner({
    close: async () => {
      observer.close();
    },
  });
  const actor = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    actorId: "actor-1",
    principalId: "owner-1",
  };
  const sources = new Map(
    [f.source, f.consumer, f.independent].map((pkg) => [
      pkg.node.packageDigest,
      pkg.directory,
    ]),
  );
  const local = f.coordinator.createInstallationHost({
    resolveSource: async ({ sourceId }) => {
      const path = sources.get(sourceId);
      assert.ok(path);
      return path;
    },
    authorizeInstallation: async () => "allow",
    authorizeActivation: async () => "allow",
    validateCompatibility: async () => {},
    authorizeCommit: ({ selection }) => {
      // An actual second SQLite connection reads the durable selection before publication.
      const row = observer
        .prepare(
          "SELECT record_json FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
        )
        .get(
          scope.tenantId,
          scope.spaceId,
          scope.profileId,
          selection.pluginId,
        );
      const current = row
        ? parsePluginSelection(JSON.parse(String(row.record_json)))
        : null;
      return JSON.stringify(current) === JSON.stringify(selection)
        ? "allow"
        : "deny";
    },
  });
  const application = new PluginInstallationApplicationService({
    store: ledger,
    profiles: {
      resolve: async () => ({
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        profileId: scope.profileId,
      }),
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    host: local,
    clock: { now: () => "2026-10-11T00:00:00.000Z" },
    digester,
  });
  let sequence = 0;
  const install = async (
    pkg: typeof f.source,
    revision: number | null = null,
  ) => {
    sources.set(pkg.node.packageDigest, pkg.directory);
    return application.install(actor, {
      sourceId: pkg.node.packageDigest,
      expectedPluginId: pkg.node.pluginId,
      expectedPackageDigest: pkg.node.packageDigest,
      expectedSelectionRevision: revision,
      idempotencyKey: `install-${++sequence}`,
    });
  };
  const select = (
    pkg: typeof f.source,
    revision: number,
    state: "enabled" | "disabled" = "enabled",
  ) =>
    application.select(actor, {
      pluginId: pkg.node.pluginId,
      expectedSelectionRevision: revision,
      state,
      selectedPackageDigest: pkg.node.packageDigest,
      idempotencyKey: `select-${++sequence}`,
    });
  const synchronize = async (authority = allow) => {
    const publication = await publishInstalledPluginComposition({
      actor,
      scope,
      installRoot: f.installRoot,
      hostServices: [],
      installations: ledger,
      compositions,
      signal: new AbortController().signal,
      authorizeSnapshot: async () => "allow",
    });
    const result = await f.coordinator.synchronizeInstalled({
      lock: publication.lock,
      authority,
    });
    return { lock: publication.lock, result };
  };
  return { ...f, install, select, synchronize, application, actor, local };
}

test("actual Application selection and composition share setup once, then restore a consumer after explicit provider withdrawal and upgrade", async (t) => {
  const f = await fixture(t);
  for (const pkg of [f.source, f.consumer, f.independent]) {
    await f.install(pkg);
    assert.equal((await f.select(pkg, 1)).projection.outcome, "applied");
    await f.synchronize();
  }
  assert.deepEqual(await f.source.records(), ["load", "setup"]);
  assert.deepEqual(await f.consumer.records(), ["load", "setup"]);
  assert.deepEqual(await f.independent.records(), ["load", "setup"]);
  const original = (await f.synchronize()).lock;
  const old = f.coordinator.acquireCurrent(borrow(original.lockDigest));
  t.after(() => old.release());
  const next = await f.make({
    pluginId: "example.source",
    version: "2.0.0",
    provides: service,
    setup: "ctx.services.provide('story.source','1',{read:()=>2})",
  });
  await f.install(next, 2);
  // The host deliberately withdraws this subtree before upgrading. The existing
  // NodeHost hot-upgrade guard remains intact; historical leases retain their graph.
  f.coordinator.revoke(next.node.pluginId);
  await f.select(next, 2);
  const upgraded = await f.synchronize();
  assert.deepEqual(upgraded.result.failures, []);
  assert.equal(
    old.getService<{ read(): number }>("story.consumer", "1").read(),
    1,
  );
  const current = f.coordinator.acquireCurrent(
    borrow(upgraded.lock.lockDigest),
  );
  assert.equal(
    current.getService<{ read(): number }>("story.consumer", "1").read(),
    2,
  );
  current.release();
  old.release();
  await f.coordinator.drain();
  assert.deepEqual(await next.records(), ["load", "setup"]);
  assert.equal(
    (await f.consumer.records()).filter((entry) => entry === "setup").length,
    2,
  );
  assert.deepEqual(await f.independent.records(), ["load", "setup"]);
});

test("fresh composition authority can reject an already selected instance; a saved graph cannot preserve its grant", async (t) => {
  const f = await fixture(t);
  await f.install(f.independent);
  await f.select(f.independent, 1);
  const denied = await f.synchronize({
    ...allow,
    authorizePreparation: () => "deny",
  });
  assert.deepEqual(denied.result.activePluginIds, []);
  assert.throws(
    () =>
      f.coordinator.acquireCurrent(
        borrow(denied.lock.lockDigest, f.independent.node.pluginId),
      ),
    /unavailable/,
  );
  assert.deepEqual(await f.independent.records(), ["load", "setup", "dispose"]);
  assert.equal(
    (
      await f.application.getSelection(f.actor, {
        pluginId: f.independent.node.pluginId,
      })
    )?.state,
    "enabled",
  );
  const restored = await f.synchronize();
  assert.deepEqual(restored.result.activePluginIds, [
    f.independent.node.pluginId,
  ]);
});

test("installation adapter is unique and ordinary synchronization cannot restart its selected instances", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.coordinator.createInstallationHost({} as never),
    /conflict/,
  );
  await assert.rejects(
    f.coordinator.synchronize({ lock: f.lock(), authority: allow }),
    /installed_synchronization_required/,
  );
  assert.deepEqual(f.coordinator.snapshot(), []);
});

test("closed coordinator fences retained installation and non-Node recovery paths", async (t) => {
  const f = await fixture(t);
  await f.install(f.independent);
  const selection = await f.application.getSelection(f.actor, {
    pluginId: f.independent.node.pluginId,
  });
  assert.ok(selection);
  const pkg = await f.application.getPackage(f.actor, {
    packageDigest: f.independent.node.packageDigest,
  });
  const profile = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: scope.profileId,
  };
  const recovery = { actor: f.actor, scope: profile, selection, package: pkg };
  const policy = {
    authorizeCurrent: () => "allow" as const,
    validateCompatibility: async () => {},
  };
  await f.coordinator.close();
  await assert.rejects(f.install(f.source), /host_unavailable/);
  await assert.rejects(
    f.select(f.independent, 1, "disabled"),
    /host_unavailable/,
  );
  await assert.rejects(f.local.prepareRecovery(recovery, policy), /closed/);
  await assert.rejects(f.local.recoverSelections([recovery], policy), /closed/);
  assert.deepEqual(await f.independent.records(), []);
  assert.deepEqual(f.coordinator.snapshot(), []);
});
