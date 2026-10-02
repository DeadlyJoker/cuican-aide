import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import type { PostgresPluginInstallationProfileOwner } from "./postgres-plugin-installation-profile-owner.ts";
import { POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS } from "./postgres-plugin-installation-profile-owner.ts";
import {
  fixture,
  deferred,
  until,
} from "./postgres-plugin-installation-profile-owner.test-support.ts";
import {
  installationRecipe,
  scope,
  selectionRecipe,
  packageRecord,
  receipt,
} from "./plugin-installation-store.test-support.ts";

const options = { skip: !process.env.CREWON_TEST_POSTGRES_URL };

// Real PG session ownership and durable projection only. No Node code, execution permission or Run is granted.
test(
  "profile owner: session excludes peers and retains the lock after COMMIT before host publication",
  options,
  async (t) => {
    const f = await fixture(t);
    const first = await f.store.recordInstalledPackage(installationRecipe());
    let withdrawn = false;
    const owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {
        withdrawn = true;
      },
    });
    await assert.rejects(
      f.peer.acquireProfileOwner({ scope, onOwnershipLost() {} }),
      /plugin_profile_owner_busy/,
    );
    const next = await owner.store.commitSelection(
      selectionRecipe(first.selection, "owner-enable"),
    );
    assert.deepEqual(
      owner.currentSelection({ scope, pluginId: first.package.pluginId }),
      next.selection,
    );
    assert.deepEqual(
      owner.currentSelectedPackage({ scope, pluginId: first.package.pluginId }),
      first.package,
    );
    // The Store Promise has returned and the synchronous host publication has not happened yet.
    const pending = f.peer.commitSelection(
      selectionRecipe(next.selection, "peer-disable", { state: "disabled" }),
    );
    void pending.catch(() => {});
    await until(async () => (await f.locks(false)).length === 1);
    assert.equal(
      (await f.peer.loadSelection({ scope, pluginId: first.package.pluginId }))!
        .revision,
      2,
    );
    const publish = () =>
      owner.currentSelection({ scope, pluginId: first.package.pluginId });
    assert.equal(publish()!.revision, 2);
    const closing = owner.close();
    assert.equal(withdrawn, true);
    assert.throws(publish, /plugin_profile_owner_unavailable/);
    await closing;
    assert.equal((await pending).selection.revision, 3);
    assert.equal((await f.locks(true)).length, 0);
  },
);

test(
  "profile owner: receipt replay projects current rows and a reopened owner reads the durable latest selection",
  options,
  async (t) => {
    const f = await fixture(t);
    const first = await f.store.recordInstalledPackage(installationRecipe());
    const owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {},
    });
    const enable = selectionRecipe(first.selection, "enable");
    const enabled = await owner.store.commitSelection(enable);
    const disabled = await owner.store.commitSelection(
      selectionRecipe(enabled.selection, "disable", { state: "disabled" }),
    );
    const replay = await owner.store.commitSelection(enable);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.selection.revision, 2);
    assert.deepEqual(
      owner.currentSelection({ scope, pluginId: first.package.pluginId }),
      disabled.selection,
    );
    const counts = await f.counts();
    await owner.close();
    const reopened = await f.peer.acquireProfileOwner({
      scope,
      onOwnershipLost() {},
    });
    assert.deepEqual(reopened.snapshot().selections, [disabled.selection]);
    assert.deepEqual(reopened.snapshot().selectedPackages, [first.package]);
    assert.deepEqual(await f.counts(), counts);
    await reopened.close();
  },
);

test(
  "profile owner: owner Store and synchronous projection are fixed to one profile while other profiles remain writable",
  options,
  async (t) => {
    const f = await fixture(t);
    const first = await f.store.recordInstalledPackage(installationRecipe());
    const owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {},
    });
    const other = { ...scope, profileId: "profile-独立" };
    const installed = await f.peer.recordInstalledPackage(
      installationRecipe("other-install", { scope: other }),
    );
    const another = await f.peer.acquireProfileOwner({
      scope: other,
      onOwnershipLost() {},
    });
    assert.equal(
      another.currentSelection({
        scope: other,
        pluginId: first.package.pluginId,
      })!.revision,
      1,
    );
    await assert.rejects(
      owner.store.loadSelection({
        scope: other,
        pluginId: first.package.pluginId,
      }),
      /scope_mismatch/,
    );
    await assert.rejects(
      owner.store.recordInstalledPackage(
        installationRecipe("cross-owner", {
          scope: other,
          version: "2.0.0",
          expectedSelectionRevision: 1,
        }),
      ),
      /scope_mismatch/,
    );
    assert.throws(
      () =>
        owner.currentSelectedPackage({
          scope: other,
          pluginId: installed.package.pluginId,
        }),
      /scope_mismatch/,
    );
    assert.deepEqual(owner.snapshot().selections, [first.selection]);
    assert.equal(Object.isFrozen(owner.snapshot().selections), true);
    await another.close();
    await owner.close();
  },
);

