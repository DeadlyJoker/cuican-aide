import assert from "node:assert/strict";
import {
  RunExecutionService,
  type DomainStore,
  type ApplicationClock,
  type ApplicationIdGenerator,
  type ContentDigester,
} from "@crewon/application";
/** Seeds a legacy Run event prefix, leaving its model history untouched. */
export async function seedRunProgressHistory(input: {
  store: DomainStore;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
  count: number;
}) {
  assert(
    Number.isSafeInteger(input.count) &&
      input.count >= 1 &&
      input.count <= 100000,
  );
  const claim = await input.store.claimNextWorkItem({
    ownerId: "progress-seed",
    leaseId: "progress-seed",
    leaseDurationMs: 30000,
  });
  assert.ok(claim);
  const execution = new RunExecutionService(input);
  await execution.startRun(claim);
  for (let offset = 0; offset < input.count; offset += 32) {
    await execution.recordOutputEvents(
      claim,
      Array.from(
        { length: Math.min(32, input.count - offset) },
        (_, index) => ({
          schemaVersion: "crewon.agent-event.v0",
          runId: claim.workItem.runId,
          segmentId: "old-output-segment",
          sequence: offset + index + 1,
          type: "model.output.delta",
          data: { delta: "old-progress" },
        }),
      ),
    );
  }
  await input.store.retryWorkItem({
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
    retryAfterMs: 0,
    reasonCode: "seed_complete",
  });
}
