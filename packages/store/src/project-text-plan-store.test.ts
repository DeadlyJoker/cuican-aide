import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createProjectTextPlan, type ProjectTextPlan } from "@crewon/domain";
import { planFixture } from "./project-text-plan.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const run =
    backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL
      ? test.skip
      : test;
  run(
    `${backend}: explicit plan schema, real current owner, original receipt replay and bounded cold reads`,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        locator = { ...f.owner, planId: p.result.plan.planId };
      assert.equal(p.result.plan.state, "ready");
      assert.equal(p.result.steps.length, 1);
      assert.equal(
        (await f.plans.commitControl(p.input, { authority: p.q })).disposition,
        "replayed",
      );
      assert.deepEqual(await f.plans.loadPlan(locator), p.result.plan);
      assert.deepEqual(
        await f.plans.loadRevision({ ...locator, planRevision: 1 }),
        p.d,
      );
      assert.deepEqual(
        await f.plans.listSteps({ ...locator, planRevision: 1 }),
        p.result.steps,
      );
      assert.equal(
        await f.plans.loadPlan({
          ...locator,
          actor: { ...f.actor, principalId: "foreign" },
        }),
        null,
      );
      const page = await f.plans.listPlans({
        ...f.owner,
        projectId: f.binding.projectId,
        afterPlanId: null,
        limit: 1,
      });
      assert.equal(page.plans.length, 1);
      assert.equal(page.nextPlanId, null);
      const scan = await f.plans.scanRecoverable({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.owner.profileId,
        afterPlanId: null,
        limit: 1,
      });
      assert.equal(scan.locators[0]?.planId, p.result.plan.planId);
      assert.equal(
        await f.plans.loadRunAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: "legacy-run",
        }),
        null,
      );
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
  run(
    `${backend}: actual slot blocks a different start; pause retains step; revoked owner rolls back`,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start();
      await assert.rejects(f.start(), /project_text_plan_active_conflict/u);
      const pause = f.control("pause", p.d, p.result, randomUUID()),
        paused = await f.plans.commitControl(pause, {
          authority: f.planAuthority(null),
        });
      assert.equal(paused.plan.state, "paused");
      assert.deepEqual(paused.steps, p.result.steps);
      await assert.rejects(f.start(), /project_text_plan_active_conflict/u);
      f.state.current = false;
      const revoke = f.control("revoke", p.d, paused, randomUUID());
      await assert.rejects(
        f.plans.commitControl(revoke, { authority: f.planAuthority(null) }),
        /named_plan_pdp_withdrawn/u,
      );
      assert.deepEqual(
        await f.plans.loadPlan({ ...f.owner, planId: p.result.plan.planId }),
        paused.plan,
      );
    },
  );
  run(
    `${backend}: real Turn admits one immutable plan Run and same-key replays without another queue entry`,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        a = await f.admit(p),
        locator = {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: a.result.result.binding.runId,
        };
      assert.equal(a.result.planAdmission.runId, locator.runId);
      assert.equal(
        await f.plans.readRequiredPlanDigest(locator),
        a.result.planAdmission.contentDigest,
      );
      assert.deepEqual(
        await f.plans.loadRunAdmission(locator),
        a.result.planAdmission,
      );
      const replay = await f.tasks.createProjectTextPlanTurnFromHost(
        f.actor,
        a.command,
        a.task,
        a.planAuthority,
      );
      assert.equal(replay.result.run.state.runId, locator.runId);
      assert.equal(replay.result.run.disposition, "replayed");
      const cold = await f.second.parent
        .projectTextPlanStore()
        .loadPlan({ ...f.owner, planId: p.d.planId });
      assert.equal(cold?.state, "running");
      assert.equal(
        (
          await f.plans.listSteps({
            ...f.owner,
            planId: p.d.planId,
            planRevision: 1,
          })
        )[0]?.input?.idempotencyKey,
        a.command.idempotencyKey,
      );
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
  run(
    `${backend}: forged prepared transition and accessor fail before writing`,
    async (t) => {
      const f = await planFixture(t, backend),
        d = f.definition(),
        input = f.control("start", d),
        q = f.planAuthority(d.delegation),
        body = {
          ...input.plan,
          state: "paused" as const,
          pauseReason: "user_paused" as const,
        };
      const { schemaVersion: _, contentDigest: __, ...raw } = body;
      const fake = createProjectTextPlan(raw, f.digester);
      await assert.rejects(
        f.plans.commitControl({ ...input, plan: fake }, { authority: q }),
        /project_text_plan_recipe_invalid/u,
      );
      assert.equal(
        await f.plans.loadPlan({ ...f.owner, planId: d.planId }),
        null,
      );
      let reads = 0;
      const accessor = Object.defineProperty({ ...input }, "kind", {
        get() {
          reads++;
          return "start";
        },
      });
      await assert.rejects(
        f.plans.commitControl(accessor, { authority: q }),
        /creative_project_json_invalid/u,
      );
      assert.equal(reads, 0);
    },
  );
}
