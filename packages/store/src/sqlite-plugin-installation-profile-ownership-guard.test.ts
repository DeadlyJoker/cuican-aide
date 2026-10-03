import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./sqlite-plugin-installation-profile-owner.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
  scope,
} from "./plugin-installation-store.test-support.ts";

test("actual SQLite ownership is checkable during candidate transaction while unpublished projections remain inaccessible", async (t) => {
  const f = await fixture(t);
  const installed = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  t.after(() => owner.close());
  owner.assertOwnership();
  const recipe = selectionRecipe(installed.selection, "owned-candidate-guard");
  let calls = 0;
  const enabled = await owner.store.commitSelection({
    ...recipe,
    beforeCommit({ selection }) {
      calls++;
      assert.deepEqual(selection, recipe.selection);
      owner.assertOwnership();
      assert.throws(
        () => owner.snapshot(),
        /plugin_profile_owner_projection_busy/u,
      );
      assert.throws(
        () =>
          owner.currentSelection({
            scope,
            pluginId: installed.package.pluginId,
          }),
        /plugin_profile_owner_projection_busy/u,
      );
      assert.deepEqual(
        f.store.currentSelection({
          scope,
          pluginId: installed.package.pluginId,
        }),
        installed.selection,
      );
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(owner.snapshot().selections, [enabled.selection]);
  await owner.close();
  assert.throws(
    () => owner.assertOwnership(),
    /plugin_profile_owner_unavailable/u,
  );
});

test("actual SQLite ownership refuses a lost sidecar file from inside the transaction and rolls back enabled write", async (t) => {
  const f = await fixture(t);
  const installed = await f.store.recordInstalledPackage(installationRecipe());
  const owner = await f.store.acquireProfileOwner({
    scope,
    onOwnershipLost() {},
  });
  t.after(() => owner.close());
  const recipe = selectionRecipe(installed.selection, "closed-owner-candidate");
  const files = await f.lockFiles();
  assert.equal(files.length, 1);
  let calls = 0;
  await assert.rejects(
    owner.store.commitSelection({
      ...recipe,
      beforeCommit() {
        calls++;
        renameSync(
          join(f.lockRoot, files[0]!),
          join(f.lockRoot, "withdrawn-owned-sidecar.sqlite"),
        );
        owner.assertOwnership();
      },
    }),
    /plugin_profile_owner_unavailable/u,
  );
  assert.equal(calls, 1);
  assert.throws(
    () => owner.assertOwnership(),
    /plugin_profile_owner_unavailable/u,
  );
  assert.deepEqual(
    f.store.currentSelection({ scope, pluginId: installed.package.pluginId }),
    installed.selection,
  );
  assert.equal(f.counts().plugin_installation_receipts, 1);
});
