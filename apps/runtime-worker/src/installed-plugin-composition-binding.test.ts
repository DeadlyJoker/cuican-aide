import assert from "node:assert/strict";
import test from "node:test";
import { composedTurnFixture } from "../../../packages/store/src/plugin-run-composition.test-support.ts";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunContextDependencies,
} from "./plugins/installed-plugin-run-context.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";

function compositionReader(
  f: Awaited<ReturnType<typeof composedTurnFixture>>,
  options: {
    loadLock?: typeof f.composition.loadLock;
    deny?: boolean;
    onAuthorize?: () => void;
    authorize?: InstalledPluginRunContextDependencies["authorization"]["authorize"];
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
      async authorize(request) {
        options.onAuthorize?.();
        if (options.authorize) return options.authorize(request);
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
test("captured provider authorization checks its own resource and preserves original bytes after upgrade", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  const requests: string[] = [];
  const reader = compositionReader(f, {
    authorize: async (request) => {
      if (request.resource.kind === "extension")
        requests.push(`${request.action}:${request.resource.pluginId}`);
      return { outcome: "allow" };
    },
  });
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  const original = await reader.assertCompositionNodeCurrent(
    snapshot,
    f.provider.package.pluginId,
    "submit",
    new AbortController().signal,
  );
  assert.deepEqual(original, f.provider.package);
  assert.ok(requests.includes(`extension:run:${f.provider.package.pluginId}`));
  const upgraded = await f.installations.recordInstalledPackage(
    installationRecipe("reader-provider-v2", {
      scope: f.scope,
      actor: f.actor,
      pluginId: f.provider.package.pluginId,
      version: "2.0.0",
      expectedSelectionRevision: f.enabled.selection.revision,
    }),
  );
  await f.installations.commitSelection(
    selectionRecipe(upgraded.selection, "reader-select-provider-v2", {
      actor: f.actor,
      packageDigest: upgraded.package.packageDigest,
    }),
  );
  assert.deepEqual(
    await reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "submit",
      new AbortController().signal,
    ),
    original,
  );
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      "example.unrelated",
      "observe",
      new AbortController().signal,
    ),
    /composition_node_unavailable/,
  );
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      { ...snapshot },
      f.provider.package.pluginId,
      "observe",
      new AbortController().signal,
    ),
    /snapshot_invalid/,
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("a root grant cannot authorize a denied provider, and warm rechecks see provider permission revocation", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  let denied = false;
  const reader = compositionReader(f, {
    authorize: async (request) =>
      request.resource.kind === "extension" &&
      request.resource.pluginId === f.provider.package.pluginId &&
      denied
        ? { outcome: "deny", reasonCode: "provider_revoked" }
        : { outcome: "allow" },
  });
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  await reader.assertCompositionNodeCurrent(
    snapshot,
    f.provider.package.pluginId,
    "submit",
    new AbortController().signal,
  );
  denied = true;
  for (const purpose of ["submit", "observe"] as const)
    await assert.rejects(
      reader.assertCompositionNodeCurrent(
        snapshot,
        f.provider.package.pluginId,
        purpose,
        new AbortController().signal,
      ),
      /execution_access_denied/,
    );
  assert.equal(await f.count("messages"), 1);
});

test("provider disable during policy evaluation invalidates the grant while authorized historical observation remains possible", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  let changed = false;
  const reader = compositionReader(f, {
    authorize: async (request) => {
      if (
        !changed &&
        request.resource.kind === "extension" &&
        request.resource.pluginId === f.provider.package.pluginId
      ) {
        changed = true;
        await f.installations.commitSelection(
          selectionRecipe(f.enabled.selection, "reader-policy-disable", {
            actor: f.actor,
            state: "disabled",
          }),
        );
      }
      return { outcome: "allow" };
    },
  });
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "observe",
      new AbortController().signal,
    ),
    /selection_changed/,
  );
  await reader.assertCompositionNodeCurrent(
    snapshot,
    f.provider.package.pluginId,
    "observe",
    new AbortController().signal,
  );
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "submit",
      new AbortController().signal,
    ),
    /generation_disabled/,
  );
  const disabled = await f.installations.loadSelection({
    scope: f.scope,
    pluginId: f.provider.package.pluginId,
  });
  assert.ok(disabled);
  await f.installations.commitSelection(
    selectionRecipe(disabled, "reader-provider-uninstall", {
      actor: f.actor,
      state: "uninstalled",
    }),
  );
  assert.deepEqual(
    await reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "observe",
      new AbortController().signal,
    ),
    f.provider.package,
  );
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "submit",
      new AbortController().signal,
    ),
    /generation_disabled/,
  );
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});

test("provider changes while refreshing root authority invalidate the earlier provider grant", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  let granted = false,
    changed = false;
  const reader = compositionReader(f, {
    authorize: async (request) => {
      if (request.resource.kind === "extension") {
        if (request.resource.pluginId === f.provider.package.pluginId)
          granted = true;
        else if (granted && !changed) {
          changed = true;
          await f.installations.commitSelection(
            selectionRecipe(f.enabled.selection, "reader-root-policy-disable", {
              actor: f.actor,
              state: "disabled",
            }),
          );
        }
      }
      return { outcome: "allow" };
    },
  });
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "observe",
      new AbortController().signal,
    ),
    /selection_changed/,
  );
  assert.equal(changed, true);
});

test("provider policy accessors and cancellation cannot create a usable grant", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  const abort = new AbortController();
  let mode = "getter",
    getters = 0;
  const reader = compositionReader(f, {
    authorize: async (request) => {
      if (
        request.resource.kind === "extension" &&
        request.resource.pluginId === f.provider.package.pluginId
      ) {
        if (mode === "getter")
          return {
            get outcome() {
              getters++;
              return "allow" as const;
            },
          };
        abort.abort(new Error("provider_check_aborted"));
      }
      return { outcome: "allow" };
    },
  });
  const snapshot = await reader.load(readInput(f));
  assert.ok(snapshot);
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "observe",
      new AbortController().signal,
    ),
    /execution_access_denied/,
  );
  assert.equal(getters, 0);
  mode = "abort";
  await assert.rejects(
    reader.assertCompositionNodeCurrent(
      snapshot,
      f.provider.package.pluginId,
      "observe",
      abort.signal,
    ),
    /provider_check_aborted/,
  );
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
