import assert from "node:assert/strict";
import test from "node:test";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import { createExtensionRunBinding } from "@crewon/domain";
import { pluginQueryFixture, actor } from "./plugin-query-task.test-support.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: query inherits the original two-package graph after a new head and provider disable, with concurrent replay and restart`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend, { composition: true });
      assert.ok(f.compositions && f.lock && f.providerSelection);
      await f.installations.commitSelection(
        selectionRecipe(
          f.providerSelection.selection,
          "query-provider-disable",
          { actor, state: "disabled" },
        ),
      );
      const next = createPluginCompositionLock(
        {
          schemaVersion: f.lock.schemaVersion,
          hostServices: f.lock.hostServices,
          scope: { ...f.lock.scope, authorityEpoch: "new-host-epoch" },
          revision: 2,
          nodes: f.lock.nodes
            .filter((node) => node.pluginId === f.pin.pluginId)
            .map((node) => ({ ...node, requires: [] })),
        },
        extensionStoreDigester,
      );
      await f.compositions.commit({
        scope: next.scope,
        actor,
        lock: next,
        expectedRevision: 1,
      });
      const pin = { ...f.queryPin, authorityEpoch: next.scope.authorityEpoch };
      const results = await Promise.all([
        f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(actor, f.command(), pin),
        f
          .create(f.second.store, f.second.parent, f.host)
          .createQueryTaskFromPlugin(actor, f.command(), pin),
      ]);
      assert.deepEqual(results.map((result) => result.run.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      const accepted = results[0]!;
      assert.equal(
        accepted.binding.schemaVersion,
        "crewon.extension-run-binding.v1",
      );
      if (accepted.binding.schemaVersion !== "crewon.extension-run-binding.v1")
        assert.fail();
      assert.equal(accepted.binding.composition.lockDigest, f.lock.lockDigest);
      const query = await f.first.store.loadPluginQueryTaskAdmission(
        accepted.binding,
      );
      assert.ok(query);
      assert.equal(query.authorityEpoch, "new-host-epoch");
      assert.equal(query.source.authorityEpoch, f.lock.scope.authorityEpoch);
      await f.second.parent.close();
      const reopened = await f.open();
      const replay = await f
        .create(reopened.store, reopened.parent, f.host)
        .createQueryTaskFromPlugin(actor, f.command(), pin);
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, accepted.binding);
      assert.equal(await f.count("run_snapshots"), 2);
      assert.equal(await f.count("plugin_task_admissions"), 1);
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.equal(f.quoteCalls(), 1);
    },
  );

  test(
    `${backend}: query source-lock tampering is rejected on receipt reload and cannot fall back to the current graph`,
    options,
    async (t) => {
      const f = await pluginQueryFixture(t, backend, { composition: true });
      assert.ok(f.lock && f.compositions);
      const accepted = await f
        .create(undefined, undefined, f.host)
        .createQueryTaskFromPlugin(actor, f.command(), f.queryPin);
      assert.equal(
        accepted.binding.schemaVersion,
        "crewon.extension-run-binding.v1",
      );
      if (accepted.binding.schemaVersion !== "crewon.extension-run-binding.v1")
        assert.fail();
      const changed = createExtensionRunBinding(
        {
          ...accepted.binding,
          composition: { ...accepted.binding.composition, revision: 2 },
        },
        extensionStoreDigester,
      );
      // Deliberate corruption of this test's own database; the saved query admission still pins the original digest.
      const literal = JSON.stringify(changed).replaceAll("'", "''");
      await f.sql(
        `UPDATE ${f.prefix}extension_run_bindings SET binding_json='${literal}' WHERE run_id='${accepted.binding.runId}'`,
      );
      const reopened = await f.open();
      await assert.rejects(
        reopened.store.loadPluginQueryTaskAdmission(accepted.binding),
        /plugin_query_composition_source_mismatch|plugin_query_admission_binding_mismatch/u,
      );
      assert.equal(await f.count("run_snapshots"), 2);
      assert.equal(f.quoteCalls(), 1);
    },
  );
}
