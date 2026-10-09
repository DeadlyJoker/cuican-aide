import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionRunBinding,
  createExtensionCreditAdmission,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import { composedTurnFixture } from "./plugin-run-composition.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} composed Run: original two-package lock, paid atomic admission, concurrent replay and physical restart`,
    options,
    async (t) => {
      const f = await composedTurnFixture(t, backend);
      const results = await Promise.all([
        f.first.store.commitExtensionTurn(f.input),
        f.second.store.commitExtensionTurn(f.input),
      ]);
      assert.deepEqual(results.map((r) => r.run.disposition).sort(), [
        "committed",
        "replayed",
      ]);
      assert.equal(await f.count("messages"), 1);
      assert.equal(await f.count("work_items"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.store.loadExtensionRunBinding(f.input.binding),
        f.input.binding,
      );
      await f.installations.commitSelection(
        selectionRecipe(f.enabled.selection, "composition-disable-provider", {
          state: "disabled",
          actor: f.actor,
        }),
      );
      const next = f.makeLock(
        2,
        [
          {
            ...f.lock.nodes.find((n) => n.pluginId === f.pin.pluginId)!,
            requires: [],
          },
        ],
        "epoch-new-host",
      );
      await f.composition.commit({
        scope: next.scope,
        actor: f.actor,
        lock: next,
        expectedRevision: 1,
      });
      const replay = await reopened.store.commitExtensionTurn(f.input);
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, f.input.binding);
      assert.deepEqual(
        await reopened.store.loadExtensionRunBinding(f.input.binding),
        f.input.binding,
      );
      assert.deepEqual(await f.readOriginal(), f.lock);
      assert.deepEqual(
        await f.composition.loadCurrent({ scope: f.scope }),
        next,
      );
      assert.equal(await f.count("messages"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
    },
  );
  test(
    `${backend} composed Run: dependency withdrawal and newly enabled phantom roll back the whole paid Turn`,
    options,
    async (t) => {
      const f = await composedTurnFixture(t, backend);
      const disabled = await f.installations.commitSelection(
        selectionRecipe(f.enabled.selection, "composition-disabled", {
          state: "disabled",
          actor: f.actor,
        }),
      );
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.input),
        /plugin_run_composition_selection_conflict/,
      );
      await f.assertNoRun();
      await f.installations.commitSelection(
        selectionRecipe(disabled.selection, "composition-reenabled", {
          actor: f.actor,
        }),
      );
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.input),
        /plugin_installation_pin_conflict/,
      );
      await f.assertNoRun();
      const extra = await f.installations.recordInstalledPackage(
        installationRecipe("composition-extra-install", {
          scope: f.scope,
          actor: f.actor,
          pluginId: "example.extra",
        }),
      );
      await f.installations.commitSelection(
        selectionRecipe(extra.selection, "composition-extra-enable", {
          actor: f.actor,
        }),
      );
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.input),
        /plugin_run_composition_selection_conflict/,
      );
      await f.assertNoRun();
    },
  );
  test(
    `${backend} composed Run: stale head and epoch spoof reject before user messages or charges`,
    options,
    async (t) => {
      const f = await composedTurnFixture(t, backend);
      const next = f.makeLock(2);
      await f.composition.commit({
        scope: next.scope,
        actor: f.actor,
        lock: next,
        expectedRevision: 1,
      });
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.input),
        /plugin_run_composition_current_conflict/,
      );
      await f.assertNoRun();
      const bad = createExtensionRunBinding(
        {
          ...f.input.binding,
          schemaVersion: "crewon.extension-run-binding.v1",
          composition: {
            profileId: f.scope.profileId,
            authorityEpoch: "spoof",
            revision: 1,
            lockDigest: f.lock.lockDigest,
          },
        },
        extensionStoreDigester,
      );
      await assert.rejects(
        f.first.store.commitExtensionTurn({ ...f.input, binding: bad }),
        /plugin_task_admission_binding_mismatch/,
      );
      await f.assertNoRun();
    },
  );
  test(
    `${backend} composed Run: root configuration cannot silently follow a different package version`,
    options,
    async (t) => {
      const f = await composedTurnFixture(t, backend);
      const replacement = await f.installations.recordInstalledPackage(
        installationRecipe("composition-root-v2-install", {
          scope: f.scope,
          actor: f.actor,
          pluginId: f.pin.pluginId,
          version: "2.0.0",
          expectedSelectionRevision: f.pin.selectionRevision,
        }),
      );
      const selected = await f.installations.commitSelection(
        selectionRecipe(replacement.selection, "composition-root-v2-enable", {
          actor: f.actor,
          packageDigest: replacement.package.packageDigest,
        }),
      );
      const next = f.makeLock(
        2,
        f.lock.nodes.map((n) =>
          n.pluginId === f.pin.pluginId
            ? {
                ...n,
                version: replacement.package.version,
                packageDigest: replacement.package.packageDigest,
                selectionRevision: selected.selection.revision,
              }
            : n,
        ),
      );
      await f.composition.commit({
        scope: next.scope,
        actor: f.actor,
        lock: next,
        expectedRevision: 1,
      });
      const binding = createExtensionRunBinding(
        {
          ...f.input.binding,
          schemaVersion: "crewon.extension-run-binding.v1",
          composition: {
            profileId: f.scope.profileId,
            authorityEpoch: next.scope.authorityEpoch,
            revision: 2,
            lockDigest: next.lockDigest,
          },
        },
        extensionStoreDigester,
      );
      const input = {
        ...f.input,
        binding,
        pluginAdmission: parsePluginTaskAdmission({
          ...f.pin,
          version: replacement.package.version,
          packageDigest: replacement.package.packageDigest,
          selectionRevision: selected.selection.revision,
          extensionBindingDigest: binding.bindingDigest,
        }),
        creditAdmission: createExtensionCreditAdmission(
          {
            binding,
            receipt: f.input.receipt,
            principalId: f.pin.principalId,
            poolId: f.input.creditAdmission!.reservation.scope.poolId,
            priceRevision: 1,
            quotedCredits: "30",
          },
          extensionStoreDigester,
        ),
      };
      await assert.rejects(
        f.first.store.commitExtensionTurn(input),
        /plugin_run_composition_configuration_conflict/,
      );
      await f.assertNoRun();
    },
  );
  test(
    `${backend} composed Run: historical lock tampering rejects binding, receipt and replay even with a valid newer head`,
    options,
    async (t) => {
      const f = await composedTurnFixture(t, backend);
      await f.first.store.commitExtensionTurn(f.input);
      const next = f.makeLock(2);
      await f.composition.commit({
        scope: next.scope,
        actor: f.actor,
        lock: next,
        expectedRevision: 1,
      });
      await f.sql(
        backend === "sqlite"
          ? "DROP TRIGGER plugin_composition_lock_no_update"
          : `DROP TRIGGER plugin_composition_lock_immutable ON ${f.prefix}plugin_composition_locks`,
      );
      const altered = {
        ...f.lock,
        hostServices: [
          {
            service: "host.clock",
            apiVersion: "1",
            implementationId: "changed",
            implementationRevision: 1,
          },
        ],
      };
      const json = JSON.stringify(altered).replaceAll("'", "''");
      await f.sql(
        `UPDATE ${f.prefix}plugin_composition_locks SET lock_json='${json}' WHERE revision=1`,
      );
      await assert.rejects(
        f.first.store.loadExtensionRunBinding(f.input.binding),
        /digest_mismatch/,
      );
      await assert.rejects(
        f.first.store.loadExtensionTurnReceipt({
          ...f.input.binding,
          receipt: f.input.receipt,
        }),
        /digest_mismatch/,
      );
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.input),
        /digest_mismatch/,
      );
      assert.equal(await f.count("messages"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
    },
  );
  test(
    `${backend} composed Run: binding insert failure rolls back the user Turn, Run, work item and hold`,
    options,
    async (t) => {
      const f = await composedTurnFixture(t, backend);
      await f.failBindings(true);
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.input),
        /test_binding_failure/,
      );
      await f.assertNoRun();
      assert.equal(await f.count("plugin_composition_locks"), 1);
      await f.failBindings(false);
      assert.equal(
        (await f.first.store.commitExtensionTurn(f.input)).run.disposition,
        "committed",
      );
    },
  );
}

