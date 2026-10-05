import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { ProjectToolMutationOperation } from "@crewon/application";
import { planFixture } from "./project-text-plan.test-support.ts";
import { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";

/** Actual Task/Run/claim/Tool writers, with a named model-free terminal lifecycle requested through the original ports. */
export async function planRunFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  adoption: "manual" | "whenUnchanged" = "manual",
) {
  let captured: null | {
    f: Awaited<ReturnType<typeof planFixture>>;
    p: Awaited<ReturnType<Awaited<ReturnType<typeof planFixture>>["start"]>>;
    a: Awaited<ReturnType<Awaited<ReturnType<typeof planFixture>>["admit"]>>;
  } = null;
  const run = await projectRunCommitFixture(t, backend, async (base) => {
    const f = await planFixture(t, backend, base),
      p = await f.start(f.definition({ adoption })),
      a = await f.admit(p);
    captured = { f, p, a };
    return a.result.result;
  });
  function original() {
    assert.ok(captured);
    return captured;
  }
  const { f, p, a } = original(),
    admission = a.result.planAdmission,
    stage = a.result.stageAdmission;
  async function operation(
    operationId: ProjectToolMutationOperation,
    request: unknown,
  ) {
    const original = await run.prepareOperation(operationId, request, stage),
      transaction = {
        ...original.transaction,
        projectTextPlanAdmission: admission,
      };
    return {
      ...original,
      transaction,
      options: {
        authority: {
          ...original.options.authority!,
          runTransaction: transaction,
        },
      },
    };
  }
  const terminal = (
    op: Awaited<ReturnType<typeof operation>>,
    output = "Named original project text receipt",
  ) => completePlanFixtureRun({ run, f, p, admission, op, output });
  return { run, f, p, a, admission, stage, operation, terminal };
}
/** Only original lifecycle writers: observes an actual tool receipt and terminal Run event. */
export async function completePlanFixtureRun(input: {
  run: Awaited<ReturnType<typeof projectRunCommitFixture>>;
  f: Awaited<ReturnType<typeof planFixture>>;
  p: Awaited<ReturnType<Awaited<ReturnType<typeof planFixture>>["start"]>>;
  admission: Awaited<
    ReturnType<Awaited<ReturnType<typeof planFixture>>["admit"]>
  >["result"]["planAdmission"];
  op: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof projectRunCommitFixture>>["prepareOperation"]
    >
  >;
  output?: string;
}) {
  const { run, f, p, admission, op } = input;
  const output = input.output ?? "Named original project text receipt";
  const at = new Date().toISOString();
  await run.parent.transitionToolExecution({
    ...run.locator,
    receiptId: op.receipt.receiptId,
    lease: run.lease,
    expectedRevision: op.receipt.revision,
    transition: {
      kind: "complete",
      occurredAt: at,
      providerReceiptId: "named-project-text-local-receipt",
      result: {
        output,
        outputDigest: run.digester.sha256(output),
        isError: false,
        artifactRef: null,
      },
    },
  });
  await run.parent.completeRunAttempt({
    ...run.locator,
    lease: run.lease,
    attempt: {
      stepId: op.receipt.stepId,
      attemptId: op.receipt.attemptId,
      finishedAt: at,
      checkpointDigest: null,
    },
  });
  const before = await run.parent.loadRun(run.locator);
  assert.ok(before);
  const eventId = randomUUID();
  const completed = await run.parent.commitLeasedRun({
    lease: run.lease,
    history: null,
    commit: {
      tenantId: run.locator.tenantId,
      expectedRevision: before.revision,
      idempotency: {
        scope: "named-plan-terminal",
        key: eventId,
        requestFingerprint: run.digester.sha256(eventId),
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: before.runId },
          eventId,
          sequence: before.lastSequence + 1,
          occurredAt: at,
          type: "run.completed",
          data: { outputRef: null },
        },
      ],
      outbox: [],
      workItems: [],
    },
  });
  const plan = await f.plans.loadPlan({ ...f.owner, planId: p.d.planId }),
    step = await f.plans.loadStep({
      ...f.owner,
      planId: p.d.planId,
      stepId: admission.stepId,
    });
  assert.ok(plan);
  assert.ok(step);
  return f.plans.commitObservation(
    {
      owner: f.owner,
      planId: plan.planId,
      expectedRevision: plan.revision,
      stepId: step.stepId,
      expectedStepRevision: step.revision,
      run: completed.state,
      terminal: {
        eventId,
        throughSequence: completed.state.lastSequence,
        runRevision: completed.state.revision,
        status: "completed",
      },
      at,
    },
    { authority: f.planAuthority(null) },
  );
}
export const planOutline = {
  title: "Named outline",
  logline: "An original saved story",
  synopsis: "An isolated text stage",
  episodes: [
    {
      episodeId: "episode-one",
      title: "Episode one",
      summary: "A bounded first episode",
    },
  ],
};
