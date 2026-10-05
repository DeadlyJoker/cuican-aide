import test from "node:test";
import assert from "node:assert/strict";
import { planFixture } from "./project-text-plan.test-support.ts";
import { unmeteredFixture } from "./plugin-task-unmetered.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: unconfigured read does no DDL; plan migration requires real conversation/text schemas`,
    options,
    async (t) => {
      const f = await unmeteredFixture(t, backend),
        plans = f.first.parent.projectTextPlanStore(),
        catalog = () =>
          f.rows(
            backend === "sqlite"
              ? "SELECT name,type FROM sqlite_schema ORDER BY name"
              : `SELECT relname,relkind FROM pg_catalog.pg_class WHERE relnamespace='${f.prefix.slice(1, -2)}'::regnamespace ORDER BY relname`,
          ),
        before = await catalog();
      assert.equal(
        await plans.loadRunAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: "legacy",
        }),
        null,
      );
      assert.deepEqual(await catalog(), before);
      await assert.rejects(plans.migrate(), /schema_incomplete/u);
      assert.deepEqual(await catalog(), before);
    },
  );
  test(
    `${backend}: view, removed trigger/index and unknown schema reject without repair`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        locator = { ...f.owner, planId: p.d.planId };
      await f.rows(
        `ALTER TABLE ${f.prefix}project_text_plans RENAME TO actual_plans`,
      );
      await f.rows(
        `CREATE VIEW ${f.prefix}project_text_plans AS SELECT * FROM ${f.prefix}actual_plans`,
      );
      await assert.rejects(f.plans.loadPlan(locator), /schema_incomplete/u);
      await f.rows(`DROP VIEW ${f.prefix}project_text_plans`);
      await f.rows(
        `ALTER TABLE ${f.prefix}actual_plans RENAME TO project_text_plans`,
      );
      await f.rows(
        `DROP INDEX ${backend === "postgres" ? f.prefix : ""}project_text_plan_recovery_page`,
      );
      await assert.rejects(f.plans.migrate(), /schema_incomplete/u);
      await f.rows(
        `CREATE INDEX project_text_plan_recovery_page ON ${f.prefix}project_text_plans(tenant_id,space_id,profile_id,plan_id${backend === "postgres" ? ' COLLATE "C"' : " COLLATE BINARY"})`,
      );
      await f.rows(
        backend === "sqlite"
          ? "DROP TRIGGER project_text_plan_steps_no_delete"
          : `DROP TRIGGER project_text_plan_steps_immutable_identity ON ${f.prefix}project_text_plan_steps`,
      );
      await assert.rejects(f.plans.loadPlan(locator), /schema_incomplete/u);
    },
  );
  test(
    `${backend}: original plan marker cannot be erased or treated as legacy when independent tables disappear`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        a = await f.admit(p),
        locator = {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: a.result.result.binding.runId,
        },
        digest = await f.plans.readRequiredPlanDigest(locator);
      assert.ok(digest);
      await assert.rejects(
        f.rows(
          `UPDATE ${f.prefix}plugin_task_admissions SET project_text_plan_digest=NULL`,
        ),
        /immutable/u,
      );
      for (const table of [
        "project_text_plan_run_admissions",
        "project_text_plan_receipts",
        "project_text_plan_steps",
        "project_text_plan_revisions",
        "project_text_plans",
        "project_text_plan_schema_version",
      ])
        await f.rows(
          `DROP TABLE ${f.prefix}${table}${backend === "postgres" ? " CASCADE" : ""}`,
        );
      assert.equal(await f.plans.readRequiredPlanDigest(locator), digest);
      await assert.rejects(
        f.plans.loadRunAdmission(locator),
        /marker_invalid/u,
      );
    },
  );
  test(
    `${backend}: unknown plan version stays unchanged after rejected migrate`,
    options,
    async (t) => {
      const f = await planFixture(t, backend);
      await f.rows(`DROP TABLE ${f.prefix}project_text_plan_schema_version`);
      await f.rows(
        `CREATE TABLE ${f.prefix}project_text_plan_schema_version(id INTEGER PRIMARY KEY,version INTEGER NOT NULL)`,
      );
      await f.rows(
        `INSERT INTO ${f.prefix}project_text_plan_schema_version VALUES(1,2)`,
      );
      await assert.rejects(f.plans.migrate(), /version_unsupported/u);
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT version FROM ${f.prefix}project_text_plan_schema_version`,
            )
          )[0]?.version,
        ),
        2,
      );
    },
  );
  if (backend === "postgres")
    test(
      "postgres: foreign opclass cannot satisfy the real keyset index",
      options,
      async (t) => {
        const f = await planFixture(t, backend);
        await f.rows(`DROP INDEX ${f.prefix}project_text_plan_recovery_page`);
        await f.rows(
          `CREATE INDEX project_text_plan_recovery_page ON ${f.prefix}project_text_plans(tenant_id,space_id,profile_id,plan_id COLLATE "C" text_pattern_ops)`,
        );
        await assert.rejects(
          f.plans.scanRecoverable({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            profileId: f.owner.profileId,
            afterPlanId: null,
            limit: 1,
          }),
          /schema_incomplete/u,
        );
      },
    );
}
