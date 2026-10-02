import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { fixture } from "./plugin-installation-store.test-support.ts";
import { extensionFixture } from "./extension-store.test-support.ts";
const locator = { tenantId: "tenant", spaceId: "space", runId: "ordinary-run" };
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: query probe construction/absence is read only and never opens extension storage`,
    options,
    async (t) => {
      const f = await fixture(t, backend, { migrate: false }),
        tables = await f.tableNames(),
        versions = await f.versions();
      const extension = t.mock.method(f.first.parent, "extensionStore", () =>
        assert.fail("must not open extension storage"),
      );
      const sql =
        backend === "sqlite"
          ? t.mock.method(DatabaseSync.prototype, "prepare", () =>
              assert.fail("construction SQL"),
            )
          : t.mock.method(Pool.prototype, "query", () =>
              assert.fail("construction SQL"),
            );
      const probe = f.first.parent.pluginTaskAdmissionProbe();
      assert.equal(sql.mock.callCount(), 0);
      sql.mock.restore();
      assert.equal(
        probe.pluginQueryAdmissionVersion,
        "crewon.plugin-query-task-admission.v1",
      );
      assert.equal(await probe.loadPluginQueryTaskAdmission(locator), null);
      assert.equal(
        await probe.loadPluginQueryTaskAdmission({
          ...locator,
          runId: " ordinary " + "x".repeat(256),
        }),
        null,
      );
      assert.equal(extension.mock.callCount(), 0);
      assert.deepEqual(await f.tableNames(), tables);
      assert.deepEqual(await f.versions(), versions);
    },
  );
  for (const table of [
    "plugin_query_task_admission_schema_version",
    "plugin_query_task_admissions",
  ])
    test(
      `${backend}: partial query table ${table} never means legacy generation`,
      options,
      async (t) => {
        const f = await extensionFixture(t, backend);
        await f.sql(`CREATE TABLE ${f.prefix}${table}(id INTEGER)`);
        const probe = f.first.parent.pluginTaskAdmissionProbe();
        await assert.rejects(
          probe.loadPluginQueryTaskAdmission(locator),
          /schema_incomplete/u,
        );
      },
    );
  test(
    `${backend}: query marker future version and table alias fail closed without authoritative absence`,
    options,
    async (t) => {
      const f = await extensionFixture(t, backend);
      await f.sql(
        `CREATE TABLE ${f.prefix}plugin_query_task_admission_schema_version(id INTEGER,version INTEGER);INSERT INTO ${f.prefix}plugin_query_task_admission_schema_version VALUES(1,2);CREATE TABLE ${f.prefix}plugin_query_task_admissions(tenant_id TEXT,run_id TEXT)`,
      );
      const probe = f.first.parent.pluginTaskAdmissionProbe();
      await assert.rejects(
        probe.loadPluginQueryTaskAdmission(locator),
        /version_unsupported/u,
      );
      await f.sql(
        `DROP TABLE ${f.prefix}plugin_query_task_admissions;CREATE VIEW ${f.prefix}plugin_query_task_admissions AS SELECT 1 AS id`,
      );
      await assert.rejects(
        probe.loadPluginQueryTaskAdmission(locator),
        /schema_incomplete/u,
      );
    },
  );
  test(
    `${backend}: query probe refuses closed hosts and accessor locators before returning absence`,
    options,
    async (t) => {
      const f = await fixture(t, backend, { migrate: false }),
        probe = f.first.parent.pluginTaskAdmissionProbe();
      let read = 0;
      await assert.rejects(
        probe.loadPluginQueryTaskAdmission(
          Object.defineProperty({ ...locator }, "runId", {
            enumerable: true,
            get() {
              read++;
              return locator.runId;
            },
          }),
        ),
      );
      assert.equal(read, 0);
      await f.first.parent.close();
      await assert.rejects(probe.loadPluginQueryTaskAdmission(locator));
    },
  );
}
