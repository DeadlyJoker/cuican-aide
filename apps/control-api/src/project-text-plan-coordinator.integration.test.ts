import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ProjectTextPlanCoordinator,
  ProjectTextPlanApplicationService,
  type ProjectTextPlanContinuationPort,
} from "@crewon/application";
import {
  planRunFixture,
  planOutline,
} from "../../../packages/store/src/project-text-plan-run.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: coordinator observes a real terminal result; cold manual wait needs actual adoption and explicit continue`,
    options,
    async (t) => {
      const f = await planRunFixture(t, backend),
        op = await outlineOperation(f),
        saved = await f.run.text.saveOutlineCandidate(
          f.f.actor,
          op.commandBody as never,
          op.options,
        );
      await finishOriginalRun(f, op);
      const runtime = coordinator(f);
      assert.equal(
        await runtime.owner.process(
          runtime.locator,
          new AbortController().signal,
        ),
        "checkpointed",
      );
      assert.equal(
        (await f.f.plans.loadPlan(runtime.locator))?.state,
        "waitingSelection",
      );
      const cold = coordinator(f);
      assert.equal(
        await cold.owner.process(cold.locator, new AbortController().signal),
        "waitingSelection",
      );
      assert.equal(
        (await f.f.text.loadOutline(textScope(f)))?.selectedContentRevision,
        null,
      );
      await assert.rejects(
        planService(f).continue(
          f.f.actor,
          {
            projectId: f.f.binding.projectId,
            planId: f.p.d.planId,
            expectedRevision: (await f.f.plans.loadPlan(runtime.locator))!
              .revision,
            idempotencyKey: randomUUID(),
          },
          f.f.planAuthority(null),
        ),
        { code: "project_text_plan_selection_required" },
      );
      const selected = await f.run.text.selectRevision(f.f.actor, {
        projectId: f.f.binding.projectId,
        artifactId: saved.artifact.artifactId,
        contentRevision: 1,
        expectedArtifactRevision: saved.artifact.revision,
        idempotencyKey: randomUUID(),
      });
      await f.run.text.setLocked(f.f.actor, {
        projectId: f.f.binding.projectId,
        artifactId: selected.artifact.artifactId,
        expectedArtifactRevision: selected.artifact.revision,
        locked: true,
        idempotencyKey: randomUUID(),
      });
      const current = await f.f.plans.loadPlan(runtime.locator);
      assert.ok(current);
      const request = {
        projectId: f.f.binding.projectId,
        planId: f.p.d.planId,
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
      };
      const service = planService(f),
        confirmed = await service.continue(
          f.f.actor,
          request,
          f.f.planAuthority(null),
        );
      assert.equal(confirmed.view.plan.state, "completed");
      assert.equal(confirmed.view.steps[0]?.selection?.mode, "manual");
      assert.equal(
        (await service.continue(f.f.actor, request, f.f.planAuthority(null)))
          .disposition,
        "replayed",
      );
      assert.equal(runtime.preparations(), 0);
      assert.equal(cold.preparations(), 0);
      await assertCounts(f, 1);
    },
  );
  test(
    `${backend}: current delegated coordinator adopts only the saved whenUnchanged result after cold terminal observation`,
    options,
    async (t) => {
      const f = await planRunFixture(t, backend, "whenUnchanged"),
        op = await outlineOperation(f);
      const saved = await f.run.text.saveOutlineCandidate(
        f.f.actor,
        op.commandBody as never,
        op.options,
      );
      await finishOriginalRun(f, op);
      const first = coordinator(f);
      assert.equal(
        await first.owner.process(first.locator, new AbortController().signal),
        "checkpointed",
      );
      const cold = coordinator(f);
      assert.equal(
        await cold.owner.process(cold.locator, new AbortController().signal),
        "selected",
      );
      assert.equal(
        (await f.f.plans.loadPlan(cold.locator))?.state,
        "completed",
      );
      const step = await f.f.plans.loadStep({
        ...cold.locator,
        stepId: f.admission.stepId,
      });
      assert.equal(step?.selection?.mode, "whenUnchanged");
      assert.equal(
        step?.selection?.contentDigest,
        saved.contentRevision!.contentDigest,
      );
      assert.equal(
        (await f.f.text.loadOutline(textScope(f)))?.selectedContentRevision,
        1,
      );
      assert.equal(
        await cold.owner.process(cold.locator, new AbortController().signal),
        "unchanged",
      );
      assert.equal(cold.preparations(), 0);
      await assertCounts(f, 1);
    },
  );
  test(
    `${backend}: a real completed Run without a saved business result pauses instead of claiming completion`,
    options,
    async (t) => {
      const f = await planRunFixture(t, backend, "whenUnchanged"),
        op = await outlineOperation(f);
      await finishOriginalRun(f, op);
      const runtime = coordinator(f);
      assert.equal(
        await runtime.owner.process(
          runtime.locator,
          new AbortController().signal,
        ),
        "checkpointed",
      );
      const plan = await f.f.plans.loadPlan(runtime.locator),
        step = await f.f.plans.loadStep({
          ...runtime.locator,
          stepId: f.admission.stepId,
        });
      assert.equal(plan?.state, "paused");
      assert.equal(plan?.pauseReason, "result_missing");
      assert.equal(step?.result, null);
      assert.equal(step?.selection, null);
      assert.equal(
        await runtime.owner.process(
          runtime.locator,
          new AbortController().signal,
        ),
        "unchanged",
      );
      assert.equal(runtime.preparations(), 0);
      await assertCounts(f, 0);
    },
  );
}

