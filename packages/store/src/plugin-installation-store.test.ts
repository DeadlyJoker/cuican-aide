import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginSelection } from "@crewon/domain";
import {
  actor,
  digest,
  fixture,
  installationRecipe,
  packageRecord,
  postgresLifecycleFixture,
  receipt,
  scope,
  selectionRecipe,
  tables,
  timestamp,
} from "./plugin-installation-store.test-support.ts";

// Real durable ledger conformance only: no provider, HTTP, UI, Run, price or debit is invoked.
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };

  test(
    `${backend} plugin installation: explicit independent migration and future version fence`,
    options,
    async (t) => {
      const f = await fixture(t, backend, { migrate: false });
      assert.equal(
        (await f.tableNames()).some(
          (name) =>
            tables.includes(name as (typeof tables)[number]) ||
            name === "plugin_installation_schema_version",
        ),
        false,
      );
      await f.first.parent.extensionStore().migrate();
      await f.first.parent.extensionStore().migrateCredits();
      await f.first.parent.creativeProjectStore().migrate();
      const before = await f.versions();
      await f.first.store.migrate();
      const saved =
        await f.first.store.recordInstalledPackage(installationRecipe());
      await f.second.store.migrate();
      await f.first.store.migrate();
      assert.deepEqual(await f.versions(), before);
      assert.deepEqual(
        await f.first.store.loadPackage({
          scope,
          packageDigest: saved.package.packageDigest,
        }),
        saved.package,
      );
      const counts = await f.counts();
      await f.execute(
        `UPDATE ${f.prefix}plugin_installation_schema_version SET version=99 WHERE id=1`,
      );
      await assert.rejects(
        f.first.store.migrate(),
        /plugin_installation_schema_version_unsupported/,
      );
      await assert.rejects(
        f.first.store.loadSelection({
          scope,
          pluginId: saved.package.pluginId,
        }),
        /plugin_installation_schema_version_unsupported/,
      );
      await assert.rejects(
        f.first.store.recordInstalledPackage(
          installationRecipe("future", {
            version: "2.0.0",
            expectedSelectionRevision: 1,
          }),
        ),
        /plugin_installation_schema_version_unsupported/,
      );
      assert.deepEqual(await f.counts(), counts);
      assert.deepEqual(await f.versions(), before);
      assert.equal(
        (
          await f.query(
            `SELECT version FROM ${f.prefix}plugin_installation_schema_version`,
          )
        )[0]!.version,
        99,
      );
    },
  );

  test(
    `${backend} plugin installation: reopened records preserve the first audit and live selection`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const first =
        await f.first.store.recordInstalledPackage(installationRecipe());
      assert.equal(first.selection.state, "disabled");
      assert.equal(first.selection.revision, 1);
      await f.first.parent.close();
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.store.loadPackage({
          scope,
          packageDigest: first.package.packageDigest,
        }),
        first.package,
      );
      const enabled = await reopened.store.commitSelection(
        selectionRecipe(first.selection, "enable"),
      );
      const second = await reopened.store.recordInstalledPackage(
        installationRecipe("install-new-version", {
          version: "2.0.0",
          expectedSelectionRevision: enabled.selection.revision,
        }),
      );
      assert.deepEqual(second.selection, enabled.selection);
      const who = {
        ...actor,
        principalId: "principal-另一管理员",
        actorId: "actor-另一管理员",
      };
      const repeat = await reopened.store.recordInstalledPackage(
        installationRecipe("fresh-install-receipt", {
          actor: who,
          expectedSelectionRevision: enabled.selection.revision,
          at: "2026-10-03T00:00:00.000Z",
        }),
      );
      assert.deepEqual(repeat.package, first.package);
      assert.deepEqual(repeat.selection, enabled.selection);
      assert.deepEqual(await f.counts(), {
        installed_plugin_packages: 2,
        plugin_profile_selections: 1,
        plugin_installation_receipts: 4,
      });
    },
  );

  test(
    `${backend} plugin installation: logical uninstall preserves immutable history and replay snapshots`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const initial =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const enabledInput = selectionRecipe(
        initial.selection,
        "toggle-same-key",
      );
      const enabled = await f.first.store.commitSelection(enabledInput);
      const uninstalled = await f.first.store.commitSelection(
        selectionRecipe(enabled.selection, "uninstall", {
          state: "uninstalled",
        }),
      );
      assert.equal(uninstalled.selection.selectedPackageDigest, null);
      assert.equal(await f.count("installed_plugin_packages"), 1);
      const reinstalled = await f.second.store.recordInstalledPackage(
        installationRecipe("reinstall-after-uninstall", {
          expectedSelectionRevision: uninstalled.selection.revision,
          at: "2026-10-04T00:00:00.000Z",
        }),
      );
      assert.equal(reinstalled.selection.state, "disabled");
      assert.equal(reinstalled.selection.revision, 4);
      assert.deepEqual(reinstalled.package, initial.package);
      const replay = await f.first.store.commitSelection({
        ...enabledInput,
        selection: parsePluginSelection({
          ...enabledInput.selection,
          updatedAt: "2026-10-05T00:00:00.000Z",
        }),
      });
      assert.deepEqual(replay, { ...enabled, disposition: "replayed" });
      assert.deepEqual(
        await f.first.store.loadSelection({
          scope,
          pluginId: initial.package.pluginId,
        }),
        reinstalled.selection,
      );
      const old = await f.first.store.loadReceipt({
        scope,
        actor,
        kind: "install",
        receipt: receipt("install-1"),
      });
      assert.deepEqual(old, { ...initial, disposition: "replayed" });
      await assert.rejects(
        f.first.store.commitSelection({
          ...enabledInput,
          selection: parsePluginSelection({
            ...enabledInput.selection,
            state: "disabled",
          }),
        }),
        { code: "plugin_installation_idempotency_conflict" },
      );
      await assert.rejects(
        f.first.store.loadReceipt({
          scope,
          actor,
          kind: "select",
          receipt: receipt("toggle-same-key", "changed-request"),
        }),
        { code: "plugin_installation_idempotency_conflict" },
      );
    },
  );

  test(
    `${backend} plugin installation: profile, actor, principal and mutation kind receipts remain isolated`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const initial = await f.first.store.recordInstalledPackage(
        installationRecipe("shared-key"),
      );
      const anotherPrincipal = { ...actor, principalId: "principal-另一个" };
      assert.equal(
        await f.first.store.loadReceipt({
          scope,
          actor: anotherPrincipal,
          kind: "install",
          receipt: receipt("shared-key"),
        }),
        null,
      );
      const anotherActor = { ...actor, actorId: "actor-另一个" };
      assert.equal(
        await f.first.store.loadReceipt({
          scope,
          actor: anotherActor,
          kind: "install",
          receipt: receipt("shared-key"),
        }),
        null,
      );
      const second = await f.first.store.recordInstalledPackage(
        installationRecipe("shared-key", {
          actor: anotherPrincipal,
          expectedSelectionRevision: 1,
        }),
      );
      assert.equal(second.disposition, "committed");
      assert.deepEqual(second.package, initial.package);
      await f.first.store.recordInstalledPackage(
        installationRecipe("shared-key", {
          actor: anotherActor,
          expectedSelectionRevision: 1,
        }),
      );
      const selected = await f.first.store.commitSelection(
        selectionRecipe(initial.selection, "shared-key"),
      );
      assert.equal(selected.kind, "select");
      assert.equal(selected.selection.state, "enabled");
      for (const other of [
        { ...scope, profileId: "profile-另一个" },
        { ...scope, spaceId: "space-另一个" },
        { ...scope, tenantId: "tenant-另一个" },
      ]) {
        assert.equal(
          await f.first.store.loadPackage({
            scope: other,
            packageDigest: initial.package.packageDigest,
          }),
          null,
        );
        assert.equal(
          await f.first.store.loadSelection({
            scope: other,
            pluginId: initial.package.pluginId,
          }),
          null,
        );
        assert.equal(
          await f.first.store.loadReceipt({
            scope: other,
            actor: {
              ...actor,
              tenantId: other.tenantId,
              spaceId: other.spaceId,
            },
            kind: "install",
            receipt: receipt("shared-key"),
          }),
          null,
        );
        assert.deepEqual(
          await f.first.store.listPackages({
            scope: other,
            pluginId: null,
            afterPackageDigest: null,
            limit: 50,
          }),
          { packages: [], next: null },
        );
      }
      const otherScope = { ...scope, profileId: "profile-另一个" };
      await f.first.store.recordInstalledPackage(
        installationRecipe("shared-key", { scope: otherScope }),
      );
      assert.deepEqual(await f.counts(), {
        installed_plugin_packages: 2,
        plugin_profile_selections: 2,
        plugin_installation_receipts: 5,
      });
    },
  );

  test(
    `${backend} plugin installation: concurrent same-key installs commit exactly one stable snapshot`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const proposals = Array.from({ length: 4 }, (_, i) =>
        installationRecipe("concurrent-key", {
          at: `2026-10-0${i + 2}T00:00:00.000Z`,
        }),
      );
      const result = await Promise.all(
        proposals.map((input, i) =>
          (i % 2 ? f.second : f.first).store.recordInstalledPackage(input),
        ),
      );
      assert.equal(
        result.filter((row) => row.disposition === "committed").length,
        1,
      );
      assert.equal(
        result.filter((row) => row.disposition === "replayed").length,
        3,
      );
      for (const row of result)
        assert.deepEqual(
          { ...row, disposition: "committed" },
          { ...result[0], disposition: "committed" },
        );
      assert.deepEqual(await f.counts(), {
        installed_plugin_packages: 1,
        plugin_profile_selections: 1,
        plugin_installation_receipts: 1,
      });
      const reopened = await f.open();
      assert.deepEqual(
        await reopened.store.loadReceipt({
          scope,
          actor,
          kind: "install",
          receipt: receipt("concurrent-key"),
        }),
        { ...result[0], disposition: "replayed" },
      );
    },
  );

  test(
    `${backend} plugin installation: CAS admits one competing selection and leaves no orphan version`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const initial =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const outcomes = await Promise.allSettled([
        f.first.store.commitSelection(
          selectionRecipe(initial.selection, "cas-a"),
        ),
        f.second.store.commitSelection(
          selectionRecipe(initial.selection, "cas-b", { state: "disabled" }),
        ),
      ]);
      assert.equal(
        outcomes.filter((row) => row.status === "fulfilled").length,
        1,
      );
      const rejected = outcomes.find(
        (row) => row.status === "rejected",
      ) as PromiseRejectedResult;
      assert.equal(
        rejected.reason.code,
        "plugin_installation_revision_conflict",
      );
      const before = await f.counts();
      await assert.rejects(
        f.first.store.recordInstalledPackage(
          installationRecipe("stale-new-version", {
            version: "2.0.0",
            expectedSelectionRevision: 1,
          }),
        ),
        { code: "plugin_installation_revision_conflict" },
      );
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        await f.first.store.loadPackage({
          scope,
          packageDigest: packageRecord({ version: "2.0.0" }).packageDigest,
        }),
        null,
      );
    },
  );

  test(
    `${backend} plugin installation: namespace publisher and immutable version cannot be rebound`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const initial =
        await f.first.store.recordInstalledPackage(installationRecipe());
      const before = await f.counts();
      await assert.rejects(
        f.first.store.recordInstalledPackage(
          installationRecipe("rebind-version", {
            expectedSelectionRevision: 1,
            packageDigest: digest("different-bytes"),
          }),
        ),
        { code: "plugin_installation_package_identity_conflict" },
      );
      await assert.rejects(
        f.first.store.recordInstalledPackage(
          installationRecipe("replace-publisher", {
            expectedSelectionRevision: 1,
            version: "2.0.0",
            publisherId: "unrelated.publisher",
          }),
        ),
        { code: "plugin_installation_publisher_conflict" },
      );
      await assert.rejects(
        f.first.store.recordInstalledPackage(
          installationRecipe("cross-namespace-digest", {
            pluginId: "example.other",
            packageDigest: initial.package.packageDigest,
          }),
        ),
        { code: "plugin_installation_package_identity_conflict" },
      );
      await assert.rejects(
        f.first.store.commitSelection(
          selectionRecipe(initial.selection, "unsaved-package", {
            packageDigest: digest("not-installed"),
          }),
        ),
        { code: "plugin_installation_package_not_found" },
      );
      const otherScope = { ...scope, profileId: "profile-foreign" };
      const foreign = await f.first.store.recordInstalledPackage(
        installationRecipe("foreign", { scope: otherScope, version: "3.0.0" }),
      );
      await assert.rejects(
        f.first.store.commitSelection(
          selectionRecipe(initial.selection, "foreign-package", {
            packageDigest: foreign.package.packageDigest,
          }),
        ),
        { code: "plugin_installation_package_not_found" },
      );
      assert.deepEqual(await f.counts(), {
        ...before,
        installed_plugin_packages: 2,
        plugin_profile_selections: 2,
        plugin_installation_receipts: 2,
      });
      const malformed = installationRecipe("forged-audit", {
        expectedSelectionRevision: 1,
      });
      await assert.rejects(
        f.first.store.recordInstalledPackage({
          ...malformed,
          package: {
            ...malformed.package,
            installedByPrincipalId: "forged-principal",
          },
        }),
        { code: "plugin_installation_actor_mismatch" },
      );
      await assert.rejects(
        f.first.store.recordInstalledPackage({
          ...malformed,
          scope: otherScope,
        }),
        { code: "plugin_installation_scope_mismatch" },
      );
    },
  );

  test(
    `${backend} plugin installation: receipt failure rolls back package and selection writes together`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.failReceipts(true);
      await assert.rejects(
        f.first.store.recordInstalledPackage(installationRecipe()),
        /plugin_installation_fixture_write_failed/,
      );
      assert.deepEqual(await f.counts(), {
        installed_plugin_packages: 0,
        plugin_profile_selections: 0,
        plugin_installation_receipts: 0,
      });
      await f.failReceipts(false);
      const initial =
        await f.first.store.recordInstalledPackage(installationRecipe());
      await f.failReceipts(true);
      const input = selectionRecipe(initial.selection, "update-rollback");
      await assert.rejects(
        f.second.store.commitSelection(input),
        /plugin_installation_fixture_write_failed/,
      );
      assert.deepEqual(
        await f.first.store.loadSelection({
          scope,
          pluginId: initial.package.pluginId,
        }),
        initial.selection,
      );
      assert.deepEqual(await f.counts(), {
        installed_plugin_packages: 1,
        plugin_profile_selections: 1,
        plugin_installation_receipts: 1,
      });
      await f.failReceipts(false);
      assert.equal(
        (await f.second.store.commitSelection(input)).selection.state,
        "enabled",
      );
    },
  );

  test(
    `${backend} plugin installation: database guards keep history and namespace identity immutable`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const initial =
        await f.first.store.recordInstalledPackage(installationRecipe());
      for (const table of [
        "installed_plugin_packages",
        "plugin_installation_receipts",
      ])
        for (const action of ["UPDATE", "DELETE"])
          await assert.rejects(
            f.execute(
              action === "UPDATE"
                ? `UPDATE ${f.prefix}${table} SET ${table === "installed_plugin_packages" ? "version='1.0.0'" : "request_digest=request_digest"}`
                : `DELETE FROM ${f.prefix}${table}`,
            ),
            /plugin_installation_history_immutable/,
          );
      await assert.rejects(
        f.execute(`DELETE FROM ${f.prefix}plugin_profile_selections`),
        /plugin_installation_identity_immutable/,
      );
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}plugin_profile_selections SET publisher_id='replacement.publisher'`,
        ),
        /plugin_installation_identity_immutable/,
      );
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}plugin_profile_selections SET selected_package_digest=NULL`,
        ),
      );
      assert.deepEqual(
        await f.first.store.loadSelection({
          scope,
          pluginId: initial.package.pluginId,
        }),
        initial.selection,
      );
      assert.deepEqual(await f.counts(), {
        installed_plugin_packages: 1,
        plugin_profile_selections: 1,
        plugin_installation_receipts: 1,
      });
    },
  );

  test(
    `${backend} plugin installation: bounded binary pages are stable across both host connections`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const ids = ["example.a_", "example.a0", "example.a-", "example.a."];
      const saved = [];
      for (let i = 0; i < ids.length; i++)
        saved.push(
          await f.first.store.recordInstalledPackage(
            installationRecipe(`page-${i}`, { pluginId: ids[i] }),
          ),
        );
      const expectedIds = [...ids].sort();
      const selected = [];
      let afterPluginId: string | null = null;
      do {
        const page = await f.second.store.listSelections({
          scope,
          afterPluginId,
          limit: 1,
        });
        selected.push(...page.selections.map((row) => row.pluginId));
        if (page.next !== null)
          assert.equal(page.next, page.selections.at(-1)!.pluginId);
        afterPluginId = page.next;
      } while (afterPluginId !== null);
      assert.deepEqual(selected, expectedIds);
      const packages = [];
      let afterPackageDigest: string | null = null;
      do {
        const page = await f.second.store.listPackages({
          scope,
          pluginId: null,
          afterPackageDigest,
          limit: 1,
        });
        packages.push(...page.packages.map((row) => row.packageDigest));
        if (page.next !== null)
          assert.equal(page.next, page.packages.at(-1)!.packageDigest);
        afterPackageDigest = page.next;
      } while (afterPackageDigest !== null);
      assert.deepEqual(
        packages,
        saved.map((row) => row.package.packageDigest).sort(),
      );
      const filtered = await f.second.store.listPackages({
        scope,
        pluginId: ids[0]!,
        afterPackageDigest: null,
        limit: 50,
      });
      assert.equal(filtered.packages.length, 1);
      assert.equal(filtered.packages[0]!.pluginId, ids[0]);
      assert.deepEqual(
        await f.first.store.listSelections({
          scope,
          afterPluginId: "zzzz",
          limit: 50,
        }),
        { selections: [], next: null },
      );
      await assert.rejects(
        f.first.store.listPackages({
          scope,
          pluginId: null,
          afterPackageDigest: null,
          limit: 51,
        }),
        { code: "plugin_installation_limit_invalid" },
      );
      await assert.rejects(
        f.first.store.listPackages({
          scope,
          pluginId: null,
          afterPackageDigest: "not-a-digest",
          limit: 1,
        }),
        { code: "plugin_installation_digest_invalid" },
      );
    },
  );

  test(
    `${backend} plugin installation: strict recipes invoke no getters and cached children obey host close`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      let getters = 0;
      const input = installationRecipe();
      Object.defineProperty(input, "package", {
        enumerable: true,
        get() {
          getters++;
          return packageRecord();
        },
      });
      await assert.rejects(f.first.store.recordInstalledPackage(input), {
        code: "plugin_installation_fields_invalid",
      });
      assert.equal(getters, 0);
      const forged = installationRecipe();
      Object.defineProperty(forged.actor, "principalId", {
        enumerable: true,
        get() {
          getters++;
          return actor.principalId;
        },
      });
      await assert.rejects(f.first.store.recordInstalledPackage(forged), {
        code: "plugin_installation_fields_invalid",
      });
      assert.equal(getters, 0);
      assert.deepEqual(await f.counts(), {
        installed_plugin_packages: 0,
        plugin_profile_selections: 0,
        plugin_installation_receipts: 0,
      });
      await f.first.parent.close();
      await assert.rejects(f.first.store.migrate(), { code: "store_closed" });
      await assert.rejects(
        f.first.store.loadPackage({
          scope,
          packageDigest: packageRecord().packageDigest,
        }),
        { code: "store_closed" },
      );
      await assert.rejects(
        f.first.store.recordInstalledPackage(installationRecipe()),
        { code: "store_closed" },
      );
      assert.equal(
        (await f.second.store.recordInstalledPackage(installationRecipe()))
          .disposition,
        "committed",
      );
    },
  );
}

