import type {
  WorkflowAgentAttemptAuthority,
  WorkflowNodeContinuationCheckpoint,
} from "@crewon/application";
import type {
  ModelDispatchReceipt,
  WorkflowSchemaValue,
} from "@crewon/domain";
import type { AgentHistoryItem } from "@crewon/agent-kernel";
import type { ProviderCheckpoint } from "@crewon/contracts";

import type {
  WorkflowModelTerminalAuthority,
  WorkflowNodeOutcome,
} from "./workflow-runtime-dispatcher.ts";

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

export function workflowContinuationCheckpoint(input: Readonly<{
  authority: WorkflowDurableExecutionAuthority;
  segmentId: string;
  modelSampleIndex: number;
  toolRoundsConsumed: number;
  history: readonly AgentHistoryItem[];
  dispatch: ModelDispatchReceipt | null;
  providerCheckpoint: ProviderCheckpoint | null;
  providerTurnState: string | null;
}>): Omit<WorkflowNodeContinuationCheckpoint, "revision" | "updatedAt"> {
  if (input.dispatch?.status === "terminal") {
    throw new Error("workflow_model_dispatch_already_terminal");
  }
  return {
    schemaVersion: "crewon.workflow-node-continuation.v0",
    authority: workflowAttemptAuthority(input.authority),
    segmentId: input.segmentId,
    modelSampleIndex: input.modelSampleIndex,
    toolRoundsConsumed: input.toolRoundsConsumed,
    providerCheckpoint: input.providerCheckpoint,
    providerTurnState: input.providerTurnState,
    activeDispatch: input.dispatch === null ? null : {
      operationId: input.dispatch.operationId,
      requestSequence: input.dispatch.requestSequence,
      expectedRevision: input.dispatch.revision,
      status: input.dispatch.status,
    },
    history: input.history,
  };
}

type TerminalOutcome =
  | Readonly<{ status: "completed"; value: WorkflowSchemaValue }>
  | Readonly<{ status: "failed"; failureCode: string }>
  | Readonly<{ status: "canceled" }>;

export function projectWorkflowModelTerminal(
  outcome: TerminalOutcome,
  dispatch: ModelDispatchReceipt | null,
): WorkflowNodeOutcome {
  if (dispatch === null) return outcome;
  const certainty = dispatch.status === "responseObserved"
    ? "responseObserved" as const
    : dispatch.status === "prepared" ? "notSent" as const : null;
  if (certainty === null ||
      (outcome.status === "completed" && certainty !== "responseObserved")) {
    return { status: "unknown" };
  }
  if (dispatch.status === "terminal") {
    throw new Error("workflow_model_dispatch_already_terminal");
  }
  const modelTerminal: WorkflowModelTerminalAuthority = {
    dispatch: {
      operationId: dispatch.operationId,
      requestSequence: dispatch.requestSequence,
      expectedRevision: dispatch.revision,
      status: dispatch.status,
    },
    dispatchTerminalOutcome: {
      kind: outcome.status,
      code: outcome.status === "failed" ? outcome.failureCode
        : outcome.status === "canceled" ? "workflow_node_canceled" : null,
      certainty,
    },
  };
  return { ...outcome, modelTerminal };
}