test(
  "PostgreSQL composition snapshot permits the actual owner's Run and fences a legacy newly-enabled row",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 10000 },
  async (t) => {
    const { Client } = await import("pg");
    const { PostgresPluginInstallationStore } = await import(
      "./postgres-plugin-installation-store.ts"
    );
    const { lockPostgresCompositionSnapshot } = await import(
      "./plugin-composition-snapshot-lock.ts"
    );
    const f = await composedTurnFixture(t, "postgres");
    const extra = await f.installations.recordInstalledPackage(
      installationRecipe("legacy-disabled", {
        scope: f.scope,
        actor: f.actor,
        pluginId: "example.disabled",
      }),
    );
    const owner = await (
      f.installations as InstanceType<typeof PostgresPluginInstallationStore>
    ).acquireProfileOwner({ scope: f.scope, onOwnershipLost() {} });
    const reader = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await reader.connect();
    try {
      await reader.query("BEGIN; SET LOCAL statement_timeout='1000ms'");
      await lockPostgresCompositionSnapshot({
        client: reader,
        schema: f.prefix.slice(1, -2),
        scope: f.scope,
        mode: "read",
      });
      // Older writers do not call the new helper; the migration's enabled-entry trigger still prevents a phantom.
      await assert.rejects(
        f.sql(
          `BEGIN; SET LOCAL statement_timeout='200ms'; UPDATE ${f.prefix}plugin_profile_selections SET state='enabled',record_json=jsonb_set(record_json,'{state}','"enabled"') WHERE plugin_id='${extra.package.pluginId}'`,
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "57014",
      );
      await f.sql("ROLLBACK");
      assert.equal(
        (
          await f.installations.loadSelection({
            scope: f.scope,
            pluginId: extra.package.pluginId,
          })
        )?.state,
        "disabled",
      );
      assert.equal(
        (await f.first.store.commitExtensionTurn(f.input)).run.disposition,
        "committed",
      );
    } finally {
      await f.sql("ROLLBACK");
      await reader.query("ROLLBACK");
      await reader.end();
      await owner.close();
    }
  },
);
