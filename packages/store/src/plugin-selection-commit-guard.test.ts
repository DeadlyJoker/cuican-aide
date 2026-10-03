import assert from "node:assert/strict";
import test from "node:test";
import type { CommitPluginSelectionInput } from "@crewon/application";
import {
  actor,
  fixture,
  installationRecipe,
  receipt,
  scope,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { fixture as ownerFixture } from "./sqlite-plugin-installation-profile-owner.test-support.ts";
import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} selection local guard throws before selection and receipt writes, then exact original request can commit`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const installed =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const recipe = selectionRecipe(installed.selection, "guarded-enable");
      const counts = await f.counts();
      let calls = 0;
      const failure = new Error("current local facts changed");
      await assert.rejects(
        f.first.store.commitSelection({
          ...recipe,
          beforeCommit({ selection }) {
            calls++;
            assert.deepEqual(selection, recipe.selection);
            assert.ok(Object.isFrozen(selection));
            throw failure;
          },
        }),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
      assert.deepEqual(await f.counts(), counts);
      assert.deepEqual(
        await f.second.store.loadSelection({
          scope,
          pluginId: installed.package.pluginId,
        }),
        installed.selection,
      );
      assert.equal(
        await f.first.store.loadReceipt({
          scope,
          actor,
          kind: "select",
          receipt: receipt("guarded-enable"),
        }),
        null,
      );
      const enabled = await f.first.store.commitSelection(recipe);
      assert.equal(enabled.disposition, "committed");
      assert.equal(enabled.selection.state, "enabled");
    },
  );
  test(
    `${backend} selection guard is a captured synchronous receiver and receipt replay bypasses it without serialization`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const installed =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const recipe = selectionRecipe(installed.selection, "guarded-replay");
      let calls = 0;
      const input = {
        ...recipe,
        beforeCommit({
          selection,
        }: Parameters<
          NonNullable<CommitPluginSelectionInput["beforeCommit"]>
        >[0]) {
          assert.equal(this, input);
          assert.deepEqual(selection, recipe.selection);
          calls++;
        },
      };
      const enabled = await f.first.store.commitSelection(input);
      assert.equal(calls, 1);
      await f.first.store.commitSelection(
        selectionRecipe(enabled.selection, "after-guard", {
          state: "disabled",
        }),
      );
      const replay = await f.second.store.commitSelection({
        ...recipe,
        beforeCommit() {
          throw new Error("replay must not invoke local guard");
        },
      });
      assert.deepEqual(replay, { ...enabled, disposition: "replayed" });
      assert.equal(calls, 1);
      const rows = await f.query(
        `SELECT result_json FROM ${f.prefix}plugin_installation_receipts`,
      );
      for (const row of rows)
        assert.equal(
          JSON.stringify(row.result_json).includes("beforeCommit"),
          false,
        );
      let staleCalls = 0;
      await assert.rejects(
        f.first.store.commitSelection({
          ...selectionRecipe(installed.selection, "stale-new-key"),
          beforeCommit() {
            staleCalls++;
          },
        }),
        /plugin_installation_revision_conflict/u,
      );
      assert.equal(staleCalls, 0);
    },
  );
  test(
    `${backend} selection guard refuses async or non-void returns and observes rejected promises without committing`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const installed =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const counts = await f.counts();
      const observed: unknown[] = [];
      const rejection = (error: unknown) => observed.push(error);
      process.on("unhandledRejection", rejection);
      try {
        for (const [index, beforeCommit] of [
          () => Promise.reject(new Error("invalid async local guard")),
          () => Promise.resolve(),
          () => true,
        ].entries()) {
          await assert.rejects(
            f.first.store.commitSelection({
              ...selectionRecipe(installed.selection, `non-sync-${index}`),
              beforeCommit,
            } as unknown as CommitPluginSelectionInput),
            /plugin_installation_before_commit_must_be_synchronous/u,
          );
          assert.deepEqual(await f.counts(), counts);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(observed, []);
      } finally {
        process.removeListener("unhandledRejection", rejection);
      }
    },
  );
  test(
    `${backend} selection guard must be an own enumerable data function; no getter is invoked and old envelopes stay exact`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const installed =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const recipe = selectionRecipe(installed.selection, "guard-shape");
      const counts = await f.counts();
      let getters = 0;
      const getter = Object.defineProperty({ ...recipe }, "beforeCommit", {
        enumerable: true,
        get() {
          getters++;
          return () => {};
        },
      });
      for (const input of [
        getter,
        { ...recipe, beforeCommit: undefined },
        { ...recipe, beforeCommit: true },
        Object.assign(Object.create({ beforeCommit() {} }), recipe),
        { ...recipe, beforeCommit() {}, extra: true },
      ])
        await assert.rejects(
          f.first.store.commitSelection(input as CommitPluginSelectionInput),
        );
      assert.equal(getters, 0);
      assert.deepEqual(await f.counts(), counts);
      await f.first.store.commitSelection(recipe);
    },
  );
}

test("SQLite owned profile guard runs inside the actual writer transaction and sees unchanged full records on the same parent connection", async (t) => {
  const f = await ownerFixture(t);
  const installed = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  t.after(() => owner.close());
  const recipe = selectionRecipe(installed.selection, "owned-local-gate");
  let calls = 0;
  const failure = new Error("local deployment withdrew");
  await assert.rejects(
    owner.store.commitSelection({
      ...recipe,
      beforeCommit({ selection }) {
        calls++;
        assert.deepEqual(selection, recipe.selection);
        assert.deepEqual(
          f.store.currentSelection({
            scope,
            pluginId: installed.package.pluginId,
          }),
          installed.selection,
        );
        assert.deepEqual(
          f.store.currentPackage({
            scope,
            packageDigest: installed.package.packageDigest,
          }),
          installed.package,
        );
        assert.throws(
          () => f.observer.exec("BEGIN IMMEDIATE"),
          /database is locked/u,
        );
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.deepEqual(owner.snapshot().selections, [installed.selection]);
  assert.deepEqual(f.counts(), {
    installed_plugin_packages: 1,
    plugin_profile_selections: 1,
    plugin_installation_receipts: 1,
  });
  const enabled = await owner.store.commitSelection(recipe);
  assert.equal(enabled.selection.state, "enabled");
  assert.deepEqual(owner.snapshot().selections, [enabled.selection]);
});

test("SQLite synchronous current reads retain schema, record integrity and parent-lifetime fences", async (t) => {
  const f = await fixture(t, "sqlite");
  const store = f.first.store;
  assert.ok(store instanceof SqlitePluginInstallationStore);
  const installed = await store.recordInstalledPackage(installationRecipe());
  assert.deepEqual(
    store.currentSelection({ scope, pluginId: installed.package.pluginId }),
    installed.selection,
  );
  assert.deepEqual(
    store.currentPackage({
      scope,
      packageDigest: installed.package.packageDigest,
    }),
    installed.package,
  );
  await assert.rejects(
    f.execute("UPDATE installed_plugin_packages SET version='9.0.0'"),
    /plugin_installation_history_immutable/u,
  );
  assert.deepEqual(
    store.currentPackage({
      scope,
      packageDigest: installed.package.packageDigest,
    }),
    installed.package,
  );
  // This owned fixture's mutable audit field is outside the SQL identity/check
  // constraints. Keep every immutable-history trigger and test the domain read fence.
  await f.execute(
    "UPDATE plugin_profile_selections SET record_json=json_set(record_json,'$.updatedAt','invalid-timestamp')",
  );
  assert.throws(
    () =>
      store.currentSelection({ scope, pluginId: installed.package.pluginId }),
    /plugin_installation_timestamp_invalid/u,
  );
  await f.execute(
    `UPDATE plugin_profile_selections SET record_json=json_set(record_json,'$.updatedAt','${installed.selection.updatedAt}')`,
  );
  assert.deepEqual(
    store.currentSelection({ scope, pluginId: installed.package.pluginId }),
    installed.selection,
  );
  await f.execute(
    "UPDATE plugin_installation_schema_version SET version=99 WHERE id=1",
  );
  assert.throws(
    () =>
      store.currentSelection({ scope, pluginId: installed.package.pluginId }),
    /schema_version_unsupported/u,
  );
  assert.throws(
    () =>
      store.currentPackage({
        scope,
        packageDigest: installed.package.packageDigest,
      }),
    /schema_version_unsupported/u,
  );
  await f.execute(
    "UPDATE plugin_installation_schema_version SET version=1 WHERE id=1",
  );
  await f.first.parent.close();
  assert.throws(() =>
    store.currentSelection({ scope, pluginId: installed.package.pluginId }),
  );
  assert.throws(() =>
    store.currentPackage({
      scope,
      packageDigest: installed.package.packageDigest,
    }),
  );
});
