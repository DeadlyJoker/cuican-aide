import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPluginCompositionLock,
  PLUGIN_COMPOSITION_LOCK_SCHEMA,
  type PluginCompositionNode,
} from "@crewon/contracts/plugins";
import { compositionStoreDigester } from "./plugin-composition-store-records.ts";
import {
  actor,
  scope,
  fixture,
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

function makeLock(
  revision = 1,
  nodes: readonly PluginCompositionNode[] = [],
  authorityEpoch = "epoch-1",
) {
  return createPluginCompositionLock(
    {
      schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
      scope: { ...scope, authorityEpoch },
      revision,
      nodes,
      hostServices: [],
    },
    compositionStoreDigester,
  );
}
const commitInput = (lock = makeLock()) => ({
  scope: lock.scope,
  actor,
  lock,
  expectedRevision: lock.revision === 1 ? null : lock.revision - 1,
});
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} composition: explicit migration, immutable history, replay and physical restart`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const store = f.first.store.compositionStore!();
      assert.equal(
        (await f.tableNames()).includes("plugin_composition_locks"),
        false,
      );
      await assert.rejects(store.loadCurrent({ scope }));
      await store.migrate();
      await store.migrate();
      assert.equal(await store.loadCurrent({ scope }), null);
      const one = makeLock();
      assert.equal(
        (await store.commit(commitInput(one))).disposition,
        "committed",
      );
      assert.deepEqual(
        await f.second.store.compositionStore!().loadCurrent({ scope }),
        one,
      );
      const two = makeLock(2, [], "epoch-after-restart");
      await store.commit(commitInput(two));
      assert.equal(
        (await store.commit(commitInput(one))).disposition,
        "replayed",
      );
      assert.deepEqual(await store.loadCurrent({ scope }), two);
      assert.deepEqual(
        await store.loadLock({ scope, lockDigest: one.lockDigest }),
        one,
      );
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}plugin_composition_locks SET actor_id='changed'`,
        ),
        /plugin_composition_lock_immutable/,
      );
      await assert.rejects(
        f.execute(`DELETE FROM ${f.prefix}plugin_composition_locks`),
        /plugin_composition_lock_immutable/,
      );
      await f.first.parent.close();
      await assert.rejects(store.loadCurrent({ scope }));
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.store.compositionStore!().loadCurrent({ scope }),
        two,
      );
      assert.deepEqual(
        await reopened.store.compositionStore!().loadLock({
          scope,
          lockDigest: one.lockDigest,
        }),
        one,
      );
      assert.equal(
        await reopened.store.compositionStore!().loadCurrent({
          scope: { ...scope, profileId: "foreign-profile" },
        }),
        null,
      );
    },
  );
  test(
    `${backend} composition: selection pins and complete enabled vector rollback`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const store = f.first.store.compositionStore!();
      await store.migrate();
      const installed =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const selected = await f.first.store.commitSelection(
        selectionRecipe(installed.selection, "enable"),
      );
      const pkg = installed.package;
      const node: PluginCompositionNode = {
        pluginId: pkg.pluginId,
        publisherId: pkg.publisherId,
        version: pkg.version,
        packageDigest: pkg.packageDigest,
        selectionRevision: selected.selection.revision,
        hostApi: "crewon.plugin-host.v1",
        requires: [],
        provides: [],
      };
      await assert.rejects(
        store.commit(commitInput(makeLock())),
        /plugin_composition_selection_conflict/,
      );
      const one = makeLock(1, [node]);
      await store.commit(commitInput(one));
      await assert.rejects(
        store.commit(
          commitInput(makeLock(2, [{ ...node, selectionRevision: 1 }])),
        ),
        /plugin_installation_pin_conflict/,
      );
      await f.first.store.commitSelection(
        selectionRecipe(selected.selection, "uninstall", {
          state: "uninstalled",
        }),
      );
      await assert.rejects(
        store.commit(commitInput(makeLock(2, [node]))),
        /plugin_composition_selection_conflict/,
      );
      assert.deepEqual(await store.loadCurrent({ scope }), one);
      assert.equal(await f.count("plugin_composition_locks"), 1);
      const two = makeLock(2);
      await store.commit(commitInput(two));
      assert.deepEqual(
        await store.loadLock({ scope, lockDigest: one.lockDigest }),
        one,
      );
    },
  );
  test(
    `${backend} composition: competing hosts CAS, actor/epoch isolation, future schema fence`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const a = f.first.store.compositionStore!(),
        b = f.second.store.compositionStore!();
      await a.migrate();
      const one = makeLock();
      await a.commit(commitInput(one));
      const results = await Promise.allSettled([
        a.commit(commitInput(makeLock(2, [], "epoch-a"))),
        b.commit(commitInput(makeLock(2, [], "epoch-b"))),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.match(
        String(
          (
            results.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        ),
        /plugin_composition_revision_conflict/,
      );
      const next = commitInput(makeLock(3));
      await assert.rejects(
        a.commit({
          ...next,
          scope: { ...next.scope, authorityEpoch: "different" },
        }),
        /plugin_composition_scope_mismatch/,
      );
      await assert.rejects(
        a.commit({ ...next, actor: { ...actor, tenantId: "foreign" } }),
      );
      assert.equal(await f.count("plugin_composition_locks"), 2);
      await f.execute(
        `UPDATE ${f.prefix}plugin_composition_schema_version SET version=99`,
      );
      await assert.rejects(
        a.migrate(),
        /plugin_composition_schema_unsupported/,
      );
      await assert.rejects(
        a.loadCurrent({ scope }),
        /plugin_composition_schema_unsupported/,
      );
      await assert.rejects(
        a.commit(next),
        /plugin_composition_schema_unsupported/,
      );
    },
  );
  test(
    `${backend} composition: migration rollback rejects a preexisting future version`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_composition_schema_version(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO ${f.prefix}plugin_composition_schema_version VALUES(1,99)`,
      );
      await assert.rejects(
        f.first.store.compositionStore!().migrate(),
        /plugin_composition_schema_unsupported/,
      );
      assert.equal(
        (await f.tableNames()).includes("plugin_composition_locks"),
        false,
      );
    },
  );
}

test("SQLite composition: actual profile owner scope, captured input, exclusion and close", async (t) => {
  const f = await fixture(t, "sqlite");
  const root = f.first.store.compositionStore!();
  await root.migrate();
  const owner = await (
    f.first.store as SqlitePluginInstallationStore
  ).acquireProfileOwner({ scope, onOwnershipLost() {} });
  const owned = owner.store.compositionStore!();
  await assert.rejects(
    owned.migrate(),
    /plugin_profile_owner_operation_invalid/,
  );
  await assert.rejects(
    owned.loadCurrent({ scope: { ...scope, profileId: "foreign" } }),
    /plugin_installation_scope_mismatch/,
  );
  await assert.rejects(
    f.second.store.compositionStore!().commit(commitInput()),
    /plugin_profile_owner_busy/,
  );
  const input = JSON.parse(JSON.stringify(commitInput()));
  const saving = owned.commit(input);
  input.lock.scope.authorityEpoch = "tampered";
  input.actor.actorId = "tampered";
  await saving;
  assert.deepEqual(await owned.loadCurrent({ scope }), makeLock());
  await owner.close();
  await assert.rejects(owned.loadCurrent({ scope }));
  await f.second.store.compositionStore!().commit(commitInput(makeLock(2)));
});

test("SQLite composition: failed head write rolls back history and JSON identity constraints reject missing fields", async (t) => {
  const f = await fixture(t, "sqlite");
  const store = f.first.store.compositionStore!();
  await store.migrate();
  await f.execute(
    "CREATE TRIGGER fixture_composition_failure BEFORE INSERT ON plugin_composition_heads BEGIN SELECT RAISE(ABORT,'fixture_head_failure'); END;",
  );
  await assert.rejects(store.commit(commitInput()), /fixture_head_failure/);
  assert.equal(await f.count("plugin_composition_locks"), 0);
  assert.equal(await store.loadCurrent({ scope }), null);
  await f.execute("DROP TRIGGER fixture_composition_failure");
  await store.commit(commitInput());
  const lock = JSON.parse(JSON.stringify(makeLock(2)));
  delete lock.schemaVersion;
  const escaped = JSON.stringify(lock).replaceAll("'", "''");
  await assert.rejects(
    f.execute(
      `INSERT INTO plugin_composition_locks(tenant_id,space_id,profile_id,authority_epoch,revision,lock_digest,actor_id,principal_id,lock_json) SELECT tenant_id,space_id,profile_id,authority_epoch,2,'${lock.lockDigest}',actor_id,principal_id,'${escaped}' FROM plugin_composition_locks LIMIT 1`,
    ),
    /CHECK constraint failed/,
  );
  assert.equal(await f.count("plugin_composition_locks"), 1);
});
