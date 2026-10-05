import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  planRunFixture,
  planOutline,
} from "./project-text-plan-run.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: pause permits the already admitted candidate but revoke denies new writes and new Turn admission`,
    options,
    async (t) => {
      const { run, f, p, operation } = await planRunFixture(t, backend);
      const current = await f.plans.loadPlan({
        ...f.owner,
        planId: p.d.planId,
      });
      assert.ok(current);
      const steps = await f.plans.listSteps({
        ...f.owner,
        planId: p.d.planId,
        planRevision: 1,
      });
      const paused = await f.plans.commitControl(
        f.control(
          "pause",
          p.d,
          { ...p.result, plan: current, steps },
          randomUUID(),
        ),
        { authority: f.planAuthority(null) },
      );
      const op = await operation("outline_save", {
        projectId: f.binding.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: planOutline,
      });
      const saved = await run.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      assert.equal(saved.disposition, "committed");
      await assert.rejects(
        f.admit(p, randomUUID()),
        hasCause("project_text_plan_revision_conflict"),
      );
      assert.equal(
        Number(
          (
            await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
          )[0]?.n,
        ),
        1,
      );
      const refreshedSteps = await f.plans.listSteps({
        ...f.owner,
        planId: p.d.planId,
        planRevision: 1,
      });
      await f.plans.commitControl(
        f.control(
          "revoke",
          p.d,
          { ...paused, steps: refreshedSteps },
          randomUUID(),
        ),
        { authority: f.planAuthority(null) },
      );
      const next = await operation("outline_save", {
        projectId: f.binding.projectId,
        expectedArtifactRevision: saved.artifact.revision,
        briefRevision: 1,
        content: { ...planOutline, synopsis: "Revoked result must not commit" },
      });
      await assert.rejects(
        run.text.saveOutlineCandidate(
          f.actor,
          next.commandBody as never,
          next.options,
        ),
        hasCause("project_text_plan_result_not_authorized"),
      );
      assert.equal((await run.counts()).project_text_revisions, 1);
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
  test(
    `${backend}: an actual brief edit retains the selected candidate but blocks stale explicit continue`,
    options,
    async (t) => {
      const { run, f, p, operation, terminal } = await planRunFixture(
          t,
          backend,
        ),
        op = await operation("outline_save", {
          projectId: f.binding.projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: planOutline,
        });
      const saved = await run.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      await terminal(op);
      await run.text.selectRevision(f.actor, {
        projectId: f.binding.projectId,
        artifactId: saved.artifact.artifactId,
        contentRevision: 1,
        expectedArtifactRevision: saved.artifact.revision,
        idempotencyKey: randomUUID(),
      });
      const project = await run.projects.getProject(f.actor, {
        projectId: f.binding.projectId,
      });
      assert.ok(project);
      await run.projects.appendBrief(f.actor, {
        projectId: project.projectId,
        expectedProjectRevision: project.revision,
        text: "Actual newer brief",
        idempotencyKey: randomUUID(),
      });
      const plan = await f.plans.loadPlan({ ...f.owner, planId: p.d.planId });
      assert.ok(plan);
      const steps = await f.plans.listSteps({
        ...f.owner,
        planId: p.d.planId,
        planRevision: 1,
      });
      await assert.rejects(
        f.plans.commitControl(
          f.control(
            "continue",
            p.d,
            { ...p.result, plan, steps },
            randomUUID(),
          ),
          { authority: f.planAuthority(null) },
        ),
        /project_text_plan_source_changed/u,
      );
      assert.deepEqual(
        await f.plans.loadPlan({ ...f.owner, planId: p.d.planId }),
        plan,
      );
      const view = await run.text.getArtifact(f.actor, {
        projectId: f.binding.projectId,
        artifactId: saved.artifact.artifactId,
      });
      assert.equal(view?.artifact.selectedContentRevision, 1);
      assert.equal(view?.dependencyState, "stale");
    },
  );
  test(
    `${backend}: whenUnchanged refuses a real head edit without silently selecting or advancing`,
    options,
    async (t) => {
      const { run, f, p, admission, operation, terminal } =
          await planRunFixture(t, backend, "whenUnchanged"),
        op = await operation("outline_save", {
          projectId: f.binding.projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: planOutline,
        });
      const saved = await run.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        observed = await terminal(op);
      assert.ok(observed.step.result);
      await run.text.saveOutlineCandidate(f.actor, {
        projectId: f.binding.projectId,
        expectedArtifactRevision: saved.artifact.revision,
        briefRevision: 1,
        content: { ...planOutline, synopsis: "Actual manual newer candidate" },
        idempotencyKey: randomUUID(),
      });
      const input = {
          projectId: f.binding.projectId,
          artifactId: saved.artifact.artifactId,
          contentRevision: 1,
          expectedArtifactRevision: saved.artifact.revision,
          idempotencyKey: randomUUID(),
        },
        planTransaction = {
          version: "crewon.project-text-plan-selection-commit.v1" as const,
          plan: observed.plan,
          planRevision: p.d,
          step: observed.step,
          admission,
          result: observed.step.result,
          input,
          authority: f.planAuthority(null),
          assertCurrent: async () => {},
        };
      await assert.rejects(
        run.text.selectRevision(f.actor, input, {
          authority: {
            assertActive: () => {},
            assertCurrent: async () => {},
            planTransaction,
          },
        }),
        hasCause("project_text_plan_selection_changed"),
      );
      assert.deepEqual(
        await f.plans.loadPlan({ ...f.owner, planId: p.d.planId }),
        observed.plan,
      );
      const view = await run.text.getArtifact(f.actor, {
        projectId: f.binding.projectId,
        artifactId: saved.artifact.artifactId,
      });
      assert.equal(view?.artifact.selectedContentRevision, null);
      assert.equal((await run.counts()).project_text_revisions, 2);
    },
  );
}
function hasCause(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    (error.message === code || hasCause(code)(error.cause));
}
