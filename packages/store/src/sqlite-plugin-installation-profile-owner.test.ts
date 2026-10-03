import assert from "node:assert/strict";
import { once } from "node:events";
import { link, mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";
import {
  SQLITE_PLUGIN_PROFILE_OWNER_LIMITS,
  type SqlitePluginInstallationProfileOwner,
  type SqlitePluginInstallationProfileBinding,
} from "./sqlite-plugin-installation-profile-owner.ts";
import { fixture } from "./sqlite-plugin-installation-profile-owner.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
  scope,
  receipt,
} from "./plugin-installation-store.test-support.ts";

test("SQLite profile owner: actual session excludes another connection beyond COMMIT without locking unrelated main-DB writes", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  let losses = 0;
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {
      losses++;
    },
  });
  await assert.rejects(
    f.peer.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_busy/,
  );
  const enabled = await owner.store.commitSelection(
    selectionRecipe(first.selection, "enable"),
  );
  assert.deepEqual(
    owner.currentSelection({ scope, pluginId: first.package.pluginId }),
    enabled.selection,
  );
  assert.deepEqual(
    owner.currentSelectedPackage({ scope, pluginId: first.package.pluginId }),
    first.package,
  );
  await assert.rejects(
    f.peer.commitSelection(
      selectionRecipe(enabled.selection, "peer-disable", { state: "disabled" }),
    ),
    /plugin_profile_owner_busy/,
  );
  assert.equal(
    (await f.peer.loadSelection({ scope, pluginId: first.package.pluginId }))!
      .revision,
    2,
  );
  // A genuinely independent SQLite connection can continue taking the main database's writer lock.
  f.observer.exec(
    "BEGIN IMMEDIATE;CREATE TABLE fixture_worker_output(value TEXT);INSERT INTO fixture_worker_output VALUES('committed');COMMIT",
  );
  assert.deepEqual(
    f.query("SELECT value FROM fixture_worker_output").map((row) => row.value),
    ["committed"],
  );
  const closing = owner.close();
  assert.equal(closing, owner.close());
  assert.equal(losses, 1);
  assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
  await closing;
  const disabled = await f.peer.commitSelection(
    selectionRecipe(enabled.selection, "peer-disable", { state: "disabled" }),
  );
  assert.equal(disabled.selection.revision, 3);
});

test("SQLite profile owner: confirmed projection survives rollback and old receipt replay projects current durable rows", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  const recipe = selectionRecipe(first.selection, "enable");
  const enabled = await owner.store.commitSelection(recipe);
  const counts = f.counts();
  f.failReceipts(true);
  await assert.rejects(
    owner.store.commitSelection(
      selectionRecipe(enabled.selection, "failing-disable", {
        state: "disabled",
      }),
    ),
    /plugin_installation_fixture_write_failed/,
  );
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(
    owner.currentSelection({ scope, pluginId: first.package.pluginId }),
    enabled.selection,
  );
  f.failReceipts(false);
  const disabled = await owner.store.commitSelection(
    selectionRecipe(enabled.selection, "disable", { state: "disabled" }),
  );
  const replay = await owner.store.commitSelection(recipe);
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.selection.revision, 2);
  assert.deepEqual(
    owner.currentSelection({ scope, pluginId: first.package.pluginId }),
    disabled.selection,
  );
  await owner.close();
  const reopened = await f.peer.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  assert.deepEqual(reopened.snapshot(), {
    scope,
    selections: [disabled.selection],
    selectedPackages: [first.package],
  });
  assert.ok(Object.isFrozen(reopened.snapshot().selections));
  await reopened.close();
});

test("SQLite profile owner: full scope is fixed and independent profiles remain writable", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  const other = { ...scope, profileId: "other-profile" };
  const otherPackage = await f.peer.recordInstalledPackage(
    installationRecipe("other", { scope: other }),
  );
  const another = await f.peer.acquireProfileOwner({
    scope: other,
    onOwnershipLost() {},
  });
  assert.deepEqual(another.snapshot().selections, [otherPackage.selection]);
  assert.throws(
    () =>
      owner.currentSelection({
        scope: other,
        pluginId: first.package.pluginId,
      }),
    /plugin_installation_scope_mismatch/,
  );
  await assert.rejects(
    owner.store.loadPackage({
      scope: other,
      packageDigest: otherPackage.package.packageDigest,
    }),
    /plugin_installation_scope_mismatch/,
  );
  await assert.rejects(
    owner.store.recordInstalledPackage(
      installationRecipe("wrong", { scope: other }),
    ),
    /plugin_installation_scope_mismatch/,
  );
  await owner.close();
  await another.close();
});

