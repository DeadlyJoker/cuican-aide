import type { ModelUsageObservationSink } from "@crewon/domain";
import { AgentKernelError } from "@crewon/agent-kernel";
import {
  RunStoreError,
  type ModelUsageStore,
  type WorkItemClaim,
} from "@crewon/application";

export function durableModelUsageSink(
  store: ModelUsageStore,
  claim: WorkItemClaim,
  attempt: { stepId: string; attemptId: string },
): ModelUsageObservationSink {
  return {
    observed: async (observation) => {
      try {
        await store.recordModelUsage({
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
            observedAt: new Date().toISOString(),
            observation,
          },
        });
      } catch (error) {
        if (
          error instanceof RunStoreError &&
          error.code === "model_usage_conflict"
        )
          throw new AgentKernelError("model_usage_conflict", false, {
            cause: error,
          });
        throw error;
      }
    },
  };
}
