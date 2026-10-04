import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PluginTaskReceiptLocator } from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import { actor, pluginQueryFixture } from "./plugin-query-task.test-support.ts";
import { extensionFixture } from "./extension-store.test-support.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const receiptWhere = (locator: PluginTaskReceiptLocator) =>
  `tenant_id=${quote(locator.tenantId)} AND space_id=${quote(locator.spaceId)} AND plugin_id=${quote(locator.pluginId)} AND kind='task' AND actor_id=${quote(locator.actorId)} AND idempotency_key=${quote(locator.idempotencyKey)}`;

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `${backend} original installed query receipt lookup`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    () => {
      async function fixture(t: Parameters<typeof pluginQueryFixture>[0]) {
        const f = await pluginQueryFixture(t, backend);
        const accepted = await f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(actor, f.command(), f.queryPin);
        const query = await f.first.store.loadPluginQueryTaskAdmission(
          accepted.binding,
        );
        assert.ok(query);
        const locator: PluginTaskReceiptLocator = {
          tenantId: query.tenantId,
          spaceId: query.spaceId,
          profileId: query.profileId,
          pluginId: query.pluginId,
          principalId: query.principalId,
          actorId: query.actorId,
          idempotencyKey: query.idempotencyKey,
        };
        const sourceLocator: PluginTaskReceiptLocator = {
          ...locator,
          principalId: query.source.principalId,
          actorId: query.source.actorId,
          idempotencyKey: query.source.idempotencyKey,
        };
        const queryWhere = `tenant_id=${quote(query.tenantId)} AND run_id=${quote(query.runId)}`;
        const sourceWhere = `tenant_id=${quote(query.source.tenantId)} AND run_id=${quote(query.source.runId)}`;
        const unlockQueries = () =>
          f.sql(
            backend === "sqlite"
              ? "DROP TRIGGER plugin_query_task_no_update; DROP TRIGGER plugin_query_task_no_delete;"
              : `DROP TRIGGER plugin_query_task_no_change ON ${f.prefix}plugin_query_task_admissions;`,
          );
        const unlockCredits = () =>
          f.sql(
            backend === "sqlite"
              ? "DROP TRIGGER extension_credit_admissions_no_update; DROP TRIGGER extension_credit_admissions_no_delete;"
              : `DROP TRIGGER extension_credit_admissions_no_update_or_delete ON ${f.prefix}extension_credit_admissions;`,
          );
        return {
          ...f,
          accepted,
          query,
          locator,
          sourceLocator,
          queryWhere,
          sourceWhere,
          unlockQueries,
          unlockCredits,
        };
      }

      test("reopened lookup retains original invocation and paid source after uninstall without any additional writes or quote", async (t) => {
        const f = await fixture(t);
        const before = Object.fromEntries(
          await Promise.all(
            [
              "extension_mutation_receipts",
              "plugin_task_admissions",
              "plugin_query_task_admissions",
              "extension_credit_admissions",
              "plugin_credit_reservations",
              "extension_external_operations",
              "run_snapshots",
              "messages",
            ].map(async (name) => [name, await f.count(name)]),
          ),
        );
        await f.installations.commitSelection(
          selectionRecipe(f.enabled.selection, "query-receipt-uninstall", {
            actor,
            state: "uninstalled",
          }),
        );
        const reopened = await f.open();
        assert.deepEqual(
          await reopened.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
          f.query,
        );
        assert.deepEqual(
          await f.second.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
          f.query,
        );
        assert.equal(f.query.authorityEpoch, "query-epoch");
        assert.deepEqual(f.query.source, f.sourceAdmission);
        assert.equal(f.quoteCalls(), 1);
        for (const [name, count] of Object.entries(before))
          assert.equal(await f.count(name), count);
      });

      test("captures all caller identity fields before asynchronous receipt or source reads", async (t) => {
        const f = await fixture(t);
        const mutable = { ...f.locator };
        const pending =
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(mutable);
        mutable.tenantId = "other-tenant";
        mutable.spaceId = "other-space";
        mutable.profileId = "other-profile";
        mutable.pluginId = "other.plugin";
        mutable.principalId = "other-principal";
        mutable.actorId = "other-actor";
        mutable.idempotencyKey = "other-key";
        assert.deepEqual(await pending, f.query);
      });

      test("returns null only for an absent exact receipt key and rejects mismatched profile or principal", async (t) => {
        const f = await fixture(t);
        for (const patch of [
          { tenantId: "other-tenant" },
          { spaceId: "other-space" },
          { pluginId: "other.plugin" },
          { actorId: "other-actor" },
          { idempotencyKey: "unused-key" },
        ])
          assert.equal(
            await f.first.store.loadPluginQueryTaskAdmissionByReceipt({
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
            f.first.store.loadPluginQueryTaskAdmissionByReceipt({
              ...f.locator,
              ...patch,
            }),
            /plugin_query_admission_record_invalid/u,
          );
      });

      test("absence does not inspect, migrate or grant query or credit storage", async (t) => {
        const f = await extensionFixture(t, backend);
        assert.equal(
          await f.first.store.loadPluginQueryTaskAdmissionByReceipt({
            tenantId: "empty-tenant",
            spaceId: "empty-space",
            profileId: "empty-profile",
            pluginId: "empty.plugin",
            principalId: "empty-principal",
            actorId: "empty-actor",
            idempotencyKey: "empty-key",
          }),
          null,
        );
        await assert.rejects(f.count("plugin_query_task_admissions"));
        await assert.rejects(f.count("extension_credit_admissions"));
        assert.equal(await f.count("extension_mutation_receipts"), 0);
      });

      test("rejects accessor, extra fields and closed owners before exposing historical evidence", async (t) => {
        const f = await fixture(t);
        const accessor = Object.defineProperty(
          { ...f.locator },
          "principalId",
          {
            enumerable: true,
            get() {
              assert.fail("identity getter ran");
            },
          },
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(accessor),
          /plugin_installation_fields_invalid/u,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt({
            ...f.locator,
            runId: "caller-selected-run",
          } as PluginTaskReceiptLocator),
          /plugin_installation_fields_invalid/u,
        );
        await f.first.parent.close();
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
        );
      });

      test("keeps ordinary generation and query receipt lookups separate", async (t) => {
        const f = await fixture(t);
        await assert.rejects(
          f.first.store.loadPluginTaskAdmissionByReceipt(f.locator),
          /plugin_task_query_admission_unsupported/u,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.sourceLocator),
          /plugin_query_admission_binding_mismatch/u,
        );
        assert.deepEqual(
          await f.first.store.loadPluginTaskAdmissionByReceipt(f.sourceLocator),
          f.sourceAdmission,
        );
      });

      test("does not hide an existing query receipt whose immutable admission is missing", async (t) => {
        const f = await fixture(t);
        await f.unlockQueries();
        await f.sql(
          `DELETE FROM ${f.prefix}plugin_query_task_admissions WHERE ${f.queryWhere}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
          /plugin_query_admission_missing/u,
        );
        assert.equal(await f.count("extension_mutation_receipts"), 4);
      });

      for (const [name, field, replacement] of [
        ["request digest", "requestDigest", `sha256:${"f".repeat(64)}`],
        ["effective key", "idempotencyKey", "another-receipt-key"],
      ] as const)
        test(`validates original query receipt against saved admission ${name}`, async (t) => {
          const f = await fixture(t);
          await f.unlockQueries();
          await f.sql(
            `UPDATE ${f.prefix}plugin_query_task_admissions SET admission_json=${quote(JSON.stringify({ ...f.query, [field]: replacement }))} WHERE ${f.queryWhere}`,
          );
          await assert.rejects(
            f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
          );
        });

      test("validates actual saved digest and complete query Turn before selecting a Run", async (t) => {
        const f = await fixture(t);
        await f.sql(
          `UPDATE ${f.prefix}extension_mutation_receipts SET request_digest='invalid-digest' WHERE ${receiptWhere(f.locator)}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
        );
        await f.sql(
          `UPDATE ${f.prefix}extension_mutation_receipts SET request_digest=${quote(f.query.requestDigest)},result_json=${quote(JSON.stringify({ binding: f.accepted.binding, run: {} }))} WHERE ${receiptWhere(f.locator)}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
        );
      });

      test("verifies saved query binding and original source rather than trusting embedded source metadata", async (t) => {
        const f = await fixture(t);
        await f.unlockQueries();
        await f.sql(
          `UPDATE ${f.prefix}plugin_query_task_admissions SET admission_json=${quote(JSON.stringify({ ...f.query, source: { ...f.query.source, principalId: "foreign-source-principal" } }))} WHERE ${f.queryWhere}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
          /plugin_query_source_invalid/u,
        );
        await f.sql(
          `UPDATE ${f.prefix}plugin_query_task_admissions SET admission_json=${quote(JSON.stringify(f.query))} WHERE ${f.queryWhere}`,
        );
        await f.sql(
          `UPDATE ${f.prefix}extension_run_bindings SET binding_json=${quote(JSON.stringify({ ...f.accepted.binding, target: { ...f.accepted.binding.target, authorityId: "foreign-query-target" } }))} WHERE ${f.queryWhere}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
        );
      });

      test("requires the original paid source receipt even when source admission and operation remain present", async (t) => {
        const f = await fixture(t);
        await f.sql(
          `DELETE FROM ${f.prefix}extension_mutation_receipts WHERE ${receiptWhere(f.sourceLocator)}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
          /plugin_query_source_invalid/u,
        );
        assert.equal(await f.count("plugin_task_admissions"), 1);
        assert.equal(await f.count("extension_external_operations"), 1);
      });

      test("validates source paid credit JSON and persisted reservation rather than only the principal column", async (t) => {
        const f = await fixture(t);
        await f.unlockCredits();
        await f.sql(
          `UPDATE ${f.prefix}extension_credit_admissions SET admission_json='{}' WHERE ${f.sourceWhere}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
        );
        const credit = f.generation.creditAdmission;
        assert.ok(credit);
        await f.sql(
          `UPDATE ${f.prefix}extension_credit_admissions SET admission_json=${quote(JSON.stringify(credit))} WHERE ${f.sourceWhere}`,
        );
        await f.sql(
          `UPDATE ${f.prefix}plugin_credit_reservations SET record_json='{}' WHERE tenant_id=${quote(credit.tenantId)} AND principal_id=${quote(credit.reservation.scope.principalId)} AND pool_id=${quote(credit.reservation.scope.poolId)} AND reservation_id=${quote(credit.reservation.reservationId)}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
        );
      });

      test("rejects a corrupted operation record even when its exact source operation key exists", async (t) => {
        const f = await fixture(t);
        await f.sql(
          `UPDATE ${f.prefix}extension_external_operations SET record_json='{}' WHERE ${f.sourceWhere} AND operation_id=${quote(f.operationId)}`,
        );
        await assert.rejects(
          f.first.store.loadPluginQueryTaskAdmissionByReceipt(f.locator),
        );
        assert.equal(await f.count("extension_external_operations"), 1);
      });

      test("retains independently authorized query actor while verifying the original source payer", async (t) => {
        const f = await pluginQueryFixture(t, backend);
        const queryActor = {
          ...actor,
          actorId: "query-actor",
          principalId: "query-principal",
        };
        const accepted = await f
          .create(undefined, undefined, f.host)
          .createQueryTaskFromPlugin(
            queryActor,
            f.command(),
            parsePluginTaskAdmissionPin({ ...f.queryPin, ...queryActor }),
          );
        const query = await f.first.store.loadPluginQueryTaskAdmission(
          accepted.binding,
        );
        assert.ok(query);
        assert.deepEqual(
          await f.first.store.loadPluginQueryTaskAdmissionByReceipt({
            tenantId: query.tenantId,
            spaceId: query.spaceId,
            profileId: query.profileId,
            pluginId: query.pluginId,
            principalId: query.principalId,
            actorId: query.actorId,
            idempotencyKey: query.idempotencyKey,
          }),
          query,
        );
        assert.equal(query.principalId, queryActor.principalId);
        assert.equal(query.source.principalId, actor.principalId);
        assert.equal(await f.count("extension_credit_admissions"), 1);
        assert.equal(f.quoteCalls(), 1);
      });
    },
  );
}