test("SQLite profile owner: a real child process holds the fence and SIGKILL releases its actual OS lock", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  const held = await f.child("owner");
  await assert.rejects(
    f.store.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_busy/,
  );
  await assert.rejects(
    f.store.commitSelection(selectionRecipe(first.selection, "blocked")),
    /plugin_profile_owner_busy/,
  );
  const exited = once(held.process, "exit");
  held.process.kill("SIGKILL");
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  const restored = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  assert.deepEqual(restored.snapshot().selections, [first.selection]);
  const enabled = await restored.store.commitSelection(
    selectionRecipe(first.selection, "after-crash"),
  );
  assert.equal(enabled.selection.revision, 2);
  await restored.close();
});

test("SQLite profile writer: actual concurrent children cannot both commit the same CAS revision", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  const [a, b] = await Promise.all([
    f.child("writer", selectionRecipe(first.selection, "race-a")),
    f.child(
      "writer",
      selectionRecipe(first.selection, "race-b", { state: "disabled" }),
    ),
  ]);
  a.go();
  b.go();
  const results = await Promise.all([a.next(), b.next()]);
  assert.equal(results.filter((result) => result.kind === "result").length, 1);
  const failed = results.find((result) => result.kind === "error")!;
  assert.match(
    String(failed.message),
    /plugin_profile_owner_busy|plugin_installation_revision_conflict/,
  );
  assert.equal(
    (await f.store.loadSelection({ scope, pluginId: first.package.pluginId }))!
      .revision,
    2,
  );
  assert.equal(f.counts().plugin_installation_receipts, 2);
});

test("SQLite profile writer: real concurrent child retries keep one stable idempotent result", async (t) => {
  const f = await fixture(t);
  const recipe = installationRecipe("cross-process-key");
  const [a, b] = await Promise.all([
    f.child("writer", recipe),
    f.child("writer", recipe),
  ]);
  a.go();
  b.go();
  const results = await Promise.all([a.next(), b.next()]);
  assert.ok(results.some((result) => result.kind === "result"));
  for (const result of results)
    if (result.kind === "error")
      assert.match(String(result.message), /plugin_profile_owner_busy/);
  const repeated = await f.store.recordInstalledPackage(recipe);
  assert.equal(repeated.disposition, "replayed");
  const saved = await f.store.loadReceipt({
    scope,
    actor: recipe.actor,
    receipt: recipe.receipt,
    kind: "install",
  });
  assert.deepEqual(saved, repeated);
  assert.equal(f.counts().installed_plugin_packages, 1);
  assert.equal(f.counts().plugin_installation_receipts, 1);
});

test("SQLite profile owner: actual scope capture, getter rejection and forged structural bindings cannot issue authority", async (t) => {
  const f = await fixture(t);
  const mutable = { ...scope };
  const acquiring = f.store.acquireProfileOwner({
    scope: mutable,
    onOwnershipLost() {},
  });
  mutable.profileId = "changed";
  const owner = await acquiring;
  assert.deepEqual(owner.scope, scope);
  await owner.close();
  let reads = 0;
  const input = {
    scope,
    get onOwnershipLost() {
      reads++;
      return () => {};
    },
  };
  assert.throws(
    () => f.store.acquireProfileOwner(input),
    /plugin_installation_fields_invalid/,
  );
  assert.equal(reads, 0);
  const binding = {
    scope,
    assertOpen() {},
    invalidate() {},
    runMutation() {
      throw new Error("never");
    },
    prepareProjection() {
      throw new Error("never");
    },
  } as SqlitePluginInstallationProfileBinding;
  assert.throws(
    () =>
      new SqlitePluginInstallationStore({
        database: f.observer,
        assertOpen() {},
        binding,
      }),
    /plugin_profile_owner_binding_invalid/,
  );
});

test("SQLite profile owner: the original in-memory Store still works while an OS-backed owner is unavailable", async () => {
  const parent = new SqliteRunStore(":memory:");
  try {
    const store = parent.pluginInstallationStore();
    await store.migrate();
    const first = await store.recordInstalledPackage(installationRecipe());
    assert.equal(
      (await store.commitSelection(selectionRecipe(first.selection, "enable")))
        .selection.revision,
      2,
    );
    await assert.rejects(
      store.acquireProfileOwner({ scope, onOwnershipLost() {} }),
      /plugin_profile_owner_requires_file/,
    );
  } finally {
    await parent.close();
  }
});

