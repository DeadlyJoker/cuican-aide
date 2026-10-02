import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "./application-error.ts";
import type { PluginPreparedSelection } from "./plugin-installation-host-port.ts";
import {
  actor,
  deferred,
  digestA,
  digestB,
  installCommand,
  installationFixture,
  scope,
  selectCommand,
} from "./plugin-installation.test-support.ts";

async function rejects(
  action: () => Promise<unknown>,
  category: string,
  code: string,
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    return true;
  });
}

test("selection persists exact desired metadata before publishing its prepared projection", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const prepare = f.host.prepareSelection.bind(f.host);
  f.host.prepareSelection = async (input) => {
    const handle = await prepare(input);
    return {
      abort: handle.abort,
      commit({ selection }) {
        assert.deepEqual([...f.store.selections.values()][0], selection);
        assert.equal(f.store.receipts.size, 2);
        handle.commit({ selection });
      },
    };
  };
  const result = await f.service.select(actor, selectCommand);
  assert.equal(result.mutation.disposition, "committed");
  assert.equal(result.mutation.selection.state, "enabled");
  assert.equal(result.mutation.selection.revision, 2);
  assert.deepEqual(result.projection, { outcome: "applied" });
  assert.deepEqual(f.state.projection, result.mutation.selection);
  assert.ok(Object.isFrozen(f.state.prepares[0]));
  assert.ok(Object.isFrozen(f.state.prepares[0]!.nextSelection));
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.aborts, 0);
});

test("disable, version switch while disabled and logical uninstall all prepare and preserve history", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  await f.service.install(actor, {
    sourceId: "source-b",
    expectedPluginId: "example.story",
    expectedPackageDigest: digestB,
    expectedSelectionRevision: 1,
    idempotencyKey: "install-next",
  });
  const switched = await f.service.select(actor, {
    ...selectCommand,
    state: "disabled",
    selectedPackageDigest: digestB,
  });
  assert.equal(f.state.prepares[0]!.package!.version, "2.0.0");
  assert.equal(switched.mutation.selection.state, "disabled");
  const removed = await f.service.select(actor, {
    ...selectCommand,
    state: "uninstalled",
    selectedPackageDigest: null,
    expectedSelectionRevision: 2,
    idempotencyKey: "remove",
  });
  assert.equal(removed.mutation.selection.selectedPackageDigest, null);
  assert.equal(f.state.prepares.at(-1)!.package, null);
  assert.equal(f.store.packages.size, 2);
  assert.equal(f.state.prepares.length, 2);
  const restored = await f.service.install(actor, {
    ...installCommand,
    expectedSelectionRevision: 3,
    idempotencyKey: "reinstall",
  });
  assert.equal(restored.selection.state, "disabled");
  assert.equal(restored.selection.revision, 4);
  assert.equal(restored.package.installedByPrincipalId, actor.principalId);
  assert.equal(f.store.packages.size, 2);
});

test("selection replay reauthorizes the original snapshot without preparing or activating superseded state", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const enabled = await f.service.select(actor, selectCommand);
  await f.service.select(actor, {
    ...selectCommand,
    state: "disabled",
    expectedSelectionRevision: 2,
    idempotencyKey: "disable",
  });
  const counts = {
    prepare: f.state.prepares.length,
    commits: f.state.commits,
    auth: f.state.decisions.length,
  };
  f.state.now = "invalid clock";
  const replay = await f.service.select(actor, selectCommand);
  assert.equal(replay.mutation.disposition, "replayed");
  assert.deepEqual(replay.mutation.selection, enabled.mutation.selection);
  assert.deepEqual(replay.projection, { outcome: "unchanged" });
  assert.equal(f.state.projection!.state, "disabled");
  assert.equal(f.state.prepares.length, counts.prepare);
  assert.equal(f.state.commits, counts.commits);
  assert.ok(f.state.decisions.length >= counts.auth + 2);
  f.state.decision = { outcome: "deny", reasonCode: "revoked" };
  await rejects(
    () => f.service.select(actor, selectCommand),
    "authorization",
    "authorization_denied",
  );
});

test("stale CAS and nonexistent package stop before host preparation", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  await rejects(
    () =>
      f.service.select(actor, {
        ...selectCommand,
        expectedSelectionRevision: 2,
      }),
    "conflict",
    "plugin_installation_revision_conflict",
  );
  await rejects(
    () =>
      f.service.select(actor, {
        ...selectCommand,
        selectedPackageDigest: digestB,
      }),
    "notFound",
    "plugin_installation_package_not_found",
  );
  const foreignDigest = `sha256:${"c".repeat(64)}`;
  f.sources.set("source-foreign", {
    ...f.sources.get("source-a")!,
    pluginId: "example.foreign",
    packageDigest: foreignDigest,
  });
  await f.service.install(actor, {
    sourceId: "source-foreign",
    expectedPluginId: "example.foreign",
    expectedPackageDigest: foreignDigest,
    expectedSelectionRevision: null,
    idempotencyKey: "foreign-install",
  });
  await rejects(
    () =>
      f.service.select(actor, {
        ...selectCommand,
        selectedPackageDigest: foreignDigest,
      }),
    "conflict",
    "plugin_installation_package_identity_conflict",
  );
  assert.equal(f.state.prepares.length, 0);
  assert.equal(f.store.receipts.size, 2);
  assert.equal(
    (await f.store.loadSelection({ scope, pluginId: "example.story" }))!
      .revision,
    1,
  );
});

