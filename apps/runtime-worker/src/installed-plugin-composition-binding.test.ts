import assert from "node:assert/strict";
import test from "node:test";
import { composedTurnFixture } from "../../../packages/store/src/plugin-run-composition.test-support.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";

function compositionReader(
  f: Awaited<ReturnType<typeof composedTurnFixture>>,
  options: {
    loadLock?: typeof f.composition.loadLock;
    deny?: boolean;
    onAuthorize?: () => void;
  } = {},
) {
  return new InstalledPluginRunContext({
    extensions: f.first.store,
    runs: f.first.parent,
    installations: f.installations,
    compositions: {
      loadLock: options.loadLock ?? f.composition.loadLock.bind(f.composition),
    },
    authorization: {
      async authorize() {
        options.onAuthorize?.();
        return options.deny
          ? { outcome: "deny", reasonCode: "test_denied" }
          : { outcome: "allow" };
      },
    },
    async resolveActor() {
      return f.actor;
    },
  });
}

function readInput(f: Awaited<ReturnType<typeof composedTurnFixture>>) {
  return {
    locator: {
      tenantId: f.input.binding.tenantId,
      spaceId: f.input.binding.spaceId,
      runId: f.input.binding.runId,
    },
    expectedTarget: f.input.binding.target,
    purpose: "observe" as const,
    signal: new AbortController().signal,
  };
}

test("read-enabled context reads the original persisted graph without changing SDK context or creating another paid Run", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  let authorizations = 0;
  const reader = compositionReader(f, {
    onAuthorize: () => {
      authorizations++;
    },
  });
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  assert.deepEqual(reader.verifiedComposition(snapshot), f.lock);
  assert.ok(Object.isFrozen(reader.verifiedComposition(snapshot)));
  assert.equal("composition" in snapshot.context, false);
  assert.equal(authorizations, 2);
  assert.throws(
    () => reader.verifiedComposition({ ...snapshot }),
    /snapshot_invalid/,
  );
  await reader.assertCurrent(snapshot, "observe", new AbortController().signal);
  assert.equal(authorizations, 4);
  assert.equal(await f.count("messages"), 1);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("old Run observation keeps its original dependency graph after provider disable and a new head", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  const reader = compositionReader(f);
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  await f.installations.commitSelection(
    selectionRecipe(f.enabled.selection, "reader-disable-provider", {
      actor: f.actor,
      state: "disabled",
    }),
  );
  const next = f.makeLock(
    2,
    [
      {
        ...f.lock.nodes.find((node) => node.pluginId === f.pin.pluginId)!,
        requires: [],
      },
    ],
    "reader-new-epoch",
  );
  await f.composition.commit({
    scope: next.scope,
    actor: f.actor,
    lock: next,
    expectedRevision: 1,
  });
  await reader.assertCurrent(snapshot, "observe", new AbortController().signal);
  const reopened = await f.open();
  const reopenedInstallations = reopened.parent.pluginInstallationStore();
  const restartedReader = compositionReader({
    ...f,
    first: reopened,
    installations: reopenedInstallations,
    composition: reopenedInstallations.compositionStore!(),
  });
  const restarted = await restartedReader.load(readInput(f));
  assert.ok(restarted);
  assert.deepEqual(restartedReader.verifiedComposition(restarted), f.lock);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("missing, changed or tampered original metadata fails before publishing an authorized snapshot", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  const cases = [
    { value: null, error: /composition_missing/ },
    { value: f.makeLock(2), error: /composition_reference_conflict/ },
    { value: { ...f.lock, revision: 99 }, error: /digest/ },
  ];
  for (const item of cases) {
    let authorizations = 0;
    const reader = compositionReader(f, {
      loadLock: async () => item.value as typeof f.lock,
      onAuthorize: () => {
        authorizations++;
      },
    });
    await assert.rejects(reader.load(readInput(f)), item.error);
    assert.equal(authorizations, 0);
  }
  let missing = false;
  const reader = compositionReader(f, {
    loadLock: async (input) => (missing ? null : f.composition.loadLock(input)),
  });
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  missing = true;
  await assert.rejects(
    reader.assertCurrent(snapshot, "observe", new AbortController().signal),
    /composition_missing/,
  );
  assert.equal(await f.count("messages"), 1);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("persisted composition metadata never bypasses current root Run authorization", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  const reader = compositionReader(f, { deny: true });
  await assert.rejects(reader.load(readInput(f)), /denied/);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});
/** A persisted graph must never be treated as the current private, single-package execution host. */
test("installed Run context refuses composed execution until a real original-lock assembly is supported", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  let authorizations = 0;
  const reader = new InstalledPluginRunContext({
    extensions: f.first.store,
    runs: f.first.parent,
    installations: f.installations,
    authorization: {
      async authorize() {
        authorizations++;
        return { outcome: "allow" };
      },
    },
    async resolveActor() {
      return f.actor;
    },
  });
  await assert.rejects(
    reader.load({
      locator: {
        tenantId: f.input.binding.tenantId,
        spaceId: f.input.binding.spaceId,
        runId: f.input.binding.runId,
      },
      expectedTarget: f.input.binding.target,
      purpose: "submit",
      signal: new AbortController().signal,
    }),
    /installed_plugin_composition_execution_unavailable/,
  );
  assert.equal(authorizations, 0);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});