test(
  "postgres plugin installation: closing the real host after an INSERT response rolls back every record",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await postgresLifecycleFixture(t);
    const gate = f.arm("receipt");
    const operation = f.track(
      f.store.recordInstalledPackage(installationRecipe()),
    );
    const rejected = assert.rejects(operation, { code: "store_closed" });
    await gate.entered.promise;
    await f.parent.close();
    gate.resume.resolve();
    await rejected;
    assert.deepEqual(await f.counts(), {
      installed_plugin_packages: 0,
      plugin_profile_selections: 0,
      plugin_installation_receipts: 0,
    });
    assert.equal(f.pool.waitingCount, 0);
    assert.equal(f.pool.totalCount, f.pool.idleCount);
  },
);

test(
  "postgres plugin installation: a confirmed COMMIT succeeds across real host close without leaking its connection",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await postgresLifecycleFixture(t);
    const gate = f.arm("commit");
    const operation = f.track(
      f.store.recordInstalledPackage(installationRecipe()),
    );
    await gate.entered.promise;
    assert.deepEqual(await f.counts(), {
      installed_plugin_packages: 1,
      plugin_profile_selections: 1,
      plugin_installation_receipts: 1,
    });
    await f.parent.close();
    gate.resume.resolve();
    const result = await operation;
    assert.equal(result.disposition, "committed");
    assert.equal(result.selection.state, "disabled");
    await assert.rejects(
      f.store.loadSelection({ scope, pluginId: result.package.pluginId }),
      { code: "store_closed" },
    );
    assert.equal(f.pool.waitingCount, 0);
    assert.equal(f.pool.totalCount, f.pool.idleCount);
  },
);
