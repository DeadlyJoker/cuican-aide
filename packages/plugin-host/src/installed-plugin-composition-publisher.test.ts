import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteRunStore } from "@crewon/store";
import type { PluginSelection } from "@crewon/domain";
import { publishInstalledPluginComposition } from "./installed-plugin-composition-publisher.ts";
import {
  compositionFixture,
  scope,
  digester,
  allow,
  borrow,
  service,
} from "./plugin-composition-fixture.test-support.ts";

const actor = {
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  principalId: "owner-1",
  actorId: "actor-1",
};
const profile = {
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  profileId: scope.profileId,
};
const at = "2026-10-10T00:00:00.000Z";
async function fixture(t: TestContext) {
  const f = await compositionFixture(t);
  const parent = new SqliteRunStore(join(f.installRoot, "metadata.sqlite"));
  f.ownOwner(parent);
  const ledger = parent.pluginInstallationStore();
  await ledger.migrate();
  const compositions = ledger.compositionStore!();
  await compositions.migrate();
  let sequence = 0;
  const receipt = () => ({
    idempotencyKey: `metadata-${++sequence}`,
    requestDigest: digester.sha256(`metadata-${sequence}`),
  });
  const select = async (
    selection: PluginSelection,
    state: PluginSelection["state"],
    digest = selection.selectedPackageDigest,
  ) =>
    (
      await ledger.commitSelection({
        scope: profile,
        actor,
        receipt: receipt(),
        expectedSelectionRevision: selection.revision,
        selection: {
          ...selection,
          revision: selection.revision + 1,
          state,
          selectedPackageDigest: state === "uninstalled" ? null : digest,
          updatedAt: at,
          updatedByPrincipalId: actor.principalId,
          updatedByActorId: actor.actorId,
        },
      })
    ).selection;
  const save = async (
    node: typeof f.source.node,
    expectedSelectionRevision: number | null = null,
  ) =>
    (
      await ledger.recordInstalledPackage({
        scope: profile,
        actor,
        receipt: receipt(),
        expectedSelectionRevision,
        package: {
          ...profile,
          schemaVersion: "crewon.installed-plugin-package.v1",
          pluginId: node.pluginId,
          publisherId: node.publisherId,
          version: node.version,
          packageDigest: node.packageDigest,
          installedAt: at,
          installedByPrincipalId: actor.principalId,
          installedByActorId: actor.actorId,
        },
      })
    ).selection;
  const selections = [];
  for (const node of f.nodes)
    selections.push(await select(await save(node), "enabled"));
  const input = {
    scope,
    actor,
    installRoot: f.installRoot,
    hostServices: [],
    installations: ledger,
    compositions,
    signal: new AbortController().signal,
    authorizeSnapshot: async () => "allow" as const,
  };
  return {
    ...f,
    parent,
    ledger,
    compositions,
    input,
    selections,
    select,
    save,
  };
}

test("real installed ledger and package bytes produce a durable graph without importing any entry", async (t) => {
  const f = await fixture(t);
  const published = await publishInstalledPluginComposition(f.input);
  assert.equal(published.disposition, "committed");
  assert.deepEqual(
    published.lock.nodes,
    f.nodes
      .map((node) => ({ ...node, selectionRevision: 2 }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
  );
  assert.deepEqual(
    await f.compositions.loadCurrent({ scope: profile }),
    published.lock,
  );
  assert.deepEqual(await f.source.records(), []);
  assert.deepEqual(await f.consumer.records(), []);
  assert.deepEqual(
    (
      await f.coordinator.synchronize({
        lock: published.lock,
        authority: allow,
      })
    ).failures,
    [],
  );
  const lease = f.coordinator.acquireCurrent(borrow(published.lock.lockDigest));
  try {
    assert.equal(
      lease.getService<{ read(): number }>("story.consumer", "1").read(),
      1,
    );
  } finally {
    lease.release();
  }
});

test("actual upgraded selection publishes its exact package and coordinator preserves the original borrowed dependency", async (t) => {
  const f = await fixture(t);
  const original = (await publishInstalledPluginComposition(f.input)).lock;
  await f.coordinator.synchronize({ lock: original, authority: allow });
  const old = f.coordinator.acquireCurrent(borrow(original.lockDigest));
  try {
    const upgraded = await f.make({
      pluginId: "example.source",
      version: "2.0.0",
      provides: service,
      setup: "ctx.services.provide('story.source','1',{read:()=>2})",
    });
    const selected = await f.save(upgraded.node, 2);
    await f.select(selected, "enabled", upgraded.node.packageDigest);
    const next = (await publishInstalledPluginComposition(f.input)).lock;
    assert.equal(next.revision, 2);
    assert.equal(
      next.nodes.find((node) => node.pluginId === "example.source")
        ?.packageDigest,
      upgraded.node.packageDigest,
    );
    assert.deepEqual(
      (await f.coordinator.synchronize({ lock: next, authority: allow }))
        .failures,
      [],
    );
    const current = f.coordinator.acquireCurrent(borrow(next.lockDigest));
    try {
      assert.equal(
        current.getService<{ read(): number }>("story.consumer", "1").read(),
        2,
      );
      assert.equal(
        old.getService<{ read(): number }>("story.consumer", "1").read(),
        1,
      );
    } finally {
      current.release();
    }
    assert.deepEqual(
      await f.compositions.loadLock({
        scope: profile,
        lockDigest: original.lockDigest,
      }),
      original,
    );
  } finally {
    old.release();
  }
});

test("uninstall publishes the empty current graph while preserving the original immutable graph", async (t) => {
  const f = await fixture(t);
  const original = (await publishInstalledPluginComposition(f.input)).lock;
  for (const selection of f.selections)
    await f.select(selection, "uninstalled");
  const empty = (await publishInstalledPluginComposition(f.input)).lock;
  assert.deepEqual(empty.nodes, []);
  assert.equal(empty.revision, 2);
  assert.deepEqual(
    await f.compositions.loadLock({
      scope: profile,
      lockDigest: original.lockDigest,
    }),
    original,
  );
  assert.equal(
    (
      await f.ledger.listPackages({
        scope: profile,
        pluginId: null,
        afterPackageDigest: null,
        limit: 50,
      })
    ).packages.length,
    3,
  );
});

test("selection changes during authority refresh fail the actual Store vector fence without publishing a head", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    publishInstalledPluginComposition({
      ...f.input,
      authorizeSnapshot: async () => {
        await f.select(
          f.selections.find((s) => s.pluginId === "example.independent")!,
          "disabled",
        );
        return "allow";
      },
    }),
    /plugin_composition_selection_conflict/,
  );
  assert.equal(await f.compositions.loadCurrent({ scope: profile }), null);
  assert.deepEqual(await f.source.records(), []);
});

