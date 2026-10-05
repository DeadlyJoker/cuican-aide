import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { planFixture } from "./project-text-plan.test-support.ts";
import { observeStageCommit } from "./project-conversation-store.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: metadata system pause is CAS-only and unavailable background authority never admits a Run`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        d = f.definition(),
        input = f.control(
          "start",
          d,
          null,
          d.delegation.idempotencyKey,
          "unavailable",
        ),
        q = f.planAuthority(d.delegation, "unavailable"),
        result = await f.plans.commitControl(input, { authority: q });
      assert.equal(result.plan.state, "paused");
      assert.equal(result.plan.pauseReason, "authorization_unavailable");
      const at = new Date().toISOString(),
        request = {
          owner: f.owner,
          planId: d.planId,
          expectedRevision: result.plan.revision,
          stepId: result.steps[0]!.stepId,
          expectedStepRevision: result.steps[0]!.revision,
          reason: "source_changed" as const,
          at,
        },
        paused = await f.plans.commitSystemPause(request, {
          authority: f.planAuthority(null),
        });
      assert.equal(paused.plan.pauseReason, "source_changed");
      assert.deepEqual(paused.step, result.steps[0]);
      await assert.rejects(
        f.plans.commitSystemPause(request, {
          authority: f.planAuthority(null),
        }),
        /revision_conflict/u,
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
  test(
    `${backend}: confirmed original Turn COMMIT survives owner withdrawal and same-key never admits a second Run`,
    options,
    async (t) => {
      const f = await planFixture(t, backend),
        p = await f.start(),
        restore = observeStageCommit(backend, () => {
          f.state.live = false;
        });
      try {
        const a = await f.admit(p);
        assert.equal(a.result.result.run.disposition, "committed");
        assert.equal(
          await f.plans.readRequiredPlanDigest({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            runId: a.result.result.binding.runId,
          }),
          a.result.planAdmission.contentDigest,
        );
        assert.equal(
          Number(
            (
              await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
            )[0]?.n,
          ),
          1,
        );
      } finally {
        restore();
      }
    },
  );
}
test(
  "postgres: actual lock wait rechecks final PDP and rolls back all plan/receipt records",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL },
  async (t) => {
    const f = await planFixture(t, "postgres"),
      schema = f.prefix.slice(1, -2),
      gate = new Client({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      });
    await gate.connect();
    let pending: Promise<unknown> | null = null;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([
          "creative-project-project",
          schema,
          f.actor.tenantId,
          f.actor.spaceId,
          f.binding.projectId,
        ]),
      ]);
      const pid = Number(
          (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
        ),
        d = f.definition(),
        input = f.control("start", d);
      const started = f.plans.commitControl(input, {
        authority: f.planAuthority(d.delegation),
      });
      pending = started;
      void started.catch(() => {});
      const until = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < until) {
        const waiters = (
          await gate.query(
            "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND datname=current_database()",
            [pid],
          )
        ).rows;
        if (waiters.length > 0) {
          blocked = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(blocked, true);
      f.state.current = false;
      await gate.query("COMMIT");
      await assert.rejects(started, /named_plan_pdp_withdrawn/u);
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plans`,
            )
          )[0]?.n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_receipts`,
            )
          )[0]?.n,
        ),
        0,
      );
    } finally {
      await gate.query("ROLLBACK");
      await pending?.catch(() => {});
      await gate.end();
    }
  },
);
