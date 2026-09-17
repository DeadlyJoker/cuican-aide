import { AgentKernelError } from "@crewon/agent-kernel";
import {
  RunStoreError,
  type CompactionCheckpointStore,
  type WorkItemClaim,
} from "@crewon/application";
import type { ContextCompactionCheckpointPort } from "@crewon/context";
export function durableCompactionCheckpoint(
  store: CompactionCheckpointStore | undefined,
  claim: WorkItemClaim,
  attempt: { stepId: string; attemptId: string },
): ContextCompactionCheckpointPort | undefined {
  if (store === undefined) return undefined;
  const scope = {
    tenantId: claim.workItem.tenantId,
    runId: claim.workItem.runId,
    ...attempt,
  };
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  async function call<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof RunStoreError &&
        error.code.startsWith("compaction_checkpoint_")
      )
        throw new AgentKernelError(error.code, false, { cause: error });
      throw error;
    }
  }
  return {
    load: (contextDigest) =>
      call(() => store.load({ scope, lease, contextDigest })),
    save: (input) => call(() => store.save({ scope, lease, ...input })),
  };
}