test("prepare rejection and malformed capability handle cannot change durable selection", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  f.state.prepareFailure = new Error("runtime incompatible");
  await rejects(
    () => f.service.select(actor, selectCommand),
    "internal",
    "plugin_installation_host_unavailable",
  );
  f.state.prepareFailure = null;
  f.host.prepareSelection = async () =>
    ({
      commit: null,
      async abort() {
        f.state.aborts++;
      },
    }) as unknown as PluginPreparedSelection;
  await rejects(
    () => f.service.select(actor, selectCommand),
    "internal",
    "plugin_installation_host_result_invalid",
  );
  assert.equal(f.state.aborts, 1);
  assert.equal(f.store.receipts.size, 1);
  assert.equal(f.state.commits, 0);
});

test("permission revoked while preparing aborts the new candidate before DB and preserves previous selection", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  f.state.prepareHook = async () => {
    f.state.decision = { outcome: "deny", reasonCode: "revoked" };
  };
  await rejects(
    () => f.service.select(actor, selectCommand),
    "authorization",
    "authorization_denied",
  );
  assert.equal(f.state.aborts, 1);
  assert.equal(f.state.commits, 0);
  assert.equal(
    (await f.store.loadSelection({ scope, pluginId: "example.story" }))!.state,
    "disabled",
  );
  assert.equal(f.store.receipts.size, 1);
});

test("DB failure aborts new candidate and cleanup failure does not hide the primary failure", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  f.store.commitFailure = new Error("database unavailable");
  f.state.abortFailure = new Error("cleanup unavailable");
  await rejects(
    () => f.service.select(actor, selectCommand),
    "internal",
    "plugin_installation_service_unavailable",
  );
  assert.equal(f.state.aborts, 1);
  assert.equal(f.state.commits, 0);
  assert.equal(f.store.receipts.size, 1);
  assert.equal(
    (await f.store.loadSelection({ scope, pluginId: "example.story" }))!
      .revision,
    1,
  );
});

test("publication failure after confirmed DB commit returns pending even when abort also fails", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  f.state.commitFailure = new Error("publication failed");
  f.state.abortFailure = new Error("cleanup failed");
  const saved = await f.service.select(actor, selectCommand);
  assert.deepEqual(saved.projection, {
    outcome: "pending",
    reasonCode: "plugin_projection_pending",
  });
  assert.equal(saved.mutation.disposition, "committed");
  assert.equal(saved.mutation.selection.state, "enabled");
  assert.equal(f.store.receipts.size, 2);
  assert.deepEqual(
    await f.store.loadSelection({ scope, pluginId: "example.story" }),
    saved.mutation.selection,
  );
  const replay = await f.service.select(actor, selectCommand);
  assert.deepEqual(replay.projection, { outcome: "unchanged" });
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.aborts, 1);
});

test("an asynchronous publication result cannot be reported as synchronous applied", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  f.host.prepareSelection = async () => ({
    commit: (() =>
      Promise.reject(
        new Error("async commit failed"),
      )) as unknown as PluginPreparedSelection["commit"],
    async abort() {
      f.state.aborts++;
    },
  });
  const result = await f.service.select(actor, selectCommand);
  assert.equal(result.projection.outcome, "pending");
  assert.equal(result.mutation.disposition, "committed");
  assert.equal(f.store.receipts.size, 2);
  assert.equal(f.state.aborts, 1);
});

test("receipt discovered during Store commit aborts prepared candidate instead of reactivating old snapshot", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  f.state.prepareHook = async () => {
    f.state.prepareHook = null;
    await f.service.select(actor, selectCommand);
    await f.service.select(actor, {
      ...selectCommand,
      state: "disabled",
      expectedSelectionRevision: 2,
      idempotencyKey: "newer",
    });
  };
  const result = await f.service.select(actor, selectCommand);
  assert.equal(result.mutation.disposition, "replayed");
  assert.equal(result.mutation.selection.state, "enabled");
  assert.deepEqual(result.projection, { outcome: "unchanged" });
  assert.equal(f.state.projection!.state, "disabled");
  assert.equal(f.state.projection!.revision, 3);
  assert.equal(f.state.commits, 2);
  assert.equal(f.state.aborts, 1);
});

test("mutable actor and selection commands are detached before the first asynchronous profile lookup", async () => {
  const f = installationFixture();
  await f.service.install(actor, installCommand);
  const gate = deferred<void>();
  const entered = deferred<void>();
  let first = true;
  f.state.profileHook = async () => {
    if (first) {
      first = false;
      entered.resolve();
      await gate.promise;
    }
    return scope;
  };
  const callerActor = { ...actor };
  const command = { ...selectCommand };
  const work = f.service.select(callerActor, command);
  await entered.promise;
  callerActor.tenantId = "attacker-tenant";
  callerActor.principalId = "attacker-principal";
  command.state = "uninstalled";
  command.selectedPackageDigest = null;
  command.expectedSelectionRevision = 999;
  gate.resolve();
  const result = await work;
  assert.equal(result.mutation.selection.state, "enabled");
  assert.equal(
    result.mutation.selection.updatedByPrincipalId,
    actor.principalId,
  );
  assert.deepEqual(f.state.prepares[0]!.actor, actor);
  assert.equal(
    f.state.prepares[0]!.nextSelection.selectedPackageDigest,
    digestA,
  );
});