test("concurrent identical publication cannot treat receipt replay as a fresh vector fence", async (t) => {
  const f = await fixture(t);
  let winner;
  await assert.rejects(
    publishInstalledPluginComposition({
      ...f.input,
      authorizeSnapshot: async () => {
        winner = (await publishInstalledPluginComposition(f.input)).lock;
        return "allow";
      },
    }),
    /plugin_composition_snapshot_superseded/,
  );
  assert.deepEqual(
    await f.compositions.loadCurrent({ scope: profile }),
    winner,
  );
});

test("concurrent distinct head publication fails CAS without replacing the winner", async (t) => {
  const f = await fixture(t);
  let winner;
  await assert.rejects(
    publishInstalledPluginComposition({
      ...f.input,
      authorizeSnapshot: async () => {
        winner = (
          await publishInstalledPluginComposition({
            ...f.input,
            hostServices: [
              {
                service: "host.test",
                apiVersion: "1",
                implementationId: "host-test",
                implementationRevision: 1,
              },
            ],
          })
        ).lock;
        return "allow";
      },
    }),
    /plugin_composition_revision_conflict/,
  );
  assert.deepEqual(
    await f.compositions.loadCurrent({ scope: profile }),
    winner,
  );
});

test("a missing required provider does not silently save a partial runnable graph", async (t) => {
  const f = await fixture(t);
  const original = (await publishInstalledPluginComposition(f.input)).lock;
  await f.select(
    f.selections.find((s) => s.pluginId === "example.source")!,
    "disabled",
  );
  await assert.rejects(
    publishInstalledPluginComposition(f.input),
    /plugin_composition_/,
  );
  assert.deepEqual(
    await f.compositions.loadCurrent({ scope: profile }),
    original,
  );
  assert.deepEqual(await f.consumer.records(), []);
});

test("snapshot policy denial and cancellation import no entries and create no head", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    publishInstalledPluginComposition({
      ...f.input,
      authorizeSnapshot: async () => "deny",
    }),
    /plugin_composition_snapshot_denied/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    publishInstalledPluginComposition({
      ...f.input,
      signal: controller.signal,
    }),
  );
  assert.equal(await f.compositions.loadCurrent({ scope: profile }), null);
  assert.deepEqual(await f.source.records(), []);
});

test("tampered installed bytes never enter the metadata graph or execute an entry", async (t) => {
  const f = await fixture(t);
  const path = join(
    f.installRoot,
    "packages",
    f.source.node.packageDigest.slice(7),
    "entry.mjs",
  );
  const original = await readFile(path);
  await chmod(path, 0o600);
  const tampered = Buffer.from(original);
  tampered[0] ^= 1;
  await writeFile(path, tampered);
  await assert.rejects(
    publishInstalledPluginComposition(f.input),
    /plugin_package_/,
  );
  assert.equal(await f.compositions.loadCurrent({ scope: profile }), null);
  assert.deepEqual(await f.source.records(), []);
});

test("foreign actors and malformed pagination fail before any graph is committed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    publishInstalledPluginComposition({
      ...f.input,
      actor: { ...actor, tenantId: "foreign-tenant" },
    }),
    /plugin_composition_actor_conflict/,
  );
  await assert.rejects(
    publishInstalledPluginComposition({
      ...f.input,
      installations: new Proxy(f.ledger, {
        get(target, key) {
          if (key === "listSelections")
            return async () => ({ selections: [], next: "non-advancing-page" });
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    }),
    /plugin_composition_selection_page_invalid/,
  );
  assert.equal(await f.compositions.loadCurrent({ scope: profile }), null);
});
