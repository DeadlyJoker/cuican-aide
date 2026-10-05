import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { planFixture } from "./project-text-plan.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: a bounded keyset scan advances past revoked and paused slots using the actual index`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const first = await planFixture(t, backend),
        a = await first.start(first.definition({ planId: "a-plan" }));
      await first.plans.commitControl(
        first.control("revoke", a.d, a.result, randomUUID()),
        { authority: first.planAuthority(null) },
      );
      const second = await planFixture(t, backend, first.originalTaskFixture),
        b = await second.start(second.definition({ planId: "b-plan" }));
      await second.plans.commitControl(
        second.control("pause", b.d, b.result, randomUUID()),
        { authority: second.planAuthority(null) },
      );
      const third = await planFixture(t, backend, first.originalTaskFixture);
      await third.start(third.definition({ planId: "c-plan" }));
      const scope = {
        tenantId: first.actor.tenantId,
        spaceId: first.actor.spaceId,
        profileId: first.owner.profileId,
        limit: 1,
      };
      const p1 = await first.plans.scanRecoverable({
          ...scope,
          afterPlanId: null,
        }),
        p2 = await first.plans.scanRecoverable({
          ...scope,
          afterPlanId: p1.nextPlanId,
        }),
        p3 = await first.plans.scanRecoverable({
          ...scope,
          afterPlanId: p2.nextPlanId,
        });
      assert.deepEqual(p1, { locators: [], nextPlanId: "a-plan" });
      assert.deepEqual(p2, { locators: [], nextPlanId: "b-plan" });
      assert.deepEqual(p3, {
        locators: [
          {
            actor: first.actor,
            profileId: first.owner.profileId,
            planId: "c-plan",
          },
        ],
        nextPlanId: null,
      });
      const listed = await first.plans.listPlans({
        ...first.owner,
        projectId: first.binding.projectId,
        afterPlanId: null,
        limit: 1,
      });
      assert.equal(listed.plans[0]?.planId, "a-plan");
      assert.equal(listed.nextPlanId, "a-plan");
      if (backend === "sqlite") {
        const explain = await first.rows(
          `EXPLAIN QUERY PLAN SELECT * FROM project_text_plans WHERE tenant_id='${scope.tenantId}' AND space_id='${scope.spaceId}' AND profile_id='${scope.profileId}' AND plan_id COLLATE BINARY>'a-plan' ORDER BY plan_id COLLATE BINARY LIMIT 2`,
        );
        assert.ok(
          explain.some(
            (r) =>
              typeof r.detail === "string" &&
              r.detail.includes("project_text_plan_recovery_page"),
          ),
        );
      } else {
        const c = new Client({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        });
        await c.connect();
        try {
          await c.query("BEGIN");
          await c.query("SET LOCAL enable_seqscan=off");
          const explain = await c.query(
            `EXPLAIN (FORMAT JSON) SELECT * FROM ${first.prefix}project_text_plans WHERE tenant_id=$1 AND space_id=$2 AND profile_id=$3 AND plan_id COLLATE "C">$4 ORDER BY plan_id COLLATE "C" LIMIT 2`,
            [scope.tenantId, scope.spaceId, scope.profileId, "a-plan"],
          );
          assert.ok(
            JSON.stringify(explain.rows).includes(
              "project_text_plan_recovery_page",
            ),
          );
          await c.query("ROLLBACK");
        } finally {
          await c.end();
        }
      }
      assert.deepEqual(await first.creditObjects(), []);
    },
  );
