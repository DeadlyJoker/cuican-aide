import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { fixture as bareFixture } from "./plugin-installation-store.test-support.ts";
import {
  extensionFixture,
  runInput,
  scope,
} from "./extension-store.test-support.ts";
import { seedProbeAdmission } from "./plugin-task-admission-probe.test-support.ts";

const locator = {
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  runId: "run-1",
};
const versionTable = "plugin_task_admission_schema_version";
const dataTable = "plugin_task_admissions";

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `${backend} read-only installed task probe`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    },
    () => {
      test("constructs with zero SQL and detects authoritative absence without extension access or migration", async (t) => {
        const f = await bareFixture(t, backend, { migrate: false });
        const before = await f.tableNames();
        const versions = await f.versions();
        assert.equal(
          before.some((name) =>
            /^(?:extension_|plugin_|installed_plugin_|creative_project_)/u.test(
              name,
            ),
          ),
          false,
        );
        const extension = t.mock.method(f.first.parent, "extensionStore", () =>
          assert.fail("absent probe accessed extensionStore"),
        );
        const noSql =
          backend === "sqlite"
            ? t.mock.method(DatabaseSync.prototype, "prepare", () =>
                assert.fail("probe construction executed SQL"),
              )
            : t.mock.method(Pool.prototype, "query", () =>
                assert.fail("probe construction executed SQL"),
              );
        const probe = f.first.parent.pluginTaskAdmissionProbe();
        assert.equal(noSql.mock.callCount(), 0);
        noSql.mock.restore();
        assert.equal(
          probe.pluginAdmissionVersion,
          "crewon.plugin-task-admission.v1",
        );
        assert.equal(await probe.loadPluginTaskAdmission(locator), null);
        assert.equal(await probe.loadPluginTaskAdmission(locator), null);
        assert.equal(extension.mock.callCount(), 0);
        assert.deepEqual(await f.tableNames(), before);
        assert.deepEqual(await f.versions(), versions);
      });

      test("the same probe observes later opt-in migration and the exact real persisted pin, including after reopen", async (t) => {
        const f = await extensionFixture(t, backend);
        const probe = f.first.parent.pluginTaskAdmissionProbe();
        assert.equal(await probe.loadPluginTaskAdmission(locator), null);
        const input = await seedProbeAdmission(f);
        assert.deepEqual(
          await probe.loadPluginTaskAdmission(input.binding),
          input.pluginAdmission,
        );
        await assert.rejects(
          probe.loadPluginTaskAdmission({
            ...locator,
            spaceId: "another-space",
          }),
          /plugin_task_admission_record_invalid/u,
        );
        const reopened = await f.open();
        assert.deepEqual(
          await reopened.parent
            .pluginTaskAdmissionProbe()
            .loadPluginTaskAdmission(locator),
          input.pluginAdmission,
        );
        assert.equal(await f.count("plugin_task_admissions"), 1);
        assert.equal(await f.count("plugin_credit_reservations"), 1);
      });

      test("preserves real ordinary Run IDs longer than plugin IDs or containing surrounding spaces before and after opt-in migration", async (t) => {
        const f = await extensionFixture(t, backend);
        await f.seedDeployment();
        const base = runInput();
        await f.prepare(base);
        const probe = f.first.parent.pluginTaskAdmissionProbe();
        const ids = [`ordinary-${"x".repeat(256)}`, " ordinary padded Run "];
        for (const [index, runId] of ids.entries()) {
          await f.first.parent.commitRun({
            ...base.commit,
            idempotency: {
              ...base.commit.idempotency,
              key: `ordinary-${index}`,
            },
            events: base.commit.events.map((event) => ({
              ...event,
              identity: { runId },
              eventId: `ordinary-created-${index}`,
            })),
            outbox: [],
            workItems: [],
          });
          const ordinary = { ...locator, runId };
          assert.equal(
            (await f.first.parent.loadRunInSpace(ordinary))?.runId,
            runId,
          );
          assert.equal(await probe.loadPluginTaskAdmission(ordinary), null);
        }
        await f.first.parent.pluginInstallationStore().migrate();
        await f.first.store.migratePluginAdmissions();
        const extension = t.mock.method(f.first.parent, "extensionStore", () =>
          assert.fail("ordinary Run reached the plugin-only reader"),
        );
        for (const runId of ids) {
          assert.equal(
            await probe.loadPluginTaskAdmission({ ...locator, runId }),
            null,
          );
          assert.equal(
            (await f.first.parent.loadRunInSpace({ ...locator, runId }))?.runId,
            runId,
          );
        }
        assert.equal(
          await probe.loadPluginTaskAdmission({
            tenantId: " ordinary tenant ",
            spaceId: `space-${"x".repeat(256)}`,
            runId: " ordinary Run ",
          }),
          null,
        );
        assert.equal(extension.mock.callCount(), 0);
        assert.equal(await f.count(dataTable), 0);
      });

      for (const present of [versionTable, dataTable])
        test(`rejects a half-created schema with only ${present}, without invoking the extension reader`, async (t) => {
          const f = await bareFixture(t, backend, { migrate: false });
          const extension = t.mock.method(
            f.first.parent,
            "extensionStore",
            () => assert.fail("incomplete schema reached extensionStore"),
          );
          const probe = f.first.parent.pluginTaskAdmissionProbe();
          await f.execute(
            `CREATE TABLE ${f.prefix}${present}(id INTEGER,version INTEGER)`,
          );
          await assert.rejects(
            probe.loadPluginTaskAdmission(locator),
            /plugin_task_admission_schema_incomplete/u,
          );
          assert.equal(extension.mock.callCount(), 0);
        });

      test("rejects a future marker version before interpreting an empty data table as no v1 task", async (t) => {
        const f = await bareFixture(t, backend, { migrate: false });
        const extension = t.mock.method(f.first.parent, "extensionStore", () =>
          assert.fail("unsupported schema reached extensionStore"),
        );
        await f.execute(`CREATE TABLE ${f.prefix}${versionTable}(id INTEGER,version INTEGER);
        INSERT INTO ${f.prefix}${versionTable} VALUES(1,99);
        CREATE TABLE ${f.prefix}${dataTable}(id INTEGER);`);
        const probe = f.first.parent.pluginTaskAdmissionProbe();
        await assert.rejects(
          probe.loadPluginTaskAdmission(locator),
          /plugin_task_admission_schema_version_unsupported/u,
        );
        assert.equal(extension.mock.callCount(), 0);
        assert.deepEqual(
          await f.query(`SELECT id,version FROM ${f.prefix}${versionTable}`),
          [{ id: 1, version: 99 }],
        );
      });

      test("rejects a view masquerading as an admission table rather than falling back to legacy", async (t) => {
        const f = await bareFixture(t, backend, { migrate: false });
        const extension = t.mock.method(f.first.parent, "extensionStore", () =>
          assert.fail("non-table schema reached extensionStore"),
        );
        await f.execute(`CREATE TABLE ${f.prefix}${versionTable}(id INTEGER,version INTEGER);
        INSERT INTO ${f.prefix}${versionTable} VALUES(1,1);
        CREATE VIEW ${f.prefix}${dataTable} AS SELECT 1 AS id;`);
        await assert.rejects(
          f.first.parent
            .pluginTaskAdmissionProbe()
            .loadPluginTaskAdmission(locator),
          /plugin_task_admission_schema_incomplete/u,
        );
        assert.equal(extension.mock.callCount(), 0);
      });

      test("does not cache a previously valid marker or suppress strict reader database failures", async (t) => {
        const f = await extensionFixture(t, backend);
        const input = await seedProbeAdmission(f);
        const probe = f.first.parent.pluginTaskAdmissionProbe();
        assert.deepEqual(
          await probe.loadPluginTaskAdmission(locator),
          input.pluginAdmission,
        );
        await f.sql(`UPDATE ${f.prefix}${versionTable} SET version=99`);
        await assert.rejects(
          probe.loadPluginTaskAdmission(locator),
          /plugin_task_admission_schema_version_unsupported/u,
        );
        await f.sql(`UPDATE ${f.prefix}${versionTable} SET version=1;
        ALTER TABLE ${f.prefix}${dataTable} RENAME COLUMN space_id TO unusable_space`);
        await assert.rejects(probe.loadPluginTaskAdmission(locator));
        assert.equal(await f.count(dataTable), 1);
      });

      test("rejects closed host and accessor locators without returning authoritative absence", async (t) => {
        const f = await bareFixture(t, backend, { migrate: false });
        const probe = f.first.parent.pluginTaskAdmissionProbe();
        let reads = 0;
        const getter = Object.defineProperty({ ...locator }, "runId", {
          get() {
            reads++;
            return "run-1";
          },
        });
        await assert.rejects(
          probe.loadPluginTaskAdmission(getter),
          /plugin_task_admission_locator_invalid/u,
        );
        assert.equal(reads, 0);
        await f.first.parent.close();
        await assert.rejects(probe.loadPluginTaskAdmission(locator));
        assert.throws(() => f.first.parent.pluginTaskAdmissionProbe());
      });
    },
  );
}
