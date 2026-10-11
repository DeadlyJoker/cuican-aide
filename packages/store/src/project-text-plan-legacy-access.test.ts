import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  planRunFixture,
  planOutline,
} from "./project-text-plan-run.test-support.ts";
import {
  assertSqlitePlanResultFacts,
  assertPostgresPlanResultFacts,
} from "./project-text-plan-result-facts.ts";
import {
  loadSqlitePlanAdmission,
  loadPostgresPlanAdmission,
} from "./project-text-plan-markers.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import { planFixture } from "./project-text-plan.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: saved plan, receipt, stages and replay refuse protected actual project`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start();
      const m = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: f.prefix.slice(1, -2),
        prefix: f.prefix,
      });
      await m.migrate();
      await m.mark(f.binding.projectId, f.actor);
      const locator = { ...f.owner, planId: p.d.planId };
      const reads = [
        () => f.plans.loadPlan(locator),
        () => f.second.parent.projectTextPlanStore().loadPlan(locator),
        () => f.plans.loadRevision({ ...locator, planRevision: 1 }),
        () =>
          f.plans.loadStep({ ...locator, stepId: p.result.steps[0]!.stepId }),
        () => f.plans.listSteps({ ...locator, planRevision: 1 }),
        () =>
          f.plans.listPlans({
            ...f.owner,
            projectId: f.binding.projectId,
            afterPlanId: null,
            limit: 1,
          }),
        () =>
          f.plans.loadMutationReceipt({ ...f.owner, receipt: p.input.receipt }),
        () => f.plans.commitControl(p.input, { authority: p.q }),
      ];
      for (const read of reads)
        await assert.rejects(read(), /creative_project_not_found/);
    },
  );
  test(
    `${backend}: recovery SQL filters protected plans before keyset pagination`,
    options,
    async (t) => {
      const f = await planFixture(t, backend);
      await f.start(f.definition({ planId: "a-protected" }));
      await f.metadata.commitProjectCreation(
        creationRecipe(
          "ordinary-plan-project",
          "ordinary-plan-project-create",
          f.actor,
        ),
      );
      const other = await planFixture(t, backend, {
        ...f.originalTaskFixture,
        reference: {
          ...f.originalTaskFixture.reference,
          projectId: "ordinary-plan-project",
        },
      });
      await other.start(other.definition({ planId: "b-ordinary" }));
      const m = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: f.prefix.slice(1, -2),
        prefix: f.prefix,
      });
      await m.migrate();
      await m.mark(f.binding.projectId, f.actor);
      assert.deepEqual(
        await f.plans.scanRecoverable({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          profileId: f.owner.profileId,
          afterPlanId: null,
          limit: 1,
        }),
        {
          locators: [
            {
              actor: other.actor,
              profileId: other.owner.profileId,
              planId: "b-ordinary",
            },
          ],
          nextPlanId: null,
        },
      );
      assert.equal(
        (await other.plans.loadPlan({ ...other.owner, planId: "b-ordinary" }))
          ?.projectId,
        other.binding.projectId,
      );
    },
  );
  test(
    `${backend}: genuine saved Run admission and required marker cannot become an unmarked legacy Run`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        a = await f.admit(p);
      const locator = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: a.result.planAdmission.runId,
      };
      const m = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: f.prefix.slice(1, -2),
        prefix: f.prefix,
      });
      await m.migrate();
      await m.mark(f.binding.projectId, f.actor);
      await assert.rejects(
        f.plans.readRequiredPlanDigest(locator),
        /creative_project_not_found/,
      );
      await assert.rejects(
        f.plans.loadRunAdmission(locator),
        /creative_project_not_found/,
      );
      await assert.rejects(
        f.tasks.createProjectTextPlanTurnFromHost(
          f.actor,
          a.command,
          a.task,
          a.planAuthority,
        ),
        hasProtectedCause,
      );
    },
  );
  test(
    `${backend}: original plan DDL leaves a partial owner namespace untouched while data fails closed`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start();
      await f.sql(
        `CREATE TABLE ${f.prefix}plugin_project_metadata_owners(tenant_id TEXT)`,
      );
      const objects = () =>
        f.rows(
          backend === "sqlite"
            ? "SELECT name,type,sql FROM sqlite_schema WHERE name LIKE 'plugin_project_metadata_owner%' ORDER BY name"
            : `SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${f.prefix.slice(1, -2)}' AND c.relname LIKE 'plugin_project_metadata_owner%' ORDER BY c.relname`,
        );
      const before = await objects();
      await f.plans.migrate();
      assert.deepEqual(await objects(), before);
      await assert.rejects(
        f.plans.loadPlan({ ...f.owner, planId: p.d.planId }),
        /plugin_project_metadata_owner_schema/,
      );
      await assert.rejects(
        f.plans.loadRunAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: "unmarked-legacy",
        }),
        /plugin_project_metadata_owner_schema/,
      );
      await assert.rejects(
        f.plans.commitControl(p.input, { authority: p.q }),
        /plugin_project_metadata_owner_schema/,
      );
    },
  );
  test(
    `${backend}: protected running plan rejects system pause and original replay before mutation`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        a = await f.admit(p);
      const saved = await f.plans.loadPlan({ ...f.owner, planId: p.d.planId }),
        steps = await f.plans.listSteps({
          ...f.owner,
          planId: p.d.planId,
          planRevision: 1,
        });
      assert.ok(saved);
      const m = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: f.prefix.slice(1, -2),
        prefix: f.prefix,
      });
      await m.migrate();
      await m.mark(f.binding.projectId, f.actor);
      await assert.rejects(
        f.plans.commitSystemPause(
          {
            owner: f.owner,
            planId: saved.planId,
            expectedRevision: saved.revision,
            stepId: steps[0]!.stepId,
            expectedStepRevision: steps[0]!.revision,
            reason: "source_changed",
            at: new Date().toISOString(),
          },
          { authority: f.planAuthority(null) },
        ),
        /creative_project_not_found/,
      );
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_run_admissions`,
            )
          )[0]?.n,
        ),
        1,
      );
      // Admission reads are already tested; real same-key replay exercises the original ExtensionStore aggregator.
      await assert.rejects(
        f.tasks.createProjectTextPlanTurnFromHost(
          f.actor,
          a.command,
          a.task,
          a.planAuthority,
        ),
        hasProtectedCause,
      );
    },
  );
  test(
    `${backend}: saved result facts and genuine Tool replay fail on the actual protected project`,
    options,
    async (t) => {
      const { run, f, p, operation } = await planRunFixture(t, backend);
      const op = await operation("outline_save", {
        projectId: f.binding.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: planOutline,
      });
      await run.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      const plan = await f.plans.loadPlan({ ...f.owner, planId: p.d.planId }),
        step = await f.plans.loadStep({
          ...f.owner,
          planId: p.d.planId,
          stepId: p.result.steps[0]!.stepId,
        });
      assert.ok(plan);
      assert.ok(step?.result);
      const m = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: f.prefix.slice(1, -2),
        prefix: f.prefix,
      });
      await m.migrate();
      await m.mark(f.binding.projectId, f.actor);
      await assert.rejects(
        run.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        hasProtectedCause,
      );
      await m.transaction(async () => {
        if (m.database)
          assert.throws(
            () => assertSqlitePlanResultFacts(m.database!, plan, step),
            /creative_project_not_found/,
          );
        else
          await assert.rejects(
            assertPostgresPlanResultFacts(
              m.client!,
              f.prefix.slice(1, -2),
              plan,
              step,
            ),
            /creative_project_not_found/,
          );
      });
    },
  );
  test(
    `${backend}: borrowed saved admission reader never manufactures a transaction`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        a = await f.admit(p);
      const m = await foundationMetadataFixture(t, {
          backend,
          path: f.databasePath,
          schema: f.prefix.slice(1, -2),
          prefix: f.prefix,
        }),
        locator = {
          tenantId: f.actor.tenantId,
          runId: a.result.planAdmission.runId,
        };
      if (m.database)
        assert.throws(
          () => loadSqlitePlanAdmission(m.database!, locator),
          /creative_project_legacy_transaction_required/,
        );
      else
        await assert.rejects(
          loadPostgresPlanAdmission(m.client!, f.prefix.slice(1, -2), locator),
          /creative_project_legacy_transaction_required/,
        );
      await m.transaction(async () => {
        assert.ok(
          m.database
            ? loadSqlitePlanAdmission(m.database, locator)
            : await loadPostgresPlanAdmission(
                m.client!,
                f.prefix.slice(1, -2),
                locator,
              ),
        );
      });
    },
  );
}

function hasProtectedCause(e: unknown): boolean {
  return (
    e instanceof Error &&
    (/creative_project_not_found/.test(e.message) ||
      (e.cause !== undefined && hasProtectedCause(e.cause)))
  );
}

test(
  "postgres: actual plan read waits for first owner migration and observes the new protected project",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    const f = await planFixture(t, "postgres"),
      p = await f.start();
    const m = await foundationMetadataFixture(t, {
      backend: "postgres",
      path: f.databasePath,
      schema: f.prefix.slice(1, -2),
      prefix: f.prefix,
    });
    await m.begin();
    await m.migrateDirect();
    await m.mark(f.binding.projectId, f.actor);
    const rejected = assert.rejects(
      f.plans.loadPlan({ ...f.owner, planId: p.d.planId }),
      /creative_project_not_found/,
    );
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      if (await m.hasBlockedReader()) {
        blocked = true;
        break;
      }
      await delay(5);
    }
    assert.equal(blocked, true);
    await m.execute("COMMIT");
    await rejected;
  },
);
