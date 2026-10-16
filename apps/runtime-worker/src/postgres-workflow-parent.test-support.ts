import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { compositionInput } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { postgresWorkflowChildWorker } from "./postgres-workflow-worker.test-support.ts";
import { ExperimentalWorkflowScheduler } from "./workflow-scheduler.ts";
type Fixture = Awaited<ReturnType<typeof postgresCompositionFixture>>;

export async function claimParent(f: Fixture, id = "parent-final") {
  const claim = await f.store.claimNextWorkItem({
    ownerId: id,
    leaseId: id,
    leaseDurationMs: 60_000,
  });
  assert.ok(claim);
  assert.equal(claim.workItem.runId, f.root.runId);
  return compositionInput(f.input.binding, claim);
}
/** Ordinary Worker plus the existing experimental scheduler, including durable PG cancellation. */
export async function postgresParentWorker(
  f: Fixture,
  t: TestContext,
  options: {
    output?: Parameters<typeof postgresWorkflowChildWorker>[2];
    afterAdmit?: () => Promise<void>;
    child?: Omit<
      NonNullable<Parameters<typeof postgresWorkflowChildWorker>[3]>,
      "experimentalScheduler"
    >;
  } = {},
) {
  const queue = (
    await f.admin.query<{ status: string; lease_id: string | null }>(
      `SELECT status,lease_id FROM ${f.sql}.work_items WHERE work_item_id=$1`,
      [f.input.lease.workItemId],
    )
  ).rows[0];
  if (queue?.status === "leased" && queue.lease_id === f.input.lease.leaseId)
    await f.store.retryWorkItem({
      ...f.input.lease,
      retryAfterMs: 0,
      reasonCode: "fixture_worker_handoff",
    });
  const scheduler = new ExperimentalWorkflowScheduler(f.store, {
    prepareWorkflowRun: (input) => f.composition.prepareWorkflowRun(input),
    admitWorkflowNodes: async (input) => {
      const result = await f.composition.admitWorkflowNodes(input);
      await options.afterAdmit?.();
      return result;
    },
    finishWorkflowSchedulerPass: (input) =>
      f.composition.finishWorkflowSchedulerPass(input),
    finalizeWorkflowRun: (input) => f.composition.finalizeWorkflowRun(input),
    propagateWorkflowCancellation: (input) =>
      f.composition.propagateWorkflowCancellation(input),
  });
  return postgresWorkflowChildWorker(f, t, options.output, {
    ...options.child,
    experimentalScheduler: scheduler,
  });
}
export async function finalizationFixture(
  t: TestContext,
  options: Parameters<typeof postgresCompositionFixture>[1] = {},
  output: Parameters<typeof postgresWorkflowChildWorker>[2] = undefined,
) {
  const f = await postgresCompositionFixture(t, options);
  const child = await postgresWorkflowChildWorker(f, t, output);
  await f.composition.admitWorkflowNodes(f.input);
  assert.equal(
    (await f.composition.finishWorkflowSchedulerPass(f.input)).kind,
    "waiting",
  );
  assert.equal((await child.worker.wake()).kind, "completed");
  const second = await claimParent(f, "parent-verify");
  await f.composition.admitWorkflowNodes(second);
  assert.equal(
    (await f.composition.finishWorkflowSchedulerPass(second)).kind,
    "waiting",
  );
  assert.equal((await child.worker.wake()).kind, "completed");
  const finalInput = await claimParent(f);
  assert.equal(
    (await f.composition.admitWorkflowNodes(finalInput)).execution.status,
    "completed",
  );
  return { ...f, child, finalInput };
}