type Fixture = Awaited<ReturnType<typeof planRunFixture>>;
type Operation = Awaited<ReturnType<Fixture["operation"]>>;
function textScope(f: Fixture) {
  return {
    owner: {
      tenantId: f.f.actor.tenantId,
      spaceId: f.f.actor.spaceId,
      principalId: f.f.actor.principalId,
    },
    projectId: f.f.binding.projectId,
  };
}
function outlineOperation(f: Fixture) {
  return f.operation("outline_save", {
    projectId: f.f.binding.projectId,
    expectedArtifactRevision: 0,
    briefRevision: 1,
    content: planOutline,
  });
}
function coordinator(f: Fixture) {
  let preparations = 0;
  // This is an explicitly named deployment port. Genuine Main issuance is covered by the Native composition test.
  const continuation: ProjectTextPlanContinuationPort = {
    async run(_locator, signal, work) {
      signal.throwIfAborted();
      return work({
        plan: f.f.planAuthority(null),
        conversation: f.f.authority,
        async prepareExecution() {
          preparations++;
          throw new Error("unexpected_new_step_preparation");
        },
      });
    },
  };
  return {
    locator: { ...f.f.owner, planId: f.p.d.planId },
    preparations: () => preparations,
    owner: new ProjectTextPlanCoordinator({
      plans: f.f.plans,
      continuation,
      projects: f.f.metadata,
      texts: f.f.text,
      conversations: f.f.store,
      threads: f.f.parent,
      runs: f.f.parent,
      tasks: f.f.tasks,
      textCommands: f.run.text,
      clock: { now: () => new Date().toISOString() },
      digester: f.f.digester,
    }),
  };
}
function planService(f: Fixture) {
  return new ProjectTextPlanApplicationService({
    plans: f.f.plans,
    conversations: f.f.store,
    projects: f.f.metadata,
    texts: f.f.text,
    extensions: f.f.first.store,
    authorization: {
      async authorize() {
        return { outcome: "allow" };
      },
    },
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester: f.f.digester,
  });
}
/** Original lease/attempt/tool/Run writers only; deliberately leaves plan observation to the coordinator. */
async function finishOriginalRun(f: Fixture, op: Operation) {
  const { run } = f,
    at = new Date().toISOString(),
    output = "Named model-free original tool lifecycle";
  await run.parent.transitionToolExecution({
    ...run.locator,
    receiptId: op.receipt.receiptId,
    lease: run.lease,
    expectedRevision: op.receipt.revision,
    transition: {
      kind: "complete",
      occurredAt: at,
      providerReceiptId: "named-local-receipt",
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
  const actual = await run.parent.loadRun(run.locator);
  assert.ok(actual);
  const eventId = randomUUID();
  await run.parent.commitLeasedRun({
    lease: run.lease,
    history: null,
    commit: {
      tenantId: run.locator.tenantId,
      expectedRevision: actual.revision,
      idempotency: {
        scope: "named-coordinator-terminal",
        key: eventId,
        requestFingerprint: run.digester.sha256(eventId),
      },
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: actual.runId },
          eventId,
          sequence: actual.lastSequence + 1,
          occurredAt: at,
          type: "run.completed",
          data: { outputRef: null },
        },
      ],
      outbox: [],
      workItems: [],
    },
  });
  await run.parent.completeWorkItem(run.lease);
}
async function assertCounts(f: Fixture, revisions: number) {
  for (const [table, expected] of [
    ["run_snapshots", 1],
    ["project_text_revisions", revisions],
    ["extension_external_operations", 0],
  ] as const) {
    assert.equal(
      Number(
        (await f.f.rows(`SELECT COUNT(*) AS n FROM ${f.f.prefix}${table}`))[0]
          ?.n,
      ),
      expected,
    );
  }
  assert.deepEqual(await f.f.creditObjects(), []);
}
