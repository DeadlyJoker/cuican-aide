import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommitRunInput,
  RunStore,
  ThreadStore,
  WorkItemClaim,
} from "@crewon/application";
import type { LeaseClock } from "./lease-clock.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";

export function registerWorkItemFairness(
  createStore: (
    clock: LeaseClock,
  ) => (RunStore & ThreadStore) | Promise<RunStore & ThreadStore>,
  createInput: () => CommitRunInput,
) {
  test("retrying an older Work Item does not starve already-ready work or change authoritative payloads", async (t) => {
    const store = await createStore({
      nowEpochMilliseconds: () => Date.parse("2026-08-08T01:00:00Z"),
    });
    t.after(() => store.close());
    await seedThread(store);
    const input = createInput();
    const workItems = [0, 1, 2].map((i) => ({
      ...input.workItems[0]!,
      workItemId: `fair-work-${i}`,
    }));
    await store.commitRun({ ...input, workItems });
    const claim = (n: number) =>
      store.claimNextWorkItem({
        ownerId: `worker-${n}`,
        leaseId: `lease-${n}`,
        leaseDurationMs: 30000,
      });
    const original = await claim(1);
    assert.ok(original);
    assert.deepEqual(original.workItem, workItems[0]);
    await store.retryWorkItem({
      ...lease(original),
      retryAfterMs: 0,
      reasonCode: "run_execution_yield",
    });
    assert.deepEqual(
      (await store.listPendingWorkItems(10)).map((w) => w.workItemId),
      [
        workItems[1]!.workItemId,
        workItems[2]!.workItemId,
        workItems[0]!.workItemId,
      ],
    );
    const second = await claim(2),
      third = await claim(3),
      resumed = await claim(4);
    assert.deepEqual(second?.workItem, workItems[1]);
    assert.deepEqual(third?.workItem, workItems[2]);
    assert.deepEqual(resumed?.workItem, original.workItem);
    assert.equal(resumed?.lease.epoch, original.lease.epoch + 1);
    await assert.rejects(store.completeWorkItem(lease(original)));
    assert.ok(resumed);
    await store.completeWorkItem(lease(resumed));
    assert.deepEqual(
      await store.listRunEvents(
        { tenantId: input.tenantId, runId: input.events[0]!.identity.runId },
        0,
        100,
      ),
      input.events,
    );
    assert.equal(
      (await store.commitRun({ ...input, workItems })).disposition,
      "replayed",
    );
  });
}

function lease(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}