test("SQLite profile lock: preexisting sidecar symlinks and hardlinks are rejected without following or changing them", async (t) => {
  const f = await fixture(t);
  await f.store.recordInstalledPackage(installationRecipe());
  const [name] = await f.lockFiles();
  const file = join(f.lockRoot, name!);
  const saved = join(f.directory, "original-fence.sqlite");
  await rename(file, saved);
  await symlink(saved, file);
  await assert.rejects(
    f.peer.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_lock_invalid/,
  );
  await rm(file);
  await link(saved, file);
  await assert.rejects(
    f.peer.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_lock_invalid/,
  );
  await rm(file);
  await rename(saved, file);
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  await owner.close();
});

test("SQLite profile lock: replacing an active sidecar inode synchronously withdraws the old owner and known writers refuse the new inode", async (t) => {
  const f = await fixture(t);
  await f.store.recordInstalledPackage(installationRecipe());
  let losses = 0;
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {
      losses++;
    },
  });
  const [name] = await f.lockFiles();
  const file = join(f.lockRoot, name!);
  const saved = join(f.directory, "held-fence.sqlite");
  await rename(file, saved);
  const replacement = new DatabaseSync(file);
  replacement.close();
  const { chmod } = await import("node:fs/promises");
  await chmod(file, 0o600);
  assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
  assert.equal(losses, 1);
  await owner.close();
  await assert.rejects(
    f.store.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_path_changed/,
  );
  await rm(file);
  await rename(saved, file);
});

test("SQLite profile lock: replacing the private lock directory invalidates its actual owner", async (t) => {
  const f = await fixture(t);
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  const original = f.lockRoot + ".old";
  await rename(f.lockRoot, original);
  await mkdir(f.lockRoot, { mode: 0o700 });
  assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
  await owner.close();
  await assert.rejects(
    f.store.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_path_changed/,
  );
  await rm(f.lockRoot, { recursive: true });
  await rename(original, f.lockRoot);
});

test("SQLite profile lock: main database hardlink or inode replacement fails closed without changing baseline SQLite reads", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  const alias = join(f.directory, "alias.sqlite");
  await link(f.path, alias);
  assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
  await owner.close();
  await assert.rejects(
    f.store.commitSelection(selectionRecipe(first.selection, "linked")),
    /plugin_profile_owner_database_invalid/,
  );
  await rm(alias);
  const original = join(f.directory, "original.sqlite");
  await rename(f.path, original);
  const replacement = new DatabaseSync(f.path);
  replacement.close();
  await assert.rejects(
    f.store.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_path_changed/,
  );
  // The existing host's actual open connection has not been rewritten or closed by that rejection.
  assert.equal(
    (await f.store.loadSelection({ scope, pluginId: first.package.pluginId }))!
      .revision,
    1,
  );
  await rm(f.path);
  await rename(original, f.path);
});

test("SQLite profile owner: parent close at the real COMMIT barrier preserves its receipt, withdraws synchronously and joins the session", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  let losses = 0;
  let owner!: SqlitePluginInstallationProfileOwner;
  owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {
      losses++;
      assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
    },
  });
  let closing: Promise<void> | undefined;
  const original = DatabaseSync.prototype.exec;
  let armed = true;
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = Reflect.apply(original, this, [sql]);
    if (
      armed &&
      sql === "COMMIT" &&
      this.location() === f.observer.location()
    ) {
      armed = false;
      assert.throws(
        () => owner.snapshot(),
        /plugin_profile_owner_projection_busy/,
      );
      closing = f.parent.close();
      assert.equal(closing, f.parent.close());
    }
    return result;
  };
  t.after(() => {
    DatabaseSync.prototype.exec = original;
  });
  const result = await owner.store.commitSelection(
    selectionRecipe(first.selection, "confirmed-close"),
  );
  assert.equal(result.selection.revision, 2);
  assert.equal(result.disposition, "committed");
  assert.ok(closing);
  await closing;
  assert.equal(losses, 1);
  assert.equal(
    (await f.peer.loadSelection({ scope, pluginId: first.package.pluginId }))!
      .revision,
    2,
  );
  await assert.rejects(
    owner.store.loadSelection({ scope, pluginId: first.package.pluginId }),
    /plugin_profile_owner_unavailable|store_closed/,
  );
  const reopened = await f.peer.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  assert.equal(reopened.snapshot().selections[0]!.revision, 2);
  await reopened.close();
});