test(
  "profile owner: actual backend loss withdraws the synchronous gate and releases a blocked writer",
  options,
  async (t) => {
    const f = await fixture(t);
    const first = await f.store.recordInstalledPackage(installationRecipe());
    const lost = deferred();
    let losses = 0;
    const owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {
        losses++;
        lost.resolve();
      },
    });
    const [lock] = await f.locks(true);
    assert.ok(lock);
    const pending = f.peer.commitSelection(
      selectionRecipe(first.selection, "after-owner-loss"),
    );
    void pending.catch(() => {});
    await until(async () => (await f.locks(false)).length === 1);
    const fence = () =>
      owner.currentSelection({ scope, pluginId: first.package.pluginId });
    assert.equal(fence()!.revision, 1);
    await f.observer.query("SELECT pg_terminate_backend($1)", [lock.pid]);
    await lost.promise;
    assert.throws(fence, /plugin_profile_owner_unavailable/);
    await assert.rejects(
      owner.store.loadSelection({ scope, pluginId: first.package.pluginId }),
      /plugin_profile_owner_unavailable/,
    );
    assert.equal((await pending).selection.revision, 2);
    await owner.close();
    assert.equal(losses, 1);
    const recovered = await f.peer.acquireProfileOwner({
      scope,
      onOwnershipLost() {},
    });
    assert.equal(
      recovered.currentSelection({ scope, pluginId: first.package.pluginId })!
        .revision,
      2,
    );
    await recovered.close();
  },
);

test(
  "profile owner: dedicated-client operations serialize and rollback does not advance the projection",
  options,
  async (t) => {
    const f = await fixture(t);
    const owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {},
    });
    const recipe = installationRecipe("concurrent-owner-install");
    const [a, b] = await Promise.all([
      owner.store.recordInstalledPackage(recipe),
      owner.store.recordInstalledPackage(recipe),
    ]);
    assert.deepEqual([a.disposition, b.disposition].sort(), [
      "committed",
      "replayed",
    ]);
    assert.deepEqual(
      owner.currentSelection({ scope, pluginId: a.package.pluginId }),
      a.selection,
    );
    const counts = await f.counts();
    await f.failReceipts(true);
    await assert.rejects(
      owner.store.commitSelection(selectionRecipe(a.selection, "rollback")),
      /plugin_installation_fixture_write_failed/,
    );
    assert.deepEqual(
      owner.currentSelection({ scope, pluginId: a.package.pluginId }),
      a.selection,
    );
    assert.deepEqual(await f.counts(), counts);
    await f.failReceipts(false);
    assert.equal(
      (await owner.store.commitSelection(selectionRecipe(a.selection, "retry")))
        .selection.revision,
      2,
    );
    await owner.close();
  },
);

test(
  "profile owner: 256 selection bound rejects a new mutation atomically and an oversized startup releases ownership",
  options,
  async (t) => {
    const f = await fixture(t);
    const owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {},
    });
    for (
      let index = 0;
      index < POSTGRES_PLUGIN_PROFILE_OWNER_LIMITS.selectionsPerProfile;
      index++
    )
      await owner.store.recordInstalledPackage(
        installationRecipe(`install-${index}`, {
          pluginId: `example.plugin${index}`,
        }),
      );
    assert.equal(owner.snapshot().selections.length, 256);
    const counts = await f.counts();
    const excess = installationRecipe("excess", { pluginId: "example.excess" });
    await assert.rejects(
      owner.store.recordInstalledPackage(excess),
      /plugin_profile_owner_selection_limit/,
    );
    assert.deepEqual(await f.counts(), counts);
    assert.equal(
      owner.currentSelection({ scope, pluginId: "example.excess" }),
      null,
    );
    await owner.close();
    await f.peer.recordInstalledPackage(excess);
    const persisted = await f.counts();
    await assert.rejects(
      f.store.acquireProfileOwner({ scope, onOwnershipLost() {} }),
      /plugin_profile_owner_selection_limit/,
    );
    assert.deepEqual(await f.counts(), persisted);
    assert.equal((await f.locks(true)).length, 0);
    await f.peer.recordInstalledPackage({
      ...excess,
      receipt: receipt("after-failed-startup"),
      expectedSelectionRevision: 1,
    });
  },
);

