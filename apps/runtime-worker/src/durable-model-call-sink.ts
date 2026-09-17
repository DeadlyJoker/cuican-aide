import type { ModelCallObservationSink } from "@crewon/domain";
import type { ModelCallStore, WorkItemClaim } from "@crewon/application";

export function durableModelCallSink(
  store: ModelCallStore,
  claim: WorkItemClaim,
  attempt: { stepId: string; attemptId: string },
): ModelCallObservationSink {
  return {
    record: async (observation) => {
      await store.recordModelCall({
        lease: {
          workItemId: claim.workItem.workItemId,
          ownerId: claim.lease.ownerId,
          leaseId: claim.lease.leaseId,
          leaseEpoch: claim.lease.epoch,
        },
        record: {
          tenantId: claim.workItem.tenantId,
          runId: claim.workItem.runId,
          ...attempt,
          observation,
        },
      });
    },
  };
}
