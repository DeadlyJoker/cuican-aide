import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ProjectTextPlanCoordinator,
  type ProjectTextPlanContinuationPort,
} from "@crewon/application";
import { planFixture } from "../../../packages/store/src/project-text-plan.test-support.ts";
import {
  saveCommand,
  activateCommand,
} from "../../../packages/store/src/extension-configuration-service.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: a genuine configuration revision change pauses before another plan Run is admitted`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start();
      await f.service.saveConfiguration(f.actor, {
        ...saveCommand,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await f.service.setActivation(f.actor, {
        ...activateCommand,
        configurationRevision: 2,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const continuation: ProjectTextPlanContinuationPort = {
        async run(_locator, signal, work) {
          signal.throwIfAborted();
          return work({
            plan: f.planAuthority(null),
            conversation: f.authority,
            async prepareExecution() {
              return f.authority;
            },
          });
        },
      };
      const coordinator = new ProjectTextPlanCoordinator({
        plans: f.plans,
        continuation,
        projects: f.metadata,
        texts: f.text,
        conversations: f.store,
        threads: f.parent,
        runs: f.parent,
        tasks: f.tasks,
        textCommands: {
          async selectRevision() {
            throw new Error("unexpected_plan_selection");
          },
        },
        clock: { now: () => new Date().toISOString() },
        digester: f.digester,
      });
      const locator = { ...f.owner, planId: p.d.planId };
      assert.equal(
        await coordinator.process(locator, new AbortController().signal),
        "paused",
      );
      const paused = await f.plans.loadPlan(locator);
      assert.equal(paused?.state, "paused");
      assert.equal(paused?.pauseReason, "installation_changed");
      assert.equal(
        (
          await f.plans.loadStep({
            ...locator,
            stepId: p.result.steps[0]!.stepId,
          })
        )?.run,
        null,
      );
      assert.equal(
        Number(
          (
            await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
          )[0]?.n,
        ),
        0,
      );
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
}