test(
  "profile owner: COMMIT response barrier closes old projection and confirmed commit survives parent close without reopening authority",
  options,
  async (t) => {
    const f = await fixture(t);
    const first = await f.store.recordInstalledPackage(installationRecipe());
    let losses = 0;
    let owner!: PostgresPluginInstallationProfileOwner;
    owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {
        losses++;
        assert.throws(
          () => owner.snapshot(),
          /plugin_profile_owner_unavailable/,
        );
      },
    });
    const [lock] = await f.locks(true);
    const entered = deferred();
    const resume = deferred();
    const original = Client.prototype.query;
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const task = Reflect.apply(original, this, args) as Promise<unknown>;
      if (
        args[0] !== "COMMIT" ||
        (this as Client & { processID: number }).processID !== lock!.pid ||
        !task?.then
      )
        return task;
      return task.then(async (result) => {
        entered.resolve();
        await resume.promise;
        return result;
      });
    } as Client["query"];
    t.after(() => {
      resume.resolve();
      Client.prototype.query = original;
    });
    const next = selectionRecipe(first.selection, "confirmed-close");
    const writing = owner.store.commitSelection(next);
    void writing.catch(() => {});
    try {
      await entered.promise;
      assert.equal(
        (await f.peer.loadSelection({
          scope,
          pluginId: first.package.pluginId,
        }))!.revision,
        2,
      );
      assert.throws(
        () =>
          owner.currentSelection({ scope, pluginId: first.package.pluginId }),
        /plugin_profile_owner_projection_busy/,
      );
      const after = f.peer.commitSelection(
        selectionRecipe(next.selection, "after-close", { state: "disabled" }),
      );
      void after.catch(() => {});
      await until(async () => (await f.locks(false)).length === 1);
      await f.first.parent.close();
      assert.equal(losses, 1);
      assert.equal((await after).selection.revision, 3);
      resume.resolve();
      const acknowledged = await writing;
      assert.equal(acknowledged.disposition, "committed");
      assert.equal(acknowledged.selection.revision, 2);
      assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
      const reopened = await f.peer.acquireProfileOwner({
        scope,
        onOwnershipLost() {},
      });
      assert.equal(
        reopened.currentSelection({ scope, pluginId: first.package.pluginId })!
          .revision,
        3,
      );
      await reopened.close();
    } finally {
      resume.resolve();
      Client.prototype.query = original;
    }
  },
);

test(
  "profile owner: unsupported schema at startup or after a read invalidates authority without changing data",
  options,
  async (t) => {
    const f = await fixture(t);
    const installed =
      await f.store.recordInstalledPackage(installationRecipe());
    const owner = await f.store.acquireProfileOwner({
      scope,
      onOwnershipLost() {},
    });
    const counts = await f.counts();
    await f.execute(
      `UPDATE ${f.prefix}plugin_installation_schema_version SET version=99 WHERE id=1`,
    );
    await assert.rejects(
      owner.store.loadSelection({
        scope,
        pluginId: installed.package.pluginId,
      }),
      /plugin_installation_schema_version_unsupported/,
    );
    assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
    await owner.close();
    await assert.rejects(
      f.peer.acquireProfileOwner({ scope, onOwnershipLost() {} }),
      /plugin_installation_schema_version_unsupported/,
    );
    assert.deepEqual(await f.counts(), counts);
    assert.equal((await f.locks(true)).length, 0);
    // Schema restoration is this fixture's teardown prerequisite, not a migration downgrade.
    await f.execute(
      `UPDATE ${f.prefix}plugin_installation_schema_version SET version=1 WHERE id=1`,
    );
    assert.deepEqual(
      await f.peer.loadPackage({
        scope,
        packageDigest: packageRecord().packageDigest,
      }),
      installed.package,
    );
  },
);
