import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginTaskReceiptLocator } from "@crewon/application";
import { extensionFixture } from "./extension-store.test-support.ts";
import { seedProbeAdmission } from "./plugin-task-admission-probe.test-support.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `${backend} original installed task receipt lookup`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      async function fixture(t: Parameters<typeof extensionFixture>[0]) {
        const f = await extensionFixture(t, backend);
        const input = await seedProbeAdmission(f);
        const admission = input.pluginAdmission!;
        const locator: PluginTaskReceiptLocator = {
          tenantId: admission.tenantId,
          spaceId: admission.spaceId,
          profileId: admission.profileId,
          pluginId: admission.pluginId,
          principalId: admission.principalId,
          actorId: admission.actorId,
          idempotencyKey: admission.idempotencyKey,
        };
        const receiptWhere = `tenant_id=${quote(admission.tenantId)} AND space_id=${quote(admission.spaceId)} AND plugin_id=${quote(admission.pluginId)} AND kind='task' AND actor_id=${quote(admission.actorId)} AND idempotency_key=${quote(admission.idempotencyKey)}`;
        const unlockAdmissions = () =>
          f.sql(
            backend === "sqlite"
              ? "DROP TRIGGER plugin_task_admissions_no_update; DROP TRIGGER plugin_task_admissions_no_delete;"
              : `DROP TRIGGER plugin_task_admissions_no_update ON ${f.prefix}plugin_task_admissions;`,
          );
        return {
          ...f,
          input,
          admission,
          locator,
          receiptWhere,
          unlockAdmissions,
        };
      }

      test("reopened lookup retains the exact original epoch and selection revision after uninstall without any writes", async (t) => {
        const f = await fixture(t);
        const before = Object.fromEntries(
          await Promise.all(
            [
              "extension_mutation_receipts",
              "plugin_task_admissions",
              "plugin_credit_reservations",
              "run_snapshots",
              "messages",
            ].map(async (name) => [name, await f.count(name)]),
          ),
        );
        const installations = f.first.parent.pluginInstallationStore();
        const selected = await installations.loadSelection({
          scope: {
            tenantId: f.locator.tenantId,
            spaceId: f.locator.spaceId,
            profileId: f.locator.profileId,
          },
          pluginId: f.locator.pluginId,
        });
        assert.ok(selected);
        await installations.commitSelection(
          selectionRecipe(selected, "receipt-lookup-uninstall", {
            actor: {
              tenantId: f.locator.tenantId,
              spaceId: f.locator.spaceId,
              principalId: f.locator.principalId,
              actorId: f.locator.actorId,
            },
            state: "uninstalled",
          }),
        );
        const reopened = await f.open();
        assert.deepEqual(
          await reopened.store.loadPluginTaskAdmissionByReceipt(f.locator),
          f.admission,
        );
        assert.deepEqual(
          await f.second.store.loadPluginTaskAdmissionByReceipt(f.locator),
          f.admission,
        );
        for (const [name, count] of Object.entries(before))
          assert.equal(await f.count(name), count);
      });

      test("captures the caller locator before any asynchronous database read", async (t) => {
        const f = await fixture(t);
        const mutable = { ...f.locator };
        const pending = f.first.store.loadPluginTaskAdmissionByReceipt(mutable);
        mutable.profileId = "other-profile";
        mutable.principalId = "other-principal";
        mutable.actorId = "other-actor";
        mutable.idempotencyKey = "other-key";
        assert.deepEqual(await pending, f.admission);
      });

      test("returns null only when the exact task receipt key is absent", async (t) => {
        const f = await fixture(t);
        for (const patch of [
          { tenantId: "other-tenant" },
          { spaceId: "other-space" },
          { pluginId: "other.plugin" },
          { actorId: "other-actor" },
          { idempotencyKey: "unused-key" },
        ])
          assert.equal(
            await f.first.store.loadPluginTaskAdmissionByReceipt({
              ...f.locator,
              ...patch,
            }),
            null,
          );
        for (const patch of [
          { profileId: "other-profile" },
          { principalId: "other-principal" },
        ])
          await assert.rejects(
            f.first.store.loadPluginTaskAdmissionByReceipt({
              ...f.locator,
              ...patch,
            }),
            /plugin_task_admission_record_invalid/u,
          );
      });

      test("rejects accessor and extra-field locators before invoking getters", async (t) => {
        const f = await fixture(t);
        const accessor = { ...f.locator };
        Object.defineProperty(accessor, "principalId", {
          enumerable: true,
          get() {
            assert.fail("identity getter ran");
          },
        });
        await assert.rejects(
          f.first.store.loadPluginTaskAdmissionByReceipt(accessor),
          /plugin_installation_fields_invalid/u,
        );
        await assert.rejects(
          f.first.store.loadPluginTaskAdmissionByReceipt({
            ...f.locator,
            runId: "caller-selected-run",
          } as PluginTaskReceiptLocator),
          /plugin_installation_fields_invalid/u,
        );
      });

      test("does not turn a real receipt with a missing admission into absence", async (t) => {
        const f = await fixture(t);
        await f.unlockAdmissions();
        await f.sql(
          `DELETE FROM ${f.prefix}plugin_task_admissions WHERE tenant_id=${quote(f.admission.tenantId)} AND run_id=${quote(f.admission.runId)}`,
        );
        await assert.rejects(
          f.first.store.loadPluginTaskAdmissionByReceipt(f.locator),
          /plugin_task_admission_missing/u,
        );
        assert.equal(await f.count("extension_mutation_receipts"), 3);
      });

      for (const [name, field, replacement] of [
        ["saved request digest", "requestDigest", `sha256:${"f".repeat(64)}`],
        ["saved effective key", "idempotencyKey", "another-receipt-key"],
      ] as const)
        test(`binds the real receipt to the admission ${name}`, async (t) => {
          const f = await fixture(t);
          await f.unlockAdmissions();
          const corrupted = JSON.stringify({
            ...f.admission,
            [field]: replacement,
          });
          await f.sql(
            `UPDATE ${f.prefix}plugin_task_admissions SET admission_json=${quote(corrupted)} WHERE tenant_id=${quote(f.admission.tenantId)} AND run_id=${quote(f.admission.runId)}`,
          );
          await assert.rejects(
            f.first.store.loadPluginTaskAdmissionByReceipt(f.locator),
          );
        });

      test("validates the actual saved receipt digest and complete Turn rather than just extracting a Run ID", async (t) => {
        const f = await fixture(t);
        await f.sql(
          `UPDATE ${f.prefix}extension_mutation_receipts SET request_digest='invalid-digest' WHERE ${f.receiptWhere}`,
        );
        await assert.rejects(
          f.first.store.loadPluginTaskAdmissionByReceipt(f.locator),
        );
        await f.sql(
          `UPDATE ${f.prefix}extension_mutation_receipts SET request_digest=${quote(f.input.receipt.requestDigest)},result_json=${quote(JSON.stringify({ binding: f.input.binding, run: {} }))} WHERE ${f.receiptWhere}`,
        );
        await assert.rejects(
          f.first.store.loadPluginTaskAdmissionByReceipt(f.locator),
        );
      });

      test("reuses strict binding and installed-package decoding even when the receipt itself remains valid", async (t) => {
        const f = await fixture(t);
        await f.sql(
          `UPDATE ${f.prefix}extension_run_bindings SET binding_json=${quote(JSON.stringify({ ...f.input.binding, target: { ...f.input.binding.target, authorityId: "foreign-authority" } }))} WHERE tenant_id=${quote(f.admission.tenantId)} AND run_id=${quote(f.admission.runId)}`,
        );
        await assert.rejects(
          f.first.store.loadPluginTaskAdmissionByReceipt(f.locator),
        );
      });
    },
  );
}
