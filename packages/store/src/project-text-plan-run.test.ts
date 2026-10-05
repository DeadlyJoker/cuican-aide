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
    `${backend}: genuine plan Tool candidate commits one result; manual HTTP select waits for explicit continue`,
    options,
    async (t) => {
      const { run, f, p, operation, terminal } = await planRunFixture(
          t,
          backend,
        ),
        request = {
          projectId: f.binding.projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: planOutline,
        },
        op = await operation("outline_save", request),
        saved = await run.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        );
      const stepId = p.result.steps[0]!.stepId,
        step = await f.plans.loadStep({
          ...f.owner,
          planId: p.d.planId,
          stepId,
        });
      assert.equal(step?.result?.toolReceiptId, op.receipt.receiptId);
      assert.equal(step?.result?.toolInputDigest, op.receipt.call.inputDigest);
      const replay = await run.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      assert.equal(replay.disposition, "replayed");
      assert.equal(
        (await f.plans.loadStep({ ...f.owner, planId: p.d.planId, stepId }))
          ?.revision,
        step?.revision,
      );
      const second = await operation("outline_save", {
        ...request,
        expectedArtifactRevision: saved.artifact.revision,
        content: { ...planOutline, synopsis: "Forbidden second result" },
      });
      await assert.rejects(
        run.text.saveOutlineCandidate(
          f.actor,
          second.commandBody as never,
          second.options,
        ),
        hasCause("project_text_plan_result_limit"),
      );
      const observed = await terminal(op);
      assert.equal(observed.plan.state, "waitingSelection");
      const key = randomUUID();
      const selected = await run.text.selectRevision(f.actor, {
        projectId: f.binding.projectId,
        artifactId: saved.artifact.artifactId,
        contentRevision: 1,
        expectedArtifactRevision: saved.artifact.revision,
        idempotencyKey: key,
      });
      const manual = await f.plans.loadStep({
        ...f.owner,
        planId: p.d.planId,
        stepId,
      });
      assert.equal(manual?.selection?.mode, "manual");
      assert.equal(manual?.selection?.idempotencyKey, key);
      assert.equal(
        (await f.plans.loadPlan({ ...f.owner, planId: p.d.planId }))?.state,
        "waitingSelection",
      );
      // A later explicit lock preserves the actual selected pointer and is allowed by continue.
      await run.text.setLocked(f.actor, {
        projectId: f.binding.projectId,
        artifactId: selected.artifact.artifactId,
        expectedArtifactRevision: selected.artifact.revision,
        locked: true,
        idempotencyKey: randomUUID(),
      });
      const current = await f.plans.loadPlan({
        ...f.owner,
        planId: p.d.planId,
      });
      assert.ok(current);
      const currentSteps = await f.plans.listSteps({
          ...f.owner,
          planId: p.d.planId,
          planRevision: 1,
        }),
        input = f.control(
          "continue",
          p.d,
          {
            kind: "start",
            disposition: "committed",
            plan: current,
            planRevision: p.d,
            steps: currentSteps,
          },
          randomUUID(),
        );
      const result = await f.plans.commitControl(input, {
        authority: f.planAuthority(null),
      });
      assert.equal(result.plan.state, "completed");
      assert.equal(result.steps[0]?.state, "succeeded");
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
  test(
    `${backend}: explicit whenUnchanged selection atomically adopts the exact candidate and completes`,
    options,
    async (t) => {
      const { run, f, p, admission, operation, terminal } =
          await planRunFixture(t, backend, "whenUnchanged"),
        op = await operation("outline_save", {
          projectId: f.binding.projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: planOutline,
        }),
        saved = await run.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        observed = await terminal(op);
      assert.ok(observed.step.result);
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
      const options = {
          authority: {
            assertCurrent: async () => {},
            assertActive: () => {},
            planTransaction,
          },
        },
        result = await run.text.selectRevision(f.actor, input, options);
      assert.equal(result.artifact.selectedContentRevision, 1);
      assert.equal(
        (await f.plans.loadPlan({ ...f.owner, planId: p.d.planId }))?.state,
        "completed",
      );
      assert.equal(
        (
          await f.plans.loadStep({
            ...f.owner,
            planId: p.d.planId,
            stepId: observed.step.stepId,
          })
        )?.selection?.mode,
        "whenUnchanged",
      );
      const replay = await run.text.selectRevision(f.actor, input, options);
      assert.equal(replay.disposition, "replayed");
      assert.equal((await run.counts()).project_text_revisions, 1);
    },
  );
}
function hasCause(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    (error.message === code || hasCause(code)(error.cause));
}
