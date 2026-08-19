import type {
  WorkflowAgentAttemptAuthority,
  WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";
import type { ModelDispatchReceipt } from "@crewon/domain";
import type { AgentHistoryItem } from "@crewon/agent-kernel/runtime";
import type { ProviderCheckpoint } from "@crewon/contracts/runtime";
import { validateWorkflowModelHistory } from "./workflow-agent-value-projection.ts";

export type WorkflowDurableExecutionAuthority = Readonly<{
  tenantId: string;
  runId: string;
  nodeId: string;
  nodeKind: "agent" | "verification";
  agentVersionId: string;
  claimId: string;
  claimEpoch: number;
  stepId: string;
  attemptId: string;
  workItemId: string;
  leaseEpoch: number;
}>;

export function workflowAttemptAuthority(
  input: WorkflowDurableExecutionAuthority,
): WorkflowAgentAttemptAuthority {
  return {
    tenantId: input.tenantId,
    runId: input.runId,
    workItemId: input.workItemId,
    leaseEpoch: input.leaseEpoch,
    nodeId: input.nodeId,
    nodeKind: input.nodeKind,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    agentVersionId: input.agentVersionId,
    attempt: { stepId: input.stepId, attemptId: input.attemptId },
  };
}

export function workflowContinuationCheckpoint(
  input: Readonly<{
    authority: WorkflowDurableExecutionAuthority;
    segmentId: string;
    modelSampleIndex: number;
    toolRoundsConsumed: number;
    history: readonly AgentHistoryItem[];
    dispatch: ModelDispatchReceipt | null;
    providerCheckpoint: ProviderCheckpoint | null;
    providerTurnState: string | null;
  }>,
): Omit<WorkflowNodeContinuationCheckpoint, "revision" | "updatedAt"> {
  if (input.dispatch?.status === "terminal") {
    throw new Error("workflow_model_dispatch_already_terminal");
  }
  return {
    schemaVersion: "crewon.workflow-node-continuation.v0",
    terminalCandidate: null,
    authority: workflowAttemptAuthority(input.authority),
    segmentId: input.segmentId,
    modelSampleIndex: input.modelSampleIndex,
    toolRoundsConsumed: input.toolRoundsConsumed,
    providerCheckpoint: input.providerCheckpoint,
    providerTurnState: input.providerTurnState,
    activeDispatch:
      input.dispatch === null
        ? null
        : {
            operationId: input.dispatch.operationId,
            requestSequence: input.dispatch.requestSequence,
            expectedRevision: input.dispatch.revision,
            status: input.dispatch.status,
          },
    history: validateWorkflowModelHistory(input.history),
  };
}