test("SQLite profile owner: selection limits reject atomically and oversized startup releases the actual session", async (t) => {
  const f = await fixture(t);
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  for (
    let index = 0;
    index < SQLITE_PLUGIN_PROFILE_OWNER_LIMITS.selectionsPerProfile;
    index++
  )
    await owner.store.recordInstalledPackage(
      installationRecipe("limit-" + index, {
        pluginId: "example.plugin" + index,
      }),
    );
  assert.equal(owner.snapshot().selections.length, 256);
  const counts = f.counts();
  const extra = installationRecipe("excess", { pluginId: "example.excess" });
  await assert.rejects(
    owner.store.recordInstalledPackage(extra),
    /plugin_profile_owner_selection_limit/,
  );
  assert.deepEqual(f.counts(), counts);
  await owner.close();
  await f.peer.recordInstalledPackage(extra);
  await assert.rejects(
    f.store.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_profile_owner_selection_limit/,
  );
  const replay = await f.peer.recordInstalledPackage({
    ...extra,
    receipt: receipt("after-startup-error"),
    expectedSelectionRevision: 1,
  });
  assert.equal(replay.selection.revision, 1);
});

test("SQLite profile owner: owners and queued mutations are bounded and closing releases every actual owner", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  const recipe = selectionRecipe(first.selection, "queue");
  const pending = Array.from({ length: 32 }, () =>
    owner.store.commitSelection(recipe),
  );
  await assert.rejects(
    owner.store.commitSelection(recipe),
    /plugin_profile_owner_operation_capacity_exhausted/,
  );
  assert.equal(
    (await Promise.all(pending)).filter(
      (result) => result.disposition === "committed",
    ).length,
    1,
  );
  const active: SqlitePluginInstallationProfileOwner[] = [owner];
  for (let index = 1; index < 32; index++)
    active.push(
      await f.store.acquireProfileOwner({
        scope: { ...scope, profileId: "capacity-" + index },
        onOwnershipLost() {},
      }),
    );
  await assert.rejects(
    f.peer.acquireProfileOwner({
      scope: { ...scope, profileId: "excess" },
      onOwnershipLost() {},
    }),
    /plugin_profile_owner_capacity_exhausted/,
  );
  const closing = f.parent.close();
  for (const value of active)
    assert.throws(() => value.snapshot(), /plugin_profile_owner_unavailable/);
  await closing;
  const reopened = await f.peer.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  await reopened.close();
});

test("SQLite profile owner: an observed unsupported schema invalidates the owner and releases its actual lock", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  let losses = 0;
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {
      losses++;
    },
  });
  const counts = f.counts();
  f.observer.exec(
    "UPDATE plugin_installation_schema_version SET version=99 WHERE id=1",
  );
  await assert.rejects(
    owner.store.loadSelection({ scope, pluginId: first.package.pluginId }),
    /plugin_installation_schema_version_unsupported/,
  );
  assert.equal(losses, 1);
  assert.throws(() => owner.snapshot(), /plugin_profile_owner_unavailable/);
  await owner.close();
  await assert.rejects(
    f.peer.acquireProfileOwner({ scope, onOwnershipLost() {} }),
    /plugin_installation_schema_version_unsupported/,
  );
  assert.deepEqual(f.counts(), counts);
  f.observer.exec(
    "UPDATE plugin_installation_schema_version SET version=1 WHERE id=1",
  );
  const recovered = await f.peer.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  await recovered.close();
});

test("SQLite profile owner: a real deferred-constraint COMMIT failure never publishes its staged projection", async (t) => {
  const f = await fixture(t);
  const first = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  f.observer.exec(
    "CREATE TABLE fixture_fk_parent(id INTEGER PRIMARY KEY);" +
      "CREATE TABLE fixture_fk_child(parent_id INTEGER REFERENCES fixture_fk_parent(id) DEFERRABLE INITIALLY DEFERRED);" +
      "CREATE TRIGGER fixture_deferred_receipt AFTER INSERT ON plugin_installation_receipts BEGIN INSERT INTO fixture_fk_child VALUES(99);END",
  );
  const counts = f.counts();
  const recipe = selectionRecipe(first.selection, "commit-failure");
  await assert.rejects(
    owner.store.commitSelection(recipe),
    /FOREIGN KEY constraint failed/,
  );
  assert.deepEqual(f.counts(), counts);
  assert.equal(
    f.query("SELECT COUNT(*) AS count FROM fixture_fk_child")[0]!.count,
    0,
  );
  assert.deepEqual(
    owner.currentSelection({ scope, pluginId: first.package.pluginId }),
    first.selection,
  );
  f.observer.exec("DROP TRIGGER fixture_deferred_receipt");
  const committed = await owner.store.commitSelection(recipe);
  assert.deepEqual(
    owner.currentSelection({ scope, pluginId: first.package.pluginId }),
    committed.selection,
  );
  await owner.close();
});
